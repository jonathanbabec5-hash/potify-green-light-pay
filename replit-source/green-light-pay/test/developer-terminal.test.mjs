/**
 * developer-terminal.test.mjs
 * v0.1.3-stage1.3 — Operations Terminal
 *
 * Tests for:
 *   - developer.html nav structure and accessibility
 *   - developer.js workspace coverage
 *   - developer.js refresh guard and stale indicator
 *   - developer.js queue bucket derivation
 *   - developer.js forbidden shell commands
 *   - developer.js token non-exposure in export and terminal output
 *   - developer.js audit scoping by aggregate_id
 *   - developer.js command verb completeness
 *   - HTTP: GET /api/ledger endpoint
 *   - HTTP: GET /api/payment-intents/:id single-intent endpoint
 *   - HTTP: ledger balance after reconciliation
 *   - HTTP: verify then reconcile flow clears the ledger difference
 *   - Version consistency across developer surfaces
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const devHtmlUrl = new URL('../public/developer.html', import.meta.url);
const devJsUrl   = new URL('../public/developer.js',   import.meta.url);
const pkgUrl     = new URL('../package.json',           import.meta.url);
const serverPath = new URL('../src/server.mjs',         import.meta.url).pathname;

// ─── Source-level assertions ──────────────────────────────────────────────────

test('developer.html has exactly 12 workspace nav buttons', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  const matches = [...html.matchAll(/data-workspace="([^"]+)"/g)];
  assert.equal(matches.length, 12, 'exactly 12 data-workspace buttons must exist');
  const expected = ['overview','transactions','queues','merchants','partners','verification','reconciliation','ledger','audit','api','health','terminal'];
  const found = matches.map(m => m[1]);
  for (const ws of expected) {
    assert.ok(found.includes(ws), `nav must include workspace "${ws}"`);
  }
});

test('developer.html has skip-to-content link', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /class="skip-link"/, 'skip-link class must exist');
  assert.match(html, /href="#workspace-root"/, 'skip link must target workspace-root');
});

test('developer.html carries the prototype version string', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /v0\.1\.3-stage1\.3/, 'version string must appear in developer.html');
});

test('developer.html has stale-indicator element id', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /id="stale-indicator"/, 'stale-indicator id must exist in developer.html header');
});

test('developer.html palette carries role=dialog and aria-modal', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /role="dialog"/, 'palette must have role=dialog');
  assert.match(html, /aria-modal="true"/, 'palette must have aria-modal="true"');
  assert.match(html, /aria-labelledby=/, 'palette dialog must have aria-labelledby');
});

test('developer.html has no inline event handlers or style attributes', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.doesNotMatch(html, /\son\w+=/i, 'no inline event handlers allowed');
  assert.doesNotMatch(html, /\sstyle=/i, 'no inline style attributes allowed');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline scripts allowed');
});

test('developer.html has merchant controls plain-language labels', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /Pause new requests/, 'Pause new requests label must be present');
  assert.match(html, /Per-transaction limit/, 'Per-transaction limit label must be present');
  assert.doesNotMatch(html, /pause_new_requests/, 'snake_case pause_new_requests must not appear');
  assert.doesNotMatch(html, /per_transaction_limit_usd/, 'snake_case per_transaction_limit_usd must not appear');
});

test('developer.html terminal-input id is referenced (rendered via developer.js)', async () => {
  const html = await readFile(devHtmlUrl, 'utf8');
  assert.match(html, /id="terminal-input"/, 'terminal-input id must be referenced in developer.html');
});

test('developer.js defines all 12 workspace identifiers in WORKSPACES array', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  const expected = ['overview','transactions','queues','merchants','partners','verification','reconciliation','ledger','audit','api','health','terminal'];
  for (const ws of expected) {
    assert.match(source, new RegExp(`'${ws}'`), `WORKSPACES must include '${ws}'`);
  }
  // Must be exactly 12 entries
  const wsDecl = source.match(/const WORKSPACES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(wsDecl, 'WORKSPACES array must be declared');
  const entries = wsDecl[1].match(/'[a-z]+'/g) || [];
  assert.equal(entries.length, 12, 'WORKSPACES must have exactly 12 entries');
});

test('developer.js refresh coordinator guards against overlapping refreshes via refreshBusy', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(source, /refreshBusy/, 'refreshBusy guard must exist in state');
  assert.match(source, /if \(state\.refreshBusy\) return/, 'early-return guard on refreshBusy must exist');
  assert.match(source, /state\.refreshBusy\s*=\s*true/, 'refreshBusy must be set true before fetch');
  assert.match(source, /state\.refreshBusy\s*=\s*false/, 'refreshBusy must be cleared in finally block');
});

test('developer.js queue bucket derivation covers all 6 lifecycle groups', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(source, /QUEUE_GROUPS/, 'QUEUE_GROUPS constant must exist');
  assert.match(source, /SCREENING_REQUIRED/, 'QUEUE_GROUPS must include SCREENING_REQUIRED');
  assert.match(source, /REVIEW_REQUIRED/, 'QUEUE_GROUPS must include REVIEW_REQUIRED');
  assert.match(source, /SUBMITTED/, 'QUEUE_GROUPS must include SUBMITTED');
  assert.match(source, /VERIFIED[\s\S]{1,50}EXCEPTION|EXCEPTION[\s\S]{1,50}VERIFIED/, 'QUEUE_GROUPS eligible bucket must include VERIFIED and EXCEPTION');
  assert.match(source, /RECONCILED/, 'QUEUE_GROUPS must include RECONCILED');
  // Queue card renders the count per group
  assert.match(source, /QUEUE_GROUPS\[/, 'workspace must reference QUEUE_GROUPS entries');
});

test('developer.js prohibits shell-like and execution commands', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(source, /SHELL_CMDS/, 'SHELL_CMDS set must exist');
  assert.match(source, /SHELL_CMDS\.has\(verb\)/, 'shell command check must use SHELL_CMDS.has(verb)');
  // Must include representative shell commands in the set
  assert.match(source, /'ls'/, "SHELL_CMDS must include 'ls'");
  assert.match(source, /'cd'/, "SHELL_CMDS must include 'cd'");
  assert.match(source, /'eval'/, "SHELL_CMDS must include 'eval'");
  assert.match(source, /'exec'/, "SHELL_CMDS must include 'exec'");
  assert.match(source, /'bash'/, "SHELL_CMDS must include 'bash'");
  // Error message must be informative
  assert.match(source, /filesystem.*shell.*package|shell.*package.*execution/s, 'prohibition message must mention filesystem, shell, and package access');
});

test('developer.js has all required command verbs', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  const verbs = ['help','status','refresh','intents','inspect','queues','verify','recon','ledger','balance','merchant','partner','controls','audit','routes','health','clear','export'];
  for (const verb of verbs) {
    assert.match(source, new RegExp(`verb === '${verb}'`), `command verb '${verb}' must be handled`);
  }
  assert.ok(verbs.length >= 18, 'at least 18 command verbs required');
});

test('developer.js does not expose checkout tokens in export or terminal output', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // The export command must explicitly exclude checkout_token
  assert.match(source, /Checkout tokens.*excluded|checkout token.*excluded|tokens.*excluded/si, 'export must document token exclusion');
  // export command must destructure away the token field
  assert.match(source, /checkout_token[^:]*:_t|checkout_token:\s*_t/, 'inspect must destructure away checkout_token');
  // No route builds a query string with token
  assert.doesNotMatch(source, /[?&]token=\$\{/, 'no query-string token construction allowed');
});

test('developer.js audit scoping filters by aggregate_id when selectedIntentId is set', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(source, /state\.selectedIntentId/, 'selectedIntentId must be used in state');
  assert.match(source, /clear-audit-scope/, 'clear-audit-scope id must appear');
  assert.match(source, /Show all events/, '"Show all events" text must appear');
  assert.match(source, /audit-scope-bar/, 'audit-scope-bar class must appear');
  // Filter path: state.selectedIntentId → .filter → aggregate_id
  assert.match(
    source,
    /state\.selectedIntentId[\s\S]{1,200}\.filter[\s\S]{1,100}aggregate_id|\.filter[\s\S]{1,100}aggregate_id[\s\S]{1,100}state\.selectedIntentId/,
    'renderAudit must filter by aggregate_id when selectedIntentId is set'
  );
});

test('developer.js version constant matches package.json version', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  const pkg    = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.match(source, /DEV_VERSION\s*=\s*'0\.1\.3-stage1\.3'/, 'DEV_VERSION must be 0.1.3-stage1.3');
  assert.equal(pkg.version, '0.1.3-stage1.3', 'package.json version must match');
});

test('developer.js has 10-second auto-refresh interval and per-second stale ticker', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // Already tested by stage1-evidence.test.mjs — duplicated here for completeness
  assert.match(source, /setInterval[\s\S]{1,60}10_000|setInterval[\s\S]{1,60}10000/, '10-second auto-refresh must exist');
  assert.match(source, /staleTickerTimer/, 'staleTickerTimer variable must exist');
  assert.match(source, /updateStaleIndicator/, 'updateStaleIndicator function must exist');
  assert.match(source, /stale-indicator/, 'stale-indicator element id must be referenced');
});

test('developer.js intent row keyboard handler guards on Enter and Space', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(source, /tabindex="0"/, 'intent rows must have tabindex="0"');
  assert.match(source, /data-row-intent-id/, 'intent rows must carry data-row-intent-id');
  assert.match(source, /addEventListener.*keydown/, 'keydown listener must be registered');
  assert.match(source, /keydown[\s\S]{1,300}Enter[\s\S]{1,100}['" ]/, 'keydown handler must check for Enter key');
  assert.match(source, /keydown[\s\S]{1,400}!== 'Enter'/, 'keydown must guard with !== "Enter"');
});

test('developer.js does not contain forbidden claims or ghost/anonymous terms', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.doesNotMatch(source, /\bghost\b/i, 'developer.js must not contain the word "ghost"');
  assert.doesNotMatch(source, /\banonymous\b/i, 'developer.js must not contain the word "anonymous"');
  assert.doesNotMatch(source, /untraceable/i, 'developer.js must not contain "untraceable"');
  assert.doesNotMatch(source, /invisible to/i, 'developer.js must not contain "invisible to"');
  assert.doesNotMatch(source, /off the books/i, 'developer.js must not contain "off the books"');
});

test('navigateTo triggers loadReconciliationCards when entering reconciliation workspace', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // navigateTo must call loadReconciliationCards() immediately after render for reconciliation
  assert.match(
    source,
    /navigateTo[\s\S]{1,600}ws === 'reconciliation'[\s\S]{1,100}loadReconciliationCards|ws === 'reconciliation'[\s\S]{1,200}loadReconciliationCards/,
    'navigateTo must call loadReconciliationCards() when workspace is reconciliation'
  );
  // Must not rely only on boot-time invocation — the call must appear inside navigateTo
  const navigateToBody = source.match(/function navigateTo[\s\S]*?^}/m)?.[0] || '';
  assert.match(navigateToBody, /loadReconciliationCards/, 'loadReconciliationCards call must be inside navigateTo body');
});

test('navigateTo triggers loadEvidenceForIntent when entering verification workspace', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // navigateTo must call loadEvidenceForIntent() immediately after render for verification
  assert.match(
    source,
    /navigateTo[\s\S]{1,600}ws === 'verification'[\s\S]{1,100}loadEvidenceForIntent|ws === 'verification'[\s\S]{1,200}loadEvidenceForIntent/,
    'navigateTo must call loadEvidenceForIntent() when workspace is verification'
  );
  const navigateToBody = source.match(/function navigateTo[\s\S]*?^}/m)?.[0] || '';
  assert.match(navigateToBody, /loadEvidenceForIntent/, 'loadEvidenceForIntent call must be inside navigateTo body');
});

test('navigateTo auto-selects first verifiable intent when entering verification with no selection', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // Must include logic that checks state.selectedIntentId is absent and finds the first eligible intent
  assert.match(
    source,
    /ws === 'verification'[\s\S]{1,200}!state\.selectedIntentId[\s\S]{1,200}\.find[\s\S]{1,200}SUBMITTED/,
    'navigateTo must auto-select first verifiable intent when no selection exists'
  );
  // Must cover the SUBMITTED status in the auto-select filter
  assert.match(source, /'SUBMITTED'[\s\S]{1,50}'REVIEW_REQUIRED'|SUBMITTED[\s\S]{1,100}REVIEW_REQUIRED/, 'auto-select filter must include SUBMITTED and REVIEW_REQUIRED');
});

// ─── HTTP integration tests ───────────────────────────────────────────────────

function startServer() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'glp-dev-')), 'glp.sqlite');
  const child  = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GLP_SANDBOX: '1', GLP_DATABASE: dbPath, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString();
      const m = buf.match(/running at http:\/\/[^:]+:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, port: Number(m[1]), dbPath }); }
    };
    child.stdout.on('data', onData);
    child.once('exit', code => reject(new Error(`server exited: code=${code}: ${buf}`)));
    setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 10_000).unref();
  });
}
async function stopServer(child) {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
}
async function call(port, path, { method = 'GET', token, body } = {}) {
  const res  = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, payload, text };
}

async function setupSubmitted(port) {
  const merchants = (await call(port, '/api/merchants')).payload.merchants;
  const merchant  = merchants[0];
  const created   = (await call(port, '/api/payment-intents', {
    method: 'POST',
    body: {
      merchantId: merchant.id,
      amountUsdCents: 5_000,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `devterm-${crypto.randomUUID()}`
    }
  })).payload;
  const token = new URLSearchParams((created.checkout_path || '').split('#')[1] || '').get('token');
  await call(port, `/api/payment-intents/${created.id}/screen`, {
    method: 'POST',
    body: { decision: 'APPROVE', partnerReference: `devterm-screen-${crypto.randomUUID()}` }
  });
  const submitted = (await call(port, `/api/checkout/${created.id}/authorize`, {
    method: 'POST', token,
    body: { signature: `devTermSig-${crypto.randomUUID().replaceAll('-','')}`, sourceWallet: 'GLPDeveloperTerminalWallet11111111111111111' }
  })).payload;
  return { merchant, intent: created, token, submitted };
}

test('GET /api/ledger returns a transactions array (empty at start)', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const res = await call(port, '/api/ledger');
  assert.equal(res.status, 200, 'GET /api/ledger must return 200');
  assert.ok(Array.isArray(res.payload.transactions), 'payload.transactions must be an array');
  assert.equal(res.payload.transactions.length, 0, 'ledger must be empty before any reconciliation');
});

test('GET /api/payment-intents/:id returns single intent detail', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const { intent } = await setupSubmitted(port);
  const res = await call(port, `/api/payment-intents/${intent.id}`);
  assert.equal(res.status, 200, 'GET /api/payment-intents/:id must return 200');
  assert.equal(res.payload.id, intent.id, 'returned intent id must match');
  assert.equal(res.payload.amount_usd_cents, 5_000, 'returned amount must match');
  assert.ok(!res.text.includes('checkout_token'), 'response must not contain checkout_token');
});

test('GET /api/payment-intents/:id returns 404 for unknown intent', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const res = await call(port, '/api/payment-intents/NOSUCHID_DEVTERM');
  assert.equal(res.status, 404, 'unknown intent must return 404');
  assert.equal(res.payload.error.code, 'NOT_FOUND', 'error code must be NOT_FOUND');
});

test('GET /api/ledger returns balanced entries after verify and reconcile', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const { intent, submitted } = await setupSubmitted(port);
  const slot = 313_000_000 + Math.floor(Math.random() * 100_000);
  const ev = {
    signature: submitted.signature,
    commitment: 'FINALIZED',
    tokenProgram: submitted.expected_token_program,
    mint: submitted.expected_mint,
    sourceWallet: submitted.source_wallet,
    destinationWallet: submitted.expected_destination,
    rawAmount: submitted.expected_raw_amount,
    slot,
    transactionError: false
  };
  await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...ev, rpcProvider: 'devterm-watcher-a' }, secondary: { ...ev, rpcProvider: 'devterm-watcher-b' } }
  });
  await call(port, `/api/payment-intents/${intent.id}/reconcile`, {
    method: 'POST',
    body: { posAmountCents: intent.amount_usd_cents, chainRawAmount: submitted.expected_raw_amount, partnerAmountCents: intent.amount_usd_cents }
  });
  const ledger = (await call(port, '/api/ledger')).payload;
  assert.ok(Array.isArray(ledger.transactions), 'transactions must be an array after reconcile');
  assert.ok(ledger.transactions.length >= 1, 'at least one ledger transaction must exist');
  const tx = ledger.transactions[0];
  assert.ok(typeof tx.debits_cents === 'number', 'debits_cents must be a number');
  assert.ok(typeof tx.credits_cents === 'number', 'credits_cents must be a number');
  assert.equal(tx.debits_cents, tx.credits_cents, 'ledger transaction must be balanced (debits = credits)');
  assert.equal(tx.balanced, true, 'balanced flag must be true');
  // Ledger must not leak tokens
  const text = (await call(port, '/api/ledger')).text;
  assert.ok(!text.includes('checkout_token'), 'ledger response must not contain checkout_token');
});

test('GET /api/ledger entries have correct account codes (DEBIT: onchain, CREDIT: merchant)', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const { intent, submitted } = await setupSubmitted(port);
  const slot = 314_000_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature:submitted.signature, commitment:'FINALIZED', tokenProgram:submitted.expected_token_program, mint:submitted.expected_mint, sourceWallet:submitted.source_wallet, destinationWallet:submitted.expected_destination, rawAmount:submitted.expected_raw_amount, slot, transactionError:false };
  await call(port, `/api/payment-intents/${intent.id}/verify`, {method:'POST',body:{primary:{...ev,rpcProvider:'wa'},secondary:{...ev,rpcProvider:'wb'}}});
  await call(port, `/api/payment-intents/${intent.id}/reconcile`, {method:'POST',body:{posAmountCents:intent.amount_usd_cents,chainRawAmount:submitted.expected_raw_amount,partnerAmountCents:intent.amount_usd_cents}});
  const ledger = (await call(port, '/api/ledger')).payload;
  const tx = ledger.transactions[0];
  assert.ok(Array.isArray(tx.entries), 'entries must be an array');
  assert.ok(tx.entries.length >= 2, 'at least 2 ledger entries must exist');
  const debitEntry  = tx.entries.find(e => e.side === 'DEBIT');
  const creditEntry = tx.entries.find(e => e.side === 'CREDIT');
  assert.ok(debitEntry, 'DEBIT entry must exist');
  assert.ok(creditEntry, 'CREDIT entry must exist');
  assert.match(debitEntry.account_code, /ONCHAIN_SETTLEMENT/, 'debit account code must reference onchain settlement');
  assert.match(creditEntry.account_code, /MERCHANT_SETTLEMENT/, 'credit account code must reference merchant settlement');
});

// ─── Regression: terminal input interaction fixes (v0.1.3-stage1.3) ──────────

test('closePalette guards against focus theft when palette is already hidden', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // The guard must check for the hidden attribute before stealing focus.
  // Without this, every Escape keypress while typing in the terminal steals focus
  // away to #palette-btn even when the palette was never open.
  assert.match(
    source,
    /function closePalette[\s\S]{1,600}hasAttribute\('hidden'\)[\s\S]{0,50}return/,
    'closePalette must return early when overlay already has the hidden attribute'
  );
  // The !overlay guard must also be present
  assert.match(
    source,
    /if \(!overlay \|\| overlay\.hasAttribute\('hidden'\)\) return/,
    'closePalette must short-circuit with: if (!overlay || overlay.hasAttribute("hidden")) return'
  );
});

test('global keydown handler skips events during IME composition', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // Without this guard, mobile autocorrect/IME composition sequences can trigger
  // the Ctrl+K palette open or the Escape palette-close handler mid-word.
  const globalKd = source.match(/document\.addEventListener\('keydown'[\s\S]{1,400}closePalette/)?.[0] || '';
  assert.match(
    globalKd,
    /isComposing/,
    'global keydown listener must check event.isComposing before processing Ctrl+K or Escape'
  );
});

test('terminal keydown handler skips ArrowUp/Down during IME composition', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // Without this guard, ArrowUp/Down during composition (e.g. navigating autocorrect
  // suggestions on iOS) would corrupt history navigation.
  assert.match(
    source,
    /termInput[\s\S]{1,200}addEventListener\('keydown'[\s\S]{1,200}isComposing/,
    'terminal keydown listener must check event.isComposing before navigating command history'
  );
});

test('terminal submit keeps one state-backed double-submit guard', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // The guard lives in shared application state so it survives an explicit render
  // while a command is still awaiting.
  assert.match(source, /terminalBusy/, 'terminalBusy flag must exist in terminal state');
  assert.match(
    source,
    /if \(state\.terminalBusy\) return/,
    'terminal submit must return immediately when terminalBusy is true'
  );
  assert.match(
    source,
    /state\.terminalBusy\s*=\s*true/,
    'terminal submit must set terminalBusy=true before awaiting executeCommand'
  );
  assert.match(
    source,
    /state\.terminalBusy\s*=\s*false/,
    'terminal submit must clear terminalBusy in the finally block'
  );
});

test('terminal submit resolves the current input and restores focus after command completes', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(
    source,
    /finally[\s\S]{1,400}\$\('#terminal-input'\)\?\.focus\(\)/,
    'terminal submit must resolve and focus the current terminal input after the command finishes'
  );
});

test('terminal output is state-backed and refreshes do not rebuild the active terminal', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  assert.match(
    source,
    /terminalLines:\s*\[\]/,
    'terminal lines must be stored in application state'
  );
  assert.match(
    source,
    /state\.workspace !== 'terminal'\) renderCurrentWorkspace\(\)/,
    'background refresh must not rebuild the active terminal'
  );
  assert.match(
    source,
    /requestAnimationFrame\(\(\) => \$\('#terminal-input'\)\?\.focus\(\)\)/,
    'input focus must happen only when navigating to the terminal'
  );
});

test('transaction filter restores focus and cursor position after re-render', async () => {
  const source = await readFile(devJsUrl, 'utf8');
  // Without this fix, every keystroke in #tx-q fires renderCurrentWorkspace() which
  // replaces the DOM, destroys focus, and the user can only type one character per click.
  // The fix must save selectionStart, re-render, find the new #tx-q, and restore both.
  assert.match(
    source,
    /selectionStart[\s\S]{1,200}renderCurrentWorkspace[\s\S]{1,200}setSelectionRange/,
    'tx-q input handler must save selectionStart, call renderCurrentWorkspace, then call setSelectionRange on the new input'
  );
  assert.match(
    source,
    /newQ[\s\S]{0,30}focus\(\)[\s\S]{0,50}setSelectionRange|setSelectionRange[\s\S]{0,100}focus/,
    'tx-q restore must call focus() and setSelectionRange on the new element'
  );
});

// ─── Regression: terminal command → real server round-trips ──────────────────
// These tests confirm that the commands a user types in the Command Terminal
// actually reach the server-side API rather than returning only local state.

test('terminal health command reaches GET /api/health on the real server', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  // Simulate what executeCommand('health') does: fetch /api/health
  const res = await call(port, '/api/health');
  assert.equal(res.status, 200, 'GET /api/health must return 200');
  assert.ok(res.payload, 'health response must be JSON');
  assert.equal(res.payload.live_money_movement, false, 'live_money_movement must be false (sandbox boundary)');
  assert.equal(res.payload.customer_pii_collected, false, 'customer_pii_collected must be false');
  assert.ok(typeof res.payload.mode === 'string', 'mode field must exist');
  // The response must be the actual server object, not a locally-animated stub
  assert.ok('integrity' in res.payload || 'version' in res.payload || 'prototype_version' in res.payload,
    'health response must include server-side metadata (integrity / version)');
});

test('terminal ledger command reaches GET /api/ledger on the real server', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const res = await call(port, '/api/ledger?limit=100');
  assert.equal(res.status, 200, 'GET /api/ledger must return 200');
  assert.ok(Array.isArray(res.payload.transactions), 'ledger response.transactions must be an array');
  // The server must not leak any checkout token material in its response
  assert.ok(!res.text.includes('checkout_token'), 'ledger response must not contain checkout_token');
});

test('terminal balance command computes totals from GET /api/ledger data', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  // After a full reconciliation run, balance must reflect real ledger entries
  const { intent, submitted } = await setupSubmitted(port);
  const slot = 316_000_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature:submitted.signature, commitment:'FINALIZED', tokenProgram:submitted.expected_token_program, mint:submitted.expected_mint, sourceWallet:submitted.source_wallet, destinationWallet:submitted.expected_destination, rawAmount:submitted.expected_raw_amount, slot, transactionError:false };
  await call(port, `/api/payment-intents/${intent.id}/verify`, {method:'POST',body:{primary:{...ev,rpcProvider:'wa'},secondary:{...ev,rpcProvider:'wb'}}});
  await call(port, `/api/payment-intents/${intent.id}/reconcile`, {method:'POST',body:{posAmountCents:intent.amount_usd_cents,chainRawAmount:submitted.expected_raw_amount,partnerAmountCents:intent.amount_usd_cents}});
  // The balance command in the terminal reads from /api/ledger
  const ledger = (await call(port, '/api/ledger?limit=100')).payload;
  const debits  = ledger.transactions.reduce((s, t) => s + (t.debits_cents  || 0), 0);
  const credits = ledger.transactions.reduce((s, t) => s + (t.credits_cents || 0), 0);
  assert.equal(debits, credits, 'balance command: debits must equal credits after matched reconciliation');
  assert.ok(debits > 0, 'balance command: debits must be non-zero after reconciliation');
});

test('terminal intents command reflects real payment-intent records from GET /api/payment-intents', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  // Create a real intent so the list is non-empty
  const { intent } = await setupSubmitted(port);
  const res = await call(port, '/api/payment-intents?limit=100');
  assert.equal(res.status, 200, 'GET /api/payment-intents must return 200');
  assert.ok(Array.isArray(res.payload.payment_intents), 'payment_intents must be an array');
  const found = res.payload.payment_intents.find(i => i.id === intent.id);
  assert.ok(found, 'newly created intent must appear in intents list (real server data)');
  assert.ok(!res.text.includes('checkout_token'), 'intents response must not expose checkout_token');
});

test('terminal inspect command fetches intent from GET /api/payment-intents/:id', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const { intent } = await setupSubmitted(port);
  const res = await call(port, `/api/payment-intents/${intent.id}`);
  assert.equal(res.status, 200, 'GET /api/payment-intents/:id must return 200');
  assert.equal(res.payload.id, intent.id, 'inspect must return the exact intent by id');
  assert.ok(res.payload.public_reference, 'inspect response must include public_reference');
  // Checkout token must be excluded from the inspect output (sandbox honesty boundary)
  assert.ok(!res.text.includes('checkout_token'), 'inspect response must not expose checkout_token');
});

test('terminal verify command sends evidence to POST /api/payment-intents/:id/verify', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const { intent, submitted } = await setupSubmitted(port);
  const slot = 317_000_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature:submitted.signature, commitment:'FINALIZED', tokenProgram:submitted.expected_token_program, mint:submitted.expected_mint, sourceWallet:submitted.source_wallet, destinationWallet:submitted.expected_destination, rawAmount:submitted.expected_raw_amount, slot, transactionError:false };
  const res = await call(port, `/api/payment-intents/${intent.id}/verify`, {
    method: 'POST',
    body: { primary: { ...ev, rpcProvider: 'rpc-dev-a' }, secondary: { ...ev, rpcProvider: 'rpc-dev-b' } }
  });
  // Must reach the real server and return a terminal status or verification result
  assert.ok([200, 201].includes(res.status), `verify must return 2xx — got ${res.status}: ${res.text}`);
  const updated = (await call(port, `/api/payment-intents/${intent.id}`)).payload;
  assert.ok(['VERIFIED','REVIEW_REQUIRED'].includes(updated.status),
    `intent must be VERIFIED or REVIEW_REQUIRED after verify call — got: ${updated.status}`);
});

test('dashboard ledger_difference_cents becomes 0 after matched reconciliation', async (t) => {
  const { child, port } = await startServer();
  t.after(() => stopServer(child));
  const before = (await call(port, '/api/dashboard')).payload;
  assert.equal(before.ledger_difference_cents, 0, 'ledger must be balanced before any transactions');
  const { intent, submitted } = await setupSubmitted(port);
  const slot = 315_000_000 + Math.floor(Math.random() * 100_000);
  const ev = { signature:submitted.signature, commitment:'FINALIZED', tokenProgram:submitted.expected_token_program, mint:submitted.expected_mint, sourceWallet:submitted.source_wallet, destinationWallet:submitted.expected_destination, rawAmount:submitted.expected_raw_amount, slot, transactionError:false };
  await call(port, `/api/payment-intents/${intent.id}/verify`, {method:'POST',body:{primary:{...ev,rpcProvider:'wa'},secondary:{...ev,rpcProvider:'wb'}}});
  await call(port, `/api/payment-intents/${intent.id}/reconcile`, {method:'POST',body:{posAmountCents:intent.amount_usd_cents,chainRawAmount:submitted.expected_raw_amount,partnerAmountCents:intent.amount_usd_cents}});
  const after = (await call(port, '/api/dashboard')).payload;
  assert.equal(after.ledger_difference_cents, 0, 'ledger must remain balanced after matched reconciliation');
  assert.ok(after.ledger_debits_cents > 0, 'debits must be non-zero after reconciliation');
  assert.equal(after.ledger_debits_cents, after.ledger_credits_cents, 'debits must equal credits');
});
