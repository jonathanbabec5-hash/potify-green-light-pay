# Green Light Pay Consumer
## Whitepaper · public developer edition

**November 25, 2026 · Working sandbox and reference source**

### Goal and audience

Let a shopper try a keypad, send to a handle and buy a sample item in one flow. The immediate audience is merchant product teams evaluating a consumer payment flow.

### Design and implementation

The consumer demo posts balanced fictional journal entries. A separate wallet reader shows balances. The Next.js reference illustrates provider boundaries. Keep the funding asset, display amount, quote and receipt distinct. A shopper must be able to tell which balance changed from the confirmation screen.

### What a contributor can establish

The fixture tests covered keypad entry, simulated purchases and sends, a balanced journal, duplicate confirmation prevention, mock wallets and source/embed parity. Repeated confirmation, journal balance and consistent asset units are testable in fixtures. Production would require provider and settlement receipts for the same sale.

### Evidence and outstanding work

Production funding, provider approval, custody, conversion and settlement remain unverified. GLP has separate finances and governance. The next acceptance case is concrete. Complete a synthetic purchase twice with the same confirmation and verify only one entry and a balanced ledger.

### Place in POTIFY

Qualify two design-partner discussions for paid integration work under a separate GLP agreement. The marketing plan gives the test window and the evidence for a commercial outcome.

[Source provenance](source.json) · [Build log](BUILD-LOG.md) · [Marketing plan](MARKETING.md)
