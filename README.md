# Green Light Pay Consumer

[Complete repository directory tree](docs/DIRECTORY.md)

## Which balance did the receipt change?

A shopper should be able to put a finger on the confirmation screen and say what moved. Green Light Pay Consumer gives a product team a fictional basket and a keypad so that question can be asked before anyone brings real money to the counter.

Follow a simulated purchase in the [consumer demo](GreenLight_Pay_Consumer_Demo.html) beside the [journal checks](tests/demo.test.cjs). Separate what the keypad displays from the asset debited and the journal entries that must balance. A wallet balance read is another operation again.

Try the same fictional confirmation twice and account for the resulting entries. Quote the label that made this clear or propose one better label. Provider clearance, settlement and custody remain unverified. Green Light Pay has separate finances, contracts and governance from POTIFY.

**Working sandbox and reference source.** Let a shopper try a keypad, send to a handle and buy a sample item in one flow.

### Setup and usage

Use Node.js 24 for the included checks. Use Python 3 for the local static preview. The dependencies for the separately scoped Next.js reference are in nextjs-reference/package.json.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory .
```

Complete the sample basket. Open http://127.0.0.1:8000/GreenLight_Pay_Consumer_Demo.html in a browser. 

### Developer entry points

The consumer demo posts balanced fictional journal entries. A separate wallet reader shows balances. The Next.js reference illustrates provider boundaries. Explore `nextjs-reference/`, `reference/`, `tests/` in the full tree.

### Verification

The fixture tests covered keypad entry, simulated purchases and sends, a balanced journal, duplicate confirmation prevention, mock wallets and source/embed parity.

```sh
node tests/demo.test.cjs
node tests/wallet.test.cjs
node tests/embed.test.cjs
```

### Release scope

Production funding, provider approval, custody, conversion and settlement remain unverified. GLP has separate finances and governance. GreenLight_Pay_Consumer_Starter.zip, November 24. Includes the AmountPad component from the original archive and the distinct simulated consumer and read-only wallet paths. The nested Next.js project is an engineering reference. Main website public-facing GLP integration screen recovered from potify-website at b40b28683e548a04619f1e018814dd91aec1256d. July reference server is a separate non-canonical historical project.

[Technical whitepaper](docs/WHITEPAPER.md) · [Marketing and sales plan](docs/MARKETING.md) · [Dated developer log](docs/BUILD-LOG.md)

Existing asset and code terms remain applicable. Public access to a recording, illustration, brand or manuscript does not itself grant commercial reuse rights.
