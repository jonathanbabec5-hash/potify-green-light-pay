import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  sandboxHtml: new URL('../public/index.html', import.meta.url),
  sandboxCss: new URL('../public/styles.css', import.meta.url),
  sandboxJs: new URL('../public/app.js', import.meta.url),
  checkoutHtml: new URL('../public/checkout.html', import.meta.url),
  checkoutCss: new URL('../public/checkout.css', import.meta.url),
  checkoutJs: new URL('../public/checkout.js', import.meta.url),
  developerHtml: new URL('../public/developer.html', import.meta.url),
  developerJs: new URL('../public/developer.js', import.meta.url),
  server: new URL('../src/server.mjs', import.meta.url),
  packageJson: new URL('../package.json', import.meta.url)
};

async function sources() {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')])));
}

test('v0.1.3-stage1.3 keeps playable, customer, and developer surfaces distinct', async () => {
  const source = await sources();
  const packageJson = JSON.parse(source.packageJson);
  assert.equal(packageJson.version, '0.1.3-stage1.3');
  assert.match(`${source.sandboxHtml}\n${source.sandboxJs}`, /Initiate Green Light Pay/);
  assert.match(source.sandboxHtml, /id="journey-list"/);
  assert.match(source.checkoutHtml, /ONE-TIME HANDOFF/);
  assert.match(source.developerHtml, /id="terminal-input"/);
  assert.match(source.server, /'\/developer': 'developer\.html'/);
  assert.match(source.server, /'\/checkout\/': 'checkout\.html'/);
});

test('strict CSP-compatible pages avoid inline scripts, handlers, and style attributes', async () => {
  const source = await sources();
  for (const html of [source.sandboxHtml, source.checkoutHtml, source.developerHtml]) {
    assert.doesNotMatch(html, /\son\w+=/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i);
  }
  assert.match(source.server, /style-src 'self'/);
  assert.doesNotMatch(source.server, /style-src[^;]*unsafe-inline/);
  assert.doesNotMatch(source.sandboxJs, /style="/);
});

test('phone contract retains target breakpoints and minimum primary actions', async () => {
  const source = await sources();
  assert.match(source.sandboxCss, /@media \(max-width: 760px\)/);
  assert.match(source.sandboxCss, /@media \(max-width: 430px\)/);
  assert.match(source.sandboxCss, /min-height: 54px/);
  assert.match(source.checkoutCss, /min-height: 56px/);
  assert.match(source.sandboxCss, /prefers-reduced-motion/);
  assert.match(source.sandboxHtml, /aria-live="polite"/);
  assert.match(source.sandboxJs, /Connection lost[\s\S]*will not show success/);
});

test('journey list items receive aria-current="step" on the active step', async () => {
  const source = await sources();
  assert.match(source.sandboxJs, /aria-current.*step|setAttribute.*aria-current.*step/);
});

test('brand SVG includes a title element for accessibility', async () => {
  const source = await sources();
  assert.match(source.sandboxHtml, /<title[^>]*>Green Light Pay<\/title>/);
  assert.match(source.sandboxHtml, /aria-labelledby/);
});

test('dialogs carry aria-modal="true" and a heading', async () => {
  const source = await sources();
  assert.match(source.sandboxHtml, /aria-modal="true"/);
  assert.match(source.sandboxHtml, /<h2[^>]*class="dialog-heading"|class="dialog-heading"[^>]*>/);
});

test('checkout-title id appears only in dynamic JS, never in static checkout.html', async () => {
  const source = await sources();
  // Must be present in the JS (the active-state render)
  assert.match(source.checkoutJs || source.sandboxJs, /id="checkout-title"/);
  // Must NOT be a static id in checkout.html (only the JS renders it)
  assert.doesNotMatch(source.checkoutHtml, /id="checkout-title"/);
});

test('v0.1.3-stage1.2 calm UI: watcher nodes display W-A/W-B shorthand labels', async () => {
  const source = await sources();
  // Node orbs use terse W-A / W-B — not raw RPC provider suffix slices
  assert.match(source.sandboxJs, /'W-A'/);
  assert.match(source.sandboxJs, /'W-B'/);
  assert.doesNotMatch(source.sandboxJs, /rpc_provider\.slice\(-5\)\.toUpperCase/);
});

test('v0.1.3-stage1.2 calm UI: checkout direct navigation shows informational state', async () => {
  const source = await sources();
  // A visitor who opens /checkout directly (no id + token) should see a calm guide, not an error
  assert.match(source.checkoutJs, /Start at the counter/);
  assert.match(source.checkoutJs, /!intentId \|\| !token/);
});

test('v0.1.3-stage1.2 calm UI: developer controls use plain-language labels', async () => {
  const source = await sources();
  // Form labels should be human-readable, not raw snake_case API field names
  assert.match(source.developerHtml, /Pause new requests/);
  assert.match(source.developerHtml, /Per-transaction limit/);
  assert.doesNotMatch(source.developerHtml, /pause_new_requests/);
  assert.doesNotMatch(source.developerHtml, /per_transaction_limit_usd/);
});
