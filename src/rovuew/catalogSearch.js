// Keyword search across every wearable category in the Roblox catalog, so
// an admin can find an item and add it to the flagged list without hunting
// for its asset ID by hand.
//
// Every match is returned, unfiltered - the caller decides what to add. The
// content filter still runs over each result's text, but only as a hint
// shown next to it; it never removes anything from the list.

const { searchCatalog, getCatalogItemDetails, wearableCategory } = require('./roblox');
const { classifyItem } = require('./contentFilter');
const { addFlag, flagLookup, listKeywords } = require('./storage');

const PAGE_LIMIT = 30;
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 250;

// What the caller can ask for, and the matching Roblox search category. The
// category only narrows what Roblox returns; `keep` is what actually decides,
// since the asset type from the details call is the authoritative answer.
const SEARCH_CATEGORIES = {
  accessory: { robloxCategory: 'Accessories', keep: ['accessory'], label: 'accessories' },
  clothing: { robloxCategory: 'Clothing', keep: ['clothing'], label: 'clothing' },
  // The classic 2D uploads, which share the Clothing category with the layered
  // 3D clothing. `keepAssetTypes` is what actually separates them: the
  // subcategory only asks Roblox to narrow, while the asset type on each
  // result is the answer that can be trusted.
  classicshirt: {
    robloxCategory: 'Clothing',
    robloxSubcategory: 'Shirts',
    keep: ['clothing'],
    keepAssetTypes: ['Shirt'],
    label: 'classic shirts',
  },
  classicpants: {
    robloxCategory: 'Clothing',
    robloxSubcategory: 'Pants',
    keep: ['clothing'],
    keepAssetTypes: ['Pants'],
    label: 'classic pants',
  },
  both: { robloxCategory: 'All', keep: ['accessory', 'clothing'], label: 'accessories and clothing' },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCatalogItems({ keyword, pages = 1, category = 'both' } = {}) {
  const searchTerm = typeof keyword === 'string' ? keyword.trim() : '';
  if (!searchTerm) return { error: 'keyword_required' };

  const wanted = SEARCH_CATEGORIES[category] || SEARCH_CATEGORIES.both;
  const pageCount = Math.min(Math.max(1, Number(pages) || 1), MAX_PAGES);
  const existingFlag = flagLookup();
  const extraKeywords = listKeywords();

  const results = [];
  const errors = [];
  const seen = new Set();
  let cursor = '';

  for (let page = 0; page < pageCount; page++) {
    let found;
    try {
      found = await searchCatalog({
        keyword: searchTerm,
        cursor,
        limit: PAGE_LIMIT,
        category: wanted.robloxCategory,
        subcategory: wanted.robloxSubcategory || null,
      });
    } catch (err) {
      errors.push(`search page ${page + 1}: ${err.message}`);
      break;
    }

    const ids = found.items.filter((i) => i.itemType === 'Asset').map((i) => i.id);
    if (ids.length === 0) break;

    let details;
    try {
      details = await getCatalogItemDetails(ids);
    } catch (err) {
      // One bad details call shouldn't end the search - the next page may
      // well succeed, and the error is reported either way.
      errors.push(`details page ${page + 1}: ${err.message}`);
      details = [];
    }

    for (const item of details) {
      // The search category is a hint; the asset type from the details call
      // is what actually decides whether this is a wearable.
      const itemCategory = wearableCategory(item.assetType);
      if (!itemCategory || !wanted.keep.includes(itemCategory.type)) continue;
      if (wanted.keepAssetTypes && !wanted.keepAssetTypes.includes(itemCategory.assetTypeName)) continue;

      const assetId = String(item.id);
      if (seen.has(assetId)) continue;
      seen.add(assetId);

      const text = classifyItem({ ...item, assetTypeName: itemCategory.assetTypeName, extraKeywords });
      results.push({
        assetId,
        name: item.name || `Unknown (ID ${assetId})`,
        url: `https://www.roblox.com/catalog/${assetId}`,
        ...itemCategory,
        creatorName: item.creatorName || null,
        description: item.description || null,
        price: item.price ?? null,
        alreadyFlagged: Boolean(existingFlag(assetId, itemCategory.type)),
        // A hint for whoever is choosing, not a filter: null when the text
        // reads as ordinary.
        filterVerdict: text.verdict === 'clean' ? null : text.verdict,
        filterReason: text.reason,
      });
    }

    cursor = found.nextPageCursor;
    if (!cursor) break;
    await sleep(PAGE_DELAY_MS);
  }

  return {
    keyword: searchTerm,
    category,
    categoryLabel: wanted.label,
    pages: pageCount,
    count: results.length,
    results,
    errors,
  };
}

// Adds the chosen asset IDs from a set of search results. The flagged list is
// re-read here rather than trusted from search time, since someone may have
// flagged one of these by hand while the results sat on screen.
//
// `reason` and `score` are what the admin typed on the command, and they win
// over the content filter's guess - a person who wrote down why is more
// reliable than a keyword match.
function addItems(results, assetIds, addedBy, { reason = null, score = null } = {}) {
  const byId = new Map(results.map((r) => [String(r.assetId), r]));
  // Read fresh here rather than trusted from search time, so an item flagged
  // by hand while these results sat on screen is caught too.
  const existingFlag = flagLookup();
  const extraKeywords = listKeywords();
  const justAdded = new Set();

  const added = [];
  let skipped = 0;

  for (const assetId of assetIds) {
    const item = byId.get(String(assetId));
    if (!item || justAdded.has(String(assetId)) || existingFlag(assetId, item.type)) {
      skipped++;
      continue;
    }
    added.push(
      addFlag({
        name: item.name,
        robloxId: item.assetId,
        type: item.type,
        reason: reason || item.filterReason || 'Added from a catalog search',
        score,
        link: item.url,
        addedBy,
      })
    );
    justAdded.add(String(assetId));
  }

  return { added, skipped };
}

module.exports = { findCatalogItems, addItems, MAX_PAGES };
