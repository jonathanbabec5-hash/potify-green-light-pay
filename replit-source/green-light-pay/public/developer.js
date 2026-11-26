// GLP Operations Terminal — developer.js
// v0.1.3-stage1.3 · Sandbox only — no live funds, no real cannabis transactions.

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEV_VERSION = '0.1.3-stage1.3';
const WORKSPACES = [
  'overview','transactions','queues','merchants','partners',
  'verification','reconciliation','ledger','audit','api','health','terminal'
];
const TERMINAL_STATUSES = new Set(['RECONCILED','DECLINED','CANCELLED','EXPIRED']);
const QUEUE_GROUPS = {
  screening:  ['SCREENING_REQUIRED'],
  review:     ['REVIEW_REQUIRED'],
  submitted:  ['SUBMITTED'],
  eligible:   ['VERIFIED','EXCEPTION'],
  reconciled: ['RECONCILED'],
  terminal:   ['CANCELLED','DECLINED','EXPIRED']
};
// Shell commands the GLP terminal does not provide (filesystem, package, or execution access).
const SHELL_CMDS = new Set([
  'ls','cd','rm','cat','mv','cp','chmod','chown','find','grep','awk','sed',
  'env','exec','eval','shell','bash','sh','zsh','fish','sudo','su',
  'curl','wget','pip','npm','yarn','pnpm','node','python','ruby','perl','php','go','cargo','make'
]);
const API_ROUTES = [
  {group:'System',method:'GET',path:'/api/health',guard:'—',purpose:'Status boundary + integrity check',synthetic:false},
  {group:'System',method:'GET',path:'/api/dashboard',guard:'—',purpose:'Counts, ledger diff, audit summary',synthetic:false},
  {group:'System',method:'GET',path:'/api/ledger',guard:'—',purpose:'Ledger transactions + entries',synthetic:false},
  {group:'Partners',method:'GET',path:'/api/partners',guard:'—',purpose:'Qualified partner registry',synthetic:true},
  {group:'Partners',method:'POST',path:'/api/partners',guard:'operator',purpose:'Create partner record',synthetic:true},
  {group:'Partners',method:'POST',path:'/api/partners/:id/status',guard:'operator',purpose:'Update partner status',synthetic:true},
  {group:'Merchants',method:'GET',path:'/api/merchants',guard:'—',purpose:'Merchant + controls records',synthetic:true},
  {group:'Merchants',method:'POST',path:'/api/merchants',guard:'underwriting',purpose:'Create merchant record',synthetic:true},
  {group:'Merchants',method:'POST',path:'/api/merchants/:id/status',guard:'underwriting',purpose:'Update merchant status',synthetic:true},
  {group:'Merchants',method:'PATCH',path:'/api/merchants/:id/controls',guard:'operator',purpose:'Update counter limits and settings',synthetic:false},
  {group:'Transactions',method:'GET',path:'/api/payment-intents',guard:'—',purpose:'Paginated run list (limit=)',synthetic:false},
  {group:'Transactions',method:'GET',path:'/api/payment-intents/:id',guard:'—',purpose:'Single intent detail',synthetic:false},
  {group:'Transactions',method:'POST',path:'/api/payment-intents',guard:'pos-emulator',purpose:'Idempotent minimum-data request',synthetic:false},
  {group:'Transactions',method:'POST',path:'/api/payment-intents/:id/screen',guard:'partner',purpose:'Partner decision fixture',synthetic:true},
  {group:'Transactions',method:'POST',path:'/api/payment-intents/:id/cancel',guard:'operator',purpose:'Cancel a non-terminal run',synthetic:false},
  {group:'Customer Handoff',method:'POST',path:'/api/payment-intents/:id/checkout',guard:'bearer token',purpose:'Rotate one-time checkout token',synthetic:false},
  {group:'Customer Handoff',method:'GET',path:'/api/checkout/:id',guard:'bearer token',purpose:'Token-bound customer handoff',synthetic:false},
  {group:'Customer Handoff',method:'GET',path:'/api/checkout/:id/qr',guard:'bearer token',purpose:'SVG QR code for handoff',synthetic:false},
  {group:'Customer Handoff',method:'POST',path:'/api/checkout/:id/authorize',guard:'bearer token',purpose:'Fictional wallet signature',synthetic:true},
  {group:'Verification',method:'POST',path:'/api/payment-intents/:id/verify',guard:'SUBMITTED',purpose:'Dual-observer comparison',synthetic:true},
  {group:'Verification',method:'GET',path:'/api/payment-intents/:id/verification',guard:'SUBMITTED+',purpose:'Verification evidence rows',synthetic:false},
  {group:'Reconciliation',method:'POST',path:'/api/payment-intents/:id/reconcile',guard:'VERIFIED|EXCEPTION',purpose:'POS / chain / partner / ledger',synthetic:true},
  {group:'Reconciliation',method:'GET',path:'/api/payment-intents/:id/reconciliation',guard:'RECONCILED|EXCEPTION',purpose:'Reconciliation record',synthetic:false},
  {group:'Evidence',method:'GET',path:'/api/payment-intents/:id/evidence',guard:'RECONCILED+',purpose:'Full evidence bundle',synthetic:false},
  {group:'Audit',method:'GET',path:'/api/audit',guard:'—',purpose:'Paginated material event log',synthetic:false},
  {group:'Audit',method:'GET',path:'/api/audit/verify',guard:'—',purpose:'Recalculate event hash chain',synthetic:false},
];

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  dashboard: null,
  partners: [],
  merchants: [],
  intents: [],
  audit: [],
  ledger: [],
  workspace: 'overview',
  selectedIntentId: null,     // intent detail + audit scoping
  selectedMerchantId: null,
  txFilter: { q: '', status: '', merchantId: '', sort: 'created_at', dir: 'desc' },
  auditFilter: { type: '', actor: '' },
  refreshBusy: false,
  cmdHistory: [],
  cmdHistoryIdx: 0,
  cmdJsonMode: false,
  terminalLines: [],
  terminalBusy: false,
  // Set by executeCommand's print helper whenever it emits an error/warning tone.
  // The submit handler reads this to decide whether to clear the input.
  terminalLastFailed: false,
  latencies: {},
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const baseMeta = document.querySelector('meta[name="glp-base"]')?.getAttribute('content') || '';
const BASE = baseMeta.startsWith('__') ? '' : baseMeta;

// ─── Refresh timers ───────────────────────────────────────────────────────────
let lastRefreshed = Date.now();
let staleTickerTimer = null;
let autoRefreshTimer = null;

// ─── Formatting helpers ───────────────────────────────────────────────────────
function escapeHtml(v) {
  return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function money(cents) {
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((Number(cents)||0)/100);
}
function shortDate(v) {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v));
}
function isoDate(v) { return v ? new Date(v).toISOString().replace('T',' ').slice(0,19)+' UTC' : '—'; }
function formatAction(v) {
  return String(v||'').toLowerCase().replaceAll('_',' ').replace(/\b\w/g, l => l.toUpperCase());
}
function statusBadge(v) {
  return `<span class="status-badge ${escapeHtml(v)}">${escapeHtml(v)}</span>`;
}
function truncStr(v, n = 16) { const s = String(v ?? ''); return s.length > n ? s.slice(0, n) + '\u2026' : s; }

// ─── Toast + announcer ────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}
function announce(msg) {
  const el = $('#aria-announcer');
  if (el) el.textContent = msg;
}

// ─── API client ───────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body = undefined, actor: actorHeader = '' } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(actorHeader ? { 'X-GLP-Actor': actorHeader } : {})
    },
    body
  });
  const elapsed = Math.round(performance.now() - t0);
  const key = path.replace(/\/[a-z0-9_-]{20,}/gi, '/:id').split('?')[0];
  state.latencies[key] = { ms: elapsed, at: new Date().toISOString() };
  let payload;
  try { payload = await res.json(); } catch { payload = {}; }
  if (!res.ok) {
    const err = new Error(payload.error?.message || 'API request failed.');
    err.code = payload.error?.code;
    throw err;
  }
  return payload;
}

// ─── Refresh coordinator (guards against overlapping refreshes) ───────────────
async function loadAll({ quiet = false } = {}) {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  let refreshSucceeded = false;
  try {
    const [dashboard, partners, merchants, intents, auditData, ledger] = await Promise.all([
      api('/api/dashboard'),
      api('/api/partners'),
      api('/api/merchants'),
      api('/api/payment-intents?limit=100'),
      api('/api/audit?limit=200'),
      api('/api/ledger?limit=100').catch(() => ({ transactions: [] }))
    ]);
    state.dashboard  = dashboard;
    state.partners   = partners.partners  || [];
    state.merchants  = merchants.merchants || [];
    state.intents    = intents.payment_intents || [];
    state.audit      = auditData.events || [];
    state.ledger     = ledger.transactions || [];
    if (!state.selectedMerchantId || !state.merchants.find(m => m.id === state.selectedMerchantId)) {
      state.selectedMerchantId = state.merchants[0]?.id ?? null;
    }
    lastRefreshed = Date.now();
    refreshSucceeded = true;
    updateStaleIndicator();
    // The terminal does not render polled data. Rebuilding it would destroy a command
    // being typed and discard the terminal's scroll position for no visible benefit.
    if (state.workspace !== 'terminal') renderCurrentWorkspace();
    if (!quiet) toast('Data refreshed.');
  } catch (error) {
    toast(error.message || 'Refresh failed.', true);
    if (!state.dashboard) {
      const root = $('#workspace-root');
      if (root) root.innerHTML = `<div class="ws-error"><p>Connection failed: ${escapeHtml(error.message)}</p><button type="button" id="retry-load" class="btn-primary">Retry</button></div>`;
    }
  } finally {
    state.refreshBusy = false;
  }
  // Reported so the `refresh` command does not claim success when the fetch failed.
  return refreshSucceeded;
}

function updateStaleIndicator() {
  const el = $('#stale-indicator');
  if (!el) return;
  const seconds = Math.floor((Date.now() - lastRefreshed) / 1000);
  el.textContent = seconds < 5 ? 'just now' : `${seconds}s ago`;
  el.classList.toggle('stale', seconds > 15);
}

// ─── Workspace router ─────────────────────────────────────────────────────────
function navigateTo(ws, { intentId = null } = {}) {
  if (!WORKSPACES.includes(ws)) return;
  state.workspace = ws;
  if (intentId) state.selectedIntentId = intentId;
  // Auto-select first verifiable intent when entering Verification with no prior selection
  if (ws === 'verification' && !state.selectedIntentId) {
    const first = state.intents.find(i =>
      ['SUBMITTED','REVIEW_REQUIRED','VERIFIED','EXCEPTION','RECONCILED'].includes(i.status)
    );
    if (first) state.selectedIntentId = first.id;
  }
  const params = intentId ? `?intent=${encodeURIComponent(intentId)}` : '';
  history.replaceState(null, '', `${BASE}/developer#${ws}${params}`);
  updateNavActive();
  renderCurrentWorkspace();
  if (ws === 'terminal') requestAnimationFrame(() => $('#terminal-input')?.focus());
  // Trigger workspace-specific async loaders immediately after render
  if (ws === 'reconciliation') loadReconciliationCards();
  if (ws === 'verification' && state.selectedIntentId) loadEvidenceForIntent(state.selectedIntentId);
  const root = $('#workspace-root');
  if (root) { root.scrollTop = 0; root.focus(); }
  announce(`${formatAction(ws)} workspace`);
}

function updateNavActive() {
  $$('.rail-item').forEach(btn => {
    const active = btn.dataset.workspace === state.workspace;
    btn.setAttribute('aria-current', active ? 'page' : 'false');
    btn.classList.toggle('active', active);
  });
}

const WS_RENDERERS = {
  overview, transactions, queues, merchants, partners,
  verification, reconciliation, ledger, audit,
  api: apiDocs, health, terminal
};

function renderCurrentWorkspace() {
  const root = $('#workspace-root');
  if (!root || !state.dashboard) return;
  root.innerHTML = (WS_RENDERERS[state.workspace] || overview)();
  bindWorkspaceEvents();
}

// ─── WORKSPACE: Overview ──────────────────────────────────────────────────────
function overview() {
  const d = state.dashboard;
  const byStatus = {};
  state.intents.forEach(i => { byStatus[i.status] = (byStatus[i.status] || 0) + 1; });
  const needsAction = (byStatus['SCREENING_REQUIRED'] || 0) + (byStatus['REVIEW_REQUIRED'] || 0);
  const pendingRecon = (byStatus['VERIFIED'] || 0) + (byStatus['EXCEPTION'] || 0);
  const ledgerOk = d.ledger_difference_cents === 0;
  const auditOk = d.audit?.valid;

  function card(label, value, sub, ws, cls = '') {
    return `<button class="ov-card${cls ? ' '+cls : ''}" type="button" data-nav-ws="${ws}" aria-label="${escapeHtml(label)}: ${escapeHtml(String(value))}">
      <span class="ov-label">${escapeHtml(label)}</span>
      <strong class="ov-value">${escapeHtml(String(value))}</strong>
      ${sub ? `<small class="ov-sub">${escapeHtml(sub)}</small>` : ''}
    </button>`;
  }

  return `<div class="ws-overview">
    <div class="ws-heading"><h1>Operations Overview</h1><p>Snapshot from current sandbox records. Each card navigates to its workspace.</p></div>
    <section class="ov-section" aria-label="Transaction activity">
      <h2>Transaction activity</h2>
      <div class="ov-grid">
        ${card('Open runs', d.open_payment_intents, 'non-terminal', 'transactions', d.open_payment_intents > 0 ? 'accent' : '')}
        ${card('Needs attention', needsAction, 'screening or review required', 'queues', needsAction > 0 ? 'warn' : '')}
        ${card('Awaiting evidence', byStatus['SUBMITTED'] || 0, 'submitted, watcher pending', 'queues')}
        ${card('Exceptions', byStatus['EXCEPTION'] || 0, 'EXCEPTION status', 'queues', (byStatus['EXCEPTION'] || 0) > 0 ? 'warn' : '')}
        ${card('Pending reconciliation', pendingRecon, 'VERIFIED or EXCEPTION', 'queues')}
        ${card('Reconciled', d.reconciled_payment_intents || 0, 'closed runs', 'reconciliation')}
      </div>
    </section>
    <section class="ov-section" aria-label="System status">
      <h2>System status</h2>
      <div class="ov-grid ov-grid-4">
        ${card('Approved partners', d.approved_partners, 'qualification gate', 'partners')}
        ${card('Active merchants', d.active_merchants, 'counter authority', 'merchants')}
        ${card('Ledger diff', money(d.ledger_difference_cents), ledgerOk ? 'balanced' : 'OUT OF BALANCE', 'ledger', ledgerOk ? 'ok' : 'err')}
        ${card('Audit chain', auditOk ? 'VALID' : 'FAILED', `${d.audit?.events_checked ?? 0} events`, 'audit', auditOk ? 'ok' : 'err')}
      </div>
    </section>
    <section class="ov-section" aria-label="Data freshness">
      <h2>Data freshness</h2>
      <div class="ov-meta-row">
        <span>Last refresh</span><strong>${escapeHtml(shortDate(new Date().toISOString()))}</strong>
        <span>Mode</span><strong>${escapeHtml(d.mode || 'SANDBOX')}</strong>
        <span>Prototype version</span><strong>${escapeHtml(d.prototype_version || '—')}</strong>
        <span>Live money movement</span><strong>${d.live_money_movement === false ? 'No' : 'Check config'}</strong>
      </div>
    </section>
  </div>`;
}

// ─── WORKSPACE: Transactions ──────────────────────────────────────────────────
function transactions() {
  const { q, status, merchantId, sort, dir } = state.txFilter;
  const ql = q.toLowerCase();
  let filtered = state.intents.filter(i => {
    if (ql && !i.public_reference.toLowerCase().includes(ql) &&
        !(i.store_id||'').toLowerCase().includes(ql) &&
        !(i.register_id||'').toLowerCase().includes(ql)) return false;
    if (status && i.status !== status) return false;
    if (merchantId && i.merchant_id !== merchantId) return false;
    return true;
  });
  filtered = [...filtered].sort((a, b) => {
    const va = a[sort] ?? a.created_at, vb = b[sort] ?? b.created_at;
    const cmp = String(va).localeCompare(String(vb), undefined, {numeric:true});
    return dir === 'asc' ? cmp : -cmp;
  });

  const statuses = [...new Set(state.intents.map(i => i.status))].sort();
  const sel = state.selectedIntentId;
  const detail = sel ? state.intents.find(i => i.id === sel) : null;

  const rows = filtered.map(intent => {
    const action = intentAction(intent);
    const evidenceText = intent.signature
      ? `<code>${escapeHtml(truncStr(intent.signature, 12))}</code>`
      : '<span class="muted">\u2014</span>';
    const isSelected = intent.id === sel;
    return `<tr class="intent-row${isSelected ? ' row-selected' : ''}" tabindex="0" data-row-intent-id="${escapeHtml(intent.id)}" aria-selected="${isSelected}">
      <td><strong>${escapeHtml(intent.public_reference)}</strong><small>${shortDate(intent.created_at)}</small></td>
      <td><strong>${escapeHtml(intent.store_id||'—')}</strong><small>${escapeHtml(intent.register_id||'—')}</small></td>
      <td class="num"><strong>${money(intent.amount_usd_cents)}</strong><small>${escapeHtml(intent.asset_code||'')}</small></td>
      <td>${statusBadge(intent.status)}</td>
      <td>${evidenceText}</td>
      <td>${action ? `<button class="row-action" type="button" data-action="${action.action}" data-intent-id="${escapeHtml(intent.id)}">${escapeHtml(action.label)}</button>` : '<small class="muted">\u2014</small>'}</td>
    </tr>`;
  }).join('');

  const detailHtml = detail ? intentDetail(detail) : `<div class="detail-empty"><p>Select a row to inspect the transaction record.</p></div>`;

  return `<div class="ws-transactions">
    <div class="ws-heading"><h1>Transactions</h1><p>${filtered.length} of ${state.intents.length} runs</p></div>
    <div class="tx-filter-bar">
      <input type="search" id="tx-q" value="${escapeHtml(q)}" placeholder="Search reference, store, register\u2026" aria-label="Search transactions">
      <select id="tx-status" aria-label="Filter by status">
        <option value="">All statuses</option>
        ${statuses.map(s => `<option value="${escapeHtml(s)}"${status===s?' selected':''}>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select id="tx-merchant" aria-label="Filter by merchant">
        <option value="">All merchants</option>
        ${state.merchants.map(m => `<option value="${escapeHtml(m.id)}"${merchantId===m.id?' selected':''}>${escapeHtml(m.dba)}</option>`).join('')}
      </select>
      <button type="button" id="tx-clear" class="btn-secondary">Clear</button>
    </div>
    <div class="tx-layout">
      <div class="tx-table-wrap">
        <table aria-label="Transaction list">
          <thead><tr>
            <th><button type="button" class="sort-btn" data-sort="public_reference">Reference</button></th>
            <th>Counter</th>
            <th><button type="button" class="sort-btn num" data-sort="amount_usd_cents">Amount</button></th>
            <th><button type="button" class="sort-btn" data-sort="status">Status</button></th>
            <th>Evidence</th>
            <th>Action</th>
          </tr></thead>
          <tbody id="intent-rows">${rows || '<tr><td colspan="6" class="empty-row">No transactions match the current filters.</td></tr>'}</tbody>
        </table>
      </div>
      <aside class="tx-detail" aria-label="Transaction detail">${detailHtml}</aside>
    </div>
  </div>`;
}

function intentAction(intent) {
  if (['SCREENING_REQUIRED','REVIEW_REQUIRED'].includes(intent.status)) return {action:'screen',label:'Screen APPROVE'};
  if (intent.status === 'SUBMITTED') return {action:'verify',label:'Dual verify'};
  if (['VERIFIED','EXCEPTION'].includes(intent.status)) return {action:'reconcile',label:'Reconcile'};
  return null;
}

function intentDetail(intent) {
  const merchant = state.merchants.find(m => m.id === intent.merchant_id);
  const partner  = state.partners.find(p => p.id === intent.partner_id);
  const events   = state.audit.filter(e => e.aggregate_id === intent.id);
  const steps    = ['SCREENING_REQUIRED','READY_FOR_PAYMENT','SUBMITTED','VERIFIED','RECONCILED'];
  const curIdx   = steps.indexOf(intent.status);
  return `<div class="intent-detail">
    <div class="detail-header">
      <h2>${escapeHtml(intent.public_reference)}</h2>${statusBadge(intent.status)}
    </div>
    <dl class="detail-grid">
      <div><dt>Amount</dt><dd class="num">${money(intent.amount_usd_cents)}</dd></div>
      <div><dt>Asset</dt><dd><code>${escapeHtml(intent.asset_code||'')}</code></dd></div>
      <div><dt>Merchant</dt><dd>${escapeHtml(merchant?.dba||'—')}</dd></div>
      <div><dt>Partner</dt><dd>${escapeHtml(truncStr(partner?.legal_name||'—',30))}</dd></div>
      <div><dt>Store</dt><dd><code>${escapeHtml(intent.store_id||'—')}</code></dd></div>
      <div><dt>Register</dt><dd><code>${escapeHtml(intent.register_id||'—')}</code></dd></div>
      <div><dt>Created</dt><dd>${shortDate(intent.created_at)}</dd></div>
      <div><dt>Updated</dt><dd>${shortDate(intent.updated_at)}</dd></div>
      ${intent.status_reason ? `<div class="full"><dt>Reason</dt><dd>${escapeHtml(intent.status_reason)}</dd></div>` : ''}
      ${intent.partner_decision ? `<div><dt>Partner decision</dt><dd>${escapeHtml(formatAction(intent.partner_decision))}</dd></div>` : ''}
      ${intent.signature ? `<div class="full"><dt>Signature (truncated)</dt><dd><code>${escapeHtml(truncStr(intent.signature,24))}</code></dd></div>` : ''}
    </dl>
    <div class="detail-section"><h3>Lifecycle</h3>
      <ol class="lifecycle-steps">
        ${steps.map((s,i) => `<li class="${i<=curIdx?'done':''}">${escapeHtml(formatAction(s))}</li>`).join('')}
      </ol>
    </div>
    <div class="detail-section"><h3>Audit events (${events.length})</h3>
      <ol class="detail-audit">
        ${events.slice(0,8).map(e => `<li><b>#${String(e.sequence).padStart(3,'0')}</b><span>${escapeHtml(formatAction(e.action))}</span><time>${shortDate(e.created_at)}</time></li>`).join('')||'<li class="muted">None yet.</li>'}
      </ol>
    </div>
    <div class="detail-actions">
      <button type="button" class="btn-secondary" data-nav-ws="verification" data-nav-intent="${escapeHtml(intent.id)}">View verification</button>
      <button type="button" class="btn-secondary" data-nav-ws="audit" data-nav-intent="${escapeHtml(intent.id)}">Scope audit</button>
    </div>
  </div>`;
}

// ─── WORKSPACE: Queues ────────────────────────────────────────────────────────
function queues() {
  const buckets = [
    {key:'screening', label:'Needs screening', desc:'Partner has not yet reviewed', warn:true},
    {key:'review',    label:'Under review',    desc:'Evidence requested re-check',  warn:true},
    {key:'submitted', label:'Awaiting evidence',desc:'Submitted, watcher evidence pending', warn:false},
    {key:'eligible',  label:'Eligible for reconciliation',desc:'VERIFIED or EXCEPTION',warn:false},
    {key:'reconciled',label:'Reconciled',       desc:'Closed, matched runs',         warn:false},
    {key:'terminal',  label:'Terminal',          desc:'Cancelled, declined, or expired',warn:false},
  ];
  const cards = buckets.map(b => {
    const items = state.intents.filter(i => QUEUE_GROUPS[b.key].includes(i.status));
    return `<section class="queue-card${b.warn&&items.length?' attention':''}" aria-label="${b.label} queue">
      <div class="queue-header"><h2>${escapeHtml(b.label)}</h2><span class="queue-count${items.length?' has-items':''}">${items.length}</span></div>
      <p class="queue-desc">${escapeHtml(b.desc)}</p>
      <ul class="queue-list" aria-label="${b.label} items">
        ${items.slice(0,10).map(i => `<li><button type="button" class="queue-item-btn" data-nav-ws="transactions" data-nav-intent="${escapeHtml(i.id)}"><span class="qi-ref">${escapeHtml(i.public_reference)}</span><span class="qi-amount num">${money(i.amount_usd_cents)}</span><span class="qi-time">${shortDate(i.updated_at)}</span></button></li>`).join('')}
        ${items.length > 10 ? `<li class="queue-more">+${items.length-10} more \u2014 see Transactions</li>` : ''}
        ${items.length === 0 ? '<li class="queue-empty">Empty</li>' : ''}
      </ul>
    </section>`;
  }).join('');
  return `<div class="ws-queues"><div class="ws-heading"><h1>Review Queues</h1><p>Counts derived from current sandbox records.</p></div><div class="queues-grid">${cards}</div></div>`;
}

// ─── WORKSPACE: Merchants ─────────────────────────────────────────────────────
function merchants() {
  const merchant = state.merchants.find(m => m.id === state.selectedMerchantId) || state.merchants[0];
  const controls = merchant?.controls;
  const list = state.merchants.map(m => `<li>
    <button type="button" class="merchant-item${m.id===merchant?.id?' active':''}" data-merchant-id="${escapeHtml(m.id)}">
      <strong>${escapeHtml(m.dba)}</strong>
      ${statusBadge(m.status)}
      <small>${escapeHtml(m.state||'')} \u00B7 ${escapeHtml(m.license_category||'')}</small>
    </button>
  </li>`).join('');

  if (!merchant || !controls) {
    return `<div class="ws-merchants"><div class="ws-heading"><h1>Merchants</h1></div><p class="muted">No merchant data available.</p></div>`;
  }

  const recentActivity = state.intents.filter(i => i.merchant_id === merchant.id).slice(0,5);

  return `<div class="ws-merchants">
    <div class="ws-heading"><h1>Merchants</h1><p>Controls changes use the guarded PATCH /api/merchants/:id/controls route and are audit-linked.</p></div>
    <div class="merchant-layout">
      <aside class="merchant-list-panel" aria-label="Merchant list"><ul role="list">${list}</ul></aside>
      <div class="merchant-detail-panel">
        <div class="merchant-header"><h2>${escapeHtml(merchant.dba)}</h2>${statusBadge(merchant.status)}</div>
        <dl class="detail-grid">
          <div><dt>Legal name</dt><dd>${escapeHtml(merchant.legal_name||'—')}</dd></div>
          <div><dt>State</dt><dd>${escapeHtml(merchant.state||'—')}</dd></div>
          <div><dt>License number</dt><dd><code>${escapeHtml(merchant.license_number||'—')}</code></dd></div>
          <div><dt>License category</dt><dd>${escapeHtml(merchant.license_category||'—')}</dd></div>
          <div><dt>POS provider</dt><dd>${escapeHtml(merchant.pos_provider||'—')}</dd></div>
          <div><dt>Sandbox only</dt><dd>${merchant.sandbox_only ? 'Yes' : 'No'}</dd></div>
          <div><dt>Settlement wallet (truncated)</dt><dd><code>${escapeHtml(truncStr(merchant.settlement_wallet||'',20))}</code></dd></div>
          <div><dt>Partner</dt><dd>${escapeHtml(truncStr(state.partners.find(p=>p.id===merchant.partner_id)?.legal_name||'—',30))}</dd></div>
        </dl>
        <section class="merchant-controls-section" aria-label="Operational controls">
          <h3>Operational controls</h3>
          <form id="controls-form" aria-label="Merchant controls">
            <div class="controls-grid">
              <label class="pause-control">
                <span><b>Pause new requests</b><small>Blocks new payment requests at the counter</small></span>
                <input id="control-paused" name="paused" type="checkbox" role="switch" ${controls.paused?'checked':''}>
              </label>
              <label>Per-transaction limit (USD)
                <input id="control-per-tx" name="perTransaction" type="number" min="1" step="0.01" value="${((controls.per_transaction_limit_cents||0)/100).toFixed(2)}" required>
              </label>
              <label>Daily limit (USD)
                <input id="control-daily" name="daily" type="number" min="1" step="0.01" value="${((controls.daily_limit_cents||0)/100).toFixed(2)}" required>
              </label>
              <label>Required finality
                <select id="control-commitment" name="commitment">
                  <option value="FINALIZED"${controls.required_commitment==='FINALIZED'?' selected':''}>Finalized</option>
                  <option value="CONFIRMED"${controls.required_commitment==='CONFIRMED'?' selected':''}>Confirmed</option>
                </select>
              </label>
              <div class="controls-readout"><span>Allowed asset</span><code>${escapeHtml(controls.allowed_asset_code||'—')}</code></div>
              <div class="controls-readout"><span>Merchant wallet (truncated)</span><code>${escapeHtml(truncStr(controls.allowed_mint||'',20))}</code></div>
            </div>
            <button class="btn-primary" type="submit">Save controls \u2014 PATCH /api/merchants/:id/controls</button>
          </form>
          <p class="controls-note">Last updated: ${shortDate(controls.updated_at)} \u00B7 Changes require a named operator actor and appear in the audit log.</p>
        </section>
        <section aria-label="Recent sandbox activity">
          <h3>Recent activity (${recentActivity.length} runs)</h3>
          <ul class="recent-list">
            ${recentActivity.map(i => `<li><button type="button" class="recent-item" data-nav-ws="transactions" data-nav-intent="${escapeHtml(i.id)}">${escapeHtml(i.public_reference)} \u00B7 ${statusBadge(i.status)} \u00B7 ${money(i.amount_usd_cents)}</button></li>`).join('')||'<li class="muted">No runs yet.</li>'}
          </ul>
        </section>
      </div>
    </div>
  </div>`;
}

// ─── WORKSPACE: Partners ──────────────────────────────────────────────────────
function partners() {
  const cards = state.partners.map(p => {
    const linked = state.intents.filter(i => i.partner_id === p.id).length;
    return `<article class="partner-card" aria-label="${escapeHtml(p.legal_name)}">
      <div class="partner-header"><h2>${escapeHtml(p.legal_name)}</h2>${statusBadge(p.status)}</div>
      <dl class="detail-grid">
        <div><dt>Approval reference</dt><dd><code>${escapeHtml(p.cannabis_approval_reference||'—')}</code></dd></div>
        <div><dt>Expires</dt><dd>${shortDate(p.approval_expires_at)}</dd></div>
        <div><dt>Screening authorized</dt><dd>${p.screening_authorized?'Yes':'No'}</dd></div>
        <div><dt>Settlement authorized</dt><dd>${p.settlement_authorized?'Yes':'No'}</dd></div>
        <div><dt>Custody authorized</dt><dd>${p.custody_authorized?'Yes':'No'}</dd></div>
        <div><dt>Linked transactions</dt><dd class="num">${linked}</dd></div>
        <div><dt>Created</dt><dd>${shortDate(p.created_at)}</dd></div>
      </dl>
      <p class="partner-note">Sandbox fixture only. No live commercial relationship represented.</p>
    </article>`;
  }).join('');
  return `<div class="ws-partners"><div class="ws-heading"><h1>Partners</h1><p>Qualification registry — sandbox fixtures only, no real commercial relationships.</p></div><div class="partner-cards">${cards||'<p class="muted">No partners found.</p>'}</div></div>`;
}

// ─── WORKSPACE: Verification ──────────────────────────────────────────────────
function verification() {
  const verifiable = state.intents.filter(i => ['SUBMITTED','REVIEW_REQUIRED','VERIFIED','EXCEPTION','RECONCILED'].includes(i.status));
  const sel = state.selectedIntentId;
  const selIntent = verifiable.find(i => i.id === sel) || verifiable[0];
  const list = verifiable.map(i => `<li>
    <button type="button" class="ev-item${selIntent?.id===i.id?' active':''}" data-select-intent="${escapeHtml(i.id)}">
      <span>${escapeHtml(i.public_reference)}</span>${statusBadge(i.status)}
    </button>
  </li>`).join('');
  const detailPanel = selIntent
    ? `<div class="ev-loading muted" data-evidence-intent="${escapeHtml(selIntent.id)}">Loading evidence for ${escapeHtml(selIntent.public_reference)}\u2026</div>`
    : `<div class="ev-empty"><p class="muted">No intent selected. Choose a submitted or verified transaction.</p></div>`;
  return `<div class="ws-verification">
    <div class="ws-heading"><h1>Verification</h1><p>Dual-observer evidence loaded from /api/payment-intents/:id/verification.</p></div>
    <div class="ev-layout">
      <aside class="ev-list-panel" aria-label="Transactions with evidence">
        <ul role="list">${list||'<li class="muted">No submitted or verified transactions.</li>'}</ul>
      </aside>
      <div class="ev-detail-panel" id="ev-detail-panel" aria-live="polite" aria-label="Evidence detail">${detailPanel}</div>
    </div>
  </div>`;
}

function renderEvidenceDetail(intent, evidence) {
  const [evA, evB] = evidence;
  if (!evA) {
    return `<div class="ev-empty-state">
      <p>No evidence rows recorded yet for ${escapeHtml(intent.public_reference)}.</p>
      <p class="muted">Evidence is written when /verify is called with dual observer data.</p>
      ${intentAction(intent)?.action==='verify' ? `<button type="button" class="btn-primary" data-action="verify" data-intent-id="${escapeHtml(intent.id)}">Submit dual observer evidence</button>` : ''}
    </div>`;
  }
  if (!evB) return `<pre class="muted">${escapeHtml(JSON.stringify(evidence,null,2))}</pre>`;
  const fields = ['rpc_provider','slot','commitment','signature','destination_wallet','raw_amount','mint'];
  const mismatch = fields.filter(f => String(evA[f]) !== String(evB[f]));
  const hasMismatch = mismatch.length > 0;
  const fRow = (label, keyA, keyB) => {
    const diff = String(evA[keyA??label]) !== String(evB[keyB??label]);
    return `<tr class="${diff?'field-mismatch':''}">
      <th scope="row">${escapeHtml(label)}</th>
      <td class="${diff?'mismatch-value':''}"><code>${escapeHtml(truncStr(String(evA[keyA??label]??'—'),28))}</code></td>
      <td class="${diff?'mismatch-value':''}"><code>${escapeHtml(truncStr(String(evB[keyB??label]??'—'),28))}</code></td>
      <td>${diff?'<span class="mismatch-flag">\u26A0 differs</span>':'<span class="match-flag">\u2713 match</span>'}</td>
    </tr>`;
  };
  const consensusCls = !hasMismatch && intent.status === 'VERIFIED' ? ' consensus-ok' : '';
  const action = intentAction(intent);
  return `<div class="ev-comparison${consensusCls}">
    <div class="ev-header">
      <h2>${escapeHtml(intent.public_reference)}</h2>${statusBadge(intent.status)}
      ${hasMismatch ? `<span class="mismatch-banner" role="alert">\u26A0 ${mismatch.length} field${mismatch.length>1?'s':''} disagree: ${mismatch.join(', ')}</span>` : '<span class="match-banner">\u2713 Observers agree</span>'}
    </div>
    <div class="ev-table-wrap">
      <table class="ev-table" aria-label="Observer evidence comparison">
        <thead><tr>
          <th scope="col">Field</th>
          <th scope="col">Observer A: ${escapeHtml(truncStr(evA.rpc_provider,20))}</th>
          <th scope="col">Observer B: ${escapeHtml(truncStr(evB.rpc_provider,20))}</th>
          <th scope="col">Agreement</th>
        </tr></thead>
        <tbody>
          ${fRow('Provider','rpc_provider','rpc_provider')}
          ${fRow('Slot','slot','slot')}
          ${fRow('Finality','commitment','commitment')}
          ${fRow('Signature (trunc.)','signature','signature')}
          ${fRow('Destination (trunc.)','destination_wallet','destination_wallet')}
          ${fRow('Raw amount','raw_amount','raw_amount')}
          ${fRow('Observed at','observed_at','observed_at')}
        </tbody>
      </table>
    </div>
    ${action ? `<div class="ev-actions">
      <button type="button" class="btn-primary" data-action="${action.action}" data-intent-id="${escapeHtml(intent.id)}">${escapeHtml(action.label)}</button>
      <p class="action-guard">Posts to the sandbox API. Appears in the audit log.</p>
    </div>` : ''}
  </div>`;
}

// ─── WORKSPACE: Reconciliation ────────────────────────────────────────────────
function reconciliation() {
  const eligible = state.intents.filter(i => ['VERIFIED','EXCEPTION','RECONCILED'].includes(i.status));
  if (!eligible.length) {
    return `<div class="ws-recon"><div class="ws-heading"><h1>Reconciliation</h1></div><p class="muted">No transactions have reached the verification stage yet.</p></div>`;
  }
  const cards = eligible.map(intent => {
    const cls = intent.status==='RECONCILED'?'recon-ok':intent.status==='EXCEPTION'?'recon-exception':'recon-pending';
    const action = intentAction(intent);
    return `<article class="recon-card ${cls}" aria-label="${escapeHtml(intent.public_reference)} reconciliation">
      <div class="recon-card-header">
        <strong>${escapeHtml(intent.public_reference)}</strong>${statusBadge(intent.status)}<span class="num">${money(intent.amount_usd_cents)}</span>
      </div>
      <div class="recon-amounts-placeholder" data-recon-intent="${escapeHtml(intent.id)}">
        ${['RECONCILED','EXCEPTION'].includes(intent.status)
          ? '<p class="recon-loading muted">Loading reconciliation record\u2026</p>'
          : `${action ? `<button type="button" class="btn-primary" data-action="${action.action}" data-intent-id="${escapeHtml(intent.id)}">${escapeHtml(action.label)}</button>` : ''}`}
      </div>
    </article>`;
  }).join('');
  return `<div class="ws-recon"><div class="ws-heading"><h1>Reconciliation</h1><p>POS / chain / partner / ledger four-way matching from actual sandbox records.</p></div><div class="recon-grid">${cards}</div></div>`;
}

function renderReconDetail(rec) {
  const exceptions = Array.isArray(rec.exceptions) ? rec.exceptions : [];
  return `<dl class="recon-amounts" aria-label="Reconciliation amounts">
    <div><dt>POS amount</dt><dd class="num">${money(rec.pos_amount_cents)}</dd></div>
    <div><dt>Chain raw amount</dt><dd class="num"><code>${escapeHtml(String(rec.chain_raw_amount))}</code></dd></div>
    <div><dt>Partner amount</dt><dd class="num">${money(rec.partner_amount_cents)}</dd></div>
    <div><dt>Ledger amount</dt><dd class="num">${money(rec.ledger_amount_cents)}</dd></div>
    <div><dt>Decision</dt><dd>${statusBadge(rec.status)}</dd></div>
    <div><dt>Recorded</dt><dd>${shortDate(rec.created_at)}</dd></div>
  </dl>
  ${exceptions.length ? `<div class="recon-exceptions" role="alert"><h4>Exceptions (${exceptions.length})</h4><ul>${exceptions.map(e=>`<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''}`;
}

// ─── WORKSPACE: Ledger ────────────────────────────────────────────────────────
function ledger() {
  const txs = state.ledger;
  const totalD = txs.reduce((s,t) => s+(t.debits_cents||0), 0);
  const totalC = txs.reduce((s,t) => s+(t.credits_cents||0), 0);
  const diff   = totalD - totalC;
  const balanced = diff === 0;
  const rows = txs.map(tx => {
    const entries = (tx.entries||[]).map(e => `<span class="${e.side.toLowerCase()}">${escapeHtml(e.account_code)}: ${money(e.amount_cents)} ${escapeHtml(e.side)}</span>`).join(' \u00B7 ');
    return `<tr>
      <td><strong>${escapeHtml(tx.public_reference||'—')}</strong><small>${shortDate(tx.created_at)}</small></td>
      <td class="num">${money(tx.debits_cents||0)}</td>
      <td class="num">${money(tx.credits_cents||0)}</td>
      <td class="num">${money(Math.abs((tx.debits_cents||0)-(tx.credits_cents||0)))}</td>
      <td><small class="ledger-entries">${entries}</small></td>
    </tr>`;
  }).join('');
  return `<div class="ws-ledger">
    <div class="ws-heading"><h1>Ledger</h1><p>Operational ledger entries. DEBIT = onchain settlement observed. CREDIT = merchant settlement pending.</p></div>
    <div class="ledger-summary" aria-label="Ledger totals">
      <div class="ledger-total"><span>Total debits</span><strong class="num">${money(totalD)}</strong></div>
      <div class="ledger-total"><span>Total credits</span><strong class="num">${money(totalC)}</strong></div>
      <div class="ledger-total${balanced?' ok':' err'}"><span>Difference</span><strong class="num">${money(diff)}</strong><small>${balanced?'Balanced':'OUT OF BALANCE'}</small></div>
    </div>
    <p class="ledger-note">No custody, transmission, or live settlement in this sandbox.</p>
    <div class="table-wrap">
      <table aria-label="Ledger transactions">
        <thead><tr><th>Transaction / intent</th><th class="num">Debits</th><th class="num">Credits</th><th class="num">Diff</th><th>Entries</th></tr></thead>
        <tbody>${rows||'<tr><td colspan="5" class="empty-row">No ledger transactions recorded yet. Complete a verification to create entries.</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── WORKSPACE: Audit ─────────────────────────────────────────────────────────
function audit() {
  const f = state.auditFilter;
  // Filter by selectedIntentId (audit scoping by aggregate_id)
  let filtered = state.selectedIntentId
    ? state.audit.filter(e => e.aggregate_id === state.selectedIntentId)
    : state.audit;
  if (f.type)  filtered = filtered.filter(e => e.action === f.type);
  if (f.actor) filtered = filtered.filter(e => e.actor.toLowerCase().includes(f.actor.toLowerCase()));

  const scopeEl = state.selectedIntentId
    ? `<div class="audit-scope-bar" role="status">
        Showing events for <strong>${escapeHtml(state.intents.find(i=>i.id===state.selectedIntentId)?.public_reference||state.selectedIntentId)}</strong>
        \u00B7 <button type="button" class="text-btn" id="clear-audit-scope">Show all events</button>
      </div>`
    : '';

  const eventTypes = [...new Set(state.audit.map(e => e.action))].sort();
  const actors     = [...new Set(state.audit.map(e => e.actor))].sort();
  const chainStatus = state.dashboard?.audit;

  const rows = filtered.map(event => {
    const ref = state.intents.find(i => i.id === event.aggregate_id)?.public_reference;
    return `<li class="audit-row">
      <span class="audit-seq">#${String(event.sequence).padStart(3,'0')}</span>
      <div class="audit-body">
        <strong>${escapeHtml(formatAction(event.action))}</strong>
        <small>${escapeHtml(event.aggregate_type||'')} \u00B7 ${escapeHtml(event.actor||'')} \u00B7 ${escapeHtml((event.event_hash||'').slice(0,12))}\u2026</small>
        ${ref ? `<small><button type="button" class="text-btn" data-nav-ws="transactions" data-nav-intent="${escapeHtml(event.aggregate_id)}">${escapeHtml(ref)}</button></small>` : ''}
      </div>
      <time class="audit-time">${shortDate(event.created_at)}</time>
    </li>`;
  }).join('');

  return `<div class="ws-audit">
    <div class="ws-heading">
      <h1>Audit</h1>
      <div class="audit-chain-status${chainStatus?.valid?' ok':' err'}" role="status">
        ${chainStatus?.valid?'\u2713 Chain valid':'\u26A0 Chain invalid'} \u00B7 ${chainStatus?.events_checked??0} events checked
      </div>
    </div>
    ${scopeEl}
    <div class="audit-filter-bar">
      <select id="audit-type-filter" aria-label="Filter by event type">
        <option value="">All event types</option>
        ${eventTypes.map(t => `<option value="${escapeHtml(t)}"${f.type===t?' selected':''}>${escapeHtml(formatAction(t))}</option>`).join('')}
      </select>
      <select id="audit-actor-filter" aria-label="Filter by actor">
        <option value="">All actors</option>
        ${actors.map(a => `<option value="${escapeHtml(a)}"${f.actor===a?' selected':''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <span class="audit-count">${filtered.length} of ${state.audit.length} events</span>
      <button type="button" class="btn-secondary" id="audit-export-btn">Export CSV</button>
    </div>
    <ol class="audit-events" aria-label="Audit event log">
      ${rows||'<li class="empty-row">No events match the current filters.</li>'}
    </ol>
  </div>`;
}

// ─── WORKSPACE: API & Events ──────────────────────────────────────────────────
function apiDocs() {
  const groups = [...new Set(API_ROUTES.map(r => r.group))];
  const sections = groups.map(group => {
    const routes = API_ROUTES.filter(r => r.group === group);
    const trows = routes.map(r => {
      const lat = state.latencies[r.path];
      return `<tr>
        <td><span class="method method-${r.method.toLowerCase()}">${r.method}</span></td>
        <td><code>${escapeHtml(r.path)}</code></td>
        <td>${escapeHtml(r.purpose)}</td>
        <td class="muted">${escapeHtml(r.guard)}</td>
        <td>${r.synthetic ? '<span class="synthetic-badge">fixture</span>' : ''}</td>
        <td>${lat ? `<span class="latency">${lat.ms}ms*</span>` : ''}</td>
      </tr>`;
    }).join('');
    return `<section class="api-group" aria-label="${group} API routes">
      <h2>${escapeHtml(group)}</h2>
      <div class="table-wrap"><table aria-label="${group} routes">
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th><th>Guard</th><th>Data</th><th>Latency*</th></tr></thead>
        <tbody>${trows}</tbody>
      </table></div>
    </section>`;
  }).join('');
  return `<div class="ws-api">
    <div class="ws-heading"><h1>API &amp; Events</h1><p>Active sandbox routes. Latency (*) is browser-observed only \u2014 not a production guarantee.</p></div>
    <p class="sandbox-note">All data is fictional sandbox data. Routes marked "fixture" use synthetic-only data. No live services or real cannabis transactions.</p>
    ${sections}
    <div class="api-verify-link">
      <a href="${BASE}/api/audit/verify" target="_blank" rel="noopener" class="btn-secondary">View audit chain JSON \u2197</a>
    </div>
  </div>`;
}

// ─── WORKSPACE: System Health ─────────────────────────────────────────────────
function health() {
  const d = state.dashboard;
  function stat(label, value, ok, note='') {
    return `<div class="health-item${ok?' ok':' err'}"><span class="health-label">${escapeHtml(label)}</span><strong class="health-value">${escapeHtml(String(value))}</strong>${note?`<small class="health-note">${escapeHtml(note)}</small>`:''}</div>`;
  }
  const lats = Object.entries(state.latencies).map(([p,v]) => `<li class="latency-row"><code>${escapeHtml(p)}</code><span class="num">${v.ms}ms</span><small>${shortDate(v.at)}</small></li>`).join('');
  return `<div class="ws-health">
    <div class="ws-heading"><h1>System Health</h1><p>Operational state from /api/health and /api/dashboard. Sandbox only \u2014 no live services.</p></div>
    <div class="health-grid">
      ${stat('Mode', d.mode, d.mode==='SANDBOX')}
      ${stat('Version', d.prototype_version, true)}
      ${stat('Live money movement', d.live_money_movement?'YES \u26A0':'No', !d.live_money_movement, 'Must always be No for sandbox')}
      ${stat('Customer PII collected', d.customer_pii_collected?'YES \u26A0':'No', !d.customer_pii_collected)}
      ${stat('Approved partners', d.approved_partners, d.approved_partners>0)}
      ${stat('Active merchants', d.active_merchants, d.active_merchants>0)}
      ${stat('Open runs', d.open_payment_intents, true, 'non-terminal intents')}
      ${stat('Ledger debits', money(d.ledger_debits_cents||0), true)}
      ${stat('Ledger credits', money(d.ledger_credits_cents||0), true)}
      ${stat('Ledger diff', money(d.ledger_difference_cents), d.ledger_difference_cents===0, 'must equal $0.00')}
      ${stat('Audit chain', d.audit?.valid?'VALID':'FAILED', d.audit?.valid, `${d.audit?.events_checked??0} events`)}
    </div>
    <section class="health-section" aria-label="Browser-observed API latencies">
      <h2>Browser-observed API latencies</h2>
      <p class="muted">Measured by this session only \u2014 not a production performance indicator.</p>
      <ul class="latency-list">${lats||'<li class="muted">No calls recorded yet.</li>'}</ul>
    </section>
    <section class="health-section" aria-label="Sandbox boundary assertions">
      <h2>Sandbox boundary assertions</h2>
      <ul class="assertion-list">
        <li>\u2713 GLP_SANDBOX=1 required at startup</li>
        <li>\u2713 No credentials, keys, or live provider connections</li>
        <li>\u2713 No real wallet, chain, or cannabis transaction</li>
        <li>\u2713 No customer PII collected at any route</li>
        <li>\u2713 Checkout tokens travel only in URL fragments, never in server logs</li>
      </ul>
    </section>
  </div>`;
}

// ─── WORKSPACE: Command Terminal ──────────────────────────────────────────────
function terminal() {
  if (!state.terminalLines.length) resetTerminalLines();
  return `<div class="ws-terminal">
    <div class="ws-heading"><h1>Command Terminal</h1><p>Sandbox command interface. No filesystem, shell, or package access.</p></div>
    <div class="terminal-panel" role="log" aria-label="Terminal output">
      <div class="terminal-toolbar">
        <span class="terminal-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="terminal-title">glp-ops \u2014 sandbox command terminal</span>
        <div class="terminal-controls">
          <button type="button" id="term-json-mode" aria-pressed="${state.cmdJsonMode}" class="${state.cmdJsonMode?'active':''}">JSON</button>
          <button type="button" id="term-copy-btn" aria-label="Copy output">Copy</button>
          <button type="button" id="term-clear-btn" aria-label="Clear terminal">Clear</button>
        </div>
      </div>
      <div class="terminal-output" id="terminal-output" aria-live="polite" aria-atomic="false">${terminalLinesMarkup()}</div>
      <form class="terminal-form" id="terminal-form" aria-label="Command input">
        <label for="terminal-input">
          <span class="term-prompt" aria-hidden="true">glp@sandbox:~$</span>
          <input id="terminal-input" name="command" type="text" autocomplete="off"
            autocapitalize="none" spellcheck="false" placeholder="type help"
            aria-label="Enter command" list="term-suggestions">
        </label>
        <datalist id="term-suggestions">
          <option value="help"><option value="status"><option value="refresh">
          <option value="intents"><option value="inspect"><option value="queues">
          <option value="verify"><option value="recon"><option value="ledger">
          <option value="balance"><option value="merchant"><option value="partner">
          <option value="controls"><option value="audit"><option value="routes">
          <option value="health"><option value="clear"><option value="export">
        </datalist>
        <button type="submit" class="term-run-btn">RUN</button>
      </form>
    </div>
    <div class="terminal-hints">
      <p>help \u00B7 status \u00B7 refresh \u00B7 intents [--status=] \u00B7 inspect &lt;ref&gt; \u00B7 queues \u00B7 verify &lt;ref&gt; [--confirm] \u00B7 recon &lt;ref&gt; [--confirm] \u00B7 ledger \u00B7 balance \u00B7 merchant [id] \u00B7 partner [id] \u00B7 controls [merchant-id] \u00B7 audit [--intent=] [--type=] \u00B7 routes \u00B7 health \u00B7 clear \u00B7 export</p>
      <p class="muted">\u2191\u2193 command history \u00B7 state-changing commands require --confirm \u00B7 JSON mode toggles structured output</p>
    </div>
  </div>`;
}

// ─── Terminal engine ──────────────────────────────────────────────────────────
function terminalTimestamp() {
  return new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
function terminalLinesMarkup() {
  return state.terminalLines.map(line => {
    if (line.command) {
      return `<div class="term-line term-cmd"><span class="term-ts">${line.ts}</span><span class="term-prompt-inline">glp@sandbox:~$</span><span class="term-cmd-text"> ${escapeHtml(line.value)}</span></div>`;
    }
    const content = typeof line.value === 'string'
      ? escapeHtml(line.value)
      : `<pre>${escapeHtml(JSON.stringify(line.value,null,2))}</pre>`;
    return `<div class="term-line${line.tone ? ' ' + line.tone : ''}"><span class="term-ts">${line.ts}</span><span class="term-content">${content}</span></div>`;
  }).join('');
}
function renderTerminalOutput({ scrollToEnd = false } = {}) {
  const termEl = $('#terminal-output');
  if (!termEl) return;
  const wasAtEnd = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 2;
  termEl.innerHTML = terminalLinesMarkup();
  if (scrollToEnd || wasAtEnd) termEl.scrollTop = termEl.scrollHeight;
}
function addTerminalLine(value, tone = '', command = false) {
  state.terminalLines.push({ value, tone, command, ts: terminalTimestamp() });
  if (state.terminalLines.length > 200) state.terminalLines.splice(0, state.terminalLines.length - 200);
  renderTerminalOutput({ scrollToEnd: true });
}
function termPrint(output, tone = '') {
  addTerminalLine(output, tone);
}
function termPrintCmd(cmd) {
  addTerminalLine(cmd, '', true);
}
function resetTerminalLines() {
  state.terminalLines = [
    { value: `GREEN LIGHT PAY OPERATIONS TERMINAL — prototype ${DEV_VERSION}`, tone: 'term-info', command: false, ts: terminalTimestamp() },
    { value: 'Boundary: sandbox orchestration + verification. live_money_movement=false', tone: 'term-muted', command: false, ts: terminalTimestamp() },
    { value: 'Type help for available commands. No filesystem, shell, or package access.', tone: 'term-muted', command: false, ts: terminalTimestamp() },
  ];
}
function bootTerminal() {
  resetTerminalLines();
  renderTerminalOutput({ scrollToEnd: true });
}

async function executeCommand(cmd) {
  const normalized = cmd.trim();
  if (!normalized) return false;
  termPrintCmd(normalized);
  const parts = normalized.split(/\s+/);
  const verb  = parts[0].toLowerCase();
  const args  = parts.slice(1);
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^-{1,2}([a-z_-]+)=?(.*)$/i);
    if (m) flags[m[1]] = m[2] || true;
    else positional.push(arg);
  }
  // Success is derived from the tone actually printed rather than from a boolean
  // returned at each of the ~25 exit points below. Several error paths used to
  // `return` undefined, which the caller read as success and wiped the command
  // the user needed to correct. Deriving it here means a newly added command
  // cannot silently regress the "clear only on success" contract.
  const print = (v, tone='') => {
    if (tone === 'term-error' || tone === 'term-warn') state.terminalLastFailed = true;
    termPrint(v, tone);
  };

  // Shell command prohibition: GLP terminal does not provide filesystem or execution access.
  if (SHELL_CMDS.has(verb)) {
    print(`The GLP terminal does not provide filesystem, shell, package, or arbitrary execution access. Type help for available commands.`, 'term-error');
    return false;
  }

  try {
    if (verb === 'help') {
      print([
        'AVAILABLE COMMANDS:',
        '  help                       \u2014 this help text',
        '  status                     \u2014 system boundary + integrity',
        '  refresh                    \u2014 reload all records',
        '  intents [--status=X]       \u2014 list payment runs',
        '  inspect <reference>        \u2014 show one intent (sanitized)',
        '  queues                     \u2014 queue bucket counts',
        '  verify <ref> [--confirm]   \u2014 dual observer evidence (requires --confirm)',
        '  recon  <ref> [--confirm]   \u2014 reconcile a verified run (requires --confirm)',
        '  ledger                     \u2014 ledger transaction list',
        '  balance                    \u2014 ledger totals and difference',
        '  merchant [id|dba]          \u2014 merchant record (sanitized)',
        '  partner  [id]              \u2014 partner record',
        '  controls [merchant-id]     \u2014 merchant controls JSON',
        '  audit [--intent=X] [--type=X] \u2014 audit log (filtered)',
        '  routes                     \u2014 API route summary',
        '  health                     \u2014 health + boundary assertions',
        '  clear                      \u2014 clear terminal output',
        '  export                     \u2014 sanitized JSON snapshot (no tokens)',
      ].join('\n'), 'term-info');
      return;
    }
    if (verb === 'clear') { bootTerminal(); return; }
    if (verb === 'refresh') {
      const refreshed = await loadAll({quiet:true});
      if (refreshed === false) { print('Refresh failed; records may be stale.', 'term-error'); return false; }
      print('Records refreshed.', 'term-info');
      return;
    }
    if (verb === 'status') { print(state.dashboard, ''); return; }
    if (verb === 'health') { print(await api('/api/health'), ''); return; }
    if (verb === 'intents') {
      let list = state.intents;
      if (flags.status) list = list.filter(i => i.status === String(flags.status).toUpperCase());
      print(list.map(({public_reference,amount_usd_cents,status,store_id}) => ({public_reference,amount_usd:money(amount_usd_cents),status,store_id})), '');
      return;
    }
    if (verb === 'inspect') {
      const key = positional.join(' ').toUpperCase();
      const found = state.intents.find(i => i.public_reference.toUpperCase()===key || i.id===positional[0]);
      if (!found) { print(`intent not found: "${positional.join(' ')}". Use intents to list references.`, 'term-error'); return; }
      // Exclude checkout token material from output
      const {checkout_token:_t, checkout_token_hash:_h, ...safe} = found;
      print(safe, '');
      return;
    }
    if (verb === 'queues') {
      const result = {};
      for (const [k,statuses] of Object.entries(QUEUE_GROUPS)) {
        result[k] = state.intents.filter(i=>statuses.includes(i.status)).map(i=>i.public_reference);
      }
      print(result, '');
      return;
    }
    if (verb === 'ledger') {
      const resp = await api('/api/ledger?limit=100');
      print((resp.transactions||[]).map(t => ({reference:t.public_reference,debits:money(t.debits_cents||0),credits:money(t.credits_cents||0),balanced:t.balanced})), '');
      return;
    }
    if (verb === 'balance') {
      const d = state.ledger.reduce((s,t)=>s+(t.debits_cents||0),0);
      const c = state.ledger.reduce((s,t)=>s+(t.credits_cents||0),0);
      print({total_debits:money(d),total_credits:money(c),difference:money(d-c),balanced:d===c,ledger_tx_count:state.ledger.length}, '');
      return;
    }
    if (verb === 'merchant') {
      const key = positional.join(' ').toLowerCase();
      const found = key
        ? state.merchants.find(m=>m.id===positional[0]||m.dba.toLowerCase().includes(key))
        : state.merchants[0];
      if (!found) { print('merchant not found', 'term-error'); return; }
      const {settlement_wallet:_w, ...safe} = found;
      print(safe, '');
      return;
    }
    if (verb === 'partner') {
      const key = positional[0];
      const found = key
        ? state.partners.find(p=>p.id===key||p.legal_name.toLowerCase().includes(key.toLowerCase()))
        : state.partners[0];
      if (!found) { print('partner not found', 'term-error'); return; }
      print(found, '');
      return;
    }
    if (verb === 'controls') {
      const key = positional[0];
      const found = key ? state.merchants.find(m=>m.id===key) : state.merchants[0];
      if (!found) { print('merchant not found', 'term-error'); return; }
      print(found.controls, '');
      return;
    }
    if (verb === 'audit') {
      let events = state.audit;
      if (flags.intent) events = events.filter(e => e.aggregate_id===flags.intent || state.intents.find(i=>i.id===e.aggregate_id)?.public_reference?.toLowerCase().includes(String(flags.intent).toLowerCase()));
      if (flags.type) events = events.filter(e => e.action===String(flags.type).toUpperCase());
      print(events.slice(0,50).map(e=>({sequence:e.sequence,action:e.action,actor:e.actor,aggregate_type:e.aggregate_type,created_at:e.created_at,event_hash:(e.event_hash||'').slice(0,16)+'\u2026'})), '');
      return;
    }
    if (verb === 'routes') {
      print(API_ROUTES.map(r=>`${r.method.padEnd(6)} ${r.path.padEnd(45)} ${r.purpose}`).join('\n'), 'term-info');
      return;
    }
    if (verb === 'verify') {
      const key = positional[0]?.toUpperCase();
      const found = key ? state.intents.find(i=>i.public_reference===key||i.id===positional[0]) : null;
      if (!found) { print('specify a valid intent reference: verify <reference> [--confirm]', 'term-error'); return; }
      if (found.status !== 'SUBMITTED') { print(`intent status is ${found.status}; verify requires SUBMITTED`, 'term-error'); return; }
      if (!flags.confirm) { print(`State-changing command requires --confirm.\nExample: verify ${found.public_reference} --confirm\nThis will post dual observer evidence and appear in the audit log.`, 'term-warn'); return; }
      const merchant = state.merchants.find(m=>m.id===found.merchant_id);
      const slot = 312_000_000 + Math.floor(Math.random() * 500_000);
      const ev = { signature:found.signature, commitment:merchant?.controls?.required_commitment||'FINALIZED', tokenProgram:found.expected_token_program, mint:found.expected_mint, sourceWallet:found.source_wallet, destinationWallet:found.expected_destination, rawAmount:found.expected_raw_amount, slot, transactionError:false };
      const result = await api(`/api/payment-intents/${encodeURIComponent(found.id)}/verify`, {method:'POST',actor:'developer-ops-terminal',body:JSON.stringify({primary:{...ev,rpcProvider:'ops-watcher-a'},secondary:{...ev,rpcProvider:'ops-watcher-b'}})});
      await loadAll({quiet:true});
      print({outcome:result.verified?'VERIFIED':'REVIEW_REQUIRED',mismatches:result.mismatches||[]}, 'term-info');
      return;
    }
    if (verb === 'recon') {
      const key = positional[0]?.toUpperCase();
      const found = key ? state.intents.find(i=>i.public_reference===key||i.id===positional[0]) : null;
      if (!found) { print('specify a valid intent reference: recon <reference> [--confirm]', 'term-error'); return; }
      if (!['VERIFIED','EXCEPTION'].includes(found.status)) { print(`intent status is ${found.status}; recon requires VERIFIED or EXCEPTION`, 'term-error'); return; }
      if (!flags.confirm) { print(`State-changing command requires --confirm.\nExample: recon ${found.public_reference} --confirm\nThis will post reconciliation and appear in the audit log.`, 'term-warn'); return; }
      const result = await api(`/api/payment-intents/${encodeURIComponent(found.id)}/reconcile`, {method:'POST',actor:'developer-ops-terminal',body:JSON.stringify({posAmountCents:found.amount_usd_cents,chainRawAmount:found.expected_raw_amount,partnerAmountCents:found.amount_usd_cents})});
      await loadAll({quiet:true});
      print({outcome:result.intent?.status,reconciliation_status:result.reconciliation?.status||'\u2014'}, 'term-info');
      return;
    }
    if (verb === 'export') {
      // Checkout tokens and sensitive fields are explicitly excluded from this export.
      const snapshot = {
        exported_at: new Date().toISOString(),
        mode: state.dashboard?.mode,
        prototype_version: state.dashboard?.prototype_version,
        live_money_movement: false,
        sandbox_only: true,
        intents: state.intents.map(({id,public_reference,amount_usd_cents,status,store_id,register_id,created_at,updated_at,partner_decision,status_reason}) =>
          ({id,public_reference,amount_usd_cents,status,store_id,register_id,created_at,updated_at,partner_decision,status_reason})),
        ledger_summary: {debits:state.ledger.reduce((s,t)=>s+(t.debits_cents||0),0),credits:state.ledger.reduce((s,t)=>s+(t.credits_cents||0),0)},
        audit_chain_valid: state.dashboard?.audit?.valid,
      };
      const exportFilename = `glp-export-${new Date().toISOString().slice(0, 10)}.json`;
      const exportBlob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const exportAnchor = document.createElement('a');
      exportAnchor.href = URL.createObjectURL(exportBlob);
      exportAnchor.download = exportFilename;
      exportAnchor.click();
      URL.revokeObjectURL(exportAnchor.href);
      print(`Downloaded ${exportFilename} — ${snapshot.intents.length} intent(s), tokens excluded.`, 'term-info');
      return;
    }
    print(`Unknown command: "${verb}". Type help for available commands.`, 'term-error');
    return false;
  } catch (err) {
    print(`${err.code?err.code+': ':''}${err.message}`, 'term-error');
    return false;
  }
}

// ─── Command palette ──────────────────────────────────────────────────────────
function openPalette() {
  const overlay = $('#palette-overlay');
  if (!overlay) return;
  overlay.removeAttribute('hidden');
  const inp = $('#palette-input');
  if (inp) { inp.value = ''; inp.focus(); renderPaletteResults(''); }
}
function closePalette() {
  const overlay = $('#palette-overlay');
  // Guard: if palette is already closed, do not steal focus from whatever the user
  // is currently interacting with (e.g. the terminal input).
  if (!overlay || overlay.hasAttribute('hidden')) return;
  overlay.setAttribute('hidden', '');
  $('#palette-btn')?.focus();
}
function renderPaletteResults(query) {
  const results = $('#palette-results');
  if (!results) return;
  const ql = query.toLowerCase();
  const wsOpts = WORKSPACES.map(ws => ({type:'workspace',label:formatAction(ws),value:ws}));
  const txOpts = state.intents.filter(i => !ql || i.public_reference.toLowerCase().includes(ql)).slice(0,8)
    .map(i => ({type:'intent',label:`${i.public_reference} \u00B7 ${i.status}`,value:i.id}));
  const opts = [...wsOpts.filter(o => !ql||o.label.toLowerCase().includes(ql)), ...txOpts].slice(0,12);
  results.innerHTML = opts.map((o,idx) =>
    `<li role="option" id="pr-${idx}"><button type="button" class="palette-result" data-palette-type="${o.type}" data-palette-value="${escapeHtml(o.value)}">
      <span class="pr-type">${o.type==='workspace'?'Go to':'View'}</span>
      <span class="pr-label">${escapeHtml(o.label)}</span>
    </button></li>`
  ).join('');
}

// ─── Workspace event binding ──────────────────────────────────────────────────
function bindWorkspaceEvents() {
  const root = $('#workspace-root');
  if (!root) return;

  // Intent row keyboard interaction
  const intentRows = $('#intent-rows');
  if (intentRows) {
    intentRows.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('tr[data-row-intent-id]');
      if (!row) return;
      event.preventDefault();
      selectIntent(row.dataset.rowIntentId);
    });
    intentRows.addEventListener('click', (event) => {
      if (event.target.closest('[data-action]')) return;
      const row = event.target.closest('tr[data-row-intent-id]');
      if (row) selectIntent(row.dataset.rowIntentId);
    });
  }

  // Transaction filter inputs
  const txQ = $('#tx-q');
  if (txQ) txQ.addEventListener('input', () => {
    // Save cursor position before the full re-render destroys this DOM node,
    // then restore focus + caret so the user can keep typing without re-clicking.
    const pos = txQ.selectionStart;
    state.txFilter.q = txQ.value;
    renderCurrentWorkspace();
    const newQ = $('#tx-q');
    if (newQ) { newQ.focus(); newQ.setSelectionRange(pos, pos); }
  });
  const txStatus = $('#tx-status');
  if (txStatus) txStatus.addEventListener('change', () => { state.txFilter.status = txStatus.value; renderCurrentWorkspace(); });
  const txMerchant = $('#tx-merchant');
  if (txMerchant) txMerchant.addEventListener('change', () => { state.txFilter.merchantId = txMerchant.value; renderCurrentWorkspace(); });
  const txClear = $('#tx-clear');
  if (txClear) txClear.addEventListener('click', () => { state.txFilter = {q:'',status:'',merchantId:'',sort:'created_at',dir:'desc'}; renderCurrentWorkspace(); });
  $$('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.sort;
      if (state.txFilter.sort === col) state.txFilter.dir = state.txFilter.dir==='asc'?'desc':'asc';
      else { state.txFilter.sort = col; state.txFilter.dir = 'desc'; }
      renderCurrentWorkspace();
    });
  });

  // Audit filters
  const auditType = $('#audit-type-filter');
  if (auditType) auditType.addEventListener('change', () => { state.auditFilter.type = auditType.value; renderCurrentWorkspace(); });
  const auditActor = $('#audit-actor-filter');
  if (auditActor) auditActor.addEventListener('change', () => { state.auditFilter.actor = auditActor.value; renderCurrentWorkspace(); });

  // Merchant controls form
  const controlsForm = $('#controls-form');
  if (controlsForm) {
    controlsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const merchant = state.merchants.find(m=>m.id===state.selectedMerchantId)||state.merchants[0];
      if (!merchant) return;
      const controls = merchant.controls;
      const fd = new FormData(event.currentTarget);
      const btn = controlsForm.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        await api(`/api/merchants/${encodeURIComponent(merchant.id)}/controls`, {
          method:'PATCH', actor:'developer-merchant-operator',
          body: JSON.stringify({
            paused: fd.get('paused')==='on',
            perTransactionLimitCents: Math.round(Number(fd.get('perTransaction'))*100),
            dailyLimitCents: Math.round(Number(fd.get('daily'))*100),
            allowedAssetCode: controls.allowed_asset_code,
            allowedMint: controls.allowed_mint,
            tokenProgram: controls.token_program,
            requiredCommitment: fd.get('commitment'),
            storeIds: controls.store_ids,
            registerIds: controls.register_ids
          })
        });
        await loadAll({quiet:true});
        toast('Merchant controls saved and audit-linked.');
      } catch (err) {
        toast(`${err.code||'ERROR'}: ${err.message}`, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // Terminal form + controls
  const termForm = $('#terminal-form');
  if (termForm) {
    const termInput = $('#terminal-input');

    // The state-backed guard survives an explicit workspace re-render while a command awaits.
    termForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.terminalBusy) return;
      const cmd = termInput?.value || '';
      if (!cmd.trim()) return;
      state.terminalBusy = true;
      if (cmd.trim()) { state.cmdHistory.push(cmd); state.cmdHistoryIdx = state.cmdHistory.length; }
      try {
        state.terminalLastFailed = false;
        await executeCommand(cmd);
        // Only clear on a successful command, so a command that needs correcting
        // (bad reference, missing --confirm, failed refresh) stays editable in place.
        // If the user typed during an awaited command, preserve that newer text.
        const currentInput = $('#terminal-input');
        if (!state.terminalLastFailed && currentInput?.value === cmd) currentInput.value = '';
      } finally {
        state.terminalBusy = false;
        // Return focus to the input so the user can type the next command without
        // having to click again (covers both Enter-to-submit and RUN-button paths).
        $('#terminal-input')?.focus();
      }
    });

    termInput?.addEventListener('keydown', (event) => {
      // Do not intercept keys during IME composition — mobile autocorrect needs
      // to resolve before ArrowUp/Down history navigation is meaningful.
      if (event.isComposing) return;
      if (event.key === 'ArrowUp' && state.cmdHistory.length) {
        event.preventDefault();
        state.cmdHistoryIdx = Math.max(0, state.cmdHistoryIdx-1);
        termInput.value = state.cmdHistory[state.cmdHistoryIdx] || '';
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.cmdHistoryIdx = Math.min(state.cmdHistory.length, state.cmdHistoryIdx+1);
        termInput.value = state.cmdHistory[state.cmdHistoryIdx] || '';
      }
    });

    // Opening the iOS keyboard shrinks the visual viewport without moving the
    // layout, which can leave the command row and RUN button behind the keyboard.
    // 'nearest' scrolls the minimum amount, so this does not fight the keyboard.
    termInput?.addEventListener('focus', () => {
      requestAnimationFrame(() => termForm.scrollIntoView({ block: 'nearest' }));
    });
  }

  // Delegated clicks for workspace-level interactions
  if (root.dataset.workspaceDelegationBound === 'true') return;
  root.dataset.workspaceDelegationBound = 'true';
  root.addEventListener('click', async (event) => {
    // Nav buttons (data-nav-ws)
    const navBtn = event.target.closest('[data-nav-ws]');
    if (navBtn) {
      navigateTo(navBtn.dataset.navWs, {intentId: navBtn.dataset.navIntent || undefined});
      return;
    }
    // Row actions (screen / verify / reconcile)
    const actionBtn = event.target.closest('[data-action][data-intent-id]');
    if (actionBtn && !actionBtn.disabled) {
      actionBtn.disabled = true;
      try { await runIntentAction(actionBtn.dataset.intentId, actionBtn.dataset.action); }
      catch (err) { toast(`${err.code||'ERROR'}: ${err.message}`, true); }
      finally { actionBtn.disabled = false; }
      return;
    }
    // Evidence intent selector
    const evBtn = event.target.closest('[data-select-intent]');
    if (evBtn) { state.selectedIntentId = evBtn.dataset.selectIntent; loadEvidenceForIntent(evBtn.dataset.selectIntent); return; }
    // Audit scope clear (clear-audit-scope must be an id for test)
    if (event.target.id === 'clear-audit-scope') { state.selectedIntentId = null; state.auditFilter.intentId = null; renderCurrentWorkspace(); return; }
    // Merchant selector
    const mBtn = event.target.closest('[data-merchant-id]');
    if (mBtn) { state.selectedMerchantId = mBtn.dataset.merchantId; renderCurrentWorkspace(); return; }
    // Audit export
    if (event.target.id === 'audit-export-btn') { exportAuditCsv(); return; }
    // Terminal controls
    if (event.target.id === 'term-clear-btn') { bootTerminal(); return; }
    if (event.target.id === 'term-json-mode') {
      state.cmdJsonMode = !state.cmdJsonMode;
      event.target.classList.toggle('active', state.cmdJsonMode);
      event.target.setAttribute('aria-pressed', String(state.cmdJsonMode));
      return;
    }
    if (event.target.id === 'term-copy-btn') {
      const out = $('#terminal-output');
      if (out) navigator.clipboard?.writeText(out.innerText).then(()=>toast('Copied.')).catch(()=>toast('Copy not available.',true));
      return;
    }
    // Retry button on error state
    if (event.target.id === 'retry-load') { loadAll().catch(err=>toast(err.message,true)); return; }
    // Palette results
    const paletteBtn = event.target.closest('.palette-result');
    if (paletteBtn) {
      closePalette();
      if (paletteBtn.dataset.paletteType==='workspace') navigateTo(paletteBtn.dataset.paletteValue);
      else if (paletteBtn.dataset.paletteType==='intent') navigateTo('transactions',{intentId:paletteBtn.dataset.paletteValue});
      return;
    }
  });
}

function selectIntent(intentId) {
  state.selectedIntentId = state.selectedIntentId === intentId ? null : intentId;
  renderCurrentWorkspace();
}

// ─── Intent actions ───────────────────────────────────────────────────────────
async function runIntentAction(intentId, action) {
  const intent   = state.intents.find(i => i.id === intentId);
  const merchant = state.merchants.find(m => m.id === intent?.merchant_id);
  if (!intent) return;
  if (action === 'screen') {
    await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/screen`, {method:'POST',actor:'developer-partner-fixture',body:JSON.stringify({decision:'APPROVE',partnerReference:`dev-screen-${crypto.randomUUID()}`})});
  }
  if (action === 'verify') {
    const slot = 312_000_000 + Math.floor(Math.random() * 500_000);
    const ev = {signature:intent.signature,commitment:merchant?.controls?.required_commitment||'FINALIZED',tokenProgram:intent.expected_token_program,mint:intent.expected_mint,sourceWallet:intent.source_wallet,destinationWallet:intent.expected_destination,rawAmount:intent.expected_raw_amount,slot,transactionError:false};
    await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/verify`, {method:'POST',actor:'developer-verifier',body:JSON.stringify({primary:{...ev,rpcProvider:'dev-watcher-a'},secondary:{...ev,rpcProvider:'dev-watcher-b'}})});
  }
  if (action === 'reconcile') {
    await api(`/api/payment-intents/${encodeURIComponent(intent.id)}/reconcile`, {method:'POST',actor:'developer-reconciler',body:JSON.stringify({posAmountCents:intent.amount_usd_cents,chainRawAmount:intent.expected_raw_amount,partnerAmountCents:intent.amount_usd_cents})});
  }
  await loadAll({quiet:true});
  toast(`${intent.public_reference}: ${action} completed.`);
}

// ─── Evidence loader (async) ──────────────────────────────────────────────────
async function loadEvidenceForIntent(intentId) {
  const panel = $('#ev-detail-panel');
  if (!panel) return;
  const intent = state.intents.find(i => i.id === intentId);
  if (!intent) return;
  try {
    const result = await api(`/api/payment-intents/${encodeURIComponent(intentId)}/verification`);
    panel.innerHTML = renderEvidenceDetail(intent, result.evidence || []);
    bindWorkspaceEvents();
  } catch (err) {
    panel.innerHTML = `<p class="term-error evidence-load-error">${escapeHtml(err.message)}</p>`;
  }
}

// ─── Reconciliation loader ────────────────────────────────────────────────────
async function loadReconciliationCards() {
  for (const el of $$('[data-recon-intent]')) {
    const intentId = el.dataset.reconIntent;
    const intent = state.intents.find(i => i.id === intentId);
    if (!intent || !['RECONCILED','EXCEPTION'].includes(intent.status)) continue;
    try {
      const result = await api(`/api/payment-intents/${encodeURIComponent(intentId)}/reconciliation`);
      if (result.reconciliation) el.innerHTML = renderReconDetail(result.reconciliation);
    } catch { /* not yet available */ }
  }
}

// ─── Audit CSV export ─────────────────────────────────────────────────────────
function exportAuditCsv() {
  const events = state.selectedIntentId
    ? state.audit.filter(e => e.aggregate_id === state.selectedIntentId)
    : state.audit;
  // Sanitize: exclude checkout token fields and sensitive payload material.
  const rows = [['sequence','action','actor','aggregate_type','aggregate_id','event_hash','created_at']];
  for (const e of events) {
    rows.push([e.sequence,e.action,e.actor,e.aggregate_type,e.aggregate_id,(e.event_hash||'').slice(0,16)+'\u2026',e.created_at]);
  }
  const csv = rows.map(r => r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = `glp-audit-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Audit CSV exported. Tokens excluded.');
}

// ─── Global event listeners ───────────────────────────────────────────────────
document.addEventListener('click', (event) => {
  const railBtn = event.target.closest('.rail-item[data-workspace]');
  if (railBtn) { navigateTo(railBtn.dataset.workspace); return; }
  const toggle = event.target.closest('#rail-toggle');
  if (toggle) {
    const rail = $('#op-rail');
    if (rail) {
      const collapsed = rail.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    return;
  }
  if (event.target.id === 'refresh-btn') { loadAll().catch(e=>toast(e.message,true)); return; }
  if (event.target.id === 'palette-btn') { openPalette(); return; }
  if (event.target.id === 'palette-overlay') { closePalette(); return; }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'palette-input') renderPaletteResults(event.target.value);
});
document.addEventListener('keydown', (event) => {
  // Skip during IME composition so autocorrect/input method characters are not
  // intercepted mid-word on mobile keyboards.
  if (event.isComposing) return;
  if ((event.metaKey||event.ctrlKey) && event.key === 'k') { event.preventDefault(); openPalette(); return; }
  if (event.key === 'Escape') closePalette();
});
window.addEventListener('hashchange', () => {
  const ws = location.hash.slice(1).split('?')[0];
  if (WORKSPACES.includes(ws)) navigateTo(ws);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function bootOps() {
  const hashWs = location.hash.slice(1).split('?')[0];
  const hashParams = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  state.workspace = WORKSPACES.includes(hashWs) ? hashWs : 'overview';
  const hashIntent = hashParams.get('intent');
  if (hashIntent) state.selectedIntentId = hashIntent;
  updateNavActive();
  loadAll({quiet:true})
    .then(() => {
      if (state.workspace === 'reconciliation') loadReconciliationCards();
      if (state.workspace === 'verification' && state.selectedIntentId) loadEvidenceForIntent(state.selectedIntentId);
      // Auto-refresh every 10 seconds + 1-second stale ticker
      staleTickerTimer = setInterval(updateStaleIndicator, 1_000);
      autoRefreshTimer = setInterval(() => loadAll({quiet:true}).catch(()=>{}), 10_000);
    })
    .catch(err => toast(`Boot failed: ${err.message}`, true));
})();
