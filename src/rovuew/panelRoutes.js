'use strict';
// Web panel routes for RoVuew: the flag list, custom keywords, importing an
// old RoVuew's data, and a quick check. Same storage the / commands use.
const fs = require('fs');
const path = require('path');

const mod = (name) => require(`./${name}`);
const TYPES = ['badge', 'accessory', 'clothing'];

function keywordsFile() {
  return path.join(mod('config').DATA_DIR, 'keywords.json');
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Keep a copy before anything replaces a whole list
function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

function flagView(f) {
  const { flagScore, flagUrl } = mod('storage');
  return { ...f, score: flagScore(f), url: flagUrl(f) };
}

function cleanScore(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Score has to be a number from 0 to 100');
  return n;
}

module.exports = (reply, author) => ({
  'GET /api/rovuew/status': () => {
    const cfg = mod('config');
    const storage = mod('storage');
    return {
      dataDir: cfg.DATA_DIR,
      flags: storage.listFlags().length,
      keywords: storage.listKeywords().length,
      apiOn: cfg.API_KEYS.length > 0,
      apiPort: cfg.PORT,
      keys: { roblox: Boolean(cfg.ROBLOX_API_KEY), serversweep: Boolean(cfg.SERVERSWEEP_API_KEY), xtracker: Boolean(cfg.XTRACKER_API_KEY) },
    };
  },

  'GET /api/rovuew/flags': () => mod('storage').listFlags().map(flagView).sort((a, b) => b.score - a.score),

  'POST /api/rovuew/flags': async (q, body) => {
    const storage = mod('storage');
    const id = String(body.assetId || '').trim();
    if (!/^\d+$/.test(id)) return reply(400, { error: 'The ID has to be a plain number' });
    let type = String(body.type || '').toLowerCase();
    let name = String(body.name || '').trim();
    if (type && !TYPES.includes(type)) return reply(400, { error: 'Type has to be badge, accessory or clothing' });
    if (!type) {
      // Same as /flag add: ask Roblox what the ID is
      const found = await mod('roblox').identifyRobloxAsset(id);
      if (found.status === 'not_found') return reply(404, { error: `Roblox has no badge, accessory or clothing item with ID ${id}` });
      if (found.status === 'unverified') return reply(422, { error: "Couldn't tell what this ID is. Pick the type yourself (and a name if it's a badge)." });
      type = found.type;
      name = name || found.name || '';
    }
    const existing = storage.findFlagFor(id, type);
    if (existing) return reply(409, { error: `${existing.name} is already on the list`, flag: flagView(existing) });
    let score;
    try { score = cleanScore(body.score); } catch (e) { return reply(400, { error: e.message }); }
    const entry = storage.addFlag({
      name: name || `Unknown (ID ${id})`, robloxId: id, type, score,
      reason: String(body.reason || '').trim() || null, link: String(body.link || '').trim() || null, addedBy: author,
    });
    return flagView(entry);
  },

  'PUT /api/rovuew/flags': (q, body) => {
    const storage = mod('storage');
    const flags = storage.loadFlags();
    const flag = flags.find((f) => f.id === q.get('id'));
    if (!flag) return reply(404, { error: 'That flag is gone. Refresh the list.' });
    if (body.name !== undefined) flag.name = String(body.name).trim() || flag.name;
    if (body.reason !== undefined) flag.reason = String(body.reason).trim() || 'No reason provided';
    if (body.link !== undefined) flag.link = String(body.link).trim() || null;
    if (body.type !== undefined) {
      if (!TYPES.includes(body.type)) return reply(400, { error: 'Type has to be badge, accessory or clothing' });
      flag.type = body.type;
    }
    if (body.score !== undefined) {
      try { flag.score = cleanScore(body.score) ?? 1; } catch (e) { return reply(400, { error: e.message }); }
    }
    flag.editedBy = author;
    flag.editedAt = new Date().toISOString();
    storage.saveFlags(flags);
    return flagView(flag);
  },

  'DELETE /api/rovuew/flags': (q) => {
    const removed = mod('storage').removeFlag(q.get('id') || '');
    return removed ? { removed: flagView(removed) } : reply(404, { error: 'No flag with that ID' });
  },

  'GET /api/rovuew/keywords': () => {
    const { listKeywords, KEYWORD_CATEGORIES } = mod('storage');
    return {
      categories: Object.entries(KEYWORD_CATEGORIES).map(([value, c]) => ({ value, label: c.label, defaultScore: c.defaultScore })),
      keywords: listKeywords().sort((a, b) => b.score - a.score),
    };
  },

  'POST /api/rovuew/keywords': (q, body) => {
    const storage = mod('storage');
    const { inspectKeyword, alreadyCovered } = mod('contentFilter');
    const raw = String(body.keyword || '');
    if (!storage.KEYWORD_CATEGORIES[body.category]) return reply(400, { error: 'Pick a category' });
    const { normalized, isPhrase, problem } = inspectKeyword(raw);
    if (problem) return reply(400, { error: `That keyword will not work: ${problem}` });
    const covered = alreadyCovered(raw, storage.listKeywords());
    if (covered) {
      return reply(409, {
        error: covered.rule.startsWith('custom:')
          ? `Already covered by the custom keyword "${covered.term}" (score ${covered.score})`
          : `Already caught by the built in list as "${covered.reason}" (score ${covered.score})`,
      });
    }
    let score;
    try { score = cleanScore(body.score); } catch (e) { return reply(400, { error: e.message }); }
    const entry = storage.addKeyword({ keyword: raw, normalized, category: body.category, score: score ?? storage.KEYWORD_CATEGORIES[body.category].defaultScore, addedBy: author });
    return { ...entry, isPhrase };
  },

  'DELETE /api/rovuew/keywords': (q) => {
    const removed = mod('storage').removeKeyword(q.get('id') || '');
    return removed ? { removed } : reply(404, { error: 'No keyword with that ID' });
  },

  // Bring in flags.json or keywords.json from the old RoVuew.
  // mode "merge" keeps what's here and adds what's new; "replace" swaps the whole list (a backup is kept).
  'POST /api/rovuew/import': (q, body) => {
    let data;
    try { data = typeof body.content === 'string' ? JSON.parse(body.content) : body.content; } catch (e) { return reply(400, { error: `That isn't valid JSON: ${e.message}` }); }
    if (!Array.isArray(data)) return reply(400, { error: 'The file should be a list, starting with [' });
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const storage = mod('storage');

    if (body.kind === 'flags') {
      const bad = data.findIndex((f) => !f || typeof f !== 'object' || !f.name || !f.assetId);
      if (bad !== -1) return reply(400, { error: `Entry ${bad + 1} is missing a name or assetId, so this doesn't look like flags.json` });
      const all = data.map((f) => ({
        id: f.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ...f, assetId: String(f.assetId), type: TYPES.includes(f.type) ? f.type : 'accessory',
      }));
      // The same item twice in one file would count its score twice. Keep the first copy,
      // but take a written reason or higher score from a later one.
      const sameSpace = (a, b) => a === b || (a !== 'badge' && b !== 'badge');
      const incoming = [];
      let doubles = 0;
      for (const f of all) {
        const first = incoming.find((x) => x.assetId === f.assetId && sameSpace(x.type, f.type));
        if (!first) { incoming.push(f); continue; }
        doubles++;
        if ((!first.reason || /^(No reason provided|Added from a catalog search)$/.test(first.reason)) && f.reason && !/^(No reason provided|Added from a catalog search)$/.test(f.reason)) first.reason = f.reason;
        if ((Number(f.score) || 0) > (Number(first.score) || 0)) first.score = f.score;
        if (!first.link && f.link) first.link = f.link;
      }
      const file = path.join(mod('config').DATA_DIR, 'flags.json');
      backup(file);
      let result = incoming; let skipped = 0;
      if (mode === 'merge') {
        const current = storage.loadFlags();
        const has = (f) => current.some((c) => c.assetId === f.assetId && (c.type === f.type || (c.type !== 'badge' && f.type !== 'badge')));
        const fresh = incoming.filter((f) => !has(f));
        skipped = incoming.length - fresh.length;
        result = [...current, ...fresh];
      }
      storage.saveFlags(result);
      return { kind: 'flags', mode, total: result.length, added: mode === 'merge' ? incoming.length - skipped : result.length, skipped, doubles };
    }

    if (body.kind === 'keywords') {
      const { inspectKeyword } = mod('contentFilter');
      const out = [];
      for (const [i, k] of data.entries()) {
        if (!k || typeof k !== 'object' || !k.keyword) return reply(400, { error: `Entry ${i + 1} has no keyword, so this doesn't look like keywords.json` });
        const { normalized, problem } = inspectKeyword(k.keyword);
        if (problem) continue;
        const { reason, ...rest } = k; // reason is worked out on load, not stored
        out.push({ id: k.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...rest, normalized: k.normalized || normalized, score: cleanScore(k.score) ?? 1 });
      }
      const file = keywordsFile();
      backup(file);
      let result = out; let skipped = 0;
      if (mode === 'merge') {
        const current = storage.listKeywords().map(({ reason, ...rest }) => rest);
        const fresh = out.filter((k) => !current.some((c) => c.normalized === k.normalized));
        skipped = out.length - fresh.length;
        result = [...current, ...fresh];
      }
      writeJson(file, result);
      return { kind: 'keywords', mode, total: result.length, added: mode === 'merge' ? out.length - skipped : result.length, skipped };
    }
    return reply(400, { error: 'kind has to be flags or keywords' });
  },

  // Quick look from the panel, same as /check, /checkclothes, /checkbadges
  'POST /api/rovuew/check': async (q, body) => {
    const svc = mod('checkService');
    const run = { accessories: svc.checkAccessories, clothing: svc.checkClothing, badges: svc.checkBadges }[body.kind || 'accessories'];
    if (!run) return reply(400, { error: 'kind has to be accessories, clothing or badges' });
    if (!String(body.user || '').trim()) return reply(400, { error: 'Type a Roblox username or ID' });
    const r = await run(String(body.user).trim());
    if (r.error === 'user_not_found') return reply(404, { error: `No Roblox user called ${body.user}` });
    if (r.private) return { username: r.username, userId: r.userId, private: true };
    const scan = r[body.kind || 'accessories'];
    return {
      username: r.username, userId: r.userId, private: false,
      scanned: scan.count, scanError: scan.error, score: r.score, autoScore: r.autoScore,
      matches: r.matches.map((m) => flagView(m.flag)), auto: r.autoMatches || [],
    };
  },
});
