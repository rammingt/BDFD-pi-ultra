'use strict';

class HttpError extends Error {
  status;
  body;
  headers;

  constructor(status, body, headers, url) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const { timeoutMs = 10_000, retries = 2, ...init } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(2 ** attempt * 500, 8_000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;

      const body = await response.text();
      const error = new HttpError(response.status, body, response.headers, url);
      if (!RETRYABLE.has(response.status) || attempt === retries) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof HttpError && !RETRYABLE.has(error.status)) throw error;
      lastError = error;
      if (attempt === retries) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Node's fetch reports every transport failure as the same "fetch failed", and hides
 * the reason that actually helps in `cause`. Dig it out, because a staff member
 * reading "fetch failed" on a Discord card has no way to tell a typo'd hostname from
 * a service that is down.
 */
function describeNetworkError(error) {
  const seen = new Set();
  let current = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    // An aborted request is our own timeout firing, not a fault at the other end.
    if (current.name === 'AbortError' || current.name === 'TimeoutError') return 'the request timed out';

    const code = (current).code;
    if (typeof code === 'string') return NETWORK_CODES[code] ?? code;

    // A host that resolves to both an IPv4 and an IPv6 address fails as an
    // AggregateError, and the errno is on the collected errors rather than a cause.
    const collected = (current).errors;
    if (Array.isArray(collected)) {
      for (const inner of collected) {
        const innerCode = (inner)?.code;
        if (typeof innerCode === 'string') return NETWORK_CODES[innerCode] ?? innerCode;
      }
    }

    current = (current).cause;
  }

  return error instanceof Error ? error.message : String(error);
}

const NETWORK_CODES = {
  ENOTFOUND: 'that host name does not resolve (ENOTFOUND)',
  EAI_AGAIN: 'the DNS lookup failed (EAI_AGAIN)',
  ECONNREFUSED: 'nothing is listening there (ECONNREFUSED)',
  ECONNRESET: 'the connection was reset (ECONNRESET)',
  ETIMEDOUT: 'the connection timed out (ETIMEDOUT)',
  EHOSTUNREACH: 'the host is unreachable (EHOSTUNREACH)',
  ENETUNREACH: 'the network is unreachable (ENETUNREACH)',
  CERT_HAS_EXPIRED: 'its TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its TLS certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its TLS certificate could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its TLS certificate is for a different host',
};

async function requestJson(url, options = {}) {
  const response = await request(url, options);
  return (await response.json());
}

module.exports = { HttpError, request, describeNetworkError, requestJson };
