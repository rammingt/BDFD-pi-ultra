const { flagScore, listKeywords } = require('./storage');
const { scanName } = require('./contentFilter');

// Compares scanned items against the flagged list, one category at a
// time. Display text always uses the flag's own stored name (set when
// the flag was created) rather than whatever name field Roblox happens
// to return for the scanned item - Roblox's endpoints are inconsistent
// about this (and for badges, no name is available at all anymore), so
// relying on our own stored label is what avoids ever showing
// "undefined" or a bare ID with nothing to explain it.

// Accessories and clothing are both catalog assets in one global ID space,
// so IDs are matched across both categories rather than only the one being
// scanned. An ID belongs to exactly one asset, so that can't produce a
// false positive, and it still catches a flag filed under the wrong
// category - including clothing added before there was a clothing category
// to file it under. Name matching is the loose fallback, so it stays
// scoped to the category being scanned.
const ASSET_FLAG_TYPES = ['accessory', 'clothing'];

// One hit per flag, however many copies of it turn up. Roblox inventories do
// contain duplicates, and counting them separately would multiply that item's
// score - "owns three of the same flagged hat" is one finding, not three.
function collectMatches(items, resolveFlag) {
  const byFlag = new Map();
  for (const item of items) {
    const flag = resolveFlag(item);
    if (!flag) continue;
    const key = flag.id || `${flag.type}:${flag.assetId}`;
    if (!byFlag.has(key)) byFlag.set(key, { flag });
  }
  return Array.from(byFlag.values());
}

function matchAssets(items, flags, nameTypes) {
  const byId = new Map();
  const byName = new Map();
  for (const f of flags) {
    if (!ASSET_FLAG_TYPES.includes(f.type)) continue;
    if (f.assetId) byId.set(String(f.assetId), f);
    if (nameTypes.includes(f.type)) byName.set(f.name.toLowerCase(), f);
  }

  return collectMatches(items, (item) => {
    const id = String(item.assetId ?? item.id ?? '');
    const name = (item.name || '').toLowerCase();
    return byId.get(id) || (name && byName.get(name)) || null;
  });
}

function matchAccessories(items, flags) {
  return matchAssets(items, flags, ['accessory']);
}

function matchClothing(items, flags) {
  return matchAssets(items, flags, ['clothing']);
}

function matchBadges(badges, flags) {
  const badgeFlags = flags.filter((f) => f.type === 'badge');
  const byId = new Map();
  const byName = new Map();
  for (const f of badgeFlags) {
    if (f.assetId) byId.set(String(f.assetId), f);
    byName.set(f.name.toLowerCase(), f);
  }

  return collectMatches(badges, (badge) => {
    const id = String(badge.id ?? '');
    const name = (badge.name || '').toLowerCase();
    return byId.get(id) || (name && byName.get(name)) || null;
  });
}

// The headline number for a set of matches: every matched flag's score added
// up, which is what the check commands report as the overview.
function totalScore(matches) {
  return matches.reduce((sum, m) => sum + flagScore(m.flag), 0);
}

// The automatic pass: reads the names of the items someone owns and scores
// whatever the word list recognises.
//
// Kept deliberately apart from the flagged-list matches above. Those are
// decisions a person made and recorded; this is a word list guessing from a
// name, and folding the two together would let a guess pass for a ruling.
// Items already on the flagged list are skipped, so nothing is counted twice.
function autoScanItems(items, { skipAssetIds = new Set() } = {}) {
  const found = new Map();
  // Read once for the whole scan: these come off disk and an admin can be
  // editing them while a check runs.
  const extraKeywords = listKeywords();

  for (const item of items) {
    if (!item.name) continue;
    const assetId = String(item.assetId ?? item.id ?? '');
    if (skipAssetIds.has(assetId) || found.has(assetId)) continue;

    const { hits, score, reasons } = scanName(item.name, {
      assetTypeName: item.assetTypeName,
      extraKeywords,
    });
    if (hits.length === 0) continue;

    found.set(assetId, {
      name: item.name,
      assetId,
      assetTypeName: item.assetTypeName || null,
      url: assetId ? `https://www.roblox.com/catalog/${assetId}` : null,
      score,
      reasons,
      categories: hits.map((h) => h.rule),
    });
  }

  // Worst first, so a truncated list still shows what matters.
  return Array.from(found.values()).sort((a, b) => b.score - a.score);
}

function totalAutoScore(autoMatches) {
  return autoMatches.reduce((sum, m) => sum + m.score, 0);
}

// The asset IDs already accounted for by the flagged list, so the automatic
// pass can leave them alone.
function matchedAssetIds(matches) {
  return new Set(matches.map((m) => String(m.flag.assetId)));
}

module.exports = {
  matchAccessories,
  matchClothing,
  matchBadges,
  totalScore,
  autoScanItems,
  totalAutoScore,
  matchedAssetIds,
};
