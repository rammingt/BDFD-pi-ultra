'use strict';
const { HttpError, request } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('roblox:authed');

/**
 * Roblox hands out a CSRF token on the first rejected write and expects it on the
 * retry. Tokens belong to the cookie that was used, so this is keyed by cookie -
 * presence and group management may well run as two different accounts.
 */
const csrfTokens = new Map();

/**
 * A request signed with a `.ROBLOSECURITY` cookie, retried once with a fresh CSRF
 * token when Roblox asks for one.
 */
async function robloxAuthed(url, options) {
  const { cookie, headers, ...rest } = options;

  const send = (token) =>
    request(url, {
      ...rest,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
        Cookie: `.ROBLOSECURITY=${cookie}`,
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      retries: rest.retries ?? 1,
      timeoutMs: rest.timeoutMs ?? 15_000,
    });

  try {
    return await send(csrfTokens.get(cookie));
  } catch (error) {
    const issued = error instanceof HttpError ? error.headers.get('x-csrf-token') : null;
    if (error instanceof HttpError && error.status === 403 && issued) {
      csrfTokens.set(cookie, issued);
      log.debug('Refreshed the Roblox CSRF token and retried');
      return send(issued);
    }
    throw error;
  }
}

/** Roblox wraps its failures in an errors array; this pulls out something readable. */
function robloxErrorMessage(error) {
  if (!(error instanceof HttpError)) return error instanceof Error ? error.message : String(error);

  try {
    const body = JSON.parse(error.body);
    const first = body.errors?.[0]?.message;
    if (first) return first;
  } catch {
    // Not JSON; fall through to the status.
  }

  if (error.status === 401) return 'The group account cookie is invalid or expired.';
  if (error.status === 403) return 'That account does not have permission to do this in the group.';
  if (error.status === 429) return 'Roblox is rate limiting the group account. Try again in a minute.';
  return `Roblox returned HTTP ${error.status}.`;
}

module.exports = { robloxAuthed, robloxErrorMessage };
