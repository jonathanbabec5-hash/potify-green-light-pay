import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PARTNER_STATUSES = new Set(['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED', 'REJECTED']);
const MERCHANT_STATUSES = new Set(['DRAFT', 'UNDER_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED']);
const TERMINAL_INTENT_STATUSES = new Set(['RECONCILED', 'DECLINED', 'CANCELLED', 'EXPIRED']);
const PROTOTYPE_VERSION = '0.1.3-stage1.3';
const ROTATABLE_INTENT_STATUSES = new Set(['SCREENING_REQUIRED', 'READY_FOR_PAYMENT', 'REVIEW_REQUIRED']);
const SENSITIVE_FIELDS = new Set([
  'customername', 'name', 'dob', 'dateofbirth', 'medicalid', 'medicalrecord',
  'certification', 'diagnosis', 'product', 'products', 'sku', 'order', 'ordernumber',
  'email', 'phone', 'address', 'biometric', 'governmentid'
]);

export class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashesMatch(left, right) {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function requiredString(value, field, max = 200) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('VALIDATION_ERROR', `${field} is required.`);
  }
  const result = value.trim();
  if (result.length > max) throw new DomainError('VALIDATION_ERROR', `${field} is too long.`);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError('VALIDATION_ERROR', `${field} must be a positive whole number.`);
  }
  return value;
}

function boolInt(value) {
  return value ? 1 : 0;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function rejectSensitiveFields(input, path = '') {
  if (!input || typeof input !== 'object') return;
  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
    if (SENSITIVE_FIELDS.has(normalized)) {
      throw new DomainError(
        'DATA_MINIMIZATION_VIOLATION',
        `The field “${path}${key}” is prohibited. Green Light Pay accepts authorization flags, not customer identity, medical, or product data.`
      );
    }
    rejectSensitiveFields(value, `${path}${key}.`);
  }
}

function ensureFutureDate(value, field) {
  const date = new Date(requiredString(value, field));
  if (Number.isNaN(date.getTime())) throw new DomainError('VALIDATION_ERROR', `${field} must be a valid date.`);
  if (date <= new Date()) throw new DomainError('EXPIRED_RECORD', `${field} must be in the future.`);
  return date.toISOString();
}

function publicPartner(row) {
  if (!row) return null;
  return {
    ...row,
    custody_authorized: Boolean(row.custody_authorized),
    conversion_authorized: Boolean(row.conversion_authorized),
    transmission_authorized: Boolean(row.transmission_authorized),
    screening_authorized: Boolean(row.screening_authorized),
    settlement_authorized: Boolean(row.settlement_authorized)
  };
}

function publicMerchant(row) {
  if (!row) return null;
  return { ...row, sandbox_only: Boolean(row.sandbox_only) };
}

function publicControls(row) {
  if (!row) return null;
  return {
    ...row,
    paused: Boolean(row.paused),
    store_ids: parseJson(row.store_ids_json, []),
    register_ids: parseJson(row.register_ids_json, [])
  };
}

function publicIntent(row) {
  if (!row) return null;
  return {
    ...row,
    pos_authorized: Boolean(row.pos_authorized),
    amount_usd: (row.amount_usd_cents / 100).toFixed(2),
    checkout_token_hash: undefined
  };
}

export class GreenLightPayCore {
  constructor(databasePath = ':memory:', { seed = false } = {}) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#createSchema();
    if (seed) this.seedDemo();
  }

  close() {
    this.db.close();
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS partners (
        id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('DRAFT','UNDER_REVIEW','APPROVED','SUSPENDED','REJECTED')),
        cannabis_approval_reference TEXT,
        approval_scope TEXT,
        approval_expires_at TEXT,
        custody_authorized INTEGER NOT NULL DEFAULT 0 CHECK(custody_authorized IN (0,1)),
        conversion_authorized INTEGER NOT NULL DEFAULT 0 CHECK(conversion_authorized IN (0,1)),
        transmission_authorized INTEGER NOT NULL DEFAULT 0 CHECK(transmission_authorized IN (0,1)),
        screening_authorized INTEGER NOT NULL DEFAULT 0 CHECK(screening_authorized IN (0,1)),
        settlement_authorized INTEGER NOT NULL DEFAULT 0 CHECK(settlement_authorized IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        dba TEXT NOT NULL,
        state TEXT NOT NULL,
        license_number TEXT NOT NULL,
        license_category TEXT NOT NULL CHECK(license_category IN ('MEDICAL','ADULT_USE')),
        license_expires_at TEXT NOT NULL,
        license_verified_at TEXT NOT NULL,
        license_verification_source TEXT NOT NULL,
        partner_id TEXT NOT NULL REFERENCES partners(id),
        pos_provider TEXT NOT NULL,
        pos_merchant_id TEXT NOT NULL,
        settlement_wallet TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('DRAFT','UNDER_REVIEW','ACTIVE','PAUSED','REJECTED')),
        sandbox_only INTEGER NOT NULL DEFAULT 1 CHECK(sandbox_only IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(state, license_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS merchant_controls (
        merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
        per_transaction_limit_cents INTEGER NOT NULL,
        daily_limit_cents INTEGER NOT NULL,
        allowed_asset_code TEXT NOT NULL,
        allowed_mint TEXT NOT NULL,
        token_program TEXT NOT NULL,
        required_commitment TEXT NOT NULL CHECK(required_commitment IN ('CONFIRMED','FINALIZED')),
        store_ids_json TEXT NOT NULL,
        register_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS payment_intents (
        id TEXT PRIMARY KEY,
        public_reference TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL REFERENCES merchants(id),
        partner_id TEXT NOT NULL REFERENCES partners(id),
        store_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        amount_usd_cents INTEGER NOT NULL,
        asset_code TEXT NOT NULL,
        expected_mint TEXT NOT NULL,
        expected_token_program TEXT NOT NULL,
        expected_raw_amount INTEGER NOT NULL,
        expected_destination TEXT NOT NULL,
        checkout_token_hash TEXT NOT NULL,
        checkout_expires_at TEXT NOT NULL,
        pos_authorized INTEGER NOT NULL CHECK(pos_authorized IN (0,1)),
        partner_decision TEXT,
        partner_reference TEXT,
        source_wallet TEXT,
        signature TEXT UNIQUE,
        status TEXT NOT NULL,
        status_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS payment_intents_merchant_created
        ON payment_intents(merchant_id, created_at);

      CREATE TABLE IF NOT EXISTS verification_evidence (
        id TEXT PRIMARY KEY,
        payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
        rpc_provider TEXT NOT NULL,
        signature TEXT NOT NULL,
        commitment TEXT NOT NULL,
        token_program TEXT NOT NULL,
        mint TEXT NOT NULL,
        source_wallet TEXT NOT NULL,
        destination_wallet TEXT NOT NULL,
        raw_amount INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        transaction_error INTEGER NOT NULL CHECK(transaction_error IN (0,1)),
        observed_at TEXT NOT NULL,
        UNIQUE(payment_intent_id, rpc_provider)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ledger_transactions (
        id TEXT PRIMARY KEY,
        payment_intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id),
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
        account_code TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reconciliations (
        payment_intent_id TEXT PRIMARY KEY REFERENCES payment_intents(id),
        pos_amount_cents INTEGER NOT NULL,
        chain_raw_amount INTEGER NOT NULL,
        partner_amount_cents INTEGER NOT NULL,
        ledger_amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('MATCHED','EXCEPTION')),
        exceptions_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  #transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #audit(aggregateType, aggregateId, action, actor, payload) {
    const previous = this.db.prepare('SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const event = {
      sequence,
      event_id: id('evt'),
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      action,
      actor: actor || 'system',
      payload,
      previous_hash: previous?.event_hash ?? 'GENESIS',
      created_at: nowIso()
    };
    const eventHash = sha256(stableStringify(event));
    this.db.prepare(`
      INSERT INTO audit_events
      (sequence,event_id,aggregate_type,aggregate_id,action,actor,payload_json,previous_hash,event_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      sequence, event.event_id, aggregateType, aggregateId, action, event.actor,
      stableStringify(payload), event.previous_hash, eventHash, event.created_at
    );
    return { ...event, event_hash: eventHash };
  }

  seedDemo() {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM partners').get().count;
    if (count > 0) return;
    const partner = this.createPartner({
      legalName: 'Green Light Qualified Partner — Simulation',
      cannabisApprovalReference: 'SANDBOX-APPROVAL-NOT-FOR-PRODUCTION',
      approvalScope: 'Virginia medical cannabis sandbox orchestration only',
      approvalExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      custodyAuthorized: true,
      conversionAuthorized: true,
      transmissionAuthorized: true,
      screeningAuthorized: true,
      settlementAuthorized: true
    }, 'seed');
    this.setPartnerStatus(partner.id, 'APPROVED', 'seed');

    const merchant = this.createMerchant({
      legalName: 'Counter One Apothecary Demonstration LLC',
      dba: 'Counter One Apothecary — Sandbox',
      state: 'VA',
      licenseNumber: 'DEMO-NOT-A-LICENSE',
      licenseCategory: 'MEDICAL',
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      licenseVerifiedAt: nowIso(),
      licenseVerificationSource: 'SANDBOX FIXTURE — NOT STATE VERIFICATION',
      partnerId: partner.id,
      posProvider: 'GLP POS Emulator',
      posMerchantId: 'demo-merchant-001',
      settlementWallet: 'GLPDemoMerchantWallet111111111111111111111111',
      sandboxOnly: true
    }, 'seed');
    this.updateMerchantControls(merchant.id, {
      paused: false,
      perTransactionLimitCents: 25_000,
      dailyLimitCents: 100_000,
      allowedAssetCode: 'SANDBOX-USD',
      allowedMint: 'GLPSandboxMint11111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      requiredCommitment: 'FINALIZED',
      storeIds: ['store-001'],
      registerIds: ['register-01']
    }, 'seed');
    this.setMerchantStatus(merchant.id, 'ACTIVE', 'seed');
  }

  createPartner(input, actor = 'operator') {
    const createdAt = nowIso();
    const partner = {
      id: id('partner'),
      legalName: requiredString(input.legalName, 'legalName'),
      status: 'DRAFT',
      cannabisApprovalReference: input.cannabisApprovalReference ? requiredString(input.cannabisApprovalReference, 'cannabisApprovalReference') : null,
      approvalScope: input.approvalScope ? requiredString(input.approvalScope, 'approvalScope', 500) : null,
      approvalExpiresAt: input.approvalExpiresAt ? ensureFutureDate(input.approvalExpiresAt, 'approvalExpiresAt') : null,
      custodyAuthorized: boolInt(input.custodyAuthorized),
      conversionAuthorized: boolInt(input.conversionAuthorized),
      transmissionAuthorized: boolInt(input.transmissionAuthorized),
      screeningAuthorized: boolInt(input.screeningAuthorized),
      settlementAuthorized: boolInt(input.settlementAuthorized)
    };
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO partners
        (id,legal_name,status,cannabis_approval_reference,approval_scope,approval_expires_at,
         custody_authorized,conversion_authorized,transmission_authorized,screening_authorized,
         settlement_authorized,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        partner.id, partner.legalName, partner.status, partner.cannabisApprovalReference,
        partner.approvalScope, partner.approvalExpiresAt, partner.custodyAuthorized,
        partner.conversionAuthorized, partner.transmissionAuthorized, partner.screeningAuthorized,
        partner.settlementAuthorized, createdAt, createdAt
      );
      this.#audit('PARTNER', partner.id, 'PARTNER_CREATED', actor, { legal_name: partner.legalName, status: partner.status });
      return this.getPartner(partner.id);
    });
  }

  #partnerQualificationErrors(partner) {
    const errors = [];
    if (!partner.cannabis_approval_reference) errors.push('written cannabis approval reference');
    if (!partner.approval_scope) errors.push('approval scope');
    if (!partner.approval_expires_at || new Date(partner.approval_expires_at) <= new Date()) errors.push('unexpired approval');
    for (const [field, label] of [
      ['custody_authorized', 'custody authorization'],
      ['conversion_authorized', 'conversion authorization'],
      ['transmission_authorized', 'transmission authorization'],
      ['screening_authorized', 'screening authorization'],
      ['settlement_authorized', 'settlement authorization']
    ]) if (!partner[field]) errors.push(label);
    return errors;
  }

  setPartnerStatus(partnerId, status, actor = 'operator') {
    if (!PARTNER_STATUSES.has(status)) throw new DomainError('VALIDATION_ERROR', 'Invalid partner status.');
    return this.#transaction(() => {
      const partner = this.getPartner(partnerId);
      if (status === 'APPROVED') {
        const missing = this.#partnerQualificationErrors(partner);
        if (missing.length) throw new DomainError('PARTNER_NOT_QUALIFIED', `Partner cannot be approved. Missing: ${missing.join(', ')}.`, 409, { missing });
      }
      this.db.prepare('UPDATE partners SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), partnerId);
      this.#audit('PARTNER', partnerId, 'PARTNER_STATUS_CHANGED', actor, { from: partner.status, to: status });
      return this.getPartner(partnerId);
    });
  }

  getPartner(partnerId) {
    const row = this.db.prepare('SELECT * FROM partners WHERE id=?').get(partnerId);
    if (!row) throw new DomainError('NOT_FOUND', 'Partner not found.', 404);
    return publicPartner(row);
  }

  listPartners() {
    return this.db.prepare('SELECT * FROM partners ORDER BY created_at DESC').all().map(publicPartner);
  }

  createMerchant(input, actor = 'operator') {
    const partner = this.getPartner(requiredString(input.partnerId, 'partnerId'));
    if (partner.status !== 'APPROVED') throw new DomainError('PARTNER_NOT_APPROVED', 'Merchant must be assigned to an approved partner.', 409);
    const createdAt = nowIso();
    const merchant = {
      id: id('merchant'),
      legalName: requiredString(input.legalName, 'legalName'),
      dba: requiredString(input.dba, 'dba'),
      state: requiredString(input.state, 'state', 2).toUpperCase(),
      licenseNumber: requiredString(input.licenseNumber, 'licenseNumber'),
      licenseCategory: requiredString(input.licenseCategory, 'licenseCategory').toUpperCase(),
      licenseExpiresAt: ensureFutureDate(input.licenseExpiresAt, 'licenseExpiresAt'),
      licenseVerifiedAt: new Date(requiredString(input.licenseVerifiedAt, 'licenseVerifiedAt')).toISOString(),
      licenseVerificationSource: requiredString(input.licenseVerificationSource, 'licenseVerificationSource', 500),
      partnerId: partner.id,
      posProvider: requiredString(input.posProvider, 'posProvider'),
      posMerchantId: requiredString(input.posMerchantId, 'posMerchantId'),
      settlementWallet: requiredString(input.settlementWallet, 'settlementWallet'),
      sandboxOnly: input.sandboxOnly !== false ? 1 : 0
    };
    if (!['MEDICAL', 'ADULT_USE'].includes(merchant.licenseCategory)) throw new DomainError('VALIDATION_ERROR', 'licenseCategory must be MEDICAL or ADULT_USE.');
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO merchants
        (id,legal_name,dba,state,license_number,license_category,license_expires_at,
         license_verified_at,license_verification_source,partner_id,pos_provider,pos_merchant_id,
         settlement_wallet,status,sandbox_only,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        merchant.id, merchant.legalName, merchant.dba, merchant.state, merchant.licenseNumber,
        merchant.licenseCategory, merchant.licenseExpiresAt, merchant.licenseVerifiedAt,
        merchant.licenseVerificationSource, merchant.partnerId, merchant.posProvider,
        merchant.posMerchantId, merchant.settlementWallet, 'UNDER_REVIEW', merchant.sandboxOnly,
        createdAt, createdAt
      );
      this.#audit('MERCHANT', merchant.id, 'MERCHANT_CREATED', actor, {
        legal_name: merchant.legalName, state: merchant.state, license_category: merchant.licenseCategory, sandbox_only: Boolean(merchant.sandboxOnly)
      });
      return this.getMerchant(merchant.id);
    });
  }

  updateMerchantControls(merchantId, input, actor = 'operator') {
    this.getMerchant(merchantId);
    const perTransaction = positiveInteger(input.perTransactionLimitCents, 'perTransactionLimitCents');
    const daily = positiveInteger(input.dailyLimitCents, 'dailyLimitCents');
    if (perTransaction > daily) throw new DomainError('VALIDATION_ERROR', 'Per-transaction limit cannot exceed the daily limit.');
    const stores = Array.isArray(input.storeIds) ? input.storeIds.map((x) => requiredString(x, 'storeId', 100)) : [];
    const registers = Array.isArray(input.registerIds) ? input.registerIds.map((x) => requiredString(x, 'registerId', 100)) : [];
    if (!stores.length || !registers.length) throw new DomainError('VALIDATION_ERROR', 'At least one store and register must be allowlisted.');
    const commitment = requiredString(input.requiredCommitment, 'requiredCommitment').toUpperCase();
    if (!['CONFIRMED', 'FINALIZED'].includes(commitment)) throw new DomainError('VALIDATION_ERROR', 'requiredCommitment must be CONFIRMED or FINALIZED.');
    const updatedAt = nowIso();
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO merchant_controls
        (merchant_id,paused,per_transaction_limit_cents,daily_limit_cents,allowed_asset_code,
         allowed_mint,token_program,required_commitment,store_ids_json,register_ids_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(merchant_id) DO UPDATE SET
          paused=excluded.paused,
          per_transaction_limit_cents=excluded.per_transaction_limit_cents,
          daily_limit_cents=excluded.daily_limit_cents,
          allowed_asset_code=excluded.allowed_asset_code,
          allowed_mint=excluded.allowed_mint,
          token_program=excluded.token_program,
          required_commitment=excluded.required_commitment,
          store_ids_json=excluded.store_ids_json,
          register_ids_json=excluded.register_ids_json,
          updated_at=excluded.updated_at
      `).run(
        merchantId, boolInt(input.paused), perTransaction, daily,
        requiredString(input.allowedAssetCode, 'allowedAssetCode'), requiredString(input.allowedMint, 'allowedMint'),
        requiredString(input.tokenProgram, 'tokenProgram'), commitment, JSON.stringify(stores),
        JSON.stringify(registers), updatedAt
      );
      this.#audit('MERCHANT', merchantId, 'MERCHANT_CONTROLS_UPDATED', actor, {
        paused: Boolean(input.paused), per_transaction_limit_cents: perTransaction,
        daily_limit_cents: daily, allowed_asset_code: input.allowedAssetCode,
        required_commitment: commitment, store_ids: stores, register_ids: registers
      });
      return this.getMerchant(merchantId);
    });
  }

  setMerchantStatus(merchantId, status, actor = 'operator') {
    if (!MERCHANT_STATUSES.has(status)) throw new DomainError('VALIDATION_ERROR', 'Invalid merchant status.');
    return this.#transaction(() => {
      const merchant = this.getMerchant(merchantId);
      if (status === 'ACTIVE') {
        const partner = this.getPartner(merchant.partner_id);
        if (partner.status !== 'APPROVED') throw new DomainError('PARTNER_NOT_APPROVED', 'Assigned partner is not approved.', 409);
        if (new Date(merchant.license_expires_at) <= new Date()) throw new DomainError('MERCHANT_LICENSE_EXPIRED', 'Merchant license has expired.', 409);
        if (!merchant.controls) throw new DomainError('CONTROLS_REQUIRED', 'Merchant controls must be configured before activation.', 409);
      }
      this.db.prepare('UPDATE merchants SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), merchantId);
      this.#audit('MERCHANT', merchantId, 'MERCHANT_STATUS_CHANGED', actor, { from: merchant.status, to: status });
      return this.getMerchant(merchantId);
    });
  }

  getMerchant(merchantId) {
    const row = this.db.prepare('SELECT * FROM merchants WHERE id=?').get(merchantId);
    if (!row) throw new DomainError('NOT_FOUND', 'Merchant not found.', 404);
    const controls = this.db.prepare('SELECT * FROM merchant_controls WHERE merchant_id=?').get(merchantId);
    return { ...publicMerchant(row), controls: publicControls(controls) };
  }

  listMerchants() {
    return this.db.prepare('SELECT id FROM merchants ORDER BY created_at DESC').all().map((row) => this.getMerchant(row.id));
  }

  createPaymentIntent(input, actor = 'pos-emulator') {
    rejectSensitiveFields(input);
    const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey', 120);
    const replay = this.db.prepare('SELECT * FROM payment_intents WHERE idempotency_key=?').get(idempotencyKey);
    if (replay) return { ...publicIntent(replay), idempotent_replay: true };

    const merchant = this.getMerchant(requiredString(input.merchantId, 'merchantId'));
    if (merchant.status !== 'ACTIVE') throw new DomainError('MERCHANT_NOT_ACTIVE', 'Merchant is not active.', 409);
    if (merchant.controls?.paused) throw new DomainError('MERCHANT_PAUSED', 'Merchant has paused new payment requests.', 409);
    if (new Date(merchant.license_expires_at) <= new Date()) throw new DomainError('MERCHANT_LICENSE_EXPIRED', 'Merchant license has expired.', 409);
    const partner = this.getPartner(merchant.partner_id);
    if (partner.status !== 'APPROVED') throw new DomainError('PARTNER_NOT_APPROVED', 'Assigned payment partner is not approved.', 409);
    if (input.posAuthorized !== true) throw new DomainError('POS_AUTHORIZATION_REQUIRED', 'The POS must supply a final authorization flag before a payment request is created.', 409);

    const controls = merchant.controls;
    const amount = positiveInteger(input.amountUsdCents, 'amountUsdCents');
    if (amount > controls.per_transaction_limit_cents) throw new DomainError('TRANSACTION_LIMIT_EXCEEDED', 'Amount exceeds the merchant per-transaction limit.', 409);
    const storeId = requiredString(input.storeId, 'storeId', 100);
    const registerId = requiredString(input.registerId, 'registerId', 100);
    if (!controls.store_ids.includes(storeId)) throw new DomainError('STORE_NOT_ALLOWED', 'Store is not allowlisted.', 409);
    if (!controls.register_ids.includes(registerId)) throw new DomainError('REGISTER_NOT_ALLOWED', 'Register is not allowlisted.', 409);
    const asset = requiredString(input.assetCode, 'assetCode');
    if (asset !== controls.allowed_asset_code) throw new DomainError('ASSET_NOT_ALLOWED', 'Requested asset is not allowlisted for this merchant.', 409);

    const today = nowIso().slice(0, 10);
    const daily = this.db.prepare(`
      SELECT COALESCE(SUM(amount_usd_cents),0) AS total
      FROM payment_intents
      WHERE merchant_id=? AND substr(created_at,1,10)=?
        AND status NOT IN ('DECLINED','CANCELLED','EXPIRED')
    `).get(merchant.id, today).total;
    if (daily + amount > controls.daily_limit_cents) throw new DomainError('DAILY_LIMIT_EXCEEDED', 'Amount would exceed the merchant daily limit.', 409);

    const createdAt = nowIso();
    const paymentId = id('pi');
    const token = randomBytes(24).toString('base64url');
    const checkoutExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const expectedRawAmount = amount * 10_000;
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO payment_intents
        (id,public_reference,idempotency_key,merchant_id,partner_id,store_id,register_id,
         amount_usd_cents,asset_code,expected_mint,expected_token_program,expected_raw_amount,
         expected_destination,checkout_token_hash,checkout_expires_at,pos_authorized,status,
         created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        paymentId, `GLP-${randomBytes(5).toString('hex').toUpperCase()}`, idempotencyKey,
        merchant.id, partner.id, storeId, registerId, amount, asset, controls.allowed_mint,
        controls.token_program, expectedRawAmount, merchant.settlement_wallet, sha256(token),
        checkoutExpiresAt, 1, 'SCREENING_REQUIRED', createdAt, createdAt
      );
      this.#audit('PAYMENT_INTENT', paymentId, 'PAYMENT_INTENT_CREATED', actor, {
        merchant_id: merchant.id, store_id: storeId, register_id: registerId,
        amount_usd_cents: amount, asset_code: asset, pos_authorized: true
      });
      return {
        ...this.getPaymentIntent(paymentId),
        checkout_token: token
      };
    });
  }

  getCheckoutSession(paymentId, checkoutToken) {
    const token = requiredString(checkoutToken, 'checkoutToken', 200);
    const row = this.db.prepare('SELECT * FROM payment_intents WHERE id=?').get(paymentId);
    if (!row || !hashesMatch(sha256(token), row.checkout_token_hash)) {
      throw new DomainError('CHECKOUT_NOT_FOUND', 'This one-time checkout could not be found.', 404);
    }
    const intent = publicIntent(row);
    const merchant = this.getMerchant(intent.merchant_id);
    const expired = new Date(intent.checkout_expires_at) <= new Date();
    return {
      mode: 'SANDBOX',
      prototype_version: PROTOTYPE_VERSION,
      live_money_movement: false,
      intent_id: intent.id,
      public_reference: intent.public_reference,
      merchant: {
        dba: merchant.dba,
        state: merchant.state,
        license_category: merchant.license_category,
        sandbox_only: merchant.sandbox_only
      },
      store_id: intent.store_id,
      register_id: intent.register_id,
      amount_usd_cents: intent.amount_usd_cents,
      amount_usd: intent.amount_usd,
      asset_code: intent.asset_code,
      status: intent.status,
      checkout_expires_at: intent.checkout_expires_at,
      expired,
      can_authorize: intent.status === 'READY_FOR_PAYMENT' && !expired
    };
  }

  authorizeCheckout(paymentId, checkoutToken, input, actor = 'customer-handoff-sandbox') {
    const checkout = this.getCheckoutSession(paymentId, checkoutToken);
    if (!checkout.can_authorize) {
      if (checkout.expired) throw new DomainError('PAYMENT_INTENT_EXPIRED', 'This one-time checkout has expired.', 409);
      throw new DomainError('CHECKOUT_NOT_READY', 'This checkout is not ready for sandbox authorization.', 409, { status: checkout.status });
    }
    return this.submitPaymentSignature(paymentId, input, actor);
  }

  rotateCheckoutToken(paymentId, actor = 'merchant-operator', currentToken) {
    return this.#transaction(() => {
      // Validate the current checkout capability before issuing a replacement.
      // A caller must already hold the current token to obtain a new one —
      // this prevents unauthenticated rotation via intent-ID enumeration.
      this.getCheckoutSession(paymentId, requiredString(currentToken, 'currentToken', 200));
      const intent = this.getPaymentIntent(paymentId);
      if (!ROTATABLE_INTENT_STATUSES.has(intent.status)) {
        throw new DomainError('INVALID_STATE', 'A checkout token can be rotated only before a payment signature is submitted.', 409, { status: intent.status });
      }
      const token = randomBytes(24).toString('base64url');
      const checkoutExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      this.db.prepare('UPDATE payment_intents SET checkout_token_hash=?, checkout_expires_at=?, updated_at=? WHERE id=?')
        .run(sha256(token), checkoutExpiresAt, nowIso(), paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'CHECKOUT_TOKEN_ROTATED', actor, {
        previous_token_invalidated: true,
        checkout_expires_at: checkoutExpiresAt
      });
      return {
        ...this.getPaymentIntent(paymentId),
        previous_token_invalidated: true,
        checkout_token: token
      };
    });
  }

  screenPaymentIntent(paymentId, input, actor = 'partner-sandbox') {
    const decision = requiredString(input.decision, 'decision').toUpperCase();
    if (!['APPROVE', 'DECLINE', 'REVIEW'].includes(decision)) throw new DomainError('VALIDATION_ERROR', 'decision must be APPROVE, DECLINE, or REVIEW.');
    const reference = requiredString(input.partnerReference, 'partnerReference');
    return this.#transaction(() => {
      const intent = this.getPaymentIntent(paymentId);
      if (!['SCREENING_REQUIRED', 'REVIEW_REQUIRED'].includes(intent.status)) throw new DomainError('INVALID_STATE', 'Payment intent is not awaiting screening.', 409);
      const partner = this.getPartner(intent.partner_id);
      if (partner.status !== 'APPROVED' || !partner.screening_authorized) throw new DomainError('PARTNER_NOT_APPROVED', 'Partner is not approved to screen this payment.', 409);
      const status = decision === 'APPROVE' ? 'READY_FOR_PAYMENT' : decision === 'DECLINE' ? 'DECLINED' : 'REVIEW_REQUIRED';
      const reason = decision === 'APPROVE' ? null : requiredString(input.reason || `${decision} by partner`, 'reason', 500);
      this.db.prepare(`
        UPDATE payment_intents
        SET partner_decision=?,partner_reference=?,status=?,status_reason=?,updated_at=?
        WHERE id=?
      `).run(decision, reference, status, reason, nowIso(), paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'PARTNER_SCREENING_RECORDED', actor, { decision, partner_reference: reference, status, reason });
      return this.getPaymentIntent(paymentId);
    });
  }

  submitPaymentSignature(paymentId, input, actor = 'checkout-sandbox') {
    const signature = requiredString(input.signature, 'signature', 200);
    const sourceWallet = requiredString(input.sourceWallet, 'sourceWallet', 200);
    return this.#transaction(() => {
      const intent = this.getPaymentIntent(paymentId);
      if (intent.status !== 'READY_FOR_PAYMENT') throw new DomainError('INVALID_STATE', 'Payment intent is not ready for a transaction signature.', 409);
      if (new Date(intent.checkout_expires_at) <= new Date()) {
        this.db.prepare('UPDATE payment_intents SET status=?,status_reason=?,updated_at=? WHERE id=?')
          .run('EXPIRED', 'Checkout token expired before submission.', nowIso(), paymentId);
        this.#audit('PAYMENT_INTENT', paymentId, 'PAYMENT_INTENT_EXPIRED', actor, {});
        throw new DomainError('PAYMENT_INTENT_EXPIRED', 'Payment intent has expired.', 409);
      }
      this.db.prepare('UPDATE payment_intents SET source_wallet=?,signature=?,status=?,updated_at=? WHERE id=?')
        .run(sourceWallet, signature, 'SUBMITTED', nowIso(), paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'SIGNATURE_SUBMITTED', actor, { signature, source_wallet: sourceWallet });
      return this.getPaymentIntent(paymentId);
    });
  }

  #normalizeEvidence(value, label) {
    if (!value || typeof value !== 'object') throw new DomainError('VALIDATION_ERROR', `${label} evidence is required.`);
    return {
      rpcProvider: requiredString(value.rpcProvider, `${label}.rpcProvider`),
      signature: requiredString(value.signature, `${label}.signature`),
      commitment: requiredString(value.commitment, `${label}.commitment`).toUpperCase(),
      tokenProgram: requiredString(value.tokenProgram, `${label}.tokenProgram`),
      mint: requiredString(value.mint, `${label}.mint`),
      sourceWallet: requiredString(value.sourceWallet, `${label}.sourceWallet`),
      destinationWallet: requiredString(value.destinationWallet, `${label}.destinationWallet`),
      rawAmount: positiveInteger(value.rawAmount, `${label}.rawAmount`),
      slot: positiveInteger(value.slot, `${label}.slot`),
      transactionError: Boolean(value.transactionError)
    };
  }

  verifyPaymentIntent(paymentId, input, actor = 'verification-service') {
    const primary = this.#normalizeEvidence(input.primary, 'primary');
    const secondary = this.#normalizeEvidence(input.secondary, 'secondary');
    return this.#transaction(() => {
      const intent = this.getPaymentIntent(paymentId);
      if (intent.status !== 'SUBMITTED') throw new DomainError('INVALID_STATE', 'Payment intent is not awaiting verification.', 409);
      const merchant = this.getMerchant(intent.merchant_id);
      const mismatches = [];
      if (primary.rpcProvider === secondary.rpcProvider) mismatches.push('RPC providers must be independent');
      const expected = {
        signature: intent.signature,
        commitment: merchant.controls.required_commitment,
        tokenProgram: intent.expected_token_program,
        mint: intent.expected_mint,
        sourceWallet: intent.source_wallet,
        destinationWallet: intent.expected_destination,
        rawAmount: intent.expected_raw_amount
      };
      for (const [label, evidence] of [['primary', primary], ['secondary', secondary]]) {
        for (const [field, expectedValue] of Object.entries(expected)) {
          if (evidence[field] !== expectedValue) mismatches.push(`${label}.${field} does not match the payment intent`);
        }
        if (evidence.transactionError) mismatches.push(`${label} reports a transaction error`);
      }
      if (primary.slot !== secondary.slot) mismatches.push('RPC providers disagree on transaction slot');

      for (const evidence of [primary, secondary]) {
        this.db.prepare(`
          INSERT INTO verification_evidence
          (id,payment_intent_id,rpc_provider,signature,commitment,token_program,mint,source_wallet,
           destination_wallet,raw_amount,slot,transaction_error,observed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(payment_intent_id,rpc_provider) DO UPDATE SET
            id=excluded.id,
            signature=excluded.signature,
            commitment=excluded.commitment,
            token_program=excluded.token_program,
            mint=excluded.mint,
            source_wallet=excluded.source_wallet,
            destination_wallet=excluded.destination_wallet,
            raw_amount=excluded.raw_amount,
            slot=excluded.slot,
            transaction_error=excluded.transaction_error,
            observed_at=excluded.observed_at
        `).run(
          id('evidence'), paymentId, evidence.rpcProvider, evidence.signature, evidence.commitment,
          evidence.tokenProgram, evidence.mint, evidence.sourceWallet, evidence.destinationWallet,
          evidence.rawAmount, evidence.slot, boolInt(evidence.transactionError), nowIso()
        );
      }

      if (mismatches.length) {
        this.db.prepare('UPDATE payment_intents SET status=?,status_reason=?,updated_at=? WHERE id=?')
          .run('REVIEW_REQUIRED', mismatches.join('; '), nowIso(), paymentId);
        this.#audit('PAYMENT_INTENT', paymentId, 'VERIFICATION_REVIEW_REQUIRED', actor, { mismatches });
        return { intent: this.getPaymentIntent(paymentId), verified: false, mismatches };
      }

      const ledgerTransactionId = id('ledger_tx');
      const createdAt = nowIso();
      this.db.prepare('INSERT INTO ledger_transactions (id,payment_intent_id,description,created_at) VALUES (?,?,?,?)')
        .run(ledgerTransactionId, paymentId, 'Operational observation of partner-directed onchain settlement', createdAt);
      this.db.prepare('INSERT INTO ledger_entries (id,transaction_id,account_code,side,amount_cents,created_at) VALUES (?,?,?,?,?,?)')
        .run(id('entry'), ledgerTransactionId, 'ONCHAIN_SETTLEMENT_OBSERVED', 'DEBIT', intent.amount_usd_cents, createdAt);
      this.db.prepare('INSERT INTO ledger_entries (id,transaction_id,account_code,side,amount_cents,created_at) VALUES (?,?,?,?,?,?)')
        .run(id('entry'), ledgerTransactionId, 'MERCHANT_SETTLEMENT_PENDING', 'CREDIT', intent.amount_usd_cents, createdAt);
      this.db.prepare('UPDATE payment_intents SET status=?,status_reason=NULL,updated_at=? WHERE id=?')
        .run('VERIFIED', createdAt, paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'TRANSACTION_VERIFIED', actor, {
        signature: intent.signature, slot: primary.slot, commitment: primary.commitment,
        mint: primary.mint, destination_wallet: primary.destinationWallet,
        raw_amount: primary.rawAmount, rpc_providers: [primary.rpcProvider, secondary.rpcProvider]
      });
      return { intent: this.getPaymentIntent(paymentId), verified: true, mismatches: [] };
    });
  }

  reconcilePaymentIntent(paymentId, input, actor = 'reconciliation-service') {
    return this.#transaction(() => {
      const intent = this.getPaymentIntent(paymentId);
      if (!['VERIFIED', 'EXCEPTION'].includes(intent.status)) throw new DomainError('INVALID_STATE', 'Payment intent is not ready for reconciliation.', 409);
      const posAmount = positiveInteger(input.posAmountCents, 'posAmountCents');
      const chainRaw = positiveInteger(input.chainRawAmount, 'chainRawAmount');
      const partnerAmount = positiveInteger(input.partnerAmountCents, 'partnerAmountCents');
      const ledger = this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN le.side='DEBIT' THEN le.amount_cents ELSE 0 END),0) AS debits,
          COALESCE(SUM(CASE WHEN le.side='CREDIT' THEN le.amount_cents ELSE 0 END),0) AS credits
        FROM ledger_transactions lt JOIN ledger_entries le ON le.transaction_id=lt.id
        WHERE lt.payment_intent_id=?
      `).get(paymentId);
      const exceptions = [];
      if (posAmount !== intent.amount_usd_cents) exceptions.push('POS amount mismatch');
      if (chainRaw !== intent.expected_raw_amount) exceptions.push('Onchain amount mismatch');
      if (partnerAmount !== intent.amount_usd_cents) exceptions.push('Partner settlement amount mismatch');
      if (ledger.debits !== ledger.credits) exceptions.push('Operational ledger is out of balance');
      if (ledger.debits !== intent.amount_usd_cents) exceptions.push('Operational ledger amount mismatch');
      const status = exceptions.length ? 'EXCEPTION' : 'MATCHED';
      const intentStatus = exceptions.length ? 'EXCEPTION' : 'RECONCILED';
      this.db.prepare(`
        INSERT INTO reconciliations
        (payment_intent_id,pos_amount_cents,chain_raw_amount,partner_amount_cents,ledger_amount_cents,status,exceptions_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(payment_intent_id) DO UPDATE SET
          pos_amount_cents=excluded.pos_amount_cents,
          chain_raw_amount=excluded.chain_raw_amount,
          partner_amount_cents=excluded.partner_amount_cents,
          ledger_amount_cents=excluded.ledger_amount_cents,
          status=excluded.status,
          exceptions_json=excluded.exceptions_json,
          created_at=excluded.created_at
      `).run(paymentId, posAmount, chainRaw, partnerAmount, ledger.debits, status, JSON.stringify(exceptions), nowIso());
      this.db.prepare('UPDATE payment_intents SET status=?,status_reason=?,updated_at=? WHERE id=?')
        .run(intentStatus, exceptions.length ? exceptions.join('; ') : null, nowIso(), paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'RECONCILIATION_COMPLETED', actor, { status, exceptions, pos_amount_cents: posAmount, chain_raw_amount: chainRaw, partner_amount_cents: partnerAmount, ledger_amount_cents: ledger.debits });
      return { intent: this.getPaymentIntent(paymentId), reconciliation: this.getReconciliation(paymentId) };
    });
  }

  cancelPaymentIntent(paymentId, reason, actor = 'merchant-operator') {
    return this.#transaction(() => {
      const intent = this.getPaymentIntent(paymentId);
      if (TERMINAL_INTENT_STATUSES.has(intent.status) || intent.status === 'VERIFIED') throw new DomainError('INVALID_STATE', 'This payment intent can no longer be cancelled.', 409);
      const text = requiredString(reason, 'reason', 500);
      this.db.prepare('UPDATE payment_intents SET status=?,status_reason=?,updated_at=? WHERE id=?')
        .run('CANCELLED', text, nowIso(), paymentId);
      this.#audit('PAYMENT_INTENT', paymentId, 'PAYMENT_INTENT_CANCELLED', actor, { reason: text });
      return this.getPaymentIntent(paymentId);
    });
  }

  getPaymentIntent(paymentId) {
    const row = this.db.prepare('SELECT * FROM payment_intents WHERE id=?').get(paymentId);
    if (!row) throw new DomainError('NOT_FOUND', 'Payment intent not found.', 404);
    return publicIntent(row);
  }

  listPaymentIntents(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return this.db.prepare('SELECT * FROM payment_intents ORDER BY created_at DESC LIMIT ?').all(safeLimit).map(publicIntent);
  }

  getReconciliation(paymentId) {
    const row = this.db.prepare('SELECT * FROM reconciliations WHERE payment_intent_id=?').get(paymentId);
    return row ? { ...row, exceptions: parseJson(row.exceptions_json, []) } : null;
  }

  getVerificationEvidence(paymentId) {
    return this.db.prepare(
      'SELECT rpc_provider,signature,commitment,token_program,mint,source_wallet,destination_wallet,raw_amount,slot,transaction_error,observed_at FROM verification_evidence WHERE payment_intent_id=? ORDER BY rpc_provider ASC'
    ).all(paymentId);
  }

  evidenceBundle(paymentId) {
    const intent = this.getPaymentIntent(paymentId);
    if (!['EXCEPTION', 'RECONCILED'].includes(intent.status)) {
      throw new DomainError('EVIDENCE_NOT_AVAILABLE', 'Evidence is available only after this payment intent has been reconciled (or flagged as an exception).', 409, { status: intent.status });
    }
    const merchant = this.getMerchant(intent.merchant_id);
    const partner = this.getPartner(intent.partner_id);
    const observations = this.db.prepare('SELECT * FROM verification_evidence WHERE payment_intent_id=? ORDER BY rpc_provider ASC').all(paymentId)
      .map((row) => ({
        rpc_provider: row.rpc_provider,
        signature: row.signature,
        commitment: row.commitment,
        token_program: row.token_program,
        mint: row.mint,
        source_wallet: row.source_wallet,
        destination_wallet: row.destination_wallet,
        raw_amount: row.raw_amount,
        slot: row.slot,
        transaction_error: Boolean(row.transaction_error),
        observed_at: row.observed_at
      }));
    const ledgerTransaction = this.db.prepare('SELECT * FROM ledger_transactions WHERE payment_intent_id=?').get(paymentId) || null;
    const ledgerEntries = ledgerTransaction
      ? this.db.prepare('SELECT * FROM ledger_entries WHERE transaction_id=? ORDER BY side ASC').all(ledgerTransaction.id)
      : [];
    const debits = ledgerEntries.filter((entry) => entry.side === 'DEBIT').reduce((sum, entry) => sum + Number(entry.amount_cents), 0);
    const credits = ledgerEntries.filter((entry) => entry.side === 'CREDIT').reduce((sum, entry) => sum + Number(entry.amount_cents), 0);
    const auditEvents = this.db.prepare('SELECT * FROM audit_events WHERE aggregate_id=? ORDER BY sequence ASC').all(paymentId)
      .map((row) => ({
        sequence: row.sequence,
        event_id: row.event_id,
        action: row.action,
        actor: row.actor,
        payload: parseJson(row.payload_json, {}),
        previous_hash: row.previous_hash,
        event_hash: row.event_hash,
        created_at: row.created_at
      }));
    return {
      schema: 'glp.sandbox.evidence.v1',
      generated_at: nowIso(),
      mode: 'SANDBOX',
      prototype_version: PROTOTYPE_VERSION,
      live_money_movement: false,
      assertions: {
        sandbox_only: true,
        no_custody: true,
        no_live_funds: true,
        fictional_records: true
      },
      payment_intent: {
        id: intent.id,
        public_reference: intent.public_reference,
        merchant_id: intent.merchant_id,
        partner_id: intent.partner_id,
        store_id: intent.store_id,
        register_id: intent.register_id,
        amount_usd_cents: intent.amount_usd_cents,
        amount_usd: intent.amount_usd,
        asset_code: intent.asset_code,
        expected_mint: intent.expected_mint,
        expected_token_program: intent.expected_token_program,
        expected_raw_amount: intent.expected_raw_amount,
        expected_destination: intent.expected_destination,
        pos_authorized: intent.pos_authorized,
        partner_decision: intent.partner_decision,
        partner_reference: intent.partner_reference,
        source_wallet: intent.source_wallet,
        signature: intent.signature,
        status: intent.status,
        status_reason: intent.status_reason,
        created_at: intent.created_at,
        updated_at: intent.updated_at
      },
      partner: {
        id: partner.id,
        legal_name: partner.legal_name,
        status: partner.status,
        cannabis_approval_reference: partner.cannabis_approval_reference,
        approval_scope: partner.approval_scope,
        approval_expires_at: partner.approval_expires_at,
        screening_authorized: partner.screening_authorized,
        settlement_authorized: partner.settlement_authorized
      },
      merchant: {
        id: merchant.id,
        legal_name: merchant.legal_name,
        dba: merchant.dba,
        state: merchant.state,
        license_number: merchant.license_number,
        license_category: merchant.license_category,
        license_expires_at: merchant.license_expires_at,
        pos_provider: merchant.pos_provider,
        settlement_wallet: merchant.settlement_wallet,
        status: merchant.status,
        sandbox_only: merchant.sandbox_only,
        controls: merchant.controls
      },
      observations,
      ledger: {
        transaction: ledgerTransaction,
        entries: ledgerEntries,
        debits_cents: debits,
        credits_cents: credits,
        difference_cents: debits - credits
      },
      reconciliation: this.getReconciliation(paymentId),
      audit_events: auditEvents,
      audit_chain: this.verifyAuditChain()
    };
  }

  listAudit(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?').all(safeLimit)
      .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
  }

  verifyAuditChain() {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY sequence ASC').all();
    let previousHash = 'GENESIS';
    for (const row of rows) {
      const event = {
        sequence: row.sequence,
        event_id: row.event_id,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        action: row.action,
        actor: row.actor,
        payload: parseJson(row.payload_json, {}),
        previous_hash: row.previous_hash,
        created_at: row.created_at
      };
      const computed = sha256(stableStringify(event));
      if (row.previous_hash !== previousHash || row.event_hash !== computed) {
        return { valid: false, events_checked: rows.length, failed_sequence: row.sequence };
      }
      previousHash = row.event_hash;
    }
    return { valid: true, events_checked: rows.length, head_hash: previousHash };
  }

  listLedger(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = this.db.prepare(`
      SELECT lt.id, lt.payment_intent_id, lt.description, lt.created_at,
             pi.public_reference
      FROM ledger_transactions lt
      JOIN payment_intents pi ON pi.id = lt.payment_intent_id
      ORDER BY lt.created_at DESC LIMIT ?
    `).all(safeLimit);
    return rows.map(tx => {
      const entries = this.db.prepare(
        'SELECT account_code, side, amount_cents FROM ledger_entries WHERE transaction_id=? ORDER BY side ASC'
      ).all(tx.id);
      const debits_cents = entries.filter(e => e.side === 'DEBIT').reduce((s, e) => s + e.amount_cents, 0);
      const credits_cents = entries.filter(e => e.side === 'CREDIT').reduce((s, e) => s + e.amount_cents, 0);
      return { ...tx, entries, debits_cents, credits_cents, balanced: debits_cents === credits_cents };
    });
  }

  dashboard() {
    const scalar = (sql, ...params) => Number(this.db.prepare(sql).get(...params).value ?? 0);
    const ledger = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN side='DEBIT' THEN amount_cents ELSE 0 END),0) AS debits,
        COALESCE(SUM(CASE WHEN side='CREDIT' THEN amount_cents ELSE 0 END),0) AS credits
      FROM ledger_entries
    `).get();
    return {
      mode: 'SANDBOX',
      prototype_version: PROTOTYPE_VERSION,
      live_money_movement: false,
      customer_pii_collected: false,
      approved_partners: scalar("SELECT COUNT(*) AS value FROM partners WHERE status='APPROVED'"),
      active_merchants: scalar("SELECT COUNT(*) AS value FROM merchants WHERE status='ACTIVE'"),
      open_payment_intents: scalar("SELECT COUNT(*) AS value FROM payment_intents WHERE status NOT IN ('RECONCILED','DECLINED','CANCELLED','EXPIRED')"),
      reconciled_payment_intents: scalar("SELECT COUNT(*) AS value FROM payment_intents WHERE status='RECONCILED'"),
      ledger_debits_cents: Number(ledger.debits),
      ledger_credits_cents: Number(ledger.credits),
      ledger_difference_cents: Number(ledger.debits) - Number(ledger.credits),
      audit: this.verifyAuditChain()
    };
  }
}
