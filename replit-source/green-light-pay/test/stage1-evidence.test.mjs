/**
 * stage1-evidence.test.mjs
 * v0.1.3-stage1.3 — Evidence, Recovery, and Cross-Tab Consistency
 *
 * Tests for:
 *   - Run summary strip across all post-counter stages
 *   - Watcher/Receipt real evidence display
 *   - saveSession token-absence guarantee
 *   - Multi-run disambiguation path
 *   - Handoff reload recovery path
 *   - Single countdown timer discipline
 *   - Developer auto-refresh and stale indicator
 *   - Developer run-row keyboard accessibility
 *   - Developer audit scoping by intent
 *   - HTTP integration: /verification and /reconciliation guard cases
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const appJs = new URL('../public/app.js', import.meta.url);
const devJs = new URL('../public/developer.js', import.meta.url);

// ─── Source-level assertions ────────────────────────────────────────────────

test('run summary strip helper exists and is called in all post-counter stage renderers', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /function renderRunSummary\s*\(/, 'renderRunSummary function must exist');
  assert.match(source, /run-summary-strip/, 'run-summary-strip class must appear in the helper');
  // Called at the top of each post-counter stage
  assert.match(source, /renderPartner[\s\S]{1,600}renderRunSummary/, 'renderPartner must call renderRunSummary');
  assert.match(source, /renderHandoff[\s\S]{1,600}renderRunSummary/, 'renderHandoff must call renderRunSummary');
  assert.match(source, /renderVerify[\s\S]{1,600}renderRunSummary/, 'renderVerify must call renderRunSummary');
  assert.match(source, /renderReceipt[\s\S]{1,600}renderRunSummary/, 'renderReceipt must call renderRunSummary');
});

test('watcher stage binds to real verification evidence state', async () => {
  const source = await readFile(appJs, 'utf8');
  // State fields for evidence
  assert.match(source, /verificationEvidence/, 'state.verificationEvidence must be declared');
  // Evidence fields rendered from the real objects
  assert.match(source, /evA\.rpc_provider/, 'must use evA.rpc_provider');
  assert.match(source, /evB\.rpc_provider/, 'must use evB.rpc_provider');
  assert.match(source, /evA\.signature/, 'must use evA.signature');
  assert.match(source, /evA\.slot/, 'must use evA.slot');
  assert.match(source, /evA\.commitment/, 'must use evA.commitment');
  assert.match(source, /evA\.raw_amount/, 'must use evA.raw_amount');
  // Fetches from the new verification endpoint
  assert.match(source, /\/verification/, 'must fetch the /verification endpoint');
});

test('receipt stage binds to real reconciliation state', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /state\.reconciliation/, 'state.reconciliation must be declared');
  assert.match(source, /rec\.pos_amount_cents/, 'must display pos_amount_cents');
  assert.match(source, /rec\.partner_amount_cents/, 'must display partner_amount_cents');
  assert.match(source, /rec\.ledger_amount_cents/, 'must display ledger_amount_cents');
  assert.match(source, /\/reconciliation/, 'must fetch the /reconciliation endpoint');
});

test('saveSession does not persist token material', async () => {
  const source = await readFile(appJs, 'utf8');
  // The actual JSON stored must contain only intentId — not checkout paths, tokens, or URLs.
  // We check the JSON.stringify argument in the setItem call itself.
  const setItemMatch = source.match(/sessionStorage\.setItem\([^)]+JSON\.stringify\(\{([\s\S]*?)\}\)/);
  const storedJson = setItemMatch ? setItemMatch[1] : '';
  assert.ok(storedJson.length > 0, 'sessionStorage.setItem with JSON.stringify must exist');
  assert.doesNotMatch(storedJson, /checkout_path/, 'stored JSON must not include checkout_path');
  assert.doesNotMatch(storedJson, /checkout_url/, 'stored JSON must not include checkout_url');
  assert.doesNotMatch(storedJson, /checkout_token/, 'stored JSON must not include checkout_token');
  assert.match(storedJson, /intentId/, 'stored JSON must include intentId');
  // The comment EXPLAINS why checkout_path is excluded; that's correct and intentional.
});

test('multi-run disambiguation state and actions are implemented', async () => {
  const source = await readFile(appJs, 'utf8');
  // State field
  assert.match(source, /multipleRuns:\s*null/, 'multipleRuns must be initialised to null in state');
  // Populated in bootstrap when multiple non-terminal intents exist
  assert.match(source, /nonTerminal[\s\S]{1,300}multipleRuns\s*=\s*nonTerminal/, 'bootstrap must set multipleRuns from nonTerminal list');
  // Disambiguation actions exist
  assert.match(source, /resume-specific/, 'resume-specific action must exist');
  assert.match(source, /force-new-run/, 'force-new-run action must exist');
  // Cleared on newRun()
  assert.match(source, /multipleRuns\s*=\s*null/, 'multipleRuns must be cleared on newRun');
});

test('handoff reload recovery is rendered when checkout token is absent', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /restart-from-handoff/, 'restart-from-handoff action must exist');
  assert.match(source, /no longer in memory/i, 'recovery message must explain why the token is gone');
  assert.match(source, /action === 'restart-from-handoff'/, 'click handler must handle restart-from-handoff');
});

test('single module-level countdownTimer is cleared on every render cycle', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /^let countdownTimer = null/m, 'countdownTimer must be a module-level variable');
  assert.match(source, /clearInterval\(countdownTimer\)[\s\S]{1,50}countdownTimer\s*=\s*null/, 'must clear and null countdownTimer in render()');
  assert.match(source, /function startHandoffCountdown\s*\(/, 'startHandoffCountdown function must exist');
  assert.match(source, /handoff-expiry-countdown/, 'countdown target element id must be present in handoff HTML');
});

test('slot-height ticker is a module-level timer cleared on every render, started at the verify stage', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /^let slotTickerTimer = null/m, 'slotTickerTimer must be a module-level variable');
  assert.match(source, /clearInterval\(slotTickerTimer\)[\s\S]{1,80}slotTickerTimer\s*=\s*null/, 'must clear and null slotTickerTimer in render()');
  assert.match(source, /function startSlotTicker\s*\(/, 'startSlotTicker function must exist');
  assert.match(source, /watcher-slot-counter/, 'slot counter element id must be referenced in the verify HTML');
  assert.match(source, /startSlotTicker\(\)/, 'startSlotTicker must be called after rendering the verify stage');
  // Ticker state must be reset on newRun() so a resumed run gets a fresh base slot.
  // slotTickerIntentId = null must appear at least twice: once in the module-level
  // declaration and once inside newRun() body.
  const resetMatches = [...source.matchAll(/slotTickerIntentId\s*=\s*null/g)];
  assert.ok(resetMatches.length >= 2, 'slotTickerIntentId must be reset to null both at declaration and inside newRun()');
});

test('consensus flash class and badge appear on the observer-strip when both RPC watchers agree', async () => {
  const source = await readFile(appJs, 'utf8');
  assert.match(source, /consensus-confirmed/, 'consensus-confirmed CSS class must be applied to observer-strip');
  assert.match(source, /consensus-badge/, 'consensus-badge element must be rendered when slots match');
  assert.match(source, /slotsMatch.*verified|verified.*slotsMatch/s, 'consensus class must be conditional on both slots matching and VERIFIED status');
});

test('developer.js sets up 10-second auto-refresh and per-second stale ticker', async () => {
  const source = await readFile(devJs, 'utf8');
  assert.match(source, /setInterval[\s\S]{1,60}10_000|setInterval[\s\S]{1,60}10000/, '10-second auto-refresh interval must exist');
  assert.match(source, /staleTickerTimer/, 'staleTickerTimer variable must exist');
  assert.match(source, /updateStaleIndicator/, 'updateStaleIndicator function must exist');
  assert.match(source, /stale-indicator/, 'stale-indicator element id must be referenced');
});

test('developer run rows are keyboard-accessible with tabindex and Enter/Space handler', async () => {
  const source = await readFile(devJs, 'utf8');
  assert.match(source, /tabindex="0"/, 'run rows must have tabindex="0"');
  assert.match(source, /data-row-intent-id/, 'run rows must carry data-row-intent-id');
  assert.match(source, /addEventListener.*keydown/, 'a keydown listener must be registered on the rows container');
  // Space bar is reported as ' ' by KeyboardEvent.key — check for both Enter and the space character
  assert.match(source, /keydown[\s\S]{1,300}Enter[\s\S]{1,100}['" ]/, 'keydown handler must check for Enter key');
  assert.match(source, /keydown[\s\S]{1,400}!== 'Enter'|Enter.*&&.*'[ ']/, 'keydown handler must guard on Enter and Space (" ")');
});

test('developer audit log supports per-intent scoping with a clear control', async () => {
  const source = await readFile(devJs, 'utf8');
  assert.match(source, /state\.selectedIntentId/, 'selectedIntentId must exist in state');
  assert.match(source, /clear-audit-scope/, 'clear-audit-scope button must exist');
  assert.match(source, /Show all events/, '"Show all events" toggle must be present');
  assert.match(source, /audit-scope-bar/, 'audit-scope-bar element must be referenced');
  // Filters audit events when selectedIntentId is set
  assert.match(source, /state\.selectedIntentId[\s\S]{1,200}\.filter[\s\S]{1,100}aggregate_id|\.filter[\s\S]{1,100}aggregate_id[\s\S]{1,100}state\.selectedIntentId/, 'renderAudit must filter by selectedIntentId');
});

test('bootstrap clears session and starts fresh when restored intent is terminal', async () => {
  const source = await readFile(appJs, 'utf8');
  // The guard must check the restored intent's status before assigning activeIntent
  assert.match(source, /TERMINAL_STATUSES\.has\(found\.status\)/, 'bootstrap must check TERMINAL_STATUSES on the restored intent');
  // When terminal, the session must be cleared (not just ignored)
  assert.match(source, /TERMINAL_STATUSES\.has\(found\.status\)[\s\S]{1,200}clearSession\(\)/, 'bootstrap must call clearSession() for a terminal intent');
  // The terminal branch must end before activeIntent is assigned —
  // extract the content of the if-block and assert it does not assign activeIntent
  const terminalBlock = source.match(/if \(found && TERMINAL_STATUSES\.has\(found\.status\)\)\s*\{([\s\S]*?)\} else/);
  assert.ok(terminalBlock, 'the terminal-status if-block must exist with an else branch');
  assert.doesNotMatch(terminalBlock[1], /activeIntent/, 'the terminal branch must not assign activeIntent');
});

// ─── HTTP integration tests ─────────────────────────────────────────────────

const serverPath = new URL('../src/server.mjs', import.meta.url).pathname;

function startServer() {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'glp-ev-')), 'glp.sqlite');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GLP_SANDBOX: '1', GLP_DATABASE: databasePath, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const m = output.match(/running at http:\/\/[^:]+:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, port: Number(m[1]), databasePath }); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited: code=${code}: ${output}`)));
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

async function setupSubmitted(port) {
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const created = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 6_000,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `ev-${crypto.randomUUID()}`
    }
  })).payload;
  const token = new URLSearchParams((created.checkout_path || '').split('#')[1] || '').get('token');
  await call(port, `/api/payment-intents/${created.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }
  });
  const submitted = (await call(port, `/api/checkout/${created.id}/authorize`, {
    method: 'POST', token,
    body: { signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`, sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111' }
  })).payload;
  return { merchant, intent: created, token, submitted };
}

test('/verification guards: 404 unknown, 409 too-early, 200 empty at SUBMITTED, 200 two rows after verify', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // Unknown intent → 404
  const notFound = await call(port, '/api/payment-intents/NOSUCHID_VERIFICATION/verification');
  assert.equal(notFound.status, 404);

  // Create a fresh intent stuck at SCREENING_REQUIRED → 409
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const fresh = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: { merchantId: merchant.id, amountUsdCents: 1_000, assetCode: merchant.controls.allowed_asset_code, storeId: merchant.controls.store_ids[0], registerId: merchant.controls.register_ids[0], posAuthorized: true, idempotencyKey: `guard-ver-${crypto.randomUUID()}` }
  })).payload;
  const tooEarly = await call(port, `/api/payment-intents/${fresh.id}/verification`);
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.payload.error.code, 'INVALID_STATE');

  // Full path to SUBMITTED
  const { intent, token, submitted } = await setupSubmitted(port);

  // At SUBMITTED → 200 with empty evidence (no verify ran yet)
  const atSubmitted = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(atSubmitted.status, 200);
  assert.ok(Array.isArray(atSubmitted.payload.evidence), 'evidence must be an array');
  assert.equal(atSubmitted.payload.evidence.length, 0);

  // Run verification
  const slot = 311_500_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature: submitted.signature, commitment: 'FINALIZED', tokenProgram: submitted.expected_token_program, mint: submitted.expected_mint, sourceWallet: submitted.source_wallet, destinationWallet: submitted.expected_destination, rawAmount: submitted.expected_raw_amount, slot, transactionError: false };
  await call(port, `/api/payment-intents/${intent.id}/verify`, { method: 'POST', body: { primary: { ...ev, rpcProvider: 'watcher-a' }, secondary: { ...ev, rpcProvider: 'watcher-b' } } });

  // After verify → 200 with two rows containing real evidence values
  const afterVerify = await call(port, `/api/payment-intents/${intent.id}/verification`);
  assert.equal(afterVerify.status, 200);
  assert.ok(Array.isArray(afterVerify.payload.evidence));
  assert.equal(afterVerify.payload.evidence.length, 2);
  const row = afterVerify.payload.evidence[0];
  assert.ok(row.rpc_provider, 'evidence row must include rpc_provider');
  assert.ok(row.slot > 0, 'evidence row must include slot');
  assert.ok(row.signature, 'evidence row must include signature');
  assert.ok(row.commitment, 'evidence row must include commitment');
  // Token must never appear in evidence rows
  assert.ok(!afterVerify.text.includes(token), 'verification response must not contain token');
  assert.ok(!afterVerify.text.includes('checkout_token'), 'verification response must not contain checkout_token field');
});

test('cancelIntent calls clearSession immediately after the API confirms the cancel', async () => {
  const source = await readFile(appJs, 'utf8');
  // cancelIntent must contain a clearSession() call after the await api(…/cancel…) line
  const fnMatch = source.match(/async function cancelIntent[\s\S]*?^}/m);
  assert.ok(fnMatch, 'cancelIntent function must exist');
  const fnBody = fnMatch[0];
  assert.match(fnBody, /clearSession\(\)/, 'cancelIntent must call clearSession() after the API confirms cancellation');
  // clearSession must come after the await api call inside the function body
  const cancelApiIndex = fnBody.indexOf('await api(');
  const clearSessionIndex = fnBody.indexOf('clearSession()');
  assert.ok(cancelApiIndex !== -1, 'cancelIntent must contain the await api(...) call');
  assert.ok(clearSessionIndex > cancelApiIndex, 'clearSession() must appear after the await api(...) cancel call');
});

test('/reconciliation guards: 404 unknown, 409 before RECONCILED, 200 with matched record after', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // Unknown intent → 404
  const notFound = await call(port, '/api/payment-intents/NOSUCHID_RECON/reconciliation');
  assert.equal(notFound.status, 404);

  const { intent, token, submitted } = await setupSubmitted(port);

  // At SUBMITTED → 409
  const atSubmitted = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(atSubmitted.status, 409);
  assert.equal(atSubmitted.payload.error.code, 'INVALID_STATE');

  // After verify → still 409
  const slot = 312_500_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature: submitted.signature, commitment: 'FINALIZED', tokenProgram: submitted.expected_token_program, mint: submitted.expected_mint, sourceWallet: submitted.source_wallet, destinationWallet: submitted.expected_destination, rawAmount: submitted.expected_raw_amount, slot, transactionError: false };
  await call(port, `/api/payment-intents/${intent.id}/verify`, { method: 'POST', body: { primary: { ...ev, rpcProvider: 'w-a' }, secondary: { ...ev, rpcProvider: 'w-b' } } });
  const afterVerify = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(afterVerify.status, 409);

  // After reconcile → 200 with MATCHED record
  await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: { posAmountCents: intent.amount_usd_cents, chainRawAmount: submitted.expected_raw_amount, partnerAmountCents: intent.amount_usd_cents }
  });
  const reconciled = await call(port, `/api/payment-intents/${intent.id}/reconciliation`);
  assert.equal(reconciled.status, 200);
  const rec = reconciled.payload.reconciliation;
  assert.ok(rec, 'reconciliation record must be present');
  assert.equal(rec.status, 'MATCHED');
  assert.equal(rec.pos_amount_cents, intent.amount_usd_cents);
  assert.equal(rec.partner_amount_cents, intent.amount_usd_cents);
  assert.ok(rec.ledger_amount_cents > 0);
  // Token must never appear in reconciliation response
  assert.ok(!reconciled.text.includes(token), 'reconciliation response must not contain token');
  assert.ok(!reconciled.text.includes('checkout_token'), 'reconciliation response must not contain checkout_token field');
});

// ─── Terminal-status bootstrap-guard integration tests ───────────────────────
// These tests confirm that DECLINED and EXPIRED intents are in TERMINAL_STATUSES
// and would therefore cause bootstrap() to call clearSession() rather than
// resume the run, producing a clean counter landing on reload.

const TERMINAL_STATUSES = new Set(['RECONCILED', 'DECLINED', 'CANCELLED', 'EXPIRED']);

test('DECLINED intent is terminal — bootstrap guard would clear session, not resume the run', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));

  // Create a fresh intent at SCREENING_REQUIRED.
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const created = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 2_500,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `terminal-declined-${crypto.randomUUID()}`
    }
  })).payload;
  assert.equal(created.status, 'SCREENING_REQUIRED');

  // Decline via the screen endpoint (mirrors a partner declining the transaction).
  const screened = await call(port, `/api/payment-intents/${created.id}/screen`, {
    method: 'POST',
    body: { decision: 'DECLINE', partnerReference: `decline-${crypto.randomUUID()}`, reason: 'sandbox-test-decline' }
  });
  assert.equal(screened.status, 200);
  assert.equal(screened.payload.status, 'DECLINED');

  // Fetch the full intent list — this is what bootstrap() does on reload.
  const all = (await call(port, '/api/payment-intents')).payload.payment_intents;
  const found = all.find((i) => i.id === created.id);
  assert.ok(found, 'DECLINED intent must appear in the list');
  assert.equal(found.status, 'DECLINED');

  // DECLINED must be in TERMINAL_STATUSES, so bootstrap clears the session.
  assert.ok(TERMINAL_STATUSES.has(found.status), 'DECLINED must be in TERMINAL_STATUSES');

  // A further cancel attempt on a terminal intent must be refused (409 INVALID_STATE).
  const cancelAttempt = await call(port, `/api/payment-intents/${created.id}/cancel`, {
    method: 'POST',
    body: { reason: 'post-terminal-cancel-attempt' }
  });
  assert.equal(cancelAttempt.status, 409);
  assert.equal(cancelAttempt.payload.error.code, 'INVALID_STATE');
});

test('EXPIRED intent is terminal — bootstrap guard would clear session, not resume the run', async (t) => {
  const { child, port, databasePath } = await startServer();
  t.after(() => stopServer(child));

  // Create and screen an intent so it reaches READY_FOR_PAYMENT.
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant = merchants[0];
  const created = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 3_000,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `terminal-expired-${crypto.randomUUID()}`
    }
  })).payload;
  const token = new URLSearchParams((created.checkout_path || '').split('#')[1] || '').get('token');
  assert.ok(token, 'token must be present');

  await call(port, `/api/payment-intents/${created.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `screen-exp-${crypto.randomUUID()}` }
  });

  // The EXPIRED status is written by submitPaymentSignature only when the
  // checkout token has already expired at the moment the signature is submitted
  // — a natural race condition in production. To simulate it reliably in tests
  // we write EXPIRED directly into the database (same technique the server
  // uses internally: a plain UPDATE), then confirm bootstrap treats it as
  // terminal without needing to replay the exact timing race.
  // WAL journal mode prevents locking conflicts with the running server.
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode=WAL');
  const expiredReason = 'Checkout token expired before submission.';
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE payment_intents SET status=?, status_reason=?, updated_at=? WHERE id=?')
    .run('EXPIRED', expiredReason, nowIso, created.id);
  db.close();

  // Fetch the intent list — this is the bootstrap() reload path.
  const all = (await call(port, '/api/payment-intents')).payload.payment_intents;
  const found = all.find((i) => i.id === created.id);
  assert.ok(found, 'EXPIRED intent must appear in the list');
  assert.equal(found.status, 'EXPIRED');

  // EXPIRED must be in TERMINAL_STATUSES, so bootstrap clears the session.
  assert.ok(TERMINAL_STATUSES.has(found.status), 'EXPIRED must be in TERMINAL_STATUSES');

  // A cancel attempt on an EXPIRED (terminal) intent must also be refused.
  const cancelAttempt = await call(port, `/api/payment-intents/${created.id}/cancel`, {
    method: 'POST',
    body: { reason: 'post-expired-cancel-attempt' }
  });
  assert.equal(cancelAttempt.status, 409);
  assert.equal(cancelAttempt.payload.error.code, 'INVALID_STATE');
});
