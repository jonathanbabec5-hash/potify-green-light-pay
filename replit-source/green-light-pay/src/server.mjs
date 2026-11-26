import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { GreenLightPayCore, DomainError } from './core.mjs';
import { requestLogLine } from './redact.mjs';

// Sandbox startup guard: this prototype is permanently sandbox-only and will
// not boot unless the operator explicitly affirms the no-live-funds boundary.
const sandboxFlag = String(process.env.GLP_SANDBOX ?? '').trim().toLowerCase();
if (!['1', 'true', 'yes', 'on'].includes(sandboxFlag)) {
  console.error('GLP_SANDBOX_GUARD: refusing to start.');
  console.error('Green Light Pay is a fictional, sandbox-only prototype. Set GLP_SANDBOX=1 to affirm the no-live-funds sandbox boundary before the server will boot.');
  process.exit(1);
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicRoot = join(root, 'public');
const databasePath = process.env.GLP_DATABASE || join(root, 'data', 'greenlight-pay.sqlite');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const basePath = String(process.env.BASE_PATH || '').trim().replace(/\/+$/, '');
const core = new GreenLightPayCore(databasePath, { seed: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function secureHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
}

function json(response, status, body) {
  response.writeHead(status, { ...secureHeaders(), 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body, null, 2));
}

function svg(response, status, body) {
  response.writeHead(status, {
    ...secureHeaders('image/svg+xml; charset=utf-8'),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function requestOrigin(request) {
  if (process.env.APP_BASE_URL) {
    const configured = new URL(process.env.APP_BASE_URL);
    if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('APP_BASE_URL must use http or https.');
    return configured.origin;
  }
  const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'https' ? 'https' : 'http';
  const hostHeader = String(request.headers.host || `127.0.0.1:${port}`);
  const candidate = new URL(`${protocol}://${hostHeader}`);
  return candidate.origin;
}

// One-time checkout capability transport:
// - The token travels ONLY in the URL fragment (never a query string), so it
//   never reaches this server, its logs, or any Referer header.
// - APIs accept the token ONLY via the Authorization: Bearer header.
function checkoutPaths(request, paymentId, checkoutToken) {
  const checkoutPath = `${basePath}/checkout/?id=${encodeURIComponent(paymentId)}#token=${encodeURIComponent(checkoutToken)}`;
  const qrPath = `${basePath}/api/checkout/${encodeURIComponent(paymentId)}/qr`;
  return {
    checkout_path: checkoutPath,
    checkout_url: new URL(checkoutPath, requestOrigin(request)).toString(),
    checkout_qr_path: qrPath
  };
}

function bearerToken(request, url) {
  if (url.searchParams.has('token')) {
    throw new DomainError('CAPABILITY_IN_QUERY', 'Checkout capabilities are accepted only in the Authorization header. Never place tokens in URLs or query strings.', 400);
  }
  const header = String(request.headers.authorization || '');
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function requireCheckoutToken(request, url) {
  const token = bearerToken(request, url);
  if (!token) throw new DomainError('CHECKOUT_NOT_FOUND', 'This one-time checkout could not be found.', 404);
  return token;
}

async function bodyJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1_000_000) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function actor(request, fallback) {
  const value = request.headers['x-glp-actor'];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
}

async function api(request, response, url, path) {
  const method = request.method || 'GET';

  if (method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok', ...core.dashboard() });
  if (method === 'GET' && path === '/api/dashboard') return json(response, 200, core.dashboard());
  if (method === 'GET' && path === '/api/partners') return json(response, 200, { partners: core.listPartners() });
  if (method === 'GET' && path === '/api/merchants') return json(response, 200, { merchants: core.listMerchants() });
  if (method === 'GET' && path === '/api/payment-intents') return json(response, 200, { payment_intents: core.listPaymentIntents(url.searchParams.get('limit')) });
  if (method === 'GET' && path === '/api/ledger') return json(response, 200, { transactions: core.listLedger(url.searchParams.get('limit')) });
  if (method === 'GET' && path === '/api/audit') return json(response, 200, { events: core.listAudit(url.searchParams.get('limit')) });
  if (method === 'GET' && path === '/api/audit/verify') return json(response, 200, core.verifyAuditChain());

  let match = path.match(/^\/api\/checkout\/([^/]+)$/);
  if (method === 'GET' && match) {
    return json(response, 200, core.getCheckoutSession(match[1], requireCheckoutToken(request, url)));
  }
  match = path.match(/^\/api\/checkout\/([^/]+)\/qr$/);
  if (method === 'GET' && match) {
    const checkoutToken = requireCheckoutToken(request, url);
    core.getCheckoutSession(match[1], checkoutToken);
    const { checkout_url: checkoutUrl } = checkoutPaths(request, match[1], checkoutToken);
    let code;
    try {
      code = await QRCode.toString(checkoutUrl, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        color: { dark: '#06160d', light: '#f3ffe9' }
      });
    } catch {
      throw new DomainError('QR_GENERATION_FAILED', 'The QR code could not be generated.', 500);
    }
    return svg(response, 200, code);
  }
  match = path.match(/^\/api\/checkout\/([^/]+)\/authorize$/);
  if (method === 'POST' && match) {
    return json(response, 200, core.authorizeCheckout(
      match[1],
      requireCheckoutToken(request, url),
      await bodyJson(request),
      actor(request, 'customer-handoff-sandbox')
    ));
  }

  if (method === 'POST' && path === '/api/partners') {
    const result = core.createPartner(await bodyJson(request), actor(request, 'partner-operator'));
    return json(response, 201, result);
  }
  match = path.match(/^\/api\/partners\/([^/]+)\/status$/);
  if (method === 'POST' && match) {
    const input = await bodyJson(request);
    return json(response, 200, core.setPartnerStatus(match[1], input.status, actor(request, 'partner-operator')));
  }

  if (method === 'POST' && path === '/api/merchants') {
    const result = core.createMerchant(await bodyJson(request), actor(request, 'merchant-underwriting'));
    return json(response, 201, result);
  }
  match = path.match(/^\/api\/merchants\/([^/]+)\/status$/);
  if (method === 'POST' && match) {
    const input = await bodyJson(request);
    return json(response, 200, core.setMerchantStatus(match[1], input.status, actor(request, 'merchant-underwriting')));
  }
  match = path.match(/^\/api\/merchants\/([^/]+)\/controls$/);
  if (method === 'PATCH' && match) {
    return json(response, 200, core.updateMerchantControls(match[1], await bodyJson(request), actor(request, 'merchant-operator')));
  }

  if (method === 'POST' && path === '/api/payment-intents') {
    const result = core.createPaymentIntent(await bodyJson(request), actor(request, 'pos-emulator'));
    if (result.idempotent_replay || !result.checkout_token) {
      return json(response, result.idempotent_replay ? 200 : 201, result);
    }
    const paths = checkoutPaths(request, result.id, result.checkout_token);
    const responseBody = { ...result, ...paths };
    delete responseBody.checkout_token;
    return json(response, 201, responseBody);
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/checkout$/);
  if (method === 'POST' && match) {
    const currentToken = requireCheckoutToken(request, url);
    const result = core.rotateCheckoutToken(match[1], actor(request, 'merchant-operator'), currentToken);
    const paths = checkoutPaths(request, result.id, result.checkout_token);
    const responseBody = { ...result, ...paths };
    delete responseBody.checkout_token;
    return json(response, 200, responseBody);
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/verification$/);
  if (method === 'GET' && match) {
    const paymentId = match[1];
    const intent = core.getPaymentIntent(paymentId);
    if (!intent) throw new DomainError('NOT_FOUND', 'Payment intent not found.', 404);
    if (!['SUBMITTED', 'REVIEW_REQUIRED', 'VERIFIED', 'EXCEPTION', 'RECONCILED'].includes(intent.status)) {
      throw new DomainError('INVALID_STATE', `Verification evidence is not yet available for status ${intent.status}.`, 409);
    }
    return json(response, 200, { evidence: core.getVerificationEvidence(paymentId) });
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/reconciliation$/);
  if (method === 'GET' && match) {
    const paymentId = match[1];
    const intent = core.getPaymentIntent(paymentId);
    if (!intent) throw new DomainError('NOT_FOUND', 'Payment intent not found.', 404);
    if (!['EXCEPTION', 'RECONCILED'].includes(intent.status)) {
      throw new DomainError('INVALID_STATE', `Reconciliation is not yet available for status ${intent.status}.`, 409);
    }
    return json(response, 200, { reconciliation: core.getReconciliation(paymentId) });
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/evidence$/);
  if (method === 'GET' && match) {
    const bundle = core.evidenceBundle(match[1]);
    const filename = `glp-evidence-${match[1].replace(/[^\w.-]/g, '_')}.json`;
    response.writeHead(200, {
      ...secureHeaders(),
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    response.end(JSON.stringify(bundle, null, 2));
    return;
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/screen$/);
  if (method === 'POST' && match) {
    return json(response, 200, core.screenPaymentIntent(match[1], await bodyJson(request), actor(request, 'partner-sandbox')));
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/verify$/);
  if (method === 'POST' && match) {
    return json(response, 200, core.verifyPaymentIntent(match[1], await bodyJson(request), actor(request, 'verification-service')));
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/reconcile$/);
  if (method === 'POST' && match) {
    return json(response, 200, core.reconcilePaymentIntent(match[1], await bodyJson(request), actor(request, 'reconciliation-service')));
  }
  match = path.match(/^\/api\/payment-intents\/([^/]+)\/cancel$/);
  if (method === 'POST' && match) {
    const input = await bodyJson(request);
    return json(response, 200, core.cancelPaymentIntent(match[1], input.reason, actor(request, 'merchant-operator')));
  }

  // Single-intent detail — must be ordered after all sub-resource routes.
  match = path.match(/^\/api\/payment-intents\/([^/]+)$/);
  if (method === 'GET' && match) return json(response, 200, core.getPaymentIntent(match[1]));

  // Note: signature submission is intentionally reachable only through the
  // token-gated checkout authorize route; any unauthenticated direct
  // submission attempt falls through to a generic 404.
  throw new DomainError('NOT_FOUND', 'API route not found.', 404);
}

async function staticFile(response, pathname) {
  const routeFiles = {
    '/': 'index.html',
    '/sandbox': 'index.html',
    '/sandbox/': 'index.html',
    '/developer': 'developer.html',
    '/developer/': 'developer.html',
    '/checkout': 'checkout.html',
    '/checkout/': 'checkout.html'
  };
  const relative = routeFiles[pathname] || pathname.slice(1);
  const filePath = resolve(publicRoot, relative);
  if (!filePath.startsWith(`${publicRoot}/`) && filePath !== join(publicRoot, 'index.html')) {
    throw new DomainError('NOT_FOUND', 'File not found.', 404);
  }
  try {
    const bytes = await readFile(filePath);
    const extension = extname(filePath);
    if (extension === '.html') {
      const html = bytes.toString('utf8').replaceAll('__GLP_BASE__', basePath);
      response.writeHead(200, { ...secureHeaders(MIME_TYPES['.html']), 'Cache-Control': 'no-cache' });
      response.end(html);
      return;
    }
    response.writeHead(200, {
      ...secureHeaders(MIME_TYPES[extension] || 'application/octet-stream'),
      'Cache-Control': 'no-cache'
    });
    response.end(bytes);
  } catch (error) {
    if (error.code === 'ENOENT') throw new DomainError('NOT_FOUND', 'File not found.', 404);
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    let pathname = url.pathname;
    if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
      pathname = pathname.slice(basePath.length) || '/';
    }
    // Redacted-by-design request log: method, path, status, and duration only.
    // Query strings, headers, bodies, and tokens are never logged.
    response.on('finish', () => {
      console.log(requestLogLine(request.method, pathname, response.statusCode, Date.now() - startedAt));
    });
    // Root redirect: bare domain root → sandbox entry point.
    // Only fires when the app is mounted at a sub-path (basePath is set).
    // The basePath guard prevents an infinite redirect when BASE_PATH is absent.
    if (basePath && url.pathname === '/') {
      response.writeHead(301, { 'Location': `${basePath}/`, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (pathname.startsWith('/api/')) await api(request, response, url, pathname);
    else await staticFile(response, pathname);
  } catch (error) {
    if (error instanceof DomainError) {
      return json(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    }
    console.error(error);
    return json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected sandbox error occurred.' } });
  }
});

server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log(`Green Light Pay sandbox running at http://${host}:${actualPort}${basePath || ''}`);
  console.log('GLP_SANDBOX affirmed — prototype 0.1.3-stage1.3. SANDBOX ONLY — no live money movement and no production provider approval.');
});

function shutdown() {
  server.close(() => {
    core.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
