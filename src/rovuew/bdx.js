'use strict';
// BDX functions for RoVuew: inventory checks against the flag list, the flag
// list itself, the automatic name scan keywords, catalog search and share links.
//
// Each function puts its result in the JSON slot, so commands read it with
// $json[...], loop over lists with $jsonList, and save it for buttons with
// $jsonStash, the same way they would with an $httpGet result.

const AUTO_NOTE = 'sus names r just word list guesses, often wrong';
const lastCheckByUser = new Map();

// Loaded on first use, after .env has been read
const mod = (name) => require(`./${name}`);

module.exports = ({ need, fail, arg, num }) => {
  const flagView = (f) => {
    const { flagScore, flagUrl } = mod('storage');
    return { ...f, score: flagScore(f), url: flagUrl(f), type: f.type || 'unknown' };
  };
  const matchView = (m) => flagView(m.flag);
  const autoView = (m) => ({ ...m, reasons: (m.reasons || []).join('; ') });

  function inventoryText(scan, matchCount, score, isPrivate) {
    if (isPrivate) return 'inventory private';
    if (!scan) return 'not scanned';
    if (scan.error) return `didnt finish: ${scan.error}`.slice(0, 1000);
    if (matchCount === 0) return `clean, ${scan.count} scanned`;
    return `${matchCount} flagged (score ${score}), ${scan.count} scanned`;
  }

  function providerText(p) {
    if (p.configured === false) return 'not set up, no api key';
    if (p.skipped) return `skipped: ${p.note}`;
    if (p.ok === false) return `lookup failed: ${p.error}`;
    return (p.lines || []).join('\n').slice(0, 1000);
  }

  const KINDS = {
    accessories: { run: 'checkAccessories', scan: 'accessories', noun: 'accessories' },
    clothing: { run: 'checkClothing', scan: 'clothing', noun: 'clothing items' },
    badges: { run: 'checkBadges', scan: 'badges', noun: 'badges' },
  };

  return {
    // Manage Server, the ROVUEW_ADMIN_ROLE_ID role, or someone in ROVUEW_ACCEPTED_USERS
    rvIsAdmin: { fn(ctx) {
      const cfg = mod('config');
      const m = ctx.discord?.member;
      if (m?.permissions?.has?.('ManageGuild')) return 'true';
      if (cfg.ADMIN_ROLE_ID && m?.roles?.cache?.has?.(cfg.ADMIN_ROLE_ID)) return 'true';
      return String(cfg.ACCEPTED_USERS.includes(ctx.author?.id));
    } },

    // One cooldown shared by every check command, like RoVuew had. Stops with the message.
    rvCooldown: { fn(ctx, a) {
      const { RATE_LIMIT_MS } = mod('config');
      const id = ctx.author?.id;
      const elapsed = Date.now() - (lastCheckByUser.get(id) || 0);
      if (elapsed < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
        const { StopExecution } = require('../interpreter');
        throw new StopExecution(arg(a, 0, 'chill %time%s before checking again').replace('%time%', wait));
      }
      lastCheckByUser.set(id, Date.now());
      return '';
    } },

    // $rvCheck[user;accessories|clothing|badges|full;discord ID?]
    // status is ok, not_found or private. Lists: matches, auto (and providers for full).
    rvCheck: { async fn(ctx, a) {
      const [user] = need(a, 1, '$rvCheck[user;accessories|clothing|badges|full;discord ID?]');
      const kindName = arg(a, 1, 'accessories').toLowerCase();
      const svc = mod('checkService');

      if (kindName === 'full') {
        const discord = arg(a, 2).trim() || null;
        if (discord && !/^\d{15,25}$/.test(discord)) fail('the Discord ID has to be the long number from Copy User ID');
        const r = await svc.fullCheck(user.trim(), { discordUserId: discord });
        if (r.error === 'user_not_found') { ctx.json = { status: 'not_found', query: user }; return ''; }
        const matches = [...r.accessoryMatches, ...r.clothingMatches, ...r.badgeMatches].map(matchView);
        ctx.json = {
          status: 'ok', kind: 'full', username: r.username, userId: r.userId, discordUserId: discord,
          private: Boolean(r.private), flagged: r.flagged, incomplete: r.incomplete,
          totalScore: r.totalScore, autoScore: r.autoScore,
          verdict: r.flagged ? 'flagged' : (r.autoMatches || []).length ? 'odd names' : r.incomplete ? 'incomplete' : 'clear',
          accessories: inventoryText(r.accessories, r.accessoryMatches.length, r.accessoryScore, r.private),
          clothing: inventoryText(r.clothing, r.clothingMatches.length, r.clothingScore, r.private),
          badges: inventoryText(r.badges, r.badgeMatches.length, r.badgeScore, r.private),
          matches, matchCount: matches.length,
          auto: (r.autoMatches || []).map(autoView), autoCount: (r.autoMatches || []).length,
          providers: r.behavior.providers.map((p) => ({ name: p.provider, text: providerText(p), flagged: Boolean(p.flagged) })),
          appealsUrl: r.behavior.appealsUrl || '',
          autoNote: AUTO_NOTE,
          file: { ...r, flagged_items: matches, automaticNote: AUTO_NOTE },
          filename: `${r.username}-fullcheck.json`,
        };
        return '';
      }

      const kind = KINDS[kindName];
      if (!kind) fail('the kind has to be accessories, clothing, badges or full');
      const r = await svc[kind.run](user.trim());
      if (r.error === 'user_not_found') { ctx.json = { status: 'not_found', query: user }; return ''; }
      if (r.private) { ctx.json = { status: 'private', username: r.username, userId: r.userId }; return ''; }
      const scan = r[kind.scan];
      const matches = r.matches.map(matchView);
      ctx.json = {
        status: 'ok', kind: kindName, noun: kind.noun, username: r.username, userId: r.userId,
        scanned: scan.count, scanError: scan.error || '', scanIncomplete: scan.error ? 'yes' : 'no',
        filename: `${r.username}-${kind.scan}.json`,
        score: r.score, matches, matchCount: matches.length,
        autoScore: r.autoScore, auto: (r.autoMatches || []).map(autoView), autoCount: (r.autoMatches || []).length,
        verdict: matches.length ? 'flagged' : (r.autoMatches || []).length ? 'odd names' : scan.error ? 'incomplete' : 'clear',
        autoNote: AUTO_NOTE,
        file: {
          username: r.username, userId: r.userId, score: r.score, flagged: matches,
          automaticScore: r.autoScore, automaticNameMatches: r.autoMatches, automaticNote: AUTO_NOTE,
          [kind.scan]: scan.items,
        },
      };
      return '';
    } },

    // The flag list, highest score first
    rvFlags: { fn(ctx) {
      const flags = mod('storage').listFlags().map(flagView).sort((x, y) => y.score - x.score);
      ctx.json = {
        flags, count: flags.length, totalScore: flags.reduce((sum, f) => sum + f.score, 0),
        file: mod('storage').listFlags(), filename: 'flagged-items.json',
      };
      return '';
    } },

    // $rvFlagAdd[id;name?;type?;reason?;score?;link?] -> status: added, exists, not_found, unverified
    rvFlagAdd: { async fn(ctx, a) {
      const rawId = need(a, 1, '$rvFlagAdd[id;name?;type?;reason?;score?;link?]')[0].trim();
      if (!/^\d+$/.test(rawId)) fail('the ID has to be a plain number, the badge ID or the asset ID from the Roblox link');
      const { verifyRobloxId, identifyRobloxAsset } = mod('roblox');
      const storage = mod('storage');
      const explicitName = arg(a, 1).trim() || null;
      const explicitType = arg(a, 2).trim().toLowerCase() || null;
      if (explicitType && !['badge', 'accessory', 'clothing'].includes(explicitType)) fail('type has to be badge, accessory or clothing');
      let type; let autoName = null; let confident = true;
      if (explicitType) {
        const v = await verifyRobloxId(explicitType, rawId);
        if (v.status === 'not_found') { ctx.json = { status: 'not_found', id: rawId, type: explicitType }; return ''; }
        type = explicitType; autoName = v.name || null; confident = v.status === 'verified';
      } else {
        const found = await identifyRobloxAsset(rawId);
        if (found.status === 'not_found' || found.status === 'unverified') { ctx.json = { status: found.status, id: rawId }; return ''; }
        type = found.type; autoName = found.name;
      }
      const existing = storage.findFlagFor(rawId, type);
      if (existing) { ctx.json = { status: 'exists', flag: flagView(existing) }; return ''; }
      const scoreText = arg(a, 4).trim();
      const entry = storage.addFlag({
        name: explicitName || autoName || `Unknown (ID ${rawId})`, robloxId: rawId, type,
        reason: arg(a, 3).trim() || null, score: scoreText === '' ? null : num(scoreText, 'score'),
        link: arg(a, 5).trim() || null, addedBy: ctx.author?.username || 'unknown',
      });
      ctx.json = { status: 'added', flag: flagView(entry), placeholderName: !confident && !explicitName };
      return '';
    } },

    // $rvFlagRemove[name or ID] -> removed yes/no, flag
    rvFlagRemove: { fn(ctx, a) {
      const removed = mod('storage').removeFlag(need(a, 1, '$rvFlagRemove[name or ID]')[0]);
      ctx.json = { removed: removed ? 'yes' : 'no', flag: removed ? flagView(removed) : null };
      return '';
    } },

    // Custom keywords for the automatic name scan, highest score first
    rvKeywords: { fn(ctx) {
      const { KEYWORD_CATEGORIES } = mod('storage');
      const keywords = mod('storage').listKeywords()
        .map((k) => ({ ...k, label: KEYWORD_CATEGORIES[k.category]?.label || k.category }))
        .sort((x, y) => y.score - x.score);
      ctx.json = { keywords, count: keywords.length, autoNote: AUTO_NOTE };
      return '';
    } },

    // $rvKeywordAdd[keyword;nsfw|political|inappropriate;score]
    // status: added, problem (see problem), covered (see covered.custom yes/no)
    rvKeywordAdd: { fn(ctx, a) {
      const [raw, category, scoreText] = need(a, 3, '$rvKeywordAdd[keyword;category;score]');
      const storage = mod('storage');
      const { inspectKeyword, alreadyCovered } = mod('contentFilter');
      if (!storage.KEYWORD_CATEGORIES[category]) fail(`category has to be ${Object.keys(storage.KEYWORD_CATEGORIES).join(', ')}`);
      const { normalized, isPhrase, problem } = inspectKeyword(raw);
      if (problem) { ctx.json = { status: 'problem', problem }; return ''; }
      const covered = alreadyCovered(raw, storage.listKeywords());
      if (covered) {
        ctx.json = { status: 'covered', covered: { ...covered, custom: covered.rule.startsWith('custom:') ? 'yes' : 'no' } };
        return '';
      }
      const entry = storage.addKeyword({ keyword: raw, normalized, category, score: num(scoreText, 'score'), addedBy: ctx.author?.username });
      ctx.json = {
        status: 'added', keyword: entry, label: storage.KEYWORD_CATEGORIES[entry.category]?.label || entry.category,
        how: isPhrase ? 'catches names with all those words in any order' : 'catches that word anywhere in a name',
        autoNote: AUTO_NOTE,
      };
      return '';
    } },

    rvKeywordRemove: { fn(ctx, a) {
      const removed = mod('storage').removeKeyword(need(a, 1, '$rvKeywordRemove[keyword]')[0]);
      ctx.json = { removed: removed ? 'yes' : 'no', keyword: removed || null };
      return '';
    } },

    // $rvSearch[keyword;accessory|clothing|classicshirt|classicpants|both;pages 1 to 5]
    // Lists: results (everything) and addable (up to 25 not already flagged)
    rvSearch: { async fn(ctx, a) {
      const [keyword] = need(a, 1, '$rvSearch[keyword;category?;pages?]');
      const r = await mod('catalogSearch').findCatalogItems({ keyword, category: arg(a, 1, 'both'), pages: arg(a, 2, '1') });
      if (r.error === 'keyword_required') fail('give it something to search for');
      const results = r.results.map((item, i) => ({
        ...item, n: String(i + 1).padStart(3),
        note: (() => {
          const bits = [item.alreadyFlagged && 'on list', item.filterVerdict && item.filterReason].filter(Boolean);
          return bits.length ? ` · *${bits.join('; ')}*` : '';
        })(),
      }));
      const addable = results.filter((x) => !x.alreadyFlagged);
      ctx.json = {
        ...r, results, errors: r.errors.join('; '),
        addable: addable.slice(0, 25), addableCount: addable.length,
        allFlagged: addable.length === 0 ? 'yes' : 'no',
        hasErrors: r.errors.length ? 'yes' : 'no',
        file: r, filename: `catalog-search-${r.keyword.replace(/[^a-z0-9]+/gi, '-')}.json`,
      };
      return '';
    } },

    // After $jsonUnstash of a search: adds the picked asset IDs. Lists: added
    rvSearchAdd: { fn(ctx, a) {
      const s = ctx.json;
      if (!s || !Array.isArray(s.results)) fail('load a search first with $jsonUnstash');
      const ids = need(a, 1, '$rvSearchAdd[asset IDs, comma separated;reason?;score?]')[0].split(',').map((x) => x.trim()).filter(Boolean);
      const scoreText = arg(a, 2, s.score ?? '').toString().trim();
      const { added, skipped } = mod('catalogSearch').addItems(s.results, ids, ctx.author?.username || 'unknown', {
        reason: arg(a, 1, s.reason || '') || null, score: scoreText === '' ? null : num(scoreText, 'score'),
      });
      ctx.json = { added: added.map(flagView), addedCount: added.length, skipped };
      return '';
    } },

    // $rvResolveLink[share link or code] -> status ok, invalid_link or not_found
    rvResolveLink: { async fn(ctx, a) {
      const r = await mod('shareLink').resolveShareLinkToItem(need(a, 1, '$rvResolveLink[link]')[0]);
      ctx.json = {
        ...r, detail: r.detail ? String(r.detail).slice(0, 500) : '',
        file: { assetId: r.assetId, name: r.name, url: r.url, type: r.type, assetTypeName: r.assetTypeName },
        filename: `asset-${r.assetId}.json`,
      };
      return '';
    } },
  };
};
