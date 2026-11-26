# Green Light Pay — Playable Sandbox

**Version 0.1.1 · July 20, 2026**

Version 0.1.1 corrects the central product flaw in the original prototype: the operational proof is no longer presented as the primary experience. The serious machinery remains intact, but the sandbox now translates it into a guided, phone-first Green Light Pay run.

> Qualified partners. Verified transactions. Clear records. Merchant controls. A payment experience designed for the reality of state-legal cannabis retail—piece by piece, counter by counter, requirement by requirement.

## The three product surfaces

| Route | Audience | Purpose |
|---|---|---|
| `/` | Cashier, stakeholder, investor, tester | A playable five-stage counter journey: initiate, qualify, hand off, verify, reconcile. |
| `/checkout/` | Customer-side sandbox participant | A token-bound, phone-first request that shows the exact fictional amount and produces a fictional wallet signature. |
| `/developer` | Developer, operations, compliance, auditor | A terminal-shaped control plane with raw state, commands, merchant controls, audit records, API routes, and manual lifecycle actions. |

The browser no longer asks a normal user to interpret ledger metrics, RPC jargon, qualification registries, or manual API state transitions before they can understand the product.

## What a person can now do

1. Open the main sandbox on a phone or computer.
2. See the fictional merchant, partner, network mode, and POS readiness.
3. Enter or choose a final authorized sale total.
4. Tap **Initiate Green Light Pay**.
5. Open the simulated qualified-partner gate.
6. Scan a genuine one-time QR code, open the customer handoff in another tab/device, or play the wallet step on one screen.
7. Record a fictional customer-owned-wallet signature.
8. Ask two independent server-side observer fixtures to verify the exact frozen transaction facts.
9. Reconcile the POS amount, chain observation, partner amount, and balanced operational ledger.
10. Receive a Green Light receipt only after the final API state is `RECONCILED`.
11. Open `/developer` to inspect the underlying proof.

The interface polls the customer handoff while it is open. If another phone authorizes the fictional request, the counter advances without pretending that the browser itself proved payment.

## Claim-to-evidence map

| Green Light Pay language | Working v0.1.1 evidence |
|---|---|
| Qualified partners | The partner gate cannot approve an incomplete authority record. A payment is screened only through the merchant’s assigned `APPROVED` partner fixture. |
| Verified transactions | Two distinct observers must agree with the frozen signature, commitment, program, mint, source, destination, raw amount, slot, and successful transaction result. |
| Clear records | Verification posts one balanced double-entry operational record. Reconciliation compares POS, chain, partner, and ledger values. Material events enter a SHA-256 hash-linked audit chain. |
| Merchant controls | The developer route exposes merchant pause, transaction cap, daily cap, asset/mint allowlist, destination, finality, and store/register bindings. The API enforces them server-side. |
| Counter-ready experience | A responsive five-stage journey hides jargon until requested, keeps the primary action prominent, gives every state a visible purpose, and ends on a recognizable receipt. |
| Customer handoff | A short-lived bearer token opens a minimized `/checkout/` session and an actual QR code. No customer, medical, or product fields appear in the handoff. |

## Important operating boundary

This is a **nonproduction sandbox**, not a live regulated payment rail.

- It does not move, transmit, custody, convert, or settle money or digital assets.
- It does not represent provider, bank, state, federal, legal, or regulatory approval.
- Its partner, merchant, license, wallet, asset, observers, signatures, and settlement records are fictional fixtures.
- It does not perform KYC, sanctions screening, SAR decisions, tax calculation, inventory control, age or medical eligibility, state track-and-trace, or product release.
- A licensed dispensary and its POS remain responsible for eligibility, purchase limits, products, tax, inventory, and state reporting.
- A specifically approved regulated partner must own screening, custody, conversion, transmission, and settlement in any live program.
- Green Light Pay owns orchestration, frozen expectations, verification, operational records, reconciliation, merchant controls, audit evidence, and support tooling.

### POTIFY relationship in this prototype

The interface uses `POTIFY presents` as creative provenance because the user explicitly requested recognizable continuity. Green Light Pay remains a separate product. This build does not accept `$POTIFY`, create token utility, use token proceeds, promise discounts or rewards, share payment revenue, conduct buybacks, add token governance, or imply token value from Green Light Pay.

The `POTIFY` name remains an IP/trademark clearance gate before a public launch. The prototype treatment is not evidence of clearance.

## Run locally

Requirements: Node.js 24 or newer.

```bash
npm ci
npm start
```

Open:

- `http://127.0.0.1:4173/` for the playable sandbox;
- `http://127.0.0.1:4173/developer` for the developer console.

The database is created at `data/greenlight-pay.sqlite`. All records are fictional and resettable.

```bash
npm run reset
npm start
```

For a hosted QR that points at the correct protected origin, set:

```text
APP_BASE_URL=https://your-protected-sandbox.example
```

Do not use an unprotected public deployment or a published filesystem as durable evidence storage.

## Developer console commands

The `/developer` command line is a constrained product console, not an operating-system shell.

```text
help
health
intents
inspect <GLP-reference>
merchant
partner
controls
audit
routes
refresh
open
clear
```

The same route retains manual controlled actions for testing screening, signature submission, verification, and reconciliation without forcing those controls into the primary sandbox.

## API surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Mode, version, counts, ledger difference, and audit integrity. |
| `GET/POST` | `/api/partners` | Partner qualification records. |
| `GET/POST` | `/api/merchants` | Merchant underwriting records. |
| `PATCH` | `/api/merchants/:id/controls` | Merchant pause, caps, asset, finality, and counter allowlists. |
| `POST` | `/api/payment-intents` | Idempotent, minimum-data counter request. |
| `POST` | `/api/payment-intents/:id/screen` | Simulated regulated-partner decision. |
| `GET` | `/api/checkout/:id` | Validate a one-time token and return minimized customer-facing facts. |
| `GET` | `/api/checkout/:id/qr` | Generate a real QR for the protected one-time handoff. |
| `POST` | `/api/checkout/:id/authorize` | Token-bound fictional wallet authorization. |
| `POST` | `/api/payment-intents/:id/submit` | Internal sandbox signature fixture. |
| `POST` | `/api/payment-intents/:id/verify` | Dual-observer exact-evidence comparison. |
| `POST` | `/api/payment-intents/:id/reconcile` | POS, chain, partner, and ledger comparison. |
| `POST` | `/api/payment-intents/:id/cancel` | Cancel a reversible run. |
| `GET` | `/api/audit` | Append-only material-event history. |
| `GET` | `/api/audit/verify` | Recalculate and verify the audit hash chain. |

## Data minimization

The payment-intent boundary rejects customer names, dates of birth, government or medical IDs, diagnoses, certifications, emails, phones, addresses, biometrics, products, SKUs, basket contents, and readable order numbers—including nested fields.

Checkout responses contain only:

- opaque intent and public references;
- fictional merchant/counter identity;
- exact amount and approved sandbox asset;
- controlled status and expiry;
- sandbox and no-live-money flags.

Checkout tokens are stored only as SHA-256 hashes at rest. API responses use `Cache-Control: no-store`, and the site sends `Referrer-Policy: no-referrer`.

## Verification completed for v0.1.1

- `15` automated tests pass: `12` deterministic domain tests plus `3` interface-contract tests.
- The complete HTTP flow reaches `RECONCILED`.
- The QR endpoint returns `image/svg+xml` and opens the token-bound customer page.
- The final ledger difference is `$0.00`.
- The audit chain verifies as valid after the complete run.
- `npm audit --omit=dev` reports `0` known vulnerabilities.
- Browser console and page error checks are clean under the strict Content Security Policy.
- Viewports `320`, `375`, `390`, and `430` CSS pixels have zero page-level horizontal overflow.
- Visible phone actions meet or exceed a `44px` touch target.
- An interrupted/unknown client response never changes the UI to success.

The `qrcode` runtime dependency exists for one reason: generate a genuine device-to-device sandbox handoff rather than a decorative QR-like image. It is locked in `package-lock.json`.

## What remains gated after 0.1.1

The next engineering version should preserve the v0.1.1 experience while replacing local prototype infrastructure:

1. Protected phone deployment and real-device testing.
2. Managed PostgreSQL, versioned migrations, backups, and restore verification.
3. Organization-scoped authentication and server-enforced roles.
4. Signed POS and regulated-partner sandbox adapters with replay protection.
5. Production-shaped Solana observer interfaces that remain disabled and deterministic until approved.
6. Exception queues, refunds/corrections, evidence export, webhooks, outbox/dead-letter handling, monitoring, and incident shutdown.
7. Independent security, accessibility, privacy, legal, compliance, tax, accounting, insurance, load, and merchant-acceptance review.
8. A specifically named merchant, POS, regulated partner, settlement path, first state, responsibility matrix, and written approval for the exact flow before any live transaction.

Read next:

- [`docs/V0.1.1_PRODUCT_CORRECTION_2026-07-20.md`](docs/V0.1.1_PRODUCT_CORRECTION_2026-07-20.md)
- [`docs/V0.1.1_VISUAL_QA_2026-07-20.md`](docs/V0.1.1_VISUAL_QA_2026-07-20.md)
- [`docs/REPLIT_HANDOFF_2026-07-20_v0.1.1.md`](docs/REPLIT_HANDOFF_2026-07-20_v0.1.1.md)
- [`docs/GREEN_LIGHT_PAY_DEEP_RESEARCH_AND_REQUIREMENTS_2026-07-18.md`](docs/GREEN_LIGHT_PAY_DEEP_RESEARCH_AND_REQUIREMENTS_2026-07-18.md)
- [`replit.md`](replit.md)

This repository is engineering work, not legal, tax, accounting, regulatory, or investment advice.
