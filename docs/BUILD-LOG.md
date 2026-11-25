# November 25, 2026 · Green Light Pay Consumer

**Question.** Let a shopper try a keypad, send to a handle and buy a sample item in one flow.

**Source and change.** GreenLight_Pay_Consumer_Starter.zip, November 24. Includes the AmountPad component from the original archive and the distinct simulated consumer and read-only wallet paths. The nested Next.js project is an engineering reference.

**Observed result.** The fixture tests covered keypad entry, simulated purchases and sends, a balanced journal, duplicate confirmation prevention, mock wallets and source/embed parity.

```sh
node tests/demo.test.cjs
node tests/wallet.test.cjs
node tests/embed.test.cjs
```

**Next acceptance check.** Complete a synthetic purchase twice with the same confirmation and verify only one entry and a balanced ledger.

**Owner and decision.** Chance coordinates public materials. The GLP project owner must confirm any commercial agreement. Production funding, provider approval, custody, conversion and settlement remain unverified. GLP has separate finances and governance.

This dated record describes the developer package. Verify remote commit and tree in the publication receipt before announcing a GitHub release.
