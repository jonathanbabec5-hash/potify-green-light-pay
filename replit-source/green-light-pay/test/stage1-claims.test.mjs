import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { GreenLightPayCore } from '../src/core.mjs';
import { redactSensitive, requestLogLine, SENSITIVE_KEY_PATTERN } from '../src/redact.mjs';

const publicDir = new URL('../public/', import.meta.url);

const FORBIDDEN_CLAIMS = [
  /\banonymous\b/i,
  /\banonymity\b/i,
  /untraceable/i,
  /\bghost\b/i,
  /invisible to/i,
  /off the books/i,
  /hidden from/i,
  /disguis/i,
  /federally approved/i,
  /legally compliant/i,
  /bank[- ]approved/i,
  /guaranteed (?:savings|hidden)/i,
  /no one can (?:see|know|find|discover|trace)/i
];

test('public copy makes no unsupported privacy, savings, or approval claims', async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith('.html') || name.endsWith('.js'));
  assert.ok(files.length >= 6);
  for (const name of files) {
    const source = await readFile(new URL(name, publicDir), 'utf8');
    for (const pattern of FORBIDDEN_CLAIMS) {
      assert.doesNotMatch(source, pattern, `${name} must not contain forbidden claim ${pattern}`);
    }
  }
});

test('checkout page carries the required privacy disclosure', async () => {
  const html = await readFile(new URL('checkout.html', publicDir), 'utf8');
  assert.match(html, /Green Light Pay minimizes what it collects\. This sandbox does not ask who you are or what you purchased\. Your wallet activity and required merchant records may still be visible to other authorized systems or parties\./);
});

test('prototype version is consistent across package, core, and surfaces', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const core = new GreenLightPayCore(':memory:', { seed: true });
  try {
    assert.equal(packageJson.version, '0.1.3-stage1.3');
    assert.equal(core.dashboard().prototype_version, '0.1.3-stage1.3');
  } finally {
    core.close();
  }
  const indexHtml = await readFile(new URL('index.html', publicDir), 'utf8');
  const developerHtml = await readFile(new URL('developer.html', publicDir), 'utf8');
  // Version string is intentionally absent from the main hero overline (calm UI);
  // it must still appear in the developer console which is the technical surface.
  assert.doesNotMatch(indexHtml, /Version 0\.1\.3-stage1\./);
  assert.match(developerHtml, /v0\.1\.3-stage1\.3/);
  assert.doesNotMatch(indexHtml, /0\.1\.1\b/);
  assert.doesNotMatch(developerHtml, /0\.1\.1\b/);
});

test('"never requests" wording is scoped with prototype context in all surfaces', async () => {
  for (const name of ['app.js', 'checkout.js']) {
    const source = await readFile(new URL(name, publicDir), 'utf8');
    if (!source.includes('never requests')) continue;
    // Scoped form: "This sandbox prototype never requests" — not a bare absolute claim
    assert.match(source, /sandbox.*never requests|prototype.*never requests/i, `${name}: "never requests" must include sandbox/prototype scope qualifier`);
  }
});

test('"In a live program" phrase is not used as a claim in any public surface', async () => {
  const files = (await readdir(publicDir)).filter((name) => name.endsWith('.html') || name.endsWith('.js'));
  for (const name of files) {
    const source = await readFile(new URL(name, publicDir), 'utf8');
    assert.doesNotMatch(source, /In a live program\b/i, `${name} must not contain "In a live program" — use "In a real regulated program" instead`);
  }
});

test('no client or server source builds token query strings or a direct submit route', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /\/submit/);
  assert.doesNotMatch(server, /[?&]token=/);
  for (const name of ['app.js', 'checkout.js', 'developer.js']) {
    const source = await readFile(new URL(name, publicDir), 'utf8');
    assert.doesNotMatch(source, /\/submit/, `${name} must not reference the removed direct-submit route`);
    assert.doesNotMatch(source, /[?&]token=\$\{/, `${name} must not place tokens in query strings`);
  }
});

test('redaction helpers strip sensitive material and log no query strings', () => {
  const redacted = redactSensitive({
    authorization: 'Bearer secret-value',
    cookie: 'session=abc',
    checkout_token: 'raw-token',
    wallet_pin: '1234',
    nested: { apiKey: 'k', safe: 'visible' },
    actor: 'test-actor'
  });
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.cookie, '[REDACTED]');
  assert.equal(redacted.checkout_token, '[REDACTED]');
  assert.equal(redacted.wallet_pin, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.safe, 'visible');
  assert.equal(redacted.actor, 'test-actor');
  assert.ok(SENSITIVE_KEY_PATTERN.test('X-Api-Key'));
  const line = requestLogLine('GET', '/api/checkout/pi_1?token=leaky#token=alsoleaky', 200, 12);
  assert.equal(line, 'GET /api/checkout/pi_1 200 12ms');
});

test('evidence bundles exclude checkout token material entirely', () => {
  const core = new GreenLightPayCore(':memory:', { seed: true });
  try {
    const merchant = core.listMerchants()[0];
    const created = core.createPaymentIntent({
      merchantId: merchant.id,
      amountUsdCents: 4_250,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `evidence-${crypto.randomUUID()}`
    }, 'test-pos');
    const token = created.checkout_token;
    const tokenHash = createHash('sha256').update(token).digest('hex');

    assert.throws(() => core.evidenceBundle(created.id), (error) => error.code === 'EVIDENCE_NOT_AVAILABLE');

    core.screenPaymentIntent(created.id, { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }, 'test-partner');
    const submitted = core.authorizeCheckout(created.id, token, {
      signature: `sig-${crypto.randomUUID()}`,
      sourceWallet: 'TestCustomerWallet111111111111111111111111111'
    });
    const evidence = {
      signature: submitted.signature,
      commitment: merchant.controls.required_commitment,
      tokenProgram: submitted.expected_token_program,
      mint: submitted.expected_mint,
      sourceWallet: submitted.source_wallet,
      destinationWallet: submitted.expected_destination,
      rawAmount: submitted.expected_raw_amount,
      slot: 311_222_333,
      transactionError: false
    };
    core.verifyPaymentIntent(submitted.id, {
      primary: { ...evidence, rpcProvider: 'rpc-a' },
      secondary: { ...evidence, rpcProvider: 'rpc-b' }
    }, 'test-verifier');
    core.reconcilePaymentIntent(submitted.id, {
      posAmountCents: submitted.amount_usd_cents,
      chainRawAmount: submitted.expected_raw_amount,
      partnerAmountCents: submitted.amount_usd_cents
    }, 'test-reconciliation');

    const bundle = core.evidenceBundle(created.id);
    const serialized = JSON.stringify(bundle);
    assert.equal(bundle.schema, 'glp.sandbox.evidence.v1');
    assert.equal(bundle.mode, 'SANDBOX');
    assert.equal(bundle.live_money_movement, false);
    assert.equal(bundle.payment_intent.status, 'RECONCILED');
    assert.equal(bundle.ledger.difference_cents, 0);
    assert.equal(bundle.reconciliation.status, 'MATCHED');
    assert.equal(bundle.audit_chain.valid, true);
    assert.ok(bundle.audit_events.length >= 4);
    assert.ok(!serialized.includes(token), 'evidence must not contain the plaintext token');
    assert.ok(!serialized.includes(tokenHash), 'evidence must not contain the token hash');
    assert.ok(!serialized.includes('checkout_token'), 'evidence must not reference checkout token fields');
  } finally {
    core.close();
  }
});

test('checkout token rotation invalidates the previous token before signature only', () => {
  const core = new GreenLightPayCore(':memory:', { seed: true });
  try {
    const merchant = core.listMerchants()[0];
    const created = core.createPaymentIntent({
      merchantId: merchant.id,
      amountUsdCents: 4_250,
      assetCode: merchant.controls.allowed_asset_code,
      storeId: merchant.controls.store_ids[0],
      registerId: merchant.controls.register_ids[0],
      posAuthorized: true,
      idempotencyKey: `rotate-${crypto.randomUUID()}`
    }, 'test-pos');
    const oldToken = created.checkout_token;

    const rotated = core.rotateCheckoutToken(created.id, 'test-operator', oldToken);
    assert.equal(rotated.previous_token_invalidated, true);
    assert.ok(rotated.checkout_token && rotated.checkout_token !== oldToken);
    assert.throws(() => core.getCheckoutSession(created.id, oldToken), (error) => error.code === 'CHECKOUT_NOT_FOUND');
    assert.equal(core.getCheckoutSession(created.id, rotated.checkout_token).status, 'SCREENING_REQUIRED');
    // Rotation without a valid current token is denied.
    assert.throws(() => core.rotateCheckoutToken(created.id, 'test-operator', 'wrong-token'), (error) => error.code === 'CHECKOUT_NOT_FOUND');

    const rotationEvents = core.listAudit(500).filter((event) => event.action === 'CHECKOUT_TOKEN_ROTATED');
    assert.equal(rotationEvents.length, 1);
    const payload = JSON.stringify(rotationEvents[0].payload);
    assert.ok(!payload.includes(oldToken) && !payload.includes(rotated.checkout_token), 'audit must not contain token material');

    core.screenPaymentIntent(created.id, { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }, 'test-partner');
    core.authorizeCheckout(created.id, rotated.checkout_token, {
      signature: `sig-${crypto.randomUUID()}`,
      sourceWallet: 'TestCustomerWallet111111111111111111111111111'
    });
    // Post-submission rotation is refused even with the valid (but now non-rotatable) token.
    assert.throws(() => core.rotateCheckoutToken(created.id, 'test-operator', rotated.checkout_token), (error) => error.code === 'INVALID_STATE');
  } finally {
    core.close();
  }
});
