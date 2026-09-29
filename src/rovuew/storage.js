const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FLAGS_FILE = path.join(DATA_DIR, 'flags.json');
// Custom auto-flag keywords live apart from the flagged items: one is a list
// of specific assets, the other a list of words to watch for.
const KEYWORDS_FILE = path.join(DATA_DIR, 'keywords.json');

function ensureDataFile(file) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify([], null, 2));
  }
}

function loadList(file) {
  ensureDataFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`${path.basename(file)} was corrupted, resetting to an empty list.`, err);
    return [];
  }
}

function saveList(file, entries) {
  ensureDataFile(file);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

function loadFlags() {
  return loadList(FLAGS_FILE);
}

function saveFlags(flags) {
  saveList(FLAGS_FILE, flags);
}

// Every flag carries a severity score, typed in when it's added. Entries
// created before scores existed have none, and those read as the default
// rather than as zero - zero would quietly drop them out of every total.
const DEFAULT_FLAG_SCORE = 1;

function normalizeScore(score) {
  if (score === null || score === undefined || score === '') return DEFAULT_FLAG_SCORE;
  const parsed = Number(score);
  return Number.isFinite(parsed) ? parsed : DEFAULT_FLAG_SCORE;
}

function flagScore(flag) {
  return normalizeScore(flag?.score);
}

// Where to send someone to look at a flagged item. A link typed in when the
// flag was added wins; otherwise it's derived from the ID, which needs the
// category because badges aren't catalog items.
function flagUrl(flag) {
  if (flag?.link) return flag.link;
  if (!flag?.assetId) return null;
  return flag.type === 'badge'
    ? `https://www.roblox.com/badges/${flag.assetId}`
    : `https://www.roblox.com/catalog/${flag.assetId}`;
}

// Accessories and clothing are both catalog assets in one shared ID space, so
// the same item counts as already-flagged whichever of the two it was filed
// under. Badges are a separate space, and a badge ID can coincide numerically
// with an asset ID, so those only collide with other badges.
function sameIdSpace(a, b) {
  if (a === b) return true;
  return a !== 'badge' && b !== 'badge';
}

// Reads the list once and hands back a lookup, for callers checking many
// items at a time - a per-item findFlagFor would re-read the file for every
// one of them.
function flagLookup() {
  const flags = loadFlags();
  return (assetId, type) => {
    const needle = String(assetId).trim();
    return flags.find((f) => String(f.assetId) === needle && sameIdSpace(f.type, type)) || null;
  };
}

// The existing flag for one item, if it's already on the list. Every add path
// checks this first, so an item can't be recorded twice.
function findFlagFor(assetId, type) {
  return flagLookup()(assetId, type);
}

function addFlag({ name, robloxId, type, reason, link, score, addedBy }) {
  const flags = loadFlags();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim(),
    assetId: String(robloxId).trim(),
    type, // 'badge' | 'accessory' | 'clothing'
    score: normalizeScore(score),
    link: link ? link.trim() : null,
    reason: reason ? reason.trim() : 'No reason provided',
    addedBy: addedBy || 'unknown',
    addedAt: new Date().toISOString(),
  };
  flags.push(entry);
  saveFlags(flags);
  return entry;
}

// Matches by internal ID, exact name (case-insensitive), or asset ID.
function removeFlag(identifier) {
  const flags = loadFlags();
  const needle = identifier.trim().toLowerCase();
  const idx = flags.findIndex(
    (f) =>
      f.id.toLowerCase() === needle ||
      f.name.toLowerCase() === needle ||
      (f.assetId && f.assetId === identifier.trim())
  );
  if (idx === -1) return null;
  const [removed] = flags.splice(idx, 1);
  saveFlags(flags);
  return removed;
}

function listFlags() {
  return loadFlags();
}

/* ------------------------- custom auto-flag words ------------------------- */

// The categories the command offers, and what each one scores by default.
// They mirror the built-in rules so a custom word behaves like the ones
// shipped with the bot.
const KEYWORD_CATEGORIES = {
  nsfw: { label: 'NSFW wording', defaultScore: 5 },
  political: { label: 'political wording', defaultScore: 3 },
  inappropriate: { label: 'inappropriate wording', defaultScore: 5 },
};

function keywordReason(entry) {
  const label = KEYWORD_CATEGORIES[entry.category]?.label || 'custom wording';
  return `${label} (custom keyword)`;
}

function listKeywords() {
  return loadList(KEYWORDS_FILE).map((entry) => ({ ...entry, reason: keywordReason(entry) }));
}

function addKeyword({ keyword, normalized, category, score, addedBy }) {
  const keywords = listKeywords();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    keyword: keyword.trim(),
    normalized,
    category,
    score: normalizeScore(score),
    addedBy: addedBy || 'unknown',
    addedAt: new Date().toISOString(),
  };
  keywords.push(entry);
  saveList(KEYWORDS_FILE, keywords);
  return entry;
}

// Matches on the internal ID or on either spelling, so removing is possible
// with whatever the admin has in front of them.
function removeKeyword(identifier) {
  const keywords = listKeywords();
  const needle = String(identifier).trim().toLowerCase();
  const idx = keywords.findIndex(
    (k) => k.id.toLowerCase() === needle || k.keyword.toLowerCase() === needle || k.normalized === needle
  );
  if (idx === -1) return null;
  const [removed] = keywords.splice(idx, 1);
  saveList(KEYWORDS_FILE, keywords);
  return removed;
}

module.exports = {
  listKeywords,
  keywordReason,
  addKeyword,
  removeKeyword,
  KEYWORD_CATEGORIES,
  loadFlags,
  saveFlags,
  addFlag,
  removeFlag,
  listFlags,
  findFlagFor,
  flagLookup,
  flagScore,
  flagUrl,
  DEFAULT_FLAG_SCORE,
};
