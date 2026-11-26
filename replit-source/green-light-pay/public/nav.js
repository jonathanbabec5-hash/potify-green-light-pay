// Green Light Pay — shared site navigation, status strip, and regulatory dialog.
// Loaded as type="module" on all three GLP routes.
// No inline styles. All presentation is in shared-nav.css.

const baseMeta = document.querySelector('meta[name="glp-base"]')?.getAttribute('content') || '';
const BASE = baseMeta.startsWith('__') ? '' : baseMeta;

// ─── Site navigation bar ───────────────────────────────────────────────────
const sitenav = document.createElement('nav');
sitenav.className = 'glp-sitenav';
sitenav.setAttribute('aria-label', 'Green Light Pay site navigation');
sitenav.innerHTML =
  '<div class="glp-sitenav-left">' +
    '<a class="glp-snl" href="' + BASE + '/">Merchant Sandbox</a>' +
    '<a class="glp-snl" href="' + BASE + '/checkout/">Checkout Demo</a>' +
    '<a class="glp-snl" href="' + BASE + '/developer">Developer Console</a>' +
  '</div>' +
  '<div class="glp-sitenav-right">' +
    '<span class="glp-sitenav-ctx-label">Context and navigation only \u2014 not a shared product, platform, or affiliation:</span>' +
    '<a class="glp-snl glp-snl-ext" href="https://potifywebsite.com/green-light-pay" target="_blank" rel="noopener noreferrer">Project Separation\u00a0\u2197</a>' +
    '<a class="glp-snl glp-snl-ext" href="https://potifywebsite.com/" target="_blank" rel="noopener noreferrer">POTIFY\u00a0Home\u00a0\u2197</a>' +
    '<button class="glp-snl glp-snl-reg glp-open-reg" type="button">Regulatory\u00a0Status</button>' +
  '</div>';

// ─── Status strip ──────────────────────────────────────────────────────────
const strip = document.createElement('div');
strip.className = 'glp-status-strip';
strip.setAttribute('role', 'note');
strip.innerHTML =
  '<span>Independent research prototype \u00b7 Early stage \u00b7 Simulated \u00b7 Not in production \u00b7 ' +
  'Does not accept or transmit: live funds, crypto, wallet credentials, card or bank data, cannabis orders, or Signal Drop entries</span>';

// ─── Regulatory status dialog ──────────────────────────────────────────────
const regDialog = document.createElement('dialog');
regDialog.id = 'glp-reg-dialog';
regDialog.className = 'glp-reg-dialog';
regDialog.setAttribute('aria-modal', 'true');
regDialog.setAttribute('aria-labelledby', 'glp-reg-heading');
regDialog.innerHTML =
  '<div class="glp-reg-header">' +
    '<h2 id="glp-reg-heading">U.S. REGULATORY STATUS \u2014 August 13, 2026</h2>' +
    '<button class="glp-reg-close" type="button" aria-label="Close regulatory status">\u00d7</button>' +
  '</div>' +
  '<div class="glp-reg-body">' +
    '<p class="glp-reg-lede">The following statements are recorded, verifiable facts drawn from official U.S. government publications as of August 13, 2026. This panel does not constitute legal advice.</p>' +

    '<section class="glp-reg-section">' +
      '<h3>FinCEN \u2014 Virtual Currency and Money Transmission</h3>' +
      '<p>In guidance FIN-2013-G001 (March 18, 2013), FinCEN stated that administrators and exchangers of convertible virtual currency may qualify as money services businesses (MSBs) and specifically as money transmitters under the Bank Secrecy Act, unless a statutory limitation or regulatory exemption applies. FinCEN extended that analysis in FIN-2019-G001 (May 9, 2019). Whether a specific architecture, token, or transaction flow constitutes money transmission is a fact-specific legal determination that requires qualified counsel review.</p>' +
      '<p class="glp-reg-cite">Official sources: FinCEN FIN-2013-G001; FinCEN FIN-2019-G001 \u2014 fincen.gov</p>' +
    '</section>' +

    '<section class="glp-reg-section">' +
      '<h3>FinCEN \u2014 Marijuana-Related Businesses</h3>' +
      '<p>FinCEN guidance FIN-2014-G001 (February 14, 2014) sets out Bank Secrecy Act expectations for financial institutions serving marijuana-related businesses (MRBs). It imposes fact-specific Suspicious Activity Report (SAR) filing duties \u2014 \u201cmarijuana limited,\u201d \u201cmarijuana priority,\u201d or \u201cmarijuana termination\u201d \u2014 and enhanced due diligence requirements on covered financial institutions. These duties apply regardless of state law.</p>' +
      '<p class="glp-reg-cite">Official source: FinCEN FIN-2014-G001 \u2014 fincen.gov</p>' +
    '</section>' +

    '<section class="glp-reg-section">' +
      '<h3>DEA \u2014 Federal Scheduling of Marijuana</h3>' +
      '<p>The Drug Enforcement Administration\u2019s public Controlled Substances scheduling list as of August 13, 2026 lists marijuana (cannabis) as a Schedule I controlled substance under the Controlled Substances Act, 21 U.S.C. \u00a7 812. A Notice of Proposed Rulemaking to transfer marijuana to Schedule III was published in the Federal Register on May 21, 2024 (89 Fed. Reg. 44597). A proposed rule is not a final rule and does not change the current legal status. Marijuana remains a Schedule I substance under federal law as of this date, regardless of state law.</p>' +
      '<p class="glp-reg-cite">Official sources: 21 U.S.C. \u00a7 812; DEA Controlled Substances \u2014 dea.gov; 89 Fed. Reg. 44597 (May 21, 2024)</p>' +
    '</section>' +

    '<section class="glp-reg-section">' +
      '<h3>FTC \u2014 Truthfulness of Advertising and Marketing Claims</h3>' +
      '<p>Under the FTC Act, 15 U.S.C. \u00a7 45, advertising and marketing claims must be truthful, non-deceptive, and substantiated by competent and reliable evidence before dissemination. The FTC\u2019s guidance on .com Disclosures (2013) requires that qualifying disclosures be clear and conspicuous. Unsubstantiated claims of compliance, approval, certification, or regulatory clearance \u2014 including implied claims \u2014 may constitute unfair or deceptive acts or practices.</p>' +
      '<p class="glp-reg-cite">Official sources: FTC Act, 15 U.S.C. \u00a7 45; FTC .com Disclosures (2013) \u2014 ftc.gov</p>' +
    '</section>' +

    '<section class="glp-reg-section glp-reg-disclaimer">' +
      '<h3>What This Sandbox Does Not Establish</h3>' +
      '<p>The existence of this sandbox, its architecture, its disclosures, and the regulatory facts stated above do not establish compliance, licensure, registration, approval, or legal clearance with any federal, state, or local law or regulation. Qualified U.S. legal counsel must independently review actual entities, operating jurisdictions, licenses, contracts, custody arrangements, transaction flows, KYC and AML controls, sanctions screening programs, privacy policies, security controls, and all marketing and advertising materials before any live or regulated activity commences.</p>' +
      '<p>This sandbox does not claim Binance listing, approval, sponsorship, endorsement, or affiliation, and has no connection to POTIFYUSDT or any exchange-listed instrument.</p>' +
    '</section>' +
  '</div>';

// ─── Inject into DOM ───────────────────────────────────────────────────────
// Prepend sitenav first, then insert strip immediately after it.
document.body.prepend(sitenav);
sitenav.insertAdjacentElement('afterend', strip);
document.body.appendChild(regDialog);

// ─── Mark active route link ────────────────────────────────────────────────
const currentPath = location.pathname.replace(/\/+$/, '') || '/';
for (const a of sitenav.querySelectorAll('a.glp-snl')) {
  const linkPath = new URL(a.href).pathname.replace(/\/+$/, '') || '/';
  if (linkPath === currentPath) a.setAttribute('aria-current', 'page');
}

// ─── Dialog open / close ───────────────────────────────────────────────────
function openReg() { regDialog.showModal(); }
function closeReg() { regDialog.close(); }

for (const btn of document.querySelectorAll('.glp-open-reg')) {
  btn.addEventListener('click', openReg);
}
regDialog.querySelector('.glp-reg-close').addEventListener('click', closeReg);
regDialog.addEventListener('click', e => { if (e.target === regDialog) closeReg(); });
