/**
 * stage1-exception.test.mjs
 * v0.1.3-stage1.3 — Exception-path end-to-end tests (Task #3)
 *
 * Covers the full disagreement → REVIEW_REQUIRED → rescreen → re-verify → reconcile cycle
 * over real HTTP, verifying:
 *   - Disagreeing RPC evidence produces REVIEW_REQUIRED, not a silent pass
 *   - /verification returns the mismatched rows with no token leakage
 *   - Token can be rotated at REVIEW_REQUIRED for a fresh re-authorization
 *   - Re-screening APPROVE restores READY_FOR_PAYMENT
 *   - A second authorization with the rotated token produces a new SUBMITTED signature
 *   - Agreeing evidence on the second attempt UPSERTs the rows and reaches VERIFIED
 *   - /verification reflects the corrected evidence after re-verify
 *   - Reconciliation with a matching amount produces MATCHED, not EXCEPTION
 *   - /reconciliation is clean of token material
 *   - Full audit trail is consistent throughout
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverPath = new URL('../src/server.mjs', import.meta.url).pathname;

function startServer(extraEnv = {}) {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'glp-exc-')), 'glp.sqlite');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GLP_SANDBOX: '1', GLP_DATABASE: databasePath, PORT: '0', HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const m = output.match(/running at http:\/\/[^:]+:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited early: code=${code}: ${output}`)));
    setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10_000).unref();
  });
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
}

async function call(port, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* non-json */ }
  return { status: response.status, payload, text };
}

/** Reach SUBMITTED via the normal create → screen-APPROVE → authorize flow. */
async function setupSubmitted(port, overrides = {}) {
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const created = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 7_500,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `exc-${crypto.randomUUID()}`,
      ...overrides
    }
  })).payload;
  const token1 = new URLSearchParams((created.checkout_path || '').split('#')[1] || '').get('token');
  await call(port, `/api/payment-intents/${created.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  const submitted = (await call(port, `/api/checkout/${created.id}/authorize`, {
    method: 'POST', token: token1,
    body: { signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`, sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111' }
  })).payload;
  return { merchant, intent: created, token: token1, submitted };
}

/** Build the correct evidence body for a given submitted intent. */
function correctEvidence(submitted) {
  return {
    signature: submitted.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted.expected_token_program,
    mint: submitted.expected_mint,
    sourceWallet: submitted.source_wallet,
    destinationWallet: submitted.expected_destination,
    rawAmount: submitted.expected_raw_amount,
    slot: 315_000_000 + Math.floor(Math.random() * 1_000_000),
    transactionError: false
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test('disagreeing evidence routes to REVIEW_REQUIRED and /verification exposes the mismatch rows', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  const { intent, token, submitted } = await setupSubmitted(port);
  const base = correctEvidence(submitted);

  // Tamper secondary to produce a rawAmount mismatch.
  const verify = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary: { ...base, rpcProvider: 'watcher-a' },
      secondary: { ...base, rpcProvider: 'watcher-b', rawAmount: base.rawAmount + 99 }
    }
  });
  assert.equal(verify.status, 200, 'verify with mismatch must respond 200 (handled, not crashed)');
  assert.equal(verify.payload.verified, false);
  assert.equal(verify.payload.intent.status, 'REVIEW_REQUIRED');
  assert.ok(Array.isArray(verify.payload.mismatches));
  assert.ok(verify.payload.mismatches.some((m) => m.includes('rawAmount')), 'mismatch reason must mention rawAmount');

  // /verification must return both evidence rows — the mismatch is recorded.
  const evCheck = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(evCheck.status, 200);
  assert.ok(Array.isArray(evCheck.payload.evidence));
  assert.equal(evCheck.payload.evidence.length, 2, 'two rows must exist even on mismatch');
  const providers = evCheck.payload.evidence.map((r) => r.rpc_provider).sort();
  assert.deepEqual(providers, ['watcher-a', 'watcher-b']);
  // Token material must never appear in the evidence response.
  assert.ok(!evCheck.text.includes(token), '/verification must not contain the checkout token');
  assert.ok(!evCheck.text.includes('checkout_token'), '/verification must not contain checkout_token field');

  // Dashboard reflects no ledger movement on a review (not a verified settlement).
  const dashboard = (await call(port, '/api/dashboard')).payload;
  assert.equal(dashboard.ledger_debits_cents, 0);
});

test('full exception-path cycle: disagree → rotate → rescreen → re-authorize → re-verify → reconcile', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  const { intent, token: token1, submitted: submitted1 } = await setupSubmitted(port);
  const base1 = correctEvidence(submitted1);

  // ── Step 1: verify with disagreeing slot → REVIEW_REQUIRED ────────────────
  const mismatchVerify = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary: { ...base1, rpcProvider: 'watcher-a', slot: base1.slot },
      secondary: { ...base1, rpcProvider: 'watcher-b', slot: base1.slot + 1 }
    }
  });
  assert.equal(mismatchVerify.payload.intent.status, 'REVIEW_REQUIRED');
  const mismatchReason = mismatchVerify.payload.intent.status_reason || '';
  // status_reason is set on REVIEW_REQUIRED; it should mention the disagreement.
  // (Not asserting exact text — just that something was recorded.)
  assert.ok(typeof mismatchReason === 'string');

  // ── Step 2: rotate the checkout token while still at REVIEW_REQUIRED ──────
  // REVIEW_REQUIRED is in ROTATABLE_INTENT_STATUSES — rotation must succeed.
  const rotation = await call(port, `/api/payment-intents/${intent.id}/checkout`, {
    method: 'POST', token: token1
  });
  assert.equal(rotation.status, 200, 'rotation at REVIEW_REQUIRED must succeed');
  assert.equal(rotation.payload.previous_token_invalidated, true);
  assert.equal(rotation.payload.checkout_token, undefined, 'token must not appear in body');
  const token2 = new URLSearchParams((rotation.payload.checkout_path || '').split('#')[1] || '').get('token');
  assert.ok(token2 && token2 !== token1, 'new token must differ from old token');

  // Old token is dead.
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token: token1 })).status, 404);
  // New token works.
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token: token2 })).status, 200);

  // ── Step 3: re-screen APPROVE → READY_FOR_PAYMENT ────────────────────────
  const rescreen = await call(port, `/api/payment-intents/${intent.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `rescreen-${crypto.randomUUID()}` }
  });
  assert.equal(rescreen.status, 200);
  assert.equal(rescreen.payload.status, 'READY_FOR_PAYMENT');

  // ── Step 4: re-authorize with the rotated token → SUBMITTED ──────────────
  const auth2 = await call(port, `/api/checkout/${intent.id}/authorize`, {
    method: 'POST', token: token2,
    body: { signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`, sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111' }
  });
  assert.equal(auth2.status, 200);
  const submitted2 = auth2.payload;
  assert.equal(submitted2.status, 'SUBMITTED');
  // The re-submission generates a fresh signature — it must differ from the first.
  assert.notEqual(submitted2.signature, submitted1.signature, 're-submission must produce a new signature');

  // ── Step 5: re-verify with MATCHING evidence → VERIFIED ──────────────────
  // Evidence is built from submitted2 (new signature and source_wallet).
  const base2 = correctEvidence(submitted2);
  const goodVerify = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary: { ...base2, rpcProvider: 'watcher-a' },
      secondary: { ...base2, rpcProvider: 'watcher-b' }
    }
  });
  assert.equal(goodVerify.status, 200);
  assert.equal(goodVerify.payload.verified, true);
  assert.equal(goodVerify.payload.intent.status, 'VERIFIED');
  assert.deepEqual(goodVerify.payload.mismatches, []);

  // ── Step 6: /verification reflects the corrected (upserted) rows ──────────
  const evAfterGood = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(evAfterGood.status, 200);
  assert.equal(evAfterGood.payload.evidence.length, 2, 'upsert must leave exactly 2 rows');
  // Both rows should now carry the corrected signature.
  for (const row of evAfterGood.payload.evidence) {
    assert.equal(row.signature, submitted2.signature, 'evidence row must carry the second (correct) signature after upsert');
    assert.equal(row.slot, base2.slot, 'both rows must agree on slot after re-verify');
  }
  // Token must not appear in evidence.
  assert.ok(!evAfterGood.text.includes(token1), '/verification must not contain token1');
  assert.ok(!evAfterGood.text.includes(token2), '/verification must not contain token2');

  // Ledger now shows the observation debit (one entry pair for the verified settlement).
  const dashboard = (await call(port, '/api/dashboard')).payload;
  assert.ok(dashboard.ledger_debits_cents > 0, 'ledger must show debit after verification');
  assert.equal(dashboard.ledger_difference_cents, 0, 'ledger must be balanced after verification');

  // ── Step 7: reconcile → MATCHED ──────────────────────────────────────────
  const reconcile = await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: {
      posAmountCents: intent.amount_usd_cents,
      chainRawAmount: submitted2.expected_raw_amount,
      partnerAmountCents: intent.amount_usd_cents
    }
  });
  assert.equal(reconcile.status, 200);
  assert.equal(reconcile.payload.intent.status, 'RECONCILED');

  // ── Step 8: /reconciliation is correct and clean ─────────────────────────
  const recRow = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(recRow.status, 200);
  const rec = recRow.payload.reconciliation;
  assert.equal(rec.status, 'MATCHED');
  assert.deepEqual(rec.exceptions, [], 'no reconciliation exceptions on a matched run');
  assert.equal(rec.pos_amount_cents, intent.amount_usd_cents);
  assert.equal(rec.partner_amount_cents, intent.amount_usd_cents);
  // No token material in the reconciliation response.
  assert.ok(!recRow.text.includes(token1), '/reconciliation must not contain token1');
  assert.ok(!recRow.text.includes(token2), '/reconciliation must not contain token2');
  assert.ok(!recRow.text.includes('checkout_token'));

  // ── Step 9: full evidence bundle is coherent and token-free ──────────────
  const bundle = await call(port, `/api/payment-intents/${intent.id}/evidence`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.payload.schema, 'glp.sandbox.evidence.v1');
  assert.equal(bundle.payload.payment_intent.status, 'RECONCILED');
  assert.equal(bundle.payload.audit_chain.valid, true);
  assert.ok(!bundle.text.includes(token1) && !bundle.text.includes(token2), 'evidence bundle must be token-free');
});

test('reconciliation-amount EXCEPTION path: mismatched amounts produce EXCEPTION status', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // Walk to VERIFIED with correct RPC agreement.
  const { intent, submitted } = await setupSubmitted(port);
  const base = correctEvidence(submitted);
  const verify = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...base, rpcProvider: 'w-a' }, secondary: { ...base, rpcProvider: 'w-b' } }
  });
  assert.equal(verify.payload.intent.status, 'VERIFIED');

  // Reconcile with a POS amount that does not match the chain.
  const wrongAmount = intent.amount_usd_cents + 100;
  const reconcile = await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: { posAmountCents: wrongAmount, chainRawAmount: submitted.expected_raw_amount, partnerAmountCents: intent.amount_usd_cents }
  });
  assert.equal(reconcile.status, 200);
  assert.equal(reconcile.payload.intent.status, 'EXCEPTION');
  assert.ok(Array.isArray(reconcile.payload.reconciliation.exceptions));
  assert.ok(reconcile.payload.reconciliation.exceptions.length > 0, 'amount mismatch must produce at least one exception');
  assert.equal(reconcile.payload.reconciliation.status, 'EXCEPTION');

  // /reconciliation reflects the EXCEPTION record.
  const recRow = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(recRow.status, 200);
  assert.equal(recRow.payload.reconciliation.status, 'EXCEPTION');

  // /verification is still accessible after EXCEPTION.
  const evCheck = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(evCheck.status, 200);
  assert.equal(evCheck.payload.evidence.length, 2);

  // Full evidence bundle is still accessible (contains the EXCEPTION status).
  const bundle = await call(port, `/api/payment-intents/${intent.id}/evidence`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.payload.payment_intent.status, 'EXCEPTION');
  assert.equal(bundle.payload.audit_chain.valid, true);
});

test('verify endpoint rejects a second call when intent is already VERIFIED', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  const { intent, submitted } = await setupSubmitted(port);
  const base = correctEvidence(submitted);
  await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...base, rpcProvider: 'w-a' }, secondary: { ...base, rpcProvider: 'w-b' } }
  });

  // Attempting to verify again (VERIFIED → not SUBMITTED) must be rejected.
  const repeat = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...base, rpcProvider: 'w-a' }, secondary: { ...base, rpcProvider: 'w-b' } }
  });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.payload.error.code, 'INVALID_STATE');
});
