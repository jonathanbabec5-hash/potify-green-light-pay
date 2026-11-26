// Redaction helpers for Green Light Pay sandbox logging.
// Request logs must never contain query strings, fragments, headers, bodies,
// tokens, PINs, or other capability material.

export const SENSITIVE_KEY_PATTERN = /(authorization|cookie|set-cookie|token|secret|password|passphrase|pin|recovery|credential|api[-_]?key|signature-key|seed)/i;

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitive(entry);
    }
    return output;
  }
  return value;
}

export function requestLogLine(method, pathname, statusCode, durationMs) {
  const cleanPath = String(pathname || '/').split('?')[0].split('#')[0];
  return `${String(method || 'GET')} ${cleanPath} ${statusCode} ${durationMs}ms`;
}
