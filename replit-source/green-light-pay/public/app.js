const STEP_ORDER = ['counter', 'partner', 'wallet', 'verify', 'receipt'];
const TERMINAL_STATUSES = new Set(['RECONCILED', 'DECLINED', 'CANCELLED', 'EXPIRED']);

const state = {
  dashboard: null,
  partners: [],
  merchants: [],
  intents: [],
  audit: [],
  activeIntent: null,
  resumeCandidate: null,
  multipleRuns: null,
  checkout: null,
  stage: 'counter',
  busy: false,
  pollTimer: null,
  pollBusy: false,
  pendingIdempotencyKey: null,
  celebratedIntentId: null,
  verificationEvidence: [],
  reconciliation: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const baseMeta = document.querySelector('meta[name="glp-base"]')?.getAttribute('content') || '';
const BASE = baseMeta.startsWith('__') ? '' : baseMeta;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
}

function compactMoney(cents) {
  return money(cents).replace('.00', '');
}

function shortDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value));
}

function formatAction(value) {
  return String(value || '').toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-GLP-Actor': options.actor || 'playable-sandbox',
      ...(options.headers || {})
    }
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The sandbox returned an unreadable response. No success was recorded.');
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'The sandbox request failed.');
    error.code = payload.error?.code || 'REQUEST_FAILED';
    error.details = payload.error?.details;
    throw error;
  }
  return payload;
}

let toastTimer;
let countdownTimer = null;
let slotTickerTimer = null;
let slotTickerBaseSlot = 0;
let slotTickerStartMs = 0;
let slotTickerIntentId = null;

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3900);
}

function friendlyError(error) {
  const messages = {
    MERCHANT_PAUSED: 'This merchant paused new requests. Open the developer console to restore the counter.',
    TRANSACTION_LIMIT_EXCEEDED: 'That total is above this counter\u2019s per-transaction limit.',
    DAILY_LIMIT_EXCEEDED: 'This sandbox merchant reached its daily request limit.',
    POS_AUTHORIZATION_REQUIRED: 'The POS must finish its own sale checks before Green Light Pay can begin.',
    PAYMENT_INTENT_EXPIRED: 'The one-time handoff expired. Restart the run to create a fresh request.',
    CHECKOUT_NOT_READY: 'The customer handoff is not ready yet.',
    CHECKOUT_NOT_FOUND: 'The one-time handoff is invalid or no longer available.',
    INVALID_STATE: 'That move is not allowed from the current payment state.',
    DATA_MINIMIZATION_VIOLATION: 'Green Light Pay rejected customer, medical, or product data at the boundary.'
  };
  return messages[error.code] || error.message || 'The action could not be completed. No success was recorded.';
}

function saveSession() {
  try {
    // checkout_path is intentionally not persisted: it carries the plaintext
    // fragment token, which must never be written to any storage. The operator
    // must issue a fresh handoff (rotate) if the session is resumed after a reload.
    sessionStorage.setItem('glp-v011-run', JSON.stringify({
      intentId: state.activeIntent?.id || null
    }));
  } catch {
    // The run still works if private browsing blocks session storage.
  }
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem('glp-v011-run') || 'null');
  } catch {
    return null;
  }
}

function clearSession() {
  try { sessionStorage.removeItem('glp-v011-run'); } catch { /* no-op */ }
}

function activeMerchant() {
  return state.merchants.find((merchant) => merchant.status === 'ACTIVE') || state.merchants[0];
}

function assignedPartner() {
  const merchant = activeMerchant();
  return state.partners.find((partner) => partner.id === merchant?.partner_id) || state.partners[0];
}

function stageForStatus(status) {
  if (status === 'SCREENING_REQUIRED' || status === 'REVIEW_REQUIRED') return 'partner';
  if (status === 'READY_FOR_PAYMENT') return 'wallet';
  if (status === 'SUBMITTED' || status === 'VERIFIED' || status === 'EXCEPTION') return 'verify';
  if (status === 'RECONCILED') return 'receipt';
  return 'counter';
}

function setStageFromIntent() {
  state.stage = state.activeIntent ? stageForStatus(state.activeIntent.status) : 'counter';
}

async function bootstrap() {
  const [dashboard, partners, merchants, intents, audit] = await Promise.all([
    api('/api/dashboard'),
    api('/api/partners'),
    api('/api/merchants'),
    api('/api/payment-intents?limit=100'),
    api('/api/audit?limit=80')
  ]);
  state.dashboard = dashboard;
  state.partners = partners.partners;
  state.merchants = merchants.merchants;
  state.intents = intents.payment_intents;
  state.audit = audit.events;

  const saved = readSession();
  if (saved?.intentId) {
    const found = state.intents.find((intent) => intent.id === saved.intentId) || null;
    if (found && TERMINAL_STATUSES.has(found.status)) {
      // The saved intent reached a terminal state. Discard it so the user lands
      // at a clean counter with no stale session from the completed/cancelled run.
      clearSession();
    } else {
      state.activeIntent = found;
      // checkout is never restored from session storage (plaintext tokens are not persisted).
      // The operator must rotate to obtain a fresh handoff after a page reload.
    }
  }
  if (!state.activeIntent) {
    const nonTerminal = state.intents.filter((intent) => !TERMINAL_STATUSES.has(intent.status));
    if (nonTerminal.length > 1) {
      state.multipleRuns = nonTerminal;
    } else {
      state.resumeCandidate = nonTerminal[0] || null;
    }
  }
  setStageFromIntent();

  // Restore verification evidence and reconciliation when resuming a run
  if (state.activeIntent) {
    const activeStatus = state.activeIntent.status;
    if (['SUBMITTED', 'VERIFIED', 'EXCEPTION', 'RECONCILED'].includes(activeStatus)) {
      try {
        const evResult = await api(`/api/payment-intents/${encodeURIComponent(state.activeIntent.id)}/verification`);
        state.verificationEvidence = evResult.evidence || [];
      } catch {
        state.verificationEvidence = [];
      }
    }
    if (activeStatus === 'RECONCILED') {
      try {
        const recResult = await api(`/api/payment-intents/${encodeURIComponent(state.activeIntent.id)}/reconciliation`);
        state.reconciliation = recResult.reconciliation || null;
      } catch {
        state.reconciliation = null;
      }
    }
  }

  render();
}

async function refreshData({ includeSystem = true } = {}) {
  const requests = [api('/api/payment-intents?limit=100'), api('/api/audit?limit=80')];
  if (includeSystem) requests.push(api('/api/dashboard'));
  const [intents, audit, dashboard] = await Promise.all(requests);
  state.intents = intents.payment_intents;
  state.audit = audit.events;
  if (dashboard) state.dashboard = dashboard;
  if (state.activeIntent) {
    state.activeIntent = state.intents.find((intent) => intent.id === state.activeIntent.id) || state.activeIntent;
  }
  setStageFromIntent();
}

function render() {
  clearPolling();
  clearInterval(countdownTimer);
  countdownTimer = null;
  clearInterval(slotTickerTimer);
  slotTickerTimer = null;
  renderHud();
  renderJourney();
  renderStageHeader();
  renderStage();
  renderRunFooter();
  renderTrace();
  $('#stage-content').setAttribute('aria-busy', String(state.busy));
  if (state.stage === 'wallet' && state.activeIntent?.status === 'READY_FOR_PAYMENT') startPolling();
  if (state.stage === 'verify' && state.activeIntent?.status === 'SUBMITTED') startVerifyPolling();
}

function renderHud() {
  const merchant = activeMerchant();
  const partner = assignedPartner();
  $('#hud-merchant').textContent = merchant?.status === 'ACTIVE' ? 'Ready' : merchant?.status || 'Unavailable';
  $('#hud-partner').textContent = partner?.status === 'APPROVED' ? 'Qualified' : partner?.status || 'Unavailable';
}

function renderJourney() {
  const currentIndex = STEP_ORDER.indexOf(state.stage);
  $$('#journey-list li').forEach((item, index) => {
    item.classList.toggle('current', index === currentIndex);
    item.classList.toggle('complete', index < currentIndex || (state.stage === 'receipt' && index === currentIndex));
    if (index === currentIndex) {
      item.setAttribute('aria-current', 'step');
    } else {
      item.removeAttribute('aria-current');
    }
  });
  const completed = state.stage === 'receipt' ? 5 : Math.max(0, currentIndex);
  $('#run-progress').textContent = `${completed} / 5`;
}

function setStageStatus(label, tone = '') {
  const status = $('#stage-status');
  status.className = `stage-status ${tone}`.trim();
  $('span', status).textContent = label;
}

function renderStageHeader() {
  const intentStatus = state.activeIntent?.status;
  const verifyLabel = intentStatus === 'VERIFIED' ? 'Verified' : intentStatus === 'EXCEPTION' ? 'Exception' : 'Observing';
  const verifyTone = intentStatus === 'VERIFIED' ? 'success' : 'review';
  const config = {
    counter: ['Level 01 · Counter', 'Initiate Green Light Pay', 'Ready', 'success'],
    partner: ['Level 02 · Green Gate', 'Open only for a qualified path', 'Partner check', 'review'],
    wallet: ['Level 03 · Customer handoff', 'Pass one exact request—not customer data', 'Awaiting signature', 'review'],
    verify: ['Level 04 · Independent watchers', 'Trust evidence, not a browser message', verifyLabel, verifyTone],
    receipt: ['Level 05 · Clear records', 'The run closes only when every record agrees', 'Reconciled', 'success']
  }[state.stage];
  $('#stage-kicker').textContent = config[0];
  $('#stage-title').textContent = config[1];
  setStageStatus(config[2], config[3]);
}

function startSlotTicker() {
  clearInterval(slotTickerTimer);
  slotTickerTimer = null;
  const ev = state.verificationEvidence;
  // If evidence is already loaded the slot is fixed in the DOM — no live ticker needed.
  if (ev?.length >= 2) return;
  const intentId = state.activeIntent?.id || null;
  if (!slotTickerStartMs || intentId !== slotTickerIntentId) {
    // Establish a stable base from the intent ID so re-renders don't jump the counter.
    const idSeed = parseInt((intentId || '').replace(/[^0-9a-f]/gi, '').slice(-6) || '0', 16);
    slotTickerBaseSlot = 311_000_000 + (idSeed % 800_000);
    slotTickerStartMs = Date.now();
    slotTickerIntentId = intentId;
  }
  function tick() {
    const el = document.getElementById('watcher-slot-counter');
    if (!el) { clearInterval(slotTickerTimer); slotTickerTimer = null; return; }
    // Solana produces ~2 slots/second; simulate that cadence.
    el.textContent = String(slotTickerBaseSlot + Math.floor((Date.now() - slotTickerStartMs) / 500));
  }
  tick();
  slotTickerTimer = setInterval(tick, 500);
}

function renderStage() {
  const container = $('#stage-content');
  if (state.stage === 'counter') container.innerHTML = renderCounter();
  if (state.stage === 'partner') container.innerHTML = renderPartner();
  if (state.stage === 'wallet') {
    container.innerHTML = renderHandoff();
    if (checkoutToken()) {
      loadQr();
    }
    startHandoffCountdown();
  }
  if (state.stage === 'verify') {
    container.innerHTML = renderVerify();
    startSlotTicker();
  }
  if (state.stage === 'receipt') {
    container.innerHTML = renderReceipt();
    celebrate();
  }
}

function renderRunSummary(intent) {
  const merchant = activeMerchant();
  return `<div class="run-summary-strip">
    <div class="rss-field rss-amount"><span>Amount</span><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(intent.asset_code)}</small></div>
    <div class="rss-field"><span>Reference</span><strong>${escapeHtml(intent.public_reference)}</strong></div>
    <div class="rss-field"><span>Merchant</span><strong>${escapeHtml(merchant?.dba || '—')}</strong></div>
  </div>`;
}

function startHandoffCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  const intent = state.activeIntent;
  if (!intent?.checkout_expires_at) return;
  function tick() {
    const el = $('#handoff-expiry-countdown');
    if (!el) { clearInterval(countdownTimer); countdownTimer = null; return; }
    const ms = new Date(intent.checkout_expires_at).getTime() - Date.now();
    if (ms <= 0) { el.textContent = 'EXPIRED'; clearInterval(countdownTimer); countdownTimer = null; return; }
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderCounter() {
  if (state.multipleRuns?.length > 1) {
    return `<div class="resume-card">
      <p class="stage-micro">Multiple open runs detected</p>
      <h3>More than one run is still active.</h3>
      <p>Choose which run to resume, or start a completely new one. Uncontinued runs will remain open until the sandbox is restarted.</p>
      <div class="resume-actions">
        ${state.multipleRuns.map((run) => `<button class="primary-action" type="button" data-action="resume-specific" data-intent-id="${escapeHtml(run.id)}">${escapeHtml(run.public_reference)} · ${compactMoney(run.amount_usd_cents)} · ${escapeHtml(formatAction(run.status))}</button>`).join('')}
        <button class="danger-action" type="button" data-action="force-new-run">Start a completely new run</button>
      </div>
    </div>`;
  }

  if (state.resumeCandidate) {
    return `<div class="resume-card">
      <p class="stage-micro">Open run detected</p>
      <h3>Pick up where the counter stopped.</h3>
      <p>The prior run is still in a controlled, nonterminal state. Resume it or cancel it and begin cleanly.</p>
      <div class="resume-meta">
        <span>${escapeHtml(state.resumeCandidate.public_reference)}</span>
        <span>${money(state.resumeCandidate.amount_usd_cents)}</span>
        <span>${escapeHtml(formatAction(state.resumeCandidate.status))}</span>
      </div>
      <div class="resume-actions">
        <button class="primary-action" type="button" data-action="resume-run">Resume the run <span class="button-arrow">→</span></button>
        <button class="danger-action" type="button" data-action="cancel-resume">Cancel and start fresh</button>
      </div>
    </div>`;
  }

  const merchant = activeMerchant();
  const partner = assignedPartner();
  if (!merchant?.controls || !partner) {
    return renderFatal('The counter is not configured.', 'A merchant, controls record, and qualified partner are required before a run can begin.');
  }
  const controls = merchant.controls;
  return `<div class="counter-stage">
    <div class="stage-copy">
      <p class="micro">COUNTER ONE · STATE-LEGAL RETAIL DEMO</p>
      <h3>The sale is ready. Start the payment.</h3>
      <p>The dispensary POS has already handled eligibility, purchase limits, products, tax, inventory, and state tracking. Green Light Pay receives only the final amount and counter authorization.</p>
      <div class="readiness-stack">
        <div class="readiness-row"><i>✓</i><strong>POS authorization</strong><span>Complete</span></div>
        <div class="readiness-row"><i>✓</i><strong>Merchant controls</strong><span>${controls.paused ? 'Paused' : 'Enforced'}</span></div>
        <div class="readiness-row"><i>✓</i><strong>Qualified partner record</strong><span>${escapeHtml(formatAction(partner.status))}</span></div>
      </div>
    </div>
    <form class="counter-console" id="counter-form">
      <div class="console-top"><span>${escapeHtml(merchant.dba)}</span><span>REGISTER 01 · SANDBOX</span></div>
      <div class="amount-panel">
        <label for="amount-usd">Final authorized total</label>
        <div class="amount-input-wrap"><span>$</span><input id="amount-usd" name="amountUsd" type="number" min="0.01" max="${(controls.per_transaction_limit_cents / 100).toFixed(2)}" step="0.01" value="42.50" inputmode="decimal" required aria-describedby="amount-note"></div>
        <div class="quick-amounts" aria-label="Demo totals">
          <button type="button" data-amount="18.50">$18.50</button>
          <button type="button" data-amount="42.50" class="selected">$42.50</button>
          <button type="button" data-amount="86.00">$86.00</button>
        </div>
        <p class="action-note" id="amount-note">Sandbox only · no real funds move here</p>
        <button class="primary-action full" type="submit">Initiate Green Light Pay <span class="button-arrow">→</span></button>
      </div>
      <div class="counter-meta"><div><span>Store</span><strong>${escapeHtml(controls.store_ids[0])}</strong></div><div><span>Finality</span><strong>${escapeHtml(formatAction(controls.required_commitment))}</strong></div></div>
    </form>
  </div>`;
}

function renderPartner() {
  const partner = assignedPartner();
  const intent = state.activeIntent;
  if (!intent || !partner) return renderFatal('No payment request is active.', 'Return to the counter and initiate a new run.');
  const review = intent.status === 'REVIEW_REQUIRED';
  return `<div class="gate-stage">
    ${renderRunSummary(intent)}
    <div class="gate-visual" id="gate-visual" aria-label="Closed qualification gate">
      <div class="gate-door left"></div><div class="gate-door right"></div>
      <div class="gate-core">${review ? 'RE-CHECK' : 'GLP'}<br>GATE</div>
    </div>
    <div class="stage-copy">
      <p class="micro">${review ? 'CONTROLLED REVIEW PATH' : 'QUALIFIED BEFORE CONNECTED'}</p>
      <h3>${review ? 'Evidence asked for another look.' : 'No partner, no green light.'}</h3>
      <p>The sandbox now asks the assigned partner fixture to screen the request. In a real regulated program, this decision and every regulated function would require specific written authority.</p>
      <div class="gate-checks">
        <div class="gate-check"><i>✓</i><div><strong>Written scope recorded</strong><span>Sandbox evidence only</span></div></div>
        <div class="gate-check"><i>✓</i><div><strong>Screening authority</strong><span>Recorded in partner gate</span></div></div>
        <div class="gate-check"><i>✓</i><div><strong>Merchant assigned</strong><span>${escapeHtml(activeMerchant()?.state || '—')} counter bound</span></div></div>
        <div class="gate-check"><i>✓</i><div><strong>Amount frozen</strong><span>${money(intent.amount_usd_cents)}</span></div></div>
      </div>
      <button class="primary-action full" type="button" data-action="open-gate">${review ? 'Approve the reviewed path' : 'Run partner check and open the gate'} <span class="button-arrow">→</span></button>
      <p class="action-note">This records a simulated partner approval. It does not represent a real provider decision.</p>
    </div>
  </div>`;
}

function renderHandoff() {
  const intent = state.activeIntent;
  if (!intent) return renderFatal('No handoff is available.', 'Return to the counter and initiate a new run.');
  const path = state.checkout?.checkout_path;
  const hasToken = Boolean(path);

  if (!hasToken) {
    return `<div class="handoff-stage">
      ${renderRunSummary(intent)}
      <div class="stage-copy">
        <p class="micro">ONE REQUEST · ONE CUSTOMER HANDOFF</p>
        <h3>The counter has done its part.</h3>
        <div class="reload-recovery">
          <p class="action-note">This session's one-time token is no longer in memory — it cannot be stored safely across a page reload. Restart the run to issue a fresh handoff.</p>
          <button class="primary-action" type="button" data-action="restart-from-handoff">Restart run and issue a new handoff</button>
        </div>
        <p class="handoff-safety">This sandbox prototype never requests a seed phrase or private key.</p>
      </div>
      <div class="handoff-card">
        <div class="handoff-card-top"><span>GREEN LIGHT HANDOFF · SANDBOX</span><span>TOKEN NOT IN MEMORY</span></div>
        <div class="handoff-card-body">
          <div class="qr-frame"><div class="qr-placeholder">TOKEN NO LONGER<br>IN MEMORY</div></div>
          <div class="handoff-amount"><span>Customer sees</span><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(intent.asset_code)} · ${escapeHtml(activeMerchant()?.dba || '')}</small></div>
        </div>
        <div class="handoff-expiry"><span>${escapeHtml(intent.public_reference)}</span><strong>Restart required</strong></div>
      </div>
    </div>`;
  }

  return `<div class="handoff-stage">
    ${renderRunSummary(intent)}
    <div class="stage-copy">
      <p class="micro">ONE REQUEST · ONE CUSTOMER HANDOFF</p>
      <h3>The counter has done its part.</h3>
      <p>The customer now receives an opaque, short-lived checkout. It carries the exact amount and destination—not their name, medical information, or basket.</p>
      <div class="handoff-actions">
        <a class="secondary-action" href="${escapeHtml(path)}" target="_blank" rel="noopener">Open customer handoff</a>
        <button class="primary-action" type="button" data-action="open-wallet">Play wallet step here</button>
      </div>
      <p class="action-note">Rotating the handoff immediately invalidates the previous one-time token. <button class="text-button" type="button" data-action="rotate-handoff">Rotate now</button></p>
      <p class="handoff-safety">This sandbox prototype never requests a seed phrase or private key.</p>
    </div>
    <div class="handoff-card">
      <div class="handoff-card-top"><span>GREEN LIGHT HANDOFF · SANDBOX</span><span>10 MINUTE TOKEN</span></div>
      <div class="handoff-card-body">
        <div class="qr-frame" id="qr-frame"><div class="qr-placeholder">LOADING QR…</div></div>
        <div class="handoff-amount"><span>Customer sees</span><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(intent.asset_code)} · ${escapeHtml(activeMerchant()?.dba || '')}</small></div>
      </div>
      <div class="handoff-expiry"><span>${escapeHtml(intent.public_reference)}</span><strong>Expires <span id="handoff-expiry-countdown">—</span></strong></div>
    </div>
  </div>`;
}

function renderVerify() {
  const intent = state.activeIntent;
  if (!intent) return renderFatal('No submitted transaction is active.', 'Return to the counter and initiate a new run.');
  const verified = intent.status === 'VERIFIED' || intent.status === 'EXCEPTION';
  const ev = state.verificationEvidence || [];
  const evA = ev[0];
  const evB = ev[1];
  // Abbreviated signature for single-observer display (evA.signature, evA.slot, evA.raw_amount)
  const sigPreview = evA ? String(evA.signature || '—').slice(0, 16) + '…' : '—';

  // Compare all trust-relevant fields between the two observers.
  const COMPARE_FIELDS = [
    { key: 'slot',               label: 'Chain slot',      fmt: (v) => escapeHtml(String(v ?? '—')) },
    { key: 'signature',          label: 'Signature',       fmt: (v) => escapeHtml((String(v || '')).slice(0, 16)) + '…' },
    { key: 'raw_amount',         label: 'Amount',          fmt: (v) => Number(v).toLocaleString() + ' raw' },
    { key: 'mint',               label: 'Asset mint',      fmt: (v) => escapeHtml((String(v || '—')).slice(0, 16)) + '…' },
    { key: 'destination_wallet', label: 'Merchant wallet', fmt: (v) => escapeHtml((String(v || '—')).slice(0, 16)) + '…' }
  ];
  const mismatchedKeys = new Set();
  if (ev.length >= 2 && evA && evB) {
    for (const { key } of COMPARE_FIELDS) {
      if (String(evA[key] ?? '') !== String(evB[key] ?? '')) mismatchedKeys.add(key);
    }
  }
  const anyMismatch = mismatchedKeys.size > 0;
  const slotsMatch = ev.length >= 2 && evA && evB && !anyMismatch;
  const consensusClass = slotsMatch && verified ? ' consensus-confirmed' : anyMismatch ? ' has-mismatch' : '';

  const nodeA = 'W-A';
  const nodeB = 'W-B';
  const nodeALabel = evA ? escapeHtml(evA.rpc_provider) : 'Observer A';
  const nodeBLabel = evB ? escapeHtml(evB.rpc_provider) : 'Observer B';

  let evidenceDisplay;
  if (ev.length >= 2 && evA && evB) {
    const fieldRows = COMPARE_FIELDS.map(({ key, label, fmt }) => {
      const differs = mismatchedKeys.has(key);
      const icon = differs ? '<i class="ev-mismatch-icon">!</i>' : '<i>✓</i>';
      const valA = fmt(evA[key]);
      const valB = fmt(evB[key]);
      const valueBlock = differs
        ? `<strong>${label}</strong><small class="ev-value-pair"><span class="ev-val-a">${valA}</span><span class="ev-val-sep">≠</span><span class="ev-val-b">${valB}</span></small>`
        : `<strong>${label}</strong><small>${valA}</small>`;
      return `<div class="${differs ? 'ev-field-mismatch' : ''}">
        ${icon}<div>${valueBlock}</div>
      </div>`;
    });
    // Add commitment (only from evA, not part of consensus comparison)
    fieldRows.splice(4, 0, `<div><i>✓</i><div><strong>Finality check</strong><small>${escapeHtml(evA.commitment)}</small></div></div>`);

    const observerStrip = anyMismatch
      ? `<div class="observer-strip has-mismatch">
          <span class="discrepancy-badge">⚠ Discrepancy detected</span>
          ${COMPARE_FIELDS.filter(f => mismatchedKeys.has(f.key)).map(f =>
            `<span class="field-mismatch-tag">${f.label}: <strong class="mismatch-val-a">${f.fmt(evA[f.key])}</strong><span class="mismatch-sep">≠</span><strong class="mismatch-val-b">${f.fmt(evB[f.key])}</strong></span>`
          ).join('')}
        </div>`
      : `<div class="observer-strip${consensusClass}">
          <span>Observer A: <strong>${nodeALabel}</strong></span>
          <span>Observer B: <strong>${nodeBLabel}</strong></span>
          <span>Slot: <strong>${escapeHtml(String(evA.slot))}</strong></span>
          ${slotsMatch && verified ? '<span class="consensus-badge">✓ Agreement</span>' : ''}
        </div>`;

    evidenceDisplay = `
    <div class="evidence-data-grid">
      ${fieldRows.join('')}
    </div>
    ${observerStrip}`;
  } else {
    evidenceDisplay = `
    <div class="evidence-grid">
      <div><i>✓</i> Verified signature</div><div><i>✓</i> Exact amount</div>
      <div><i>✓</i> Verified asset</div><div><i>✓</i> Merchant wallet</div>
      <div><i>✓</i> Finality check</div><div><i>✓</i> Chain slot</div>
    </div>
    <div class="slot-ticker-row">
      <span class="slot-ticker-label">Current slot</span>
      <span id="watcher-slot-counter" aria-live="off">—</span>
    </div>`;
  }

  return `<div class="watcher-stage">
    ${renderRunSummary(intent)}
    <div class="watcher-layout">
      <div class="watcher-map" aria-label="Two independent sandbox observers comparing one transaction">
        <div class="watcher-beam"></div>
        <div class="watcher-node"><div class="node-orb">${nodeA}</div><strong>Primary watcher</strong><small>${nodeALabel}</small></div>
        <div class="transaction-core">${verified ? 'MATCH' : 'GLP'}<br>${verified ? '✓' : 'TX'}</div>
        <div class="watcher-node"><div class="node-orb">${nodeB}</div><strong>Second watcher</strong><small>${nodeBLabel}</small></div>
      </div>
      <div class="stage-copy">
        <p class="micro">${verified ? 'EVIDENCE MATCHED' : 'SERVER-SIDE VERIFICATION'}</p>
        <h3>${verified ? 'Both watchers saw the same truth.' : 'A wallet message is not proof.'}</h3>
        <p>${verified ? 'The frozen expectation and both observations agree. The balanced operational record is posted, but the run still needs four-way reconciliation.' : 'The server will compare two independent observations against the exact request the counter created.'}</p>
        ${evidenceDisplay}
        ${verified ? '<div class="verified-banner"><i>✓</i><span>Dual-observer verification passed and the ledger entry balances.</span></div><button class="primary-action full" type="button" data-action="reconcile">Reconcile POS, chain, partner, and ledger <span class="button-arrow">→</span></button>' : '<button class="primary-action full" type="button" data-action="verify">Run independent verification <span class="button-arrow">→</span></button>'}
      </div>
    </div>
  </div>`;
}

function renderReceipt() {
  const intent = state.activeIntent;
  if (!intent) return renderFatal('No receipt is available.', 'Complete a Green Light Pay run first.');
  const rec = state.reconciliation;
  const developerUrl = `${BASE}/developer?intent=${encodeURIComponent(intent.id)}`;
  const auditEvent = state.audit.find((e) => e.aggregate_id === intent.id && e.action === 'RECONCILIATION_COMPLETED');

  let proofContent;
  if (rec) {
    proofContent = `
    <div class="receipt-proof-data">
      <div><span>Partner qualified</span><small>${escapeHtml(formatAction(intent.partner_decision || 'APPROVE'))} · ${escapeHtml(intent.partner_reference || '—')}</small></div>
      <div><span>Merchant controls passed</span><small>${escapeHtml(intent.store_id)} · ${escapeHtml(intent.register_id)}</small></div>
      <div><span>Two observers matched</span><small>Slot ${escapeHtml(String(state.verificationEvidence[0]?.slot || '—'))} · dual-observer confirmed</small></div>
      <div><span>Ledger balanced</span><small>${money(rec.ledger_amount_cents)} · diff $0.00</small></div>
      <div><span>All amounts matched</span><small>POS ${money(rec.pos_amount_cents)} · partner ${money(rec.partner_amount_cents)}</small></div>
      <div><span>Audit event linked</span><small>${auditEvent ? `#${String(auditEvent.sequence).padStart(3, '0')} · ${shortDate(auditEvent.created_at)}` : 'see developer console'}</small></div>
    </div>
    <div class="reconciliation-meta"><span>Reconciled ${shortDate(rec.created_at)}</span><strong>${escapeHtml(formatAction(rec.status || 'MATCHED'))}</strong></div>`;
  } else {
    proofContent = `<div class="receipt-proof"><span>Partner qualified</span><span>Merchant controls passed</span><span>Two observers matched</span><span>Ledger balanced</span><span>POS amount matched</span><span>Audit event linked</span></div>`;
  }

  return `<div class="receipt-stage">
    ${renderRunSummary(intent)}
    <div class="win-heading">
      <div class="win-mark">✓</div>
      <p class="stage-micro">GREEN LIGHT · RUN COMPLETE</p>
      <h3>Every record agrees.</h3>
      <p>The sandbox did not declare success until verification and four-way reconciliation both passed.</p>
    </div>
    <div class="digital-receipt">
      <div class="receipt-top"><span>${escapeHtml(intent.public_reference)}</span><strong>RECONCILED</strong></div>
      <div class="receipt-main">
        <div class="receipt-total"><span>Authorized total</span><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(intent.asset_code)} · Sandbox only</small></div>
        ${proofContent}
      </div>
    </div>
    <div class="receipt-actions">
      <button class="primary-action" type="button" data-action="new-run">Play another run</button>
      <a class="secondary-action" href="${developerUrl}">Inspect the technical proof</a>
    </div>
  </div>`;
}

function renderFatal(title, message) {
  return `<div class="error-panel"><p class="stage-micro">RUN BLOCKED</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p><button class="quiet-action" type="button" data-action="new-run">Return to the counter</button></div>`;
}

function renderRunFooter() {
  $('#run-reference').textContent = state.activeIntent?.public_reference || 'NOT STARTED';
  const restart = $('#restart-run');
  const status = state.activeIntent?.status;
  restart.hidden = !state.activeIntent || status === 'VERIFIED' || status === 'EXCEPTION';
  restart.textContent = status === 'RECONCILED' ? 'Play another run' : 'Restart run';
}

function renderTrace() {
  const events = state.activeIntent
    ? state.audit.filter((event) => event.aggregate_id === state.activeIntent.id).slice(0, 8)
    : state.audit.slice(0, 6);
  $('#trace-events').innerHTML = events.length
    ? events.map((event) => `<li><span>#${String(event.sequence).padStart(3, '0')}</span><span>${escapeHtml(formatAction(event.action))}</span><time datetime="${escapeHtml(event.created_at)}">${shortDate(event.created_at)}</time></li>`).join('')
    : '<li><span>#000</span><span>The trace begins when the counter initiates a run.</span><time>Ready</time></li>';
}

async function runBusy(work) {
  if (state.busy) return;
  state.busy = true;
  $('#stage-content').setAttribute('aria-busy', 'true');
  $$('button', $('#stage-content')).forEach((button) => { button.disabled = true; });
  try {
    await work();
  } catch (error) {
    toast(friendlyError(error), true);
  } finally {
    state.busy = false;
    $('#stage-content').setAttribute('aria-busy', 'false');
    $$('button', $('#stage-content')).forEach((button) => { button.disabled = false; });
  }
}

async function initiateRun(form) {
  const merchant = activeMerchant();
  const controls = merchant?.controls;
  const amount = Number(new FormData(form).get('amountUsd'));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid final total.');
  state.pendingIdempotencyKey ||= `counter-${crypto.randomUUID()}`;
  const result = await api('/api/payment-intents', {
    method: 'POST',
    actor: 'counter-one-pos-sandbox',
    body: JSON.stringify({
      merchantId: merchant.id,
      amountUsdCents: Math.round(amount * 100),
      assetCode: controls.allowed_asset_code,
      storeId: controls.store_ids[0],
      registerId: controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: state.pendingIdempotencyKey
    })
  });
  state.pendingIdempotencyKey = null;
  state.activeIntent = result;
  state.checkout = result.checkout_path ? {
    checkout_path: result.checkout_path,
    checkout_url: result.checkout_url,
    checkout_qr_path: result.checkout_qr_path
  } : null;
  state.resumeCandidate = null;
  state.multipleRuns = null;
  saveSession();
  await refreshData();
  render();
  toast(`${result.public_reference} initiated. The qualified-partner gate is next.`);
}

async function openGate() {
  const intent = state.activeIntent;
  await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/screen`, {
    method: 'POST',
    actor: 'qualified-partner-fixture',
    body: JSON.stringify({ decision: 'APPROVE', partnerReference: `sandbox-screen-${crypto.randomUUID()}` })
  });
  $('#gate-visual')?.classList.add('open');
  setStageStatus('Gate open', 'success');
  await sleep(780);
  await refreshData();
  saveSession();
  render();
  toast('The simulated qualified-partner gate opened.');
}

function checkoutToken() {
  // The one-time capability lives only in the URL fragment of the handoff
  // path. It is exchanged with the API exclusively via Authorization headers.
  const path = state.checkout?.checkout_path || '';
  const fragment = path.split('#')[1] || '';
  return new URLSearchParams(fragment).get('token');
}

async function loadQr() {
  const frame = $('#qr-frame');
  const token = checkoutToken();
  const qrPath = state.checkout?.checkout_qr_path;
  if (!frame || !token || !qrPath) return;
  try {
    const response = await fetch(qrPath, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('QR unavailable');
    const markup = await response.text();
    if (!markup.includes('<svg')) throw new Error('QR unavailable');
    frame.innerHTML = markup;
  } catch {
    frame.innerHTML = '<div class="qr-placeholder">QR UNAVAILABLE<br>USE ONE-SCREEN DEMO</div>';
  }
}

async function rotateHandoff() {
  const intent = state.activeIntent;
  const token = checkoutToken();
  if (!token) {
    // The plaintext token is never persisted; it lives only in memory for the
    // current page session. After a reload the operator must restart the run.
    throw Object.assign(
      new Error('The one-time handoff token is no longer in memory. Restart the run to create a fresh checkout session.'),
      { code: 'CHECKOUT_NOT_FOUND' }
    );
  }
  const result = await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/checkout`, {
    method: 'POST',
    actor: 'counter-one-operator',
    headers: { Authorization: `Bearer ${token}` }
  });
  state.checkout = {
    checkout_path: result.checkout_path,
    checkout_url: result.checkout_url,
    checkout_qr_path: result.checkout_qr_path
  };
  saveSession();
  await refreshData();
  render();
  toast('A fresh one-time handoff was issued. The previous token is now invalid.');
}

function renderWalletDialog() {
  const intent = state.activeIntent;
  $('#wallet-dialog-body').innerHTML = `<div class="wallet-shell">
    <div class="wallet-brand"><i>W</i><div><strong>Customer-owned sandbox wallet</strong><small>Partner fixture · no private keys requested</small></div></div>
    <div class="wallet-payment"><span>AUTHORIZE FICTIONAL PAYMENT</span><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(activeMerchant()?.dba || '')}</small></div>
    <div class="wallet-facts"><div><span>Asset</span><strong>${escapeHtml(intent.asset_code)}</strong></div><div><span>Request</span><strong>${escapeHtml(intent.public_reference)}</strong></div><div><span>Network</span><strong>Deterministic sandbox</strong></div></div>
    <button class="primary-action full" type="button" data-wallet-action="authorize">Approve sandbox payment</button>
    <p class="wallet-warning">This creates a fictional signature only. It does not connect a wallet, debit a balance, move an asset, or release cannabis product.</p>
  </div>`;
  $('#wallet-dialog').showModal();
}

async function authorizeWallet() {
  const intent = state.activeIntent;
  const token = checkoutToken();
  if (!token) {
    $('#wallet-dialog').close();
    throw Object.assign(new Error('This browser no longer holds the one-time handoff token. Issue a fresh handoff to continue.'), { code: 'CHECKOUT_NOT_FOUND' });
  }
  const result = await api(`/api/checkout/${encodeURIComponent(intent.id)}/authorize`, {
    method: 'POST',
    actor: 'customer-owned-wallet-fixture',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`,
      sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111'
    })
  });
  state.activeIntent = result;
  await refreshData();
  saveSession();
  $('#wallet-dialog-body').innerHTML = '<div class="wallet-success"><i>✓</i><h3>Fictional signature sent.</h3><p>The counter can now ask two independent watchers to verify the exact transaction evidence.</p><button class="secondary-action full" type="button" data-close-dialog>Return to the counter</button></div>';
  await sleep(700);
  $('#wallet-dialog').close();
  render();
  toast('The sandbox wallet signed. Verification is now available.');
}

async function verifyIntent() {
  const intent = state.activeIntent;
  const merchant = state.merchants.find((item) => item.id === intent.merchant_id);
  const slot = 311_000_000 + Math.floor(Math.random() * 800_000);
  const evidence = {
    signature: intent.signature,
    commitment: merchant.controls.required_commitment,
    tokenProgram: intent.expected_token_program,
    mint: intent.expected_mint,
    sourceWallet: intent.source_wallet,
    destinationWallet: intent.expected_destination,
    rawAmount: intent.expected_raw_amount,
    slot,
    transactionError: false
  };
  const result = await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/verify`, {
    method: 'POST',
    actor: 'dual-observer-verification-service',
    body: JSON.stringify({
      primary: { ...evidence, rpcProvider: 'sandbox-watcher-a' },
      secondary: { ...evidence, rpcProvider: 'sandbox-watcher-b' }
    })
  });
  state.activeIntent = result.intent;
  // Fetch and store real evidence values for display in the Watchers stage
  try {
    const evResult = await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/verification`);
    state.verificationEvidence = evResult.evidence || [];
  } catch {
    state.verificationEvidence = [];
  }
  await refreshData();
  saveSession();
  render();
  toast('Both independent watchers matched the frozen payment request.');
}

async function reconcileIntent() {
  const intent = state.activeIntent;
  const result = await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/reconcile`, {
    method: 'POST',
    actor: 'four-way-reconciliation-service',
    body: JSON.stringify({
      posAmountCents: intent.amount_usd_cents,
      chainRawAmount: intent.expected_raw_amount,
      partnerAmountCents: intent.amount_usd_cents
    })
  });
  state.activeIntent = result.intent;
  // Fetch reconciliation record for display in the Receipt stage
  try {
    const recResult = await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/reconciliation`);
    state.reconciliation = recResult.reconciliation || null;
  } catch {
    state.reconciliation = null;
  }
  await refreshData();
  saveSession();
  render();
  toast('POS, chain, partner, and ledger records all agree.');
}

async function cancelIntent(intent) {
  if (!intent || TERMINAL_STATUSES.has(intent.status)) return;
  await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/cancel`, {
    method: 'POST',
    actor: 'counter-one-operator',
    body: JSON.stringify({ reason: 'Sandbox run restarted by the operator.' })
  });
  // The intent is now CANCELLED (terminal). Clear the session immediately so a
  // subsequent page reload doesn't see a stale intent and block a fresh start.
  clearSession();
}

async function newRun({ cancelCurrent = false } = {}) {
  if (cancelCurrent && state.activeIntent) await cancelIntent(state.activeIntent);
  state.activeIntent = null;
  state.resumeCandidate = null;
  state.multipleRuns = null;
  state.checkout = null;
  state.stage = 'counter';
  state.pendingIdempotencyKey = null;
  state.verificationEvidence = [];
  state.reconciliation = null;
  slotTickerBaseSlot = 0;
  slotTickerStartMs = 0;
  slotTickerIntentId = null;
  clearSession();
  await refreshData();
  render();
  $('#play-stage').focus();
}

async function resumeRun() {
  state.activeIntent = state.resumeCandidate;
  state.resumeCandidate = null;
  state.checkout = null;
  setStageFromIntent();
  saveSession();
  render();
  toast(`Resumed ${state.activeIntent.public_reference}.`);
}

async function cancelResume() {
  await cancelIntent(state.resumeCandidate);
  state.resumeCandidate = null;
  await refreshData();
  render();
  toast('The prior fictional run was cancelled.');
}

function startPolling() {
  clearPolling();
  state.pollTimer = setInterval(async () => {
    if (state.pollBusy || !state.activeIntent || document.hidden || !navigator.onLine) return;
    state.pollBusy = true;
    try {
      const before = state.activeIntent.status;
      await refreshData({ includeSystem: false });
      if (state.activeIntent.status !== before) {
        saveSession();
        render();
        toast('The customer handoff returned a sandbox signature.');
      }
    } catch {
      // Polling never changes the display to success on an unknown response.
    } finally {
      state.pollBusy = false;
    }
  }, 1600);
}

function startVerifyPolling() {
  clearPolling();
  const intentId = state.activeIntent?.id;
  state.pollTimer = setInterval(async () => {
    if (state.pollBusy || !state.activeIntent || document.hidden || !navigator.onLine) return;
    if (state.activeIntent.id !== intentId) { clearPolling(); return; }
    if ((state.verificationEvidence || []).length >= 2) { clearPolling(); return; }
    state.pollBusy = true;
    try {
      const evResult = await api(`/api/payment-intents/${encodeURIComponent(intentId)}/verification`);
      const evidence = evResult.evidence || [];
      if (evidence.length >= 2) {
        state.verificationEvidence = evidence;
        clearPolling();
        await refreshData({ includeSystem: false });
        saveSession();
        render();
      }
    } catch {
      // Polling never changes the display on an unknown response.
    } finally {
      state.pollBusy = false;
    }
  }, 2000);
}

function clearPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function celebrate() {
  if (state.celebratedIntentId === state.activeIntent?.id || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  state.celebratedIntentId = state.activeIntent.id;
  const container = $('#confetti');
  container.innerHTML = '<i></i>'.repeat(24);
  setTimeout(() => { container.innerHTML = ''; }, 3200);
}

$('#stage-content').addEventListener('submit', (event) => {
  if (event.target.id !== 'counter-form') return;
  event.preventDefault();
  runBusy(() => initiateRun(event.target));
});

$('#stage-content').addEventListener('click', (event) => {
  const amountButton = event.target.closest('[data-amount]');
  if (amountButton) {
    $('#amount-usd').value = amountButton.dataset.amount;
    $$('[data-amount]', $('#stage-content')).forEach((button) => button.classList.toggle('selected', button === amountButton));
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'open-gate') runBusy(openGate);
  if (action === 'rotate-handoff') runBusy(rotateHandoff);
  if (action === 'open-wallet') renderWalletDialog();
  if (action === 'verify') runBusy(verifyIntent);
  if (action === 'reconcile') runBusy(reconcileIntent);
  if (action === 'new-run') runBusy(() => newRun());
  if (action === 'resume-run') runBusy(resumeRun);
  if (action === 'cancel-resume') runBusy(cancelResume);
  if (action === 'force-new-run') runBusy(() => newRun());
  if (action === 'restart-from-handoff') runBusy(() => newRun({ cancelCurrent: true }));
  if (action === 'resume-specific') {
    const intentId = event.target.closest('[data-intent-id]')?.dataset.intentId;
    runBusy(async () => {
      const found = (state.multipleRuns || []).find((r) => r.id === intentId);
      if (found) {
        state.activeIntent = found;
        state.multipleRuns = null;
        state.checkout = null;
        setStageFromIntent();
        saveSession();
        await refreshData();
        render();
        toast(`Resumed ${found.public_reference}.`);
      }
    });
  }
});

$('#wallet-dialog').addEventListener('click', (event) => {
  if (event.target.closest('[data-wallet-action="authorize"]')) runBusy(authorizeWallet);
});

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]');
  if (close) close.closest('dialog')?.close();
});

$('#open-boundary').addEventListener('click', () => $('#boundary-dialog').showModal());

$('#restart-run').addEventListener('click', () => {
  const shouldCancel = state.activeIntent && !TERMINAL_STATUSES.has(state.activeIntent.status);
  runBusy(() => newRun({ cancelCurrent: shouldCancel }));
});

window.addEventListener('offline', () => {
  setStageStatus('Connection lost', 'error');
  toast('Connection lost. The sandbox will not show success until the server answers again.', true);
});

window.addEventListener('online', () => {
  toast('Connection restored. Refreshing the controlled state.');
  refreshData().then(render).catch(() => toast('The server is still unavailable.', true));
});

bootstrap().catch((error) => {
  $('#stage-content').innerHTML = renderFatal('The sandbox could not start.', friendlyError(error));
  $('#stage-content').setAttribute('aria-busy', 'false');
  setStageStatus('Unavailable', 'error');
  toast(friendlyError(error), true);
});
