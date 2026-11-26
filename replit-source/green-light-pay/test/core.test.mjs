import assert from 'node:assert/strict';
import test from 'node:test';
import { GreenLightPayCore, DomainError } from '../src/core.mjs';

function sandbox() {
  return new GreenLightPayCore(':memory:', { seed: true });
}

function createIntent(core, overrides = {}) {
  const merchant = core.listMerchants()[0];
  return core.createPaymentIntent({
    merchantId: merchant.id,
    amountUsdCents: 4_250,
    assetCode: merchant.controls.allowed_asset_code,
    storeId: merchant.controls.store_ids[0],
    registerId: merchant.controls.register_ids[0],
    posAuthorized: true,
    idempotencyKey: `test-${crypto.randomUUID()}`,
    ...overrides
  }, 'test-pos');
}

function approveAndSubmit(core, intent) {
  core.screenPaymentIntent(intent.id, { decision: 'APPROVE', partnerReference: `screen-${crypto.randomUUID()}` }, 'test-partner');
  return core.submitPaymentSignature(intent.id, {
    signature: `sig-${crypto.randomUUID()}`,
    sourceWallet: 'TestCustomerWallet111111111111111111111111111'
  }, 'test-checkout');
}

function evidenceFor(core, intent, overrides = {}) {
  const merchant = core.getMerchant(intent.merchant_id);
  const base = {
    signature: intent.signature,
    commitment: merchant.controls.required_commitment,
    tokenProgram: intent.expected_token_program,
    mint: intent.expected_mint,
    sourceWallet: intent.source_wallet,
    destinationWallet: intent.expected_destination,
    rawAmount: intent.expected_raw_amount,
    slot: 311_111_111,
    transactionError: false,
    ...overrides
  };
  return {
    primary: { ...base, rpcProvider: 'rpc-a' },
    secondary: { ...base, rpcProvider: 'rpc-b' }
  };
}

test('seeded sandbox begins with qualified records, zero ledger difference, and a valid audit chain', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const dashboard = core.dashboard();
  assert.equal(dashboard.mode, 'SANDBOX');
  assert.equal(dashboard.prototype_version, '0.1.3-stage1.3');
  assert.equal(dashboard.live_money_movement, false);
  assert.equal(dashboard.customer_pii_collected, false);
  assert.equal(dashboard.approved_partners, 1);
  assert.equal(dashboard.active_merchants, 1);
  assert.equal(dashboard.ledger_difference_cents, 0);
  assert.equal(dashboard.audit.valid, true);
});

test('a partner cannot be approved without documented scope and authority', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const partner = core.createPartner({ legalName: 'Incomplete Partner' }, 'test');
  assert.throws(
    () => core.setPartnerStatus(partner.id, 'APPROVED', 'test'),
    (error) => error instanceof DomainError && error.code === 'PARTNER_NOT_QUALIFIED' && error.details.missing.length >= 1
  );
});

test('payment requests reject customer identity, medical, and product fields', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  assert.throws(
    () => createIntent(core, { customerName: 'Do not collect this' }),
    (error) => error instanceof DomainError && error.code === 'DATA_MINIMIZATION_VIOLATION'
  );
  assert.throws(
    () => createIntent(core, { metadata: { sku: 'NO-SKU' } }),
    (error) => error instanceof DomainError && error.code === 'DATA_MINIMIZATION_VIOLATION'
  );
});

test('merchant pause and transaction caps block new requests', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const merchant = core.listMerchants()[0];
  assert.throws(
    () => createIntent(core, { amountUsdCents: merchant.controls.per_transaction_limit_cents + 1 }),
    (error) => error.code === 'TRANSACTION_LIMIT_EXCEEDED'
  );
  core.updateMerchantControls(merchant.id, {
    paused: true,
    perTransactionLimitCents: merchant.controls.per_transaction_limit_cents,
    dailyLimitCents: merchant.controls.daily_limit_cents,
    allowedAssetCode: merchant.controls.allowed_asset_code,
    allowedMint: merchant.controls.allowed_mint,
    tokenProgram: merchant.controls.token_program,
    requiredCommitment: merchant.controls.required_commitment,
    storeIds: merchant.controls.store_ids,
    registerIds: merchant.controls.register_ids
  }, 'test-merchant');
  assert.throws(() => createIntent(core), (error) => error.code === 'MERCHANT_PAUSED');
});

test('idempotency returns the original request instead of creating a duplicate', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const merchant = core.listMerchants()[0];
  const input = {
    merchantId: merchant.id,
    amountUsdCents: 5_000,
    assetCode: merchant.controls.allowed_asset_code,
    storeId: merchant.controls.store_ids[0],
    registerId: merchant.controls.register_ids[0],
    posAuthorized: true,
    idempotencyKey: 'fixed-idempotency-key'
  };
  const first = core.createPaymentIntent(input, 'test-pos');
  const second = core.createPaymentIntent(input, 'test-pos');
  assert.equal(second.id, first.id);
  assert.equal(second.idempotent_replay, true);
  assert.equal(core.listPaymentIntents().length, 1);
});

test('a one-time checkout reveals only minimized handoff data to the correct token', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const session = core.getCheckoutSession(created.id, created.checkout_token);
  assert.equal(session.prototype_version, '0.1.3-stage1.3');
  assert.equal(session.status, 'SCREENING_REQUIRED');
  assert.equal(session.can_authorize, false);
  assert.equal(session.live_money_movement, false);
  assert.equal(session.amount_usd_cents, created.amount_usd_cents);
  assert.equal('source_wallet' in session, false);
  assert.equal('checkout_token' in core.getPaymentIntent(created.id), false);
  assert.throws(
    () => core.getCheckoutSession(created.id, 'wrong-one-time-token'),
    (error) => error instanceof DomainError && error.code === 'CHECKOUT_NOT_FOUND'
  );
});

test('the customer handoff can authorize only after the qualified-partner gate opens', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const authorization = {
    signature: `sig-${crypto.randomUUID()}`,
    sourceWallet: 'TestCustomerWallet111111111111111111111111111'
  };
  assert.throws(
    () => core.authorizeCheckout(created.id, created.checkout_token, authorization),
    (error) => error instanceof DomainError && error.code === 'CHECKOUT_NOT_READY'
  );
  core.screenPaymentIntent(created.id, {
    decision: 'APPROVE',
    partnerReference: `screen-${crypto.randomUUID()}`
  }, 'test-partner');
  const submitted = core.authorizeCheckout(created.id, created.checkout_token, authorization);
  assert.equal(submitted.status, 'SUBMITTED');
  assert.throws(
    () => core.authorizeCheckout(created.id, created.checkout_token, authorization),
    (error) => error instanceof DomainError && error.code === 'CHECKOUT_NOT_READY'
  );
});

test('independent matching evidence verifies once and posts a balanced operational ledger', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const submitted = approveAndSubmit(core, created);
  const result = core.verifyPaymentIntent(submitted.id, evidenceFor(core, submitted), 'test-verifier');
  assert.equal(result.verified, true);
  assert.equal(result.intent.status, 'VERIFIED');
  const dashboard = core.dashboard();
  assert.equal(dashboard.ledger_debits_cents, 4_250);
  assert.equal(dashboard.ledger_credits_cents, 4_250);
  assert.equal(dashboard.ledger_difference_cents, 0);
});

test('disagreeing RPC evidence routes the request to review instead of fulfilling it', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const submitted = approveAndSubmit(core, created);
  const evidence = evidenceFor(core, submitted);
  evidence.secondary.rawAmount += 1;
  const result = core.verifyPaymentIntent(submitted.id, evidence, 'test-verifier');
  assert.equal(result.verified, false);
  assert.equal(result.intent.status, 'REVIEW_REQUIRED');
  assert.ok(result.mismatches.some((message) => message.includes('rawAmount')));
  assert.equal(core.dashboard().ledger_debits_cents, 0);
});

test('a reviewed payment can be rescreened and verified with refreshed observer evidence', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const firstSubmission = approveAndSubmit(core, created);
  const mismatchedEvidence = evidenceFor(core, firstSubmission);
  mismatchedEvidence.secondary.destinationWallet = 'WrongDestination111111111111111111111111111';
  const review = core.verifyPaymentIntent(firstSubmission.id, mismatchedEvidence, 'test-verifier');
  assert.equal(review.intent.status, 'REVIEW_REQUIRED');

  core.screenPaymentIntent(created.id, {
    decision: 'APPROVE',
    partnerReference: `rescreen-${crypto.randomUUID()}`
  }, 'test-partner');
  const secondSubmission = core.submitPaymentSignature(created.id, {
    signature: `sig-${crypto.randomUUID()}`,
    sourceWallet: 'TestCustomerWallet111111111111111111111111111'
  }, 'test-checkout');
  const result = core.verifyPaymentIntent(secondSubmission.id, evidenceFor(core, secondSubmission), 'test-verifier');
  assert.equal(result.verified, true);
  assert.equal(result.intent.status, 'VERIFIED');
  assert.equal(core.dashboard().ledger_difference_cents, 0);
});

test('four-way matching reconciles POS, chain, partner, and ledger records', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  const created = createIntent(core);
  const submitted = approveAndSubmit(core, created);
  core.verifyPaymentIntent(submitted.id, evidenceFor(core, submitted), 'test-verifier');
  const result = core.reconcilePaymentIntent(submitted.id, {
    posAmountCents: submitted.amount_usd_cents,
    chainRawAmount: submitted.expected_raw_amount,
    partnerAmountCents: submitted.amount_usd_cents
  }, 'test-reconciliation');
  assert.equal(result.intent.status, 'RECONCILED');
  assert.equal(result.reconciliation.status, 'MATCHED');
  assert.deepEqual(result.reconciliation.exceptions, []);
});

test('audit-chain verification detects record tampering', (t) => {
  const core = sandbox();
  t.after(() => core.close());
  assert.equal(core.verifyAuditChain().valid, true);
  core.db.prepare('UPDATE audit_events SET actor=? WHERE sequence=1').run('tampered');
  const result = core.verifyAuditChain();
  assert.equal(result.valid, false);
  assert.equal(result.failed_sequence, 1);
});
