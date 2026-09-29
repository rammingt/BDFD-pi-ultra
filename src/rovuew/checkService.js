const {
  resolveUserId,
  getUserInfo,
  canViewInventory,
  getFullInventory,
  getClothing,
  getBadges,
} = require('./roblox');
const { listFlags } = require('./storage');
const {
  matchAccessories,
  matchClothing,
  matchBadges,
  totalScore,
  autoScanItems,
  totalAutoScore,
  matchedAssetIds,
} = require('./flagCheck');
const { checkBehavior } = require('./behaviorApis');

// Shared by both check functions: resolve the username/ID, then find out
// whether the inventory is even viewable before fetching anything else.
async function resolveTarget(usernameOrId) {
  const userId = await resolveUserId(usernameOrId);
  if (!userId) return { error: 'user_not_found' };

  const [userInfo, viewable] = await Promise.all([getUserInfo(userId), canViewInventory(userId)]);
  const username = userInfo?.name || String(usernameOrId);

  if (!viewable) return { userId, username, private: true };
  return { userId, username, private: false };
}

// Accessories and badges are completely independent checks now - they
// use different Roblox APIs (legacy vs. Open Cloud) with different
// failure modes, so each is its own function and, in the bot, its own
// command. Running one never depends on the other succeeding.

async function scanAccessories(userId) {
  try {
    const { items, failures } = await getFullInventory(userId);
    return {
      items,
      count: items.length,
      error: failures.length > 0 ? `Some categories failed: ${failures.join('; ')}` : null,
    };
  } catch (err) {
    return { items: [], count: 0, error: err.message || 'Unknown error' };
  }
}

async function scanClothing(userId) {
  try {
    const { items, failures } = await getClothing(userId);
    return {
      items,
      count: items.length,
      error: failures.length > 0 ? `Some categories failed: ${failures.join('; ')}` : null,
    };
  } catch (err) {
    return { items: [], count: 0, error: err.message || 'Unknown error' };
  }
}

async function scanBadges(userId) {
  try {
    const items = await getBadges(userId);
    return { items, count: items.length, error: null };
  } catch (err) {
    return { items: [], count: 0, error: err.message || 'Unknown error' };
  }
}

async function checkAccessories(usernameOrId) {
  const target = await resolveTarget(usernameOrId);
  if (target.error || target.private) return target;

  const accessories = await scanAccessories(target.userId);
  const matches = matchAccessories(accessories.items, listFlags());
  const autoMatches = autoScanItems(accessories.items, { skipAssetIds: matchedAssetIds(matches) });
  return {
    ...target,
    accessories,
    matches,
    score: totalScore(matches),
    autoMatches,
    autoScore: totalAutoScore(autoMatches),
  };
}

async function checkClothing(usernameOrId) {
  const target = await resolveTarget(usernameOrId);
  if (target.error || target.private) return target;

  const clothing = await scanClothing(target.userId);
  const matches = matchClothing(clothing.items, listFlags());
  const autoMatches = autoScanItems(clothing.items, { skipAssetIds: matchedAssetIds(matches) });
  return {
    ...target,
    clothing,
    matches,
    score: totalScore(matches),
    autoMatches,
    autoScore: totalAutoScore(autoMatches),
  };
}

async function checkBadges(usernameOrId) {
  const target = await resolveTarget(usernameOrId);
  if (target.error || target.private) return target;

  const badges = await scanBadges(target.userId);
  const matches = matchBadges(badges.items, listFlags());
  const autoMatches = autoScanItems(badges.items, { skipAssetIds: matchedAssetIds(matches) });
  return {
    ...target,
    badges,
    matches,
    score: totalScore(matches),
    autoMatches,
    autoScore: totalAutoScore(autoMatches),
  };
}

// Everything at once: both inventory scans plus the external
// behaviour-tracking APIs. Unlike the single-source commands, a private
// inventory doesn't end the check here - the reputation APIs key off the
// user ID and answer perfectly well for an account whose inventory is
// hidden, which is exactly the case where they're most worth having.
async function fullCheck(usernameOrId, { discordUserId = null } = {}) {
  const target = await resolveTarget(usernameOrId);
  if (target.error) return target;

  const [accessories, clothing, badges, behavior] = await Promise.all([
    target.private ? null : scanAccessories(target.userId),
    target.private ? null : scanClothing(target.userId),
    target.private ? null : scanBadges(target.userId),
    checkBehavior({ robloxUserId: target.userId, discordUserId }),
  ]);

  const flags = listFlags();
  const accessoryMatches = accessories ? matchAccessories(accessories.items, flags) : [];
  const clothingMatches = clothing ? matchClothing(clothing.items, flags) : [];
  const badgeMatches = badges ? matchBadges(badges.items, flags) : [];

  // Badges carry no name, so only the two wearable scans have anything for
  // the automatic pass to read.
  const scannedByName = [...(accessories?.items || []), ...(clothing?.items || [])];
  const autoMatches = autoScanItems(scannedByName, {
    skipAssetIds: matchedAssetIds([...accessoryMatches, ...clothingMatches, ...badgeMatches]),
  });

  return {
    ...target,
    discordUserId,
    accessories,
    clothing,
    badges,
    accessoryMatches,
    clothingMatches,
    badgeMatches,
    behavior,
    autoMatches,
    autoScore: totalAutoScore(autoMatches),
    accessoryScore: totalScore(accessoryMatches),
    clothingScore: totalScore(clothingMatches),
    badgeScore: totalScore(badgeMatches),
    // The overview number: every flagged item found, across all three
    // categories, added up.
    totalScore: totalScore([...accessoryMatches, ...clothingMatches, ...badgeMatches]),
    flagged:
      accessoryMatches.length > 0 ||
      clothingMatches.length > 0 ||
      badgeMatches.length > 0 ||
      behavior.flagged,
    incomplete:
      target.private ||
      behavior.incomplete ||
      Boolean(accessories?.error) ||
      Boolean(clothing?.error) ||
      Boolean(badges?.error),
  };
}

module.exports = { checkAccessories, checkClothing, checkBadges, fullCheck };
