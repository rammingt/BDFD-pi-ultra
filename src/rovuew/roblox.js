// Thin wrapper around Roblox's public web APIs.
// Uses the global `fetch` built into Node 18+, so no extra HTTP package is needed.
const config = require('./config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries once or twice on 429 (rate limited by Roblox) with a short backoff.
async function fetchWithRetry(url, options = {}, retries = 2) {
  const res = await fetch(url, options);
  if (res.status === 429 && retries > 0) {
    await sleep(1000);
    return fetchWithRetry(url, options, retries - 1);
  }
  return res;
}

// Resolves a username to a numeric Roblox user ID. If a numeric ID is
// passed in already, it's returned as-is (no API call needed).
async function resolveUserId(usernameOrId) {
  if (/^\d+$/.test(String(usernameOrId).trim())) {
    return Number(usernameOrId);
  }
  const res = await fetchWithRetry('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [String(usernameOrId).trim()], excludeBannedUsers: false }),
  });
  if (!res.ok) throw new Error(`Failed to resolve username (status ${res.status})`);
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return data.data[0].id;
}

async function getUserInfo(userId) {
  const res = await fetchWithRetry(`https://users.roblox.com/v1/users/${userId}`);
  if (!res.ok) return null;
  return res.json();
}

// Roblox's dedicated endpoint for whether an inventory can be viewed
// (accounts for private inventory settings, under-13 restrictions, etc).
async function canViewInventory(userId) {
  const res = await fetchWithRetry(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`);
  if (!res.ok) return false;
  const data = await res.json();
  return Boolean(data.canView);
}

// All limited/collectible items (the category most trading/scam-watch
// communities care about) in one paginated call. Throws on failure
// instead of silently returning a truncated/empty list, so callers can
// tell "genuinely has none" apart from "the request failed".
async function getCollectibles(userId) {
  let items = [];
  let cursor = '';
  do {
    const url = `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`collectibles endpoint returned HTTP ${res.status}`);
    const data = await res.json();
    items = items.concat(data.data || []);
    cursor = data.nextPageCursor || '';
  } while (cursor);
  return items;
}

// Roblox doesn't expose a single "everything in the inventory" endpoint
// anymore - you enumerate per asset-type ID. This list covers the
// wearable/tradable categories people most commonly flag. Add more IDs
// from Roblox's AssetType list if you need broader coverage.
const ASSET_TYPES = {
  8: 'Hat',
  17: 'Head',
  18: 'Face',
  19: 'Gear',
  32: 'Package',
  41: 'HairAccessory',
  42: 'FaceAccessory',
  43: 'NeckAccessory',
  44: 'ShoulderAccessory',
  45: 'FrontAccessory',
  46: 'BackAccessory',
  47: 'WaistAccessory',
};

// Clothing is enumerated the same way but kept in its own list: it's a
// separate check (and a separate command), and the classic 2D types live
// alongside the newer layered-clothing ones.
const CLOTHING_TYPES = {
  2: 'T-Shirt',
  11: 'Shirt',
  12: 'Pants',
  64: 'TShirtAccessory',
  65: 'ShirtAccessory',
  66: 'PantsAccessory',
  67: 'JacketAccessory',
  68: 'SweaterAccessory',
  69: 'ShortsAccessory',
  70: 'LeftShoeAccessory',
  71: 'RightShoeAccessory',
  72: 'DressSkirtAccessory',
};

async function getInventoryByType(userId, assetTypeId) {
  let items = [];
  let cursor = '';
  do {
    const url = `https://inventory.roblox.com/v2/users/${userId}/inventory/${assetTypeId}?limit=100&sortOrder=Asc${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // This endpoint's items carry the display name in `assetName`, not
    // `name` (unlike the collectibles endpoint below) - normalize it here
    // so every accessory the rest of the app sees has a consistent `name`.
    items = items.concat((data.data || []).map((item) => ({ ...item, name: item.assetName })));
    cursor = data.nextPageCursor || '';
  } while (cursor);
  return items;
}

// Walks every asset type in `typeMap`. Returns { items, failures };
// `failures` lists which categories couldn't be fetched (e.g. Roblox
// rate-limited that specific call) so a scan is never silently
// incomplete - one bad category doesn't throw away everything else, but
// it also isn't hidden.
async function scanAssetTypes(userId, typeMap) {
  const failures = [];
  const items = [];
  for (const typeId of Object.keys(typeMap)) {
    try {
      const found = await getInventoryByType(userId, typeId);
      for (const item of found) {
        items.push({ ...item, assetTypeName: typeMap[typeId] });
      }
    } catch (err) {
      failures.push(`${typeMap[typeId]}: ${err.message}`);
    }
    await sleep(150); // be polite to Roblox's rate limits
  }
  return { items, failures };
}

async function getFullInventory(userId) {
  let collectibles = [];
  const collectibleFailures = [];
  try {
    collectibles = await getCollectibles(userId);
  } catch (err) {
    collectibleFailures.push(`collectibles: ${err.message}`);
  }

  const { items: otherItems, failures } = await scanAssetTypes(userId, ASSET_TYPES);

  // De-duplicate by asset ID; prefer the collectible version since it
  // carries extra data (recent average price, serial number, etc).
  const merged = new Map();
  for (const item of otherItems) merged.set(String(item.assetId ?? item.id), item);
  for (const item of collectibles) {
    const id = String(item.assetId ?? item.id);
    // The collectible record wins, but it carries no asset type, so the one
    // from the per-type pass is kept - some checks are scoped to a slot.
    merged.set(id, { assetTypeName: merged.get(id)?.assetTypeName, ...item });
  }
  return { items: Array.from(merged.values()), failures: [...collectibleFailures, ...failures] };
}

// Clothing only - no collectibles pass, since a limited shirt already
// shows up in its own asset-type enumeration.
async function getClothing(userId) {
  return scanAssetTypes(userId, CLOTHING_TYPES);
}

// Classifies a catalog asset type into what /flag add files it under, so a
// shirt is never stored as an accessory (which would make it invisible to
// the clothing scan). Shared by /searchcatalog and /resolvelink - both turn
// a raw asset type ID from Roblox into the same two categories.
function wearableCategory(assetType) {
  if (CLOTHING_TYPES[assetType]) return { type: 'clothing', assetTypeName: CLOTHING_TYPES[assetType] };
  if (ASSET_TYPES[assetType]) return { type: 'accessory', assetTypeName: ASSET_TYPES[assetType] };
  return null;
}

/* ---------------------------- catalog search ---------------------------- */

const CATALOG_BASE = 'https://catalog.roblox.com';

// One page of catalog search results. The search endpoint only returns
// { id, itemType } per hit - names, descriptions and the real asset type
// come from the details call below.
async function searchCatalog({ keyword = null, cursor = '', limit = 30, category = 'All', subcategory = null } = {}) {
  // sortType 0 is relevance, which is what you want when the caller gave a
  // keyword and expects the closest matches first.
  const params = new URLSearchParams({ category, limit: String(limit), sortType: '0' });
  if (keyword) params.set('keyword', keyword);
  if (cursor) params.set('cursor', cursor);
  // Narrows within a category - "Shirts" and "Pants" are the classic 2D types,
  // as opposed to the layered clothing that also lives under Clothing.
  if (subcategory) params.set('subcategory', subcategory);

  const res = await fetchWithRetry(`${CATALOG_BASE}/v1/search/items?${params}`);
  if (!res.ok) throw new Error(`catalog search returned HTTP ${res.status}`);
  const data = await res.json();
  return { items: data.data || [], nextPageCursor: data.nextPageCursor || '' };
}

// Roblox answers an unauthenticated POST here with 403 plus a CSRF token to
// use on the retry, so the first rejection is expected rather than a failure.
async function postWithCsrf(url, body) {
  const send = (token) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
      body: JSON.stringify(body),
    });

  let res = await send(null);
  if (res.status === 403) {
    const token = res.headers.get('x-csrf-token');
    if (token) res = await send(token);
  }
  return res;
}

const DETAILS_BATCH_SIZE = 100;

// Names, descriptions, creators and asset types for up to a few hundred IDs,
// in batches of the size Roblox accepts per call.
async function getCatalogItemDetails(assetIds) {
  const details = [];
  for (let i = 0; i < assetIds.length; i += DETAILS_BATCH_SIZE) {
    const batch = assetIds.slice(i, i + DETAILS_BATCH_SIZE);
    const res = await postWithCsrf(`${CATALOG_BASE}/v1/catalog/items/details`, {
      items: batch.map((id) => ({ itemType: 'Asset', id })),
    });
    if (!res.ok) throw new Error(`catalog details returned HTTP ${res.status}`);
    const data = await res.json();
    details.push(...(data.data || []));
    if (i + DETAILS_BATCH_SIZE < assetIds.length) await sleep(250);
  }
  return details;
}

/* ------------------------- share link resolution ------------------------- */

// Roblox's "share" links (roblox.com/share?code=...&type=...) carry an opaque
// code, not an asset ID. These are the links Roblox hands you from a Share
// button rather than the address bar, and they're built to be *opened*: a
// browser resolves one by following it to the real item page. That needs no
// auth, so it's the path tried first here. The resolver API below is the
// fallback, and needs a CSRF handshake (and possibly a signed-in session),
// so it can't be relied on alone.
const SHARELINKS_BASE = 'https://apis.roblox.com/sharelinks/v1';

// Roblox lands an item share on /catalog/<id> for a single asset, or
// /bundles/<id> for a bundle. The two ID spaces are unrelated, so which one
// it was has to be carried out of here - a bundle ID saved as an asset ID
// would match nothing.
const ITEM_PATH_PATTERN = /\/(catalog|bundles)\/(\d+)/i;

// Roblox serves some pages differently to clients that don't look like a
// browser, and this path is deliberately imitating one.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Roblox's share codes are 32 lowercase hex characters (a UUID with the
// dashes stripped), matched here so a plain code works as input too, not
// only a full link.
const SHARE_CODE_PATTERN = /^[a-f0-9]{32}$/i;

function parseShareLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const code = url.searchParams.get('code');
    if (code && SHARE_CODE_PATTERN.test(code)) {
      return { code, type: url.searchParams.get('type') || 'AvatarItemDetails' };
    }
    return null;
  } catch {
    // Not parseable as a URL - accept it if it's a bare code by itself.
    return SHARE_CODE_PATTERN.test(raw) ? { code: raw, type: 'AvatarItemDetails' } : null;
  }
}

function itemFromUrl(url) {
  const match = String(url || '').match(ITEM_PATH_PATTERN);
  if (!match) return null;
  return {
    status: 'ok',
    assetId: match[2],
    itemKind: match[1].toLowerCase() === 'bundles' ? 'bundle' : 'asset',
  };
}

// Opens the share link the way a browser would and sees where it ends up.
// Roblox usually redirects straight to the item page, so the final URL is the
// answer; when it serves an interstitial instead, the canonical item URL is
// still in the markup.
async function resolveByOpeningLink(parsed, attempts) {
  const shareUrl = `https://www.roblox.com/share?code=${encodeURIComponent(parsed.code)}&type=${encodeURIComponent(parsed.type)}`;

  let res;
  try {
    res = await fetchWithRetry(shareUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    });
  } catch (err) {
    attempts.push(`opening the link failed (${err.message})`);
    return null;
  }

  const landed = itemFromUrl(res.url);
  if (landed) return landed;

  if (!res.ok) {
    attempts.push(`opening the link returned HTTP ${res.status}`);
    return null;
  }

  const html = await res.text().catch(() => '');
  // og:url and rel=canonical are checked before any stray link in the page,
  // since the page chrome is full of /catalog/<id> links to other items.
  const canonical =
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    null;

  const found = itemFromUrl(canonical);
  if (found) return found;

  attempts.push(`opening the link landed on ${res.url} with no item in the page`);
  return null;
}

// Roblox's own resolver endpoint. Needs the CSRF handshake the catalog
// details call also does, and may additionally want a signed-in session,
// which is why it's the fallback rather than the primary path.
async function resolveViaApi(parsed, attempts) {
  let res;
  try {
    res = await postWithCsrf(`${SHARELINKS_BASE}/resolve-link`, {
      linkId: parsed.code,
      linkType: parsed.type,
    });
  } catch (err) {
    attempts.push(`resolver API failed (${err.message})`);
    return null;
  }

  if (!res.ok) {
    attempts.push(
      `resolver API returned HTTP ${res.status}${
        res.status === 401 || res.status === 403 ? ' (it may need a signed-in session)' : ''
      }`
    );
    return null;
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    attempts.push('resolver API returned a non-JSON response');
    return null;
  }

  // The result is nested under a key matching the link's own type, but the
  // exact casing isn't something to bet the whole feature on, so it's
  // matched case-insensitively rather than assumed.
  const bucket = data.resolvedLinkData || {};
  const key = Object.keys(bucket).find((k) => k.toLowerCase() === parsed.type.toLowerCase());
  const resolved = key ? bucket[key] : null;
  const assetId = resolved?.itemId ?? resolved?.assetId ?? resolved?.id ?? null;

  if (assetId == null) {
    attempts.push('resolver API had no item for that code');
    return null;
  }
  return { status: 'ok', assetId: String(assetId), itemKind: 'asset' };
}

// Returns { status: 'invalid_link' } | { status: 'not_found', detail } |
// { status: 'ok', assetId, itemKind }. Both resolution routes are tried
// before calling it a miss, and `detail` says what each one did - an expired
// code and Roblox refusing to answer a bot look identical to the caller
// otherwise.
async function resolveShareLink(input) {
  const parsed = parseShareLink(input);
  if (!parsed) return { status: 'invalid_link' };

  const attempts = [];
  const resolved = (await resolveByOpeningLink(parsed, attempts)) || (await resolveViaApi(parsed, attempts));
  if (resolved) return resolved;

  return { status: 'not_found', detail: attempts.join('; ') };
}

// Badges: Roblox locked the old badges.roblox.com endpoint behind a
// login cookie in 2026, so reading a user's earned badges now goes
// through Roblox's Open Cloud API instead, authenticated with an API
// key you generate yourself (see README). Note this API only returns
// each badge's numeric ID, not its display name - Roblox no longer
// exposes a name lookup for arbitrary badge IDs without a cookie either,
// so matched badges are shown using the name you gave them in /flag add.
async function getBadges(userId) {
  if (!config.ROBLOX_API_KEY) {
    throw new Error(
      'ROBLOX_API_KEY is not set. Create one at https://create.roblox.com/dashboard/credentials (grant it Inventory read access) and set it as an environment variable.'
    );
  }

  let badges = [];
  let pageToken = '';
  do {
    const url = `https://apis.roblox.com/cloud/v2/users/${userId}/inventory-items?maxPageSize=100&filter=badges=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetchWithRetry(url, { headers: { 'x-api-key': config.ROBLOX_API_KEY } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Roblox Open Cloud API returned HTTP ${res.status}${body ? `: ${body.slice(0, 150)}` : ''}`);
    }
    const data = await res.json();
    for (const item of data.inventoryItems || []) {
      if (item.badgeDetails?.badgeId) {
        badges.push({ id: item.badgeDetails.badgeId });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return badges;
}

// Looks up a badge by ID directly. NOTE: as of Roblox's 2026 lockdown of
// badges.roblox.com, this now requires a login cookie and will almost
// always fail with 401 for a bot - kept here in case Roblox reopens it,
// but callers should expect { status: 'unverified' } in practice and
// fall back to asking the admin for a name manually.
async function getBadgeInfo(badgeId) {
  const res = await fetchWithRetry(`https://badges.roblox.com/v1/badges/${badgeId}`);
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) return { status: 'unverified' };
  const data = await res.json();
  return { status: 'verified', name: data.name };
}

// Looks up a catalog asset (accessory/hat/gear/clothing/etc) by ID
// directly. `category` is what /flag add files it under, derived from the
// asset type Roblox reports so a shirt isn't stored as an accessory.
async function getAssetInfo(assetId) {
  const res = await fetchWithRetry(`https://economy.roblox.com/v2/assets/${assetId}/details`);
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) return { status: 'unverified' };
  const data = await res.json();
  const assetTypeId = data.AssetTypeId ?? data.assetTypeId ?? null;
  return {
    status: 'verified',
    name: data.Name || data.name,
    category: assetTypeId != null && CLOTHING_TYPES[assetTypeId] ? 'clothing' : 'accessory',
  };
}

// Verifies a flagged-list entry against Roblox before it's saved.
// Returns { status: 'verified', name } | { status: 'not_found' } |
// { status: 'unverified' } (Roblox couldn't be reached / rate limited).
async function verifyRobloxId(type, id) {
  try {
    return type === 'badge' ? await getBadgeInfo(id) : await getAssetInfo(id);
  } catch (err) {
    return { status: 'unverified' };
  }
}

// Used by /flag add when no type is given: queries the badge API and
// the catalog API for the same ID in parallel, and whichever one
// actually finds something tells us the type and the canonical name.
async function identifyRobloxAsset(id) {
  const [badgeResult, assetResult] = await Promise.all([
    getBadgeInfo(id).catch(() => ({ status: 'unverified' })),
    getAssetInfo(id).catch(() => ({ status: 'unverified' })),
  ]);

  if (badgeResult.status === 'verified') {
    return { status: 'verified', type: 'badge', name: badgeResult.name };
  }
  if (assetResult.status === 'verified') {
    return { status: 'verified', type: assetResult.category, name: assetResult.name };
  }
  if (badgeResult.status === 'not_found' && assetResult.status === 'not_found') {
    return { status: 'not_found' };
  }
  // At least one lookup couldn't be completed (network/rate limit, or -
  // very commonly now - the badge lookup being cookie-gated) and neither
  // confirmed a match, so we can't be sure which type this is.
  return { status: 'unverified' };
}

module.exports = {
  resolveUserId,
  getUserInfo,
  canViewInventory,
  getFullInventory,
  getClothing,
  getBadges,
  searchCatalog,
  getCatalogItemDetails,
  wearableCategory,
  resolveShareLink,
  parseShareLink,
  verifyRobloxId,
  identifyRobloxAsset,
  ASSET_TYPES,
  CLOTHING_TYPES,
};
