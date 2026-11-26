const baseMeta = document.querySelector('meta[name="glp-base"]')?.getAttribute('content') || '';
const BASE = baseMeta.startsWith('__') ? '' : baseMeta;
const home = `${BASE}/`;

const params = new URLSearchParams(location.search);
const intentId = params.get('id');
// The one-time capability travels ONLY in the URL fragment, which never
// reaches the server, its logs, or any Referer header. It is exchanged with
// the API exclusively through the Authorization header.
const token = new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token');
const legacyQueryToken = params.has('token');
const content = document.querySelector('#checkout-content');
const clock = document.querySelector('#checkout-clock');
const toastElement = document.querySelector('#toast');
let session = null;
let timer = null;
let busy = false;

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

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-GLP-Actor': 'customer-handoff-sandbox',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'The sandbox request failed.');
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

let toastTimer;
function toast(message, error = false) {
  toastElement.textContent = message;
  toastElement.classList.toggle('error', error);
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 3800);
}

function remaining() {
  if (!session?.checkout_expires_at) return '—';
  const milliseconds = new Date(session.checkout_expires_at).getTime() - Date.now();
  if (milliseconds <= 0) return 'EXPIRED';
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function render() {
  content.setAttribute('aria-busy', String(busy));
  clock.textContent = remaining();
  if (!session) return;
  if (session.can_authorize) {
    content.innerHTML = `<div>
      <div class="wallet-intro"><i>W</i><div><strong>Customer-owned sandbox wallet</strong><small>Fictional partner handoff</small></div></div>
      <div class="merchant-heading"><p>Payment requested by</p><h1 id="checkout-title">${escapeHtml(session.merchant.dba)}</h1><span>${escapeHtml(session.merchant.state)} · ${escapeHtml(session.merchant.license_category.replace('_', ' '))} sandbox</span></div>
      <div class="checkout-total"><span>Exact authorized total</span><strong>${money(session.amount_usd_cents)}</strong><small>${escapeHtml(session.asset_code)}</small></div>
      <div class="checkout-facts"><div><span>Request</span><strong>${escapeHtml(session.public_reference)}</strong></div><div><span>Counter</span><strong>${escapeHtml(session.store_id)} / ${escapeHtml(session.register_id)}</strong></div><div><span>Mode</span><strong>NO LIVE FUNDS</strong></div></div>
      <button class="authorize-button" id="authorize" type="button" ${busy ? 'disabled' : ''}>Approve fictional payment</button>
      <p class="authorization-note">This records a deterministic sandbox signature. It does not connect a real wallet, debit an account, move value, or authorize product release.</p>
    </div>`;
    return;
  }
  if (['SUBMITTED', 'VERIFIED', 'RECONCILED'].includes(session.status)) {
    content.innerHTML = `<div class="success-state"><div class="result-mark">✓</div><div class="status-pill">${escapeHtml(session.status)}</div><h1>${session.status === 'RECONCILED' ? 'The records are closed.' : 'Signature returned.'}</h1><p>${session.status === 'SUBMITTED' ? 'Return to the counter. Green Light Pay still has to verify the evidence and reconcile every record before the run can complete.' : 'The counter has advanced this fictional request through its controlled path.'}</p><a class="return-button" href="${escapeHtml(home)}">Return to Green Light Pay</a></div>`;
    return;
  }
  if (session.status === 'SCREENING_REQUIRED' || session.status === 'REVIEW_REQUIRED') {
    content.innerHTML = `<div class="blocked-state"><div class="result-mark">!</div><div class="status-pill">AWAITING PARTNER GATE</div><h1>The handoff is not open yet.</h1><p>The counter must complete the qualified-partner step before this one-time request can be authorized. This page will keep checking.</p><a class="return-button" href="${escapeHtml(home)}">Return to the counter</a></div>`;
    return;
  }
  content.innerHTML = `<div class="blocked-state"><div class="result-mark">×</div><div class="status-pill">${escapeHtml(session.status)}</div><h1>This handoff is closed.</h1><p>The request expired, was cancelled, or is no longer available for authorization. No payment success was recorded.</p><a class="return-button" href="${escapeHtml(home)}">Return to the counter</a></div>`;
}

async function load() {
  if (legacyQueryToken) throw new Error('This link format is no longer supported. Tokens never travel in query strings — ask the counter for a fresh handoff.');
  if (!intentId || !token) throw new Error('This handoff link is incomplete.');
  session = await api(`/api/checkout/${encodeURIComponent(intentId)}`);
  render();
}

async function authorize() {
  if (busy || !session?.can_authorize) return;
  busy = true;
  render();
  try {
    await api(`/api/checkout/${encodeURIComponent(intentId)}/authorize`, {
      method: 'POST',
      body: JSON.stringify({
        signature: `sandboxSig-${crypto.randomUUID().replaceAll('-', '')}`,
        sourceWallet: 'GLPDemoCustomerWallet111111111111111111111111'
      })
    });
    await load();
    toast('Fictional signature returned to the counter.');
  } catch (error) {
    toast(error.message || 'Authorization failed. No success was recorded.', true);
  } finally {
    busy = false;
    render();
  }
}

content.addEventListener('click', (event) => {
  if (event.target.closest('#authorize')) authorize();
});

timer = setInterval(() => {
  if (session) clock.textContent = remaining();
  if (session && !session.can_authorize && ['SCREENING_REQUIRED', 'REVIEW_REQUIRED'].includes(session.status) && !document.hidden) {
    load().catch(() => {});
  }
}, 1000);

window.addEventListener('beforeunload', () => clearInterval(timer));
window.addEventListener('offline', () => toast('Connection lost. This page will not show success without a server response.', true));

// Direct navigation (no token or id in URL) — show a calm informational state,
// not an alarming error, since this just means the user visited the page directly.
if (legacyQueryToken) {
  content.setAttribute('aria-busy', 'false');
  content.innerHTML = `<div class="blocked-state"><div class="result-mark">×</div><div class="status-pill">LINK FORMAT CHANGED</div><h1>This link format is no longer supported.</h1><p>Tokens never travel in query strings. Ask the counter for a fresh handoff link.</p><a class="return-button" href="${escapeHtml(home)}">Return to Green Light Pay</a></div>`;
} else if (!intentId || !token) {
  content.setAttribute('aria-busy', 'false');
  content.innerHTML = `<div class="success-state"><div class="result-mark result-mark--nav">→</div><div class="status-pill">SANDBOX HANDOFF</div><h1>Start at the counter.</h1><p>This screen opens automatically during the handoff step. Complete the Counter and Green Gate stages in Green Light Pay, then follow the handoff link to land here.</p><a class="return-button" href="${escapeHtml(home)}">Open Green Light Pay</a></div>`;
} else {
  load().catch((error) => {
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = `<div class="blocked-state"><div class="result-mark">×</div><div class="status-pill">HANDOFF UNAVAILABLE</div><h1>We could not open this request.</h1><p>${escapeHtml(error.message || 'The link is invalid, expired, or no longer available.')} No payment success was recorded.</p><a class="return-button" href="${escapeHtml(home)}">Return to Green Light Pay</a></div>`;
    toast(error.message || 'The handoff could not be opened.', true);
  });
}
