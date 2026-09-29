// Wrappers for the third-party reputation APIs that /fullcheck consults
// alongside the local flagged-item list. The Roblox-side checks only say
// what someone owns; these say where they've been.
//
// Every provider resolves to the same shape so callers never special-case
// one:
//   { provider, configured, skipped, ok, flagged, lines, detail, error }
//
// A provider with no API key set comes back `configured: false` rather
// than as a clean result. Reporting an unconfigured provider as "nothing
// found" would turn a check that never ran into a false all-clear, which
// is the one failure mode that actually matters here.

const config = require('./config');

const REQUEST_TIMEOUT_MS = 10000;

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'request timed out';
  return err.message || 'unknown error';
}

// Treats an empty object/array as "no record" - several of these APIs
// answer a miss with 200 and an empty body rather than a 404.
function hasContent(data) {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === 'object') return Object.keys(data).length > 0;
  return Boolean(data);
}

/* -------------------------------------------------------------------- */
/* ServerSweep - Discord-side history (keyed by Discord user ID)         */
/* -------------------------------------------------------------------- */

const SERVERSWEEP_BASE = 'https://api.serversweep.com';

// Surfacing this on any flagged user is a condition of ServerSweep's
// terms, not a courtesy - omitting it can get the API key revoked.
const SERVERSWEEP_APPEALS_URL = 'https://discord.gg/KdVhtSE4Jp';

const SERVERSWEEP_TAGS = {
  1: 'Age Verified',
  2: 'Content Creator',
  3: 'Owner',
  4: 'Partner',
  5: 'Buyer',
  6: 'Level',
  7: 'Requested NSFW',
};

function serverSweepError(status, retryAfter) {
  switch (status) {
    case 400:
      return 'bad request';
    case 401:
      return 'missing or invalid SERVERSWEEP_API_KEY';
    case 403:
      return 'SERVERSWEEP_API_KEY is disabled';
    case 429:
      return `rate limited${retryAfter ? ` (retry in ${retryAfter}s)` : ''}`;
    case 500:
      return 'ServerSweep reported an internal error';
    default:
      return `HTTP ${status}`;
  }
}

function guildTypes(guild) {
  const info = guild.guildInfo;
  const entries = Array.isArray(info) ? info : info ? [info] : [];
  const types = new Set();
  for (const entry of entries) {
    for (const type of entry.types || []) types.add(type);
  }
  return Array.from(types);
}

function activityTags(guild) {
  return (guild.activity?.tags || []).map((id) => SERVERSWEEP_TAGS[id] || `tag ${id}`);
}

function summarizeServerSweep(data) {
  const guilds = Array.isArray(data.guilds) ? data.guilds : [];
  const lines = [`Flagged in ${guilds.length} tracked server(s).`];
  if (data.lastSeen) lines.push(`Last seen: ${data.lastSeen}`);

  for (const guild of guilds.slice(0, 5)) {
    const bits = [];
    const types = guildTypes(guild);
    if (types.length) bits.push(types.join('/'));
    if (guild.verifiedLeft) bits.push('confirmed left');
    const tags = activityTags(guild);
    if (tags.length) bits.push(tags.join(', '));
    lines.push(`- ${guild.name || guild.id}${bits.length ? ` (${bits.join('; ')})` : ''}`);
  }
  if (guilds.length > 5) lines.push(`...and ${guilds.length - 5} more, see the JSON.`);
  return lines;
}

async function checkServerSweep(discordUserId) {
  const base = { provider: 'ServerSweep' };
  if (!config.SERVERSWEEP_API_KEY) return { ...base, configured: false };
  if (!discordUserId) {
    return { ...base, configured: true, skipped: true, note: 'no Discord ID given' };
  }

  try {
    const res = await fetch(`${SERVERSWEEP_BASE}/v1/check/${encodeURIComponent(discordUserId)}`, {
      headers: { 'X-API-Key': config.SERVERSWEEP_API_KEY },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 204) {
      return { ...base, configured: true, ok: true, flagged: false, lines: ['Not flagged in any tracked server.'] };
    }
    if (!res.ok) {
      return {
        ...base,
        configured: true,
        ok: false,
        error: serverSweepError(res.status, res.headers.get('retry-after')),
      };
    }

    const data = await res.json();

    // An accepted appeal is deliberately not treated as a live flag - the
    // user already went through ServerSweep's process, and re-punishing
    // them for it is exactly what the appeals route exists to prevent.
    if (data.appealed) {
      return {
        ...base,
        configured: true,
        ok: true,
        flagged: false,
        appealed: true,
        lines: ['Previously flagged, but has since appealed.'],
        detail: data,
      };
    }

    return {
      ...base,
      configured: true,
      ok: true,
      flagged: true,
      appealsUrl: SERVERSWEEP_APPEALS_URL,
      lines: summarizeServerSweep(data),
      detail: data,
    };
  } catch (err) {
    return { ...base, configured: true, ok: false, error: describeError(err) };
  }
}

/* -------------------------------------------------------------------- */
/* XTracker - Roblox-side cheat history (keyed by Roblox user ID)        */
/* -------------------------------------------------------------------- */

const XTRACKER_BASE = 'https://api.xtracker.xyz';

// XTracker documents its endpoints and auth header but not its response
// bodies, so a hit is inferred from "200 with a non-empty payload" and
// the raw object is passed straight through to the JSON attachment
// instead of being reshaped against field names we'd only be guessing at.
async function xtrackerLookup(path, robloxUserId) {
  const res = await fetch(`${XTRACKER_BASE}${path}?id=${encodeURIComponent(robloxUserId)}`, {
    headers: { Authorization: config.XTRACKER_API_KEY },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 204) return { hit: false, data: null };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  return { hit: hasContent(data), data };
}

function describeLookup(label, settled) {
  if (settled.status === 'rejected') return `${label}: lookup failed (${describeError(settled.reason)})`;
  return `${label}: ${settled.value.hit ? 'MATCH' : 'clean'}`;
}

async function checkXTracker(robloxUserId) {
  const base = { provider: 'XTracker' };
  if (!config.XTRACKER_API_KEY) return { ...base, configured: false };

  const [registry, ownership] = await Promise.allSettled([
    xtrackerLookup('/api/registry/user', robloxUserId),
    xtrackerLookup('/api/ownership/user', robloxUserId),
  ]);

  if (registry.status === 'rejected' && ownership.status === 'rejected') {
    return { ...base, configured: true, ok: false, error: describeError(registry.reason) };
  }

  return {
    ...base,
    configured: true,
    ok: true,
    flagged: [registry, ownership].some((r) => r.status === 'fulfilled' && r.value.hit),
    partial: registry.status === 'rejected' || ownership.status === 'rejected',
    lines: [describeLookup('Cheater registry', registry), describeLookup('Cheat ownership', ownership)],
    detail: {
      registry: registry.status === 'fulfilled' ? registry.value.data : null,
      ownership: ownership.status === 'fulfilled' ? ownership.value.data : null,
    },
  };
}

/* -------------------------------------------------------------------- */
/* TASE - Discord-side moderation history (keyed by Discord user ID)     */
/* -------------------------------------------------------------------- */

const TASE_BASE = 'https://api.tasebot.org';

// TASE's docs give the path but not the shape of the body, so a hit is
// inferred the same way XTracker's is - "200 with a non-empty payload" -
// and the raw object goes through to the JSON attachment rather than
// being reshaped against guessed field names.
//
// The endpoint takes a 16-20 character id, which is a Discord snowflake.
// Passing a Roblox id here would be answered with a 400 or a miss, and a
// miss reads as "clean" - so this is deliberately keyed off Discord only.
//
// Unlike the two above, TASE needs no key, so it is always `configured`
// and the only thing that can stop it running is having no Discord id.
async function checkTase(discordUserId) {
  const base = { provider: 'TASE', configured: true };
  if (!discordUserId) {
    return { ...base, skipped: true, note: 'no Discord ID given' };
  }

  try {
    const res = await fetch(`${TASE_BASE}/v2/check/${encodeURIComponent(discordUserId)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 404 || res.status === 204) {
      return { ...base, ok: true, flagged: false, lines: ['No TASE record.'] };
    }
    if (res.status === 401 || res.status === 403) {
      // Not expected on a keyless endpoint; worth saying plainly if it happens.
      return { ...base, ok: false, error: `TASE refused the request (HTTP ${res.status})` };
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      return { ...base, ok: false, error: `rate limited${retryAfter ? ` (retry in ${retryAfter}s)` : ''}` };
    }
    if (!res.ok) {
      return { ...base, ok: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json().catch(() => null);
    const flagged = hasContent(data);

    return {
      ...base,
      ok: true,
      flagged,
      lines: flagged ? summarizeTase(data) : ['No TASE record.'],
      detail: data,
    };
  } catch (err) {
    return { ...base, ok: false, error: describeError(err) };
  }
}

// Written against the fields TASE is likely to use, but nothing is assumed:
// anything it does not recognise still reaches the reader through `detail`,
// so an unexpected body is never silently dropped.
function summarizeTase(data) {
  const lines = [];
  const records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [data];

  for (const record of records.slice(0, 5)) {
    if (!record || typeof record !== 'object') continue;
    const bits = [record.type || record.reason || record.status, record.date || record.createdAt]
      .filter(Boolean)
      .join(' - ');
    if (bits) lines.push(`- ${bits}`);
  }

  if (records.length > 5) lines.push(`...and ${records.length - 5} more, see the JSON.`);
  return lines.length ? ['Has a TASE record.', ...lines] : ['Has a TASE record; see the JSON.'];
}

/* -------------------------------------------------------------------- */

async function checkBehavior({ robloxUserId, discordUserId = null }) {
  const providers = await Promise.all([
    checkXTracker(robloxUserId),
    checkServerSweep(discordUserId),
    checkTase(discordUserId),
  ]);

  return {
    providers,
    flagged: providers.some((p) => p.flagged),
    // Only ever shown when something is actually flagged, per ServerSweep's terms.
    appealsUrl: providers.find((p) => p.flagged && p.appealsUrl)?.appealsUrl || null,
    // True when at least one source didn't return a usable answer, so an
    // "all clear" can be labelled as the partial result it really is.
    incomplete: providers.some((p) => p.configured === false || p.skipped || p.ok === false || p.partial),
  };
}

module.exports = { checkBehavior, checkXTracker, checkServerSweep, checkTase, SERVERSWEEP_APPEALS_URL };
