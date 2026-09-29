// Turns a Roblox share link (or its bare code) into the item it points to.
// A share link on its own is useless for /flag add - it carries an opaque
// code, not an asset ID - so this exists purely to bridge the gap: paste a
// link, get back the ID, name and category /flag add actually needs.

const { resolveShareLink, getCatalogItemDetails, wearableCategory } = require('./roblox');

// Returns one of:
//   { status: 'invalid_link' }              - not a share link or code
//   { status: 'not_found', detail }         - Roblox didn't resolve it
//   { status: 'ok', assetId, url, name, type, assetTypeName, itemKind }
// `name`/`type`/`assetTypeName` are null rather than the whole call failing
// if the follow-up catalog lookup fails - the asset ID and URL are still
// useful on their own.
async function resolveShareLinkToItem(input) {
  const resolved = await resolveShareLink(input);
  if (resolved.status !== 'ok') return resolved;

  const itemKind = resolved.itemKind || 'asset';
  const base = {
    status: 'ok',
    assetId: resolved.assetId,
    itemKind,
    url:
      itemKind === 'bundle'
        ? `https://www.roblox.com/bundles/${resolved.assetId}`
        : `https://www.roblox.com/catalog/${resolved.assetId}`,
  };

  // Bundle IDs live in their own namespace, so the asset details call would
  // either miss or answer about an unrelated asset. The ID and URL are still
  // correct; the category just isn't an asset category.
  if (itemKind === 'bundle') {
    return { ...base, name: null, type: 'bundle', assetTypeName: 'Bundle' };
  }

  let details;
  try {
    [details] = await getCatalogItemDetails([resolved.assetId]);
  } catch {
    return { ...base, name: null, type: null, assetTypeName: null };
  }

  const category = details ? wearableCategory(details.assetType) : null;
  return {
    ...base,
    name: details?.name || null,
    type: category?.type || null,
    assetTypeName: category?.assetTypeName || null,
  };
}

module.exports = { resolveShareLinkToItem };
