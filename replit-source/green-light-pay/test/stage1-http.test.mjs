import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverPath = new URL('../src/server.mjs', import.meta.url).pathname;

function startServer(extraEnv = {}) {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'glp-test-')), 'glp.sqlite');
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      GLP_SANDBOX: '1',
      GLP_DATABASE: databasePath,
      PORT: '0',
      HOST: '127.0.0.1',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/running at http:\/\/[^:]+:(\d+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolvePromise({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => rejectPromise(new Error(`server exited early with code ${code}: ${output}`)));
    setTimeout(() => rejectPromise(new Error(`server did not start: ${output}`)), 10_000).unref();
  });
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
}

async function call(port, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* svg or non-json */ }
  return { status: response.status, payload, text, headers: response.headers };
}

async function createIntent(port) {
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const result = await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 4_250,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `http-${crypto.randomUUID()}`
    }
  });
  assert.equal(result.status, 201);
  const intent = result.payload;
  const fragment = String(intent.checkout_path).split('#')[1] || '';
  const token = new URLSearchParams(fragment).get('token');
  return { merchant, intent, token };
}

test('startup guard refuses to boot without an affirmative GLP_SANDBOX', async () => {
  for (const value of [undefined, 'false', '0', 'production']) {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, GLP_SANDBOX: value ?? '', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `expected refusal for GLP_SANDBOX=${value}`);
    assert.match(stderr, /GLP_SANDBOX_GUARD: refusing to start/);
  }
});

test('HTTP surface enforces Stage 1 token, bypass, rotation, evidence, and header contracts', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // Health + security headers.
  const health = await call(port, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.prototype_version, '0.1.3-stage1.3');
  assert.equal(health.payload.live_money_movement, false);
  assert.equal(health.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(health.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(health.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  // Creation returns a fragment-based handoff and never a token in a query string.
  const { intent, token } = await createIntent(port);
  assert.ok(token, 'token must be recoverable from the fragment');
  assert.match(intent.checkout_path, /#token=/);
  assert.doesNotMatch(intent.checkout_path, /[?&]token=/);
  assert.equal(intent.checkout_token, undefined);
  assert.equal(intent.checkout_uri, undefined);
  assert.doesNotMatch(intent.checkout_qr_path, /token/);

  // Checkout session: header-auth only; query tokens rejected loudly.
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token })).status, 200);
  assert.equal((await call(port, `/api/checkout/${intent.id}`)).status, 404);
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token: 'wrong-token' })).status, 404);
  const queryAttempt = await call(port, `/api/checkout/${intent.id}?token=${encodeURIComponent(token)}`);
  assert.equal(queryAttempt.status, 400);
  assert.equal(queryAttempt.payload.error.code, 'CAPABILITY_IN_QUERY');
  assert.ok(!queryAttempt.text.includes(token), 'rejection must not echo the token');

  // QR requires the bearer header too.
  const qr = await call(port, `/api/checkout/${intent.id}/qr`, { token });
  assert.equal(qr.status, 200);
  assert.match(qr.text, /<svg/);
  assert.equal((await call(port, `/api/checkout/${intent.id}/qr`)).status, 404);

  // The direct-submit bypass is gone: generic 404.
  const bypass = await call(port, `/api/payment-intents/${intent.id}/submit`, {
    method: 'POST',
    body: { signature: 'sig-bypass', sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111' }
  });
  assert.equal(bypass.status, 404);
  assert.equal(bypass.payload.error.code, 'NOT_FOUND');

  // Rotation: unauthenticated rotation is rejected (missing Bearer → generic 404).
  const unauthedRotation = await call(port, `/api/payment-intents/${intent.id}/checkout`, { method: 'POST' });
  assert.equal(unauthedRotation.status, 404);
  assert.equal(unauthedRotation.payload.error.code, 'CHECKOUT_NOT_FOUND');
  // Rotation with wrong token is also rejected.
  const wrongTokenRotation = await call(port, `/api/payment-intents/${intent.id}/checkout`, { method: 'POST', token: 'not-the-right-token' });
  assert.equal(wrongTokenRotation.status, 404);

  // Rotation with the valid current token: new fragment token, old token dead, no token fields in response body.
  const rotated = await call(port, `/api/payment-intents/${intent.id}/checkout`, { method: 'POST', token });
  assert.equal(rotated.payload.previous_token_invalidated, true);
  assert.equal(rotated.payload.checkout_token, undefined);
  const newToken = new URLSearchParams(String(rotated.payload.checkout_path).split('#')[1] || '').get('token');
  assert.ok(newToken && newToken !== token);
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token })).status, 404);
  assert.equal((await call(port, `/api/checkout/${intent.id}`, { token: newToken })).status, 200);

  // Full lifecycle with the rotated token.
  const screen = await call(port, `/api/payment-intents/${intent.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  assert.equal(screen.status, 200);

  // Evidence unavailable before reconciliation.
  const early = await call(port, `/api/payment-intents/${intent.id}/evidence`);
  assert.equal(early.status, 409);
  assert.equal(early.payload.error.code, 'EVIDENCE_NOT_AVAILABLE');

  const authorized = await call(port, `/api/checkout/${intent.id}/authorize`, {
    method: 'POST',
    token: newToken,
    body: { signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`, sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111' }
  });
  assert.equal(authorized.status, 200);
  const submitted = authorized.payload;

  // Rotation after signature submission is refused, even with the valid token.
  const lateRotation = await call(port, `/api/payment-intents/${intent.id}/checkout`, { method: 'POST', token: newToken });
  assert.equal(lateRotation.status, 409);

  const evidence = {
    signature: submitted.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted.expected_token_program,
    mint: submitted.expected_mint,
    sourceWallet: submitted.source_wallet,
    destinationWallet: submitted.expected_destination,
    rawAmount: submitted.expected_raw_amount,
    slot: 311_555_777,
    transactionError: false
  };
  // GET /verification before any verification rows → 200 with empty array
  const verificationEmpty = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(verificationEmpty.status, 200);
  assert.ok(Array.isArray(verificationEmpty.payload.evidence));
  assert.equal(verificationEmpty.payload.evidence.length, 0);

  // GET /reconciliation before RECONCILED → 409
  const reconciliationBefore = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(reconciliationBefore.status, 409);
  assert.equal(reconciliationBefore.payload.error.code, 'INVALID_STATE');

  // Unknown intent → 404 for both new endpoints
  assert.equal((await call(port, `/api/payment-intents/NO_SUCH_ID/verification`)).status, 404);
  assert.equal((await call(port, `/api/payment-intents/NO_SUCH_ID/reconciliation`)).status, 404);

  const verified = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...evidence, rpcProvider: 'rpc-a' }, secondary: { ...evidence, rpcProvider: 'rpc-b' } }
  });
  assert.equal(verified.status, 200);

  // GET /verification after verify → 200 with two rows
  const verificationRows = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(verificationRows.status, 200);
  assert.ok(Array.isArray(verificationRows.payload.evidence));
  assert.equal(verificationRows.payload.evidence.length, 2);
  assert.ok(verificationRows.payload.evidence[0].rpc_provider);
  assert.ok(!verificationRows.text.includes(newToken), 'verification rows must not contain token');

  const reconciled = await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: { posAmountCents: submitted.amount_usd_cents, chainRawAmount: submitted.expected_raw_amount, partnerAmountCents: submitted.amount_usd_cents }
  });
  assert.equal(reconciled.status, 200);

  // GET /reconciliation after RECONCILED → 200
  const reconciliationRow = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(reconciliationRow.status, 200);
  assert.ok(reconciliationRow.payload.reconciliation);
  assert.equal(reconciliationRow.payload.reconciliation.status, 'MATCHED');
  assert.ok(!reconciliationRow.text.includes(newToken), 'reconciliation must not contain token');

  // Evidence endpoint: reconciled bundle, downloadable, secret-free.
  const bundle = await call(port, `/api/payment-intents/${intent.id}/evidence`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-disposition') || '', /attachment/);
  assert.equal(bundle.payload.schema, 'glp.sandbox.evidence.v1');
  assert.equal(bundle.payload.payment_intent.status, 'RECONCILED');
  assert.equal(bundle.payload.audit_chain.valid, true);
  assert.ok(!bundle.text.includes(token) && !bundle.text.includes(newToken), 'evidence must not contain tokens');
  assert.ok(!bundle.text.includes('checkout_token'), 'evidence must not contain token fields');
});

test('exception and rescreening path reaches VERIFIED after disagreeing-then-agreeing evidence', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // 1. Create intent and keep the original checkout token.
  const { intent, token } = await createIntent(port);

  // 2. Screen to APPROVED → READY_FOR_PAYMENT.
  const screen1 = await call(port, `/api/payment-intents/${intent.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  assert.equal(screen1.status, 200);
  assert.equal(screen1.payload.status, 'READY_FOR_PAYMENT');

  // 3. Authorize → SUBMITTED (signature A).
  const auth1 = await call(port, `/api/checkout/${intent.id}/authorize`, {
    method: 'POST',
    token,
    body: {
      signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`,
      sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111'
    }
  });
  assert.equal(auth1.status, 200);
  const submitted1 = auth1.payload;

  // 4. Verify with disagreeing evidence (secondary slot differs) → REVIEW_REQUIRED.
  const baseEvidence1 = {
    signature: submitted1.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted1.expected_token_program,
    mint: submitted1.expected_mint,
    sourceWallet: submitted1.source_wallet,
    destinationWallet: submitted1.expected_destination,
    rawAmount: submitted1.expected_raw_amount,
    slot: 311_555_777,
    transactionError: false
  };
  const verify1 = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary:   { ...baseEvidence1, rpcProvider: 'rpc-a' },
      secondary: { ...baseEvidence1, rpcProvider: 'rpc-b', slot: 999_000_001 } // slot mismatch
    }
  });
  assert.equal(verify1.status, 200);
  assert.equal(verify1.payload.verified, false);
  assert.ok(verify1.payload.mismatches.length > 0, 'mismatches must be reported');
  assert.equal(verify1.payload.intent.status, 'REVIEW_REQUIRED');

  // 5. /verification returns two rows; no token material present.
  const verif1 = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(verif1.status, 200);
  assert.ok(Array.isArray(verif1.payload.evidence));
  assert.equal(verif1.payload.evidence.length, 2, 'two evidence rows after first verify');
  assert.ok(verif1.payload.evidence[0].rpc_provider, 'evidence rows must include rpc_provider');
  assert.ok(!verif1.text.includes(token), 'verification rows must not contain checkout token');

  // 6. Re-screen from REVIEW_REQUIRED → APPROVED (READY_FOR_PAYMENT).
  const screen2 = await call(port, `/api/payment-intents/${intent.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  assert.equal(screen2.status, 200);
  assert.equal(screen2.payload.status, 'READY_FOR_PAYMENT');

  // 7. Authorize again → SUBMITTED (signature B, distinct from A).
  const auth2 = await call(port, `/api/checkout/${intent.id}/authorize`, {
    method: 'POST',
    token,
    body: {
      signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`,
      sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111'
    }
  });
  assert.equal(auth2.status, 200);
  const submitted2 = auth2.payload;

  // 8. Verify with agreeing evidence → VERIFIED.
  const baseEvidence2 = {
    signature: submitted2.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted2.expected_token_program,
    mint: submitted2.expected_mint,
    sourceWallet: submitted2.source_wallet,
    destinationWallet: submitted2.expected_destination,
    rawAmount: submitted2.expected_raw_amount,
    slot: 311_555_778,
    transactionError: false
  };
  const verify2 = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary:   { ...baseEvidence2, rpcProvider: 'rpc-a' },
      secondary: { ...baseEvidence2, rpcProvider: 'rpc-b' }
    }
  });
  assert.equal(verify2.status, 200);
  assert.equal(verify2.payload.verified, true);
  assert.equal(verify2.payload.mismatches.length, 0);
  assert.equal(verify2.payload.intent.status, 'VERIFIED');

  // 9. /verification still has exactly two rows (same RPC providers, upserted).
  const verif2 = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(verif2.status, 200);
  assert.equal(verif2.payload.evidence.length, 2, 'evidence count must remain 2 after rescreen');
  assert.ok(!verif2.text.includes(token), 'verification rows must not contain token after rescreening');

  // 10. Reconcile → RECONCILED / MATCHED.
  const reconcile = await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: {
      posAmountCents:     submitted2.amount_usd_cents,
      chainRawAmount:     submitted2.expected_raw_amount,
      partnerAmountCents: submitted2.amount_usd_cents
    }
  });
  assert.equal(reconcile.status, 200);

  // 11. /reconciliation endpoint reflects MATCHED status; no token in response.
  const reconciliation = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(reconciliation.status, 200);
  assert.ok(reconciliation.payload.reconciliation);
  assert.equal(reconciliation.payload.reconciliation.status, 'MATCHED');
  assert.ok(!reconciliation.text.includes(token), 'reconciliation must not contain token');
});

test('reconciliation amount mismatch flags the intent as EXCEPTION (not MATCHED)', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // 1. Create intent and screen to READY_FOR_PAYMENT.
  const { intent, token } = await createIntent(port);
  const screen = await call(port, `/api/payment-intents/${intent.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  assert.equal(screen.status, 200);
  assert.equal(screen.payload.status, 'READY_FOR_PAYMENT');

  // 2. Authorize → SUBMITTED.
  const authorized = await call(port, `/api/checkout/${intent.id}/authorize`, {
    method: 'POST',
    token,
    body: {
      signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`,
      sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111'
    }
  });
  assert.equal(authorized.status, 200);
  const submitted = authorized.payload;

  // 3. Verify with agreeing evidence → VERIFIED.
  const baseEvidence = {
    signature: submitted.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted.expected_token_program,
    mint: submitted.expected_mint,
    sourceWallet: submitted.source_wallet,
    destinationWallet: submitted.expected_destination,
    rawAmount: submitted.expected_raw_amount,
    slot: 400_111_222,
    transactionError: false
  };
  const verified = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: {
      primary:   { ...baseEvidence, rpcProvider: 'rpc-a' },
      secondary: { ...baseEvidence, rpcProvider: 'rpc-b' }
    }
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.payload.verified, true);
  assert.equal(verified.payload.intent.status, 'VERIFIED');

  // 4. Reconcile with a deliberately wrong posAmountCents → EXCEPTION.
  const wrongAmount = submitted.amount_usd_cents + 1; // one cent off
  const reconciled = await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: {
      posAmountCents:     wrongAmount,
      chainRawAmount:     submitted.expected_raw_amount,
      partnerAmountCents: submitted.amount_usd_cents
    }
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.payload.intent.status, 'EXCEPTION', 'intent status must be EXCEPTION on mismatch');
  assert.notEqual(reconciled.payload.intent.status, 'RECONCILED', 'must not be RECONCILED on mismatch');
  assert.equal(reconciled.payload.reconciliation.status, 'EXCEPTION');
  assert.ok(Array.isArray(reconciled.payload.reconciliation.exceptions));
  assert.ok(reconciled.payload.reconciliation.exceptions.length > 0, 'exceptions array must be non-empty');

  // 5. GET /reconciliation returns EXCEPTION with non-empty exceptions.
  const reconciliationRow = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(reconciliationRow.status, 200);
  assert.ok(reconciliationRow.payload.reconciliation);
  assert.equal(reconciliationRow.payload.reconciliation.status, 'EXCEPTION');
  assert.ok(reconciliationRow.payload.reconciliation.exceptions.length > 0, 'GET /reconciliation must expose exceptions');

  // 6. GET /evidence is available for EXCEPTION status (not gated behind RECONCILED-only).
  const bundle = await call(port, `/api/payment-intents/${intent.id}/evidence`);
  assert.equal(bundle.status, 200, 'evidence endpoint must be available for EXCEPTION status');
  assert.match(bundle.headers.get('content-disposition') || '', /attachment/);
  assert.equal(bundle.payload.schema, 'glp.sandbox.evidence.v1');
  assert.equal(bundle.payload.payment_intent.status, 'EXCEPTION');

  // 7. GET /verification still returns the two evidence rows.
  const verificationRows = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(verificationRows.status, 200);
  assert.ok(Array.isArray(verificationRows.payload.evidence));
  assert.equal(verificationRows.payload.evidence.length, 2, 'verification must retain two evidence rows after EXCEPTION');
});

test('BASE_PATH serving strips the prefix and injects the base into HTML', async (t) => {
  const { child, port } = await startServer({ BASE_PATH: '/green-light-pay/' });
  t.after(() => stopServer(child));
  const health = await call(port, '/green-light-pay/api/health');
  assert.equal(health.status, 200);
  const page = await fetch(`http://127.0.0.1:${port}/green-light-pay/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /href="\/green-light-pay\/styles\.css"/);
  assert.match(html, /content="\/green-light-pay"/);
  assert.ok(!html.includes('__GLP_BASE__'));
  const { intent } = await createIntent(port); // unprefixed API also works for direct dev access
  assert.match(intent.checkout_path, /^\/green-light-pay\/checkout\/\?id=/);
});
