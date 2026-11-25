# Green Light Pay Consumer

[Complete repository directory tree](docs/DIRECTORY.md)

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
