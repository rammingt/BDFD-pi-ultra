// Heuristic classifier for catalog listings. Roblox uploaders who want to
// get something past moderation don't spell it out, so matching raw text
// catches almost nothing: the work here is normalizing away the usual
// evasions first (leetspeak, padded letters, spaced-out words) and only
// then looking for terms.
//
// Nothing here auto-moderates anyone. It produces candidates for a human
// to confirm, so the bias is toward surfacing a questionable listing and
// against inventing a match in an innocent one - a false positive costs a
// reviewer a glance, but it's what erodes trust in the whole list.

// Digits and symbols that stand in for letters. Applied before matching,
// so a term only has to be listed in its plain spelling.
const LEET = {
  4: 'a',
  '@': 'a',
  3: 'e',
  1: 'i',
  '!': 'i',
  '|': 'i',
  0: 'o',
  5: 's',
  $: 's',
  7: 't',
  '+': 't',
  8: 'b',
  6: 'g',
  9: 'g',
  2: 'z',
};

// Symbols only stand in for letters in the middle of a word. Requiring an
// alphanumeric on both sides is load-bearing, not caution: a trailing "!"
// converted to "i" turns the very common "LOL!" into "loli", which is a
// term this filter treats as a child-safety hit. A missed "$exy" is a
// cheaper mistake than a fabricated one.
const INNER_SYMBOLS = /(?<=[a-z0-9])[!|@$+](?=[a-z0-9])/g;

// Collapses padding ("coooondo", "sexxx") down to the plain spelling.
// Three or more, never two: doubled letters are ordinary English, and
// collapsing them would rewrite "nigger" as "niger" - which then matches
// Niger and Nigeria, so every national flag shirt would read as a slur.
// Terms are deliberately left uncollapsed for the same reason, so a term
// keeps its real spelling and only padded text is folded toward it.
function collapseRuns(text) {
  return text.replace(/(.)\1{2,}/g, '$1');
}

function normalizeTokens(text, { collapse, mapDigits }) {
  return String(text || '')
    .toLowerCase()
    .replace(INNER_SYMBOLS, (ch) => LEET[ch])
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => {
      // A run of digits is a number, not a disguised word, so it's left
      // alone - otherwise "Level 3 Shirt" reads as "level e shirt".
      if (!mapDigits || !/[a-z]/.test(token)) return collapse ? collapseRuns(token) : token;
      let out = '';
      for (const ch of token) out += LEET[ch] ?? ch;
      return collapse ? collapseRuns(out) : out;
    })
    .join(' ');
}

// Digits inside a word are ambiguous: "s3xy" wants them read as letters,
// "germany1939" wants them left as a number. Both readings are produced and
// both are searched, rather than picking one and losing the other.
function normalize(text) {
  return normalizeTokens(text, { collapse: true, mapDigits: true });
}

function normalizeKeepingDigits(text) {
  return normalizeTokens(text, { collapse: true, mapDigits: false });
}

// Terms are always written in plain spelling, so their digits are never a
// disguise - "1488" and "germany1939" mean the numbers they say.
function normalizeTerm(term) {
  return normalizeTokens(term, { collapse: false, mapDigits: false }).replace(/ /g, '');
}

// Joins runs of isolated single characters back into a word, so "c o n d o"
// reads as "condo" while ordinary text is left alone. This is deliberately
// narrower than stripping every space: "second order" must not turn into
// something containing "condo".
function joinSpacedLetters(plain) {
  return plain.replace(/\b(?:[a-z0-9] ){2,}[a-z0-9]\b/g, (run) => run.replace(/ /g, ''));
}

function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Three ways a term can match, in increasing reach:
//
//   word  - whole words only. The default, and what keeps "class" clear of
//           "ass" and "analysis" clear of "anal".
//   stem  - anywhere inside a word, so run-together names ("pornlover123",
//           "SexyOutfitStore") are caught. Every entry has to be checked by
//           hand against ordinary English first: "rapist" cannot be a stem,
//           because "therapist" contains it.
//   loose - anywhere, with spaces stripped as well, so multi-word phrases
//           match however they're spaced. Long distinctive strings only.
const STEM_MIN_LENGTH = 4;
const LOOSE_MIN_LENGTH = 8;

// Each rule carries the score an automatic match adds. Roblox already blocks
// plain profanity, slurs and explicit sexual words in item names, so listing
// those here would be dead weight - what actually reaches the catalog is the
// coded spelling people reach for instead, and that is what these cover.
//
// Identity words (femboy, trap, catgirl and the like) are deliberately absent.
// They describe how people present themselves, not wrongdoing, and flagging
// them would turn this into something it should not be.
const RULES = [
  {
    id: 'sexual',
    score: 5,
    severity: 'block',
    reason: 'sexual wording',
    word: ['nsfw', 'ahegao', 'hentai', 'lewd', 'fetish', 'bdsm', 'milf', 'thong', 'gstring', 'lingerie', 'stripper', 'twerk'],
    stem: ['ahegao', 'hentai', 'fetish', 'lingerie', 'stripper', 'onlyfans'],
    loose: ['onlyfans'],
  },
  {
    id: 'bypass',
    score: 5,
    severity: 'block',
    reason: 'coded wording used to get past moderation',
    // "jeffrey" and "diddy" are left out on their own: Diddy Kong and anyone
    // actually called Jeffrey would match, and the deliberate misspelling and
    // the full-name forms are the part that carries the signal.
    // "femby" and not "femboy": Roblox moderates the real spelling, so the
    // clipped one is what actually reaches a catalog name.
    word: ['seggs', 'epstein', 'jeffry', 'unalive', 'kys', 'femby'],
    stem: ['epstein', 'seggs'],
    loose: ['jeffreyepstein', 'jeffryepstein', 'freakoff'],
  },
  {
    id: 'condo',
    score: 5,
    severity: 'block',
    reason: 'condo / adult-game reference',
    // "condo" stays a whole-word term on purpose: as a substring it turns up
    // inside innocent text ("second order"), and the spaced-out spelling is
    // already covered by joinSpacedLetters.
    word: ['condo', 'condos', 'kondo', 'condoh'],
    loose: ['scentedcon', 'scentedtea', 'condogame', 'condoserver'],
  },
  {
    id: 'extremist',
    score: 5,
    severity: 'block',
    reason: 'extremist or hate-symbol reference',
    // Scored above the political rule on purpose: these are the euphemisms
    // people use precisely because the plain words are blocked.
    word: ['aryan', 'totenkopf', 'wehrmacht', 'reich', 'fuhrer', 'furher', 'heil', 'sieg', '1488'],
    stem: ['totenkopf', 'wehrmacht'],
    loose: ['thirdreich', 'fourthreich', 'siegheil', 'whitepower', 'gaschamber', 'germany1939', 'germany1940'],
  },
  {
    id: 'political',
    score: 3,
    severity: 'suspect',
    // Said plainly in the output, because a national flag or a football shirt
    // lands here just as readily as anything worth acting on.
    reason: 'country or conflict reference (often harmless on its own)',
    word: ['israel', 'israeli', 'palestine', 'palestinian', 'idf', 'hamas', 'zionist', 'hezbollah', 'taliban'],
    stem: ['israel', 'palestin', 'zionis'],
    loose: ['freepalestine', 'fromtheriver', 'israeldefense'],
  },
  {
    id: 'avatar',
    score: 3,
    severity: 'suspect',
    // Scored low and said plainly, because these are worn innocently far more
    // often than not - a pride item and a thigh-high sock both land here. It
    // marks an outfit worth a glance, nothing more.
    reason: 'outfit wording common in ERP avatars (frequently innocent)',
    // The phrase only, never the bare word: "gay" on its own describes people,
    // not behaviour, and has no business in a list like this.
    loose: ['gayfurry', 'thighhigh', 'thighhighs'],
  },
  {
    id: 'frontlayer',
    score: 3,
    severity: 'suspect',
    reason: 'turtleneck worn as a front accessory',
    // Scoped on purpose: a turtleneck shirt is ordinary clothing, while one
    // stacked on the front accessory slot is being used for a body shape.
    onlyAssetTypes: ['FrontAccessory'],
    loose: ['turtleneck'],
  },
  {
    id: 'contact',
    score: 4,
    severity: 'suspect',
    reason: 'off-platform contact or e-dating signal',
    word: ['dmme', 'edate', 'edating', 'egirl', 'eboy', 'sugarbaby', 'kik'],
    // Multi-word phrases have to go here rather than in `word`: spaces are
    // stripped before a loose match, so "add me on discord" lines up with
    // the run-together spelling.
    loose: ['discordgg', 'joinmyserver', 'addmeondiscord', 'dmmeondiscord', 'sugardaddy'],
  },
  {
    id: 'drugs',
    score: 2,
    severity: 'suspect',
    reason: 'drug reference',
    // "lean" and "plug" are left out on purpose - both are ordinary words in
    // clothing names ("Lean Fit Tee") and would fire constantly.
    word: ['weed', 'cocaine', 'meth', 'vape', 'bong'],
    loose: ['drugdealer'],
  },
];

// Compiled once. The guard is the point: a short term in `loose` would
// quietly start matching inside ordinary words, which is the one failure
// mode that makes a list like this useless, so it's a startup error rather
// than something to notice later in review.
function compileNeedles(terms, ruleId, kind, minLength) {
  return (terms || []).map((term) => {
    const needle = normalizeTerm(term);
    if (needle.length < minLength) {
      throw new Error(
        `contentFilter: ${kind} term "${term}" in rule "${ruleId}" is too short (${needle.length} < ${minLength}); list it under \`word\` instead.`
      );
    }
    return { term, needle };
  });
}

const COMPILED = RULES.map((rule) => ({
  ...rule,
  word: (rule.word || []).map((term) => ({
    term,
    pattern: new RegExp(`\\b${escapeRegex(normalizeTerm(term))}\\b`),
  })),
  stem: compileNeedles(rule.stem, rule.id, 'stem', STEM_MIN_LENGTH),
  loose: compileNeedles(rule.loose, rule.id, 'loose', LOOSE_MIN_LENGTH),
}));

// A custom keyword matches whole-word when it is one word, and across spaces
// when it is a phrase. One word can never match inside a longer one, which is
// what keeps a short keyword from quietly matching half the catalog.
// A word of a multi-word keyword may also match inside a longer word, but only
// once it is this long. Below it, short words like "red" or "cap" start turning
// up inside ordinary names ("Sacred Capital") and the keyword stops meaning
// anything.
const TOKEN_SUBSTRING_MIN = 4;

function compileKeyword(entry) {
  const plain = normalizeTokens(entry.keyword, { collapse: false, mapDigits: false });
  const parts = plain.split(' ').filter(Boolean);
  if (parts.length === 0) return null;

  return {
    entry,
    isPhrase: parts.length > 1,
    squashed: parts.join(''),
    tokens: parts.map((text) => ({
      text,
      pattern: new RegExp(`\\b${escapeRegex(text)}\\b`),
      // Only ever for a multi-word keyword, where every other word has to be
      // present too. On its own a word must match whole, or "crown" would
      // fire inside "Crownley".
      canSubstring: parts.length > 1 && text.length >= TOKEN_SUBSTRING_MIN,
    })),
  };
}

// A multi-word keyword matches when every one of its words turns up, in any
// order and anywhere in the name: "usa quarter zip" is meant to catch "USA
// dark blue quarter zip sweater", not only that exact phrase. Requiring all of
// them is what keeps it precise - any single one of those words alone would be
// useless.
//
// A single-word keyword still has to match as a whole word, so "crown" never
// fires inside "Crownley".
function keywordMatches(compiled, words, squashedReadings) {
  // Written run-together, e.g. "USAQuarterZip". Length-gated like the built-in
  // loose terms, and for the same reason: "red cap" squashes to "redcap",
  // which is sitting inside "sacred capital".
  const runTogether =
    compiled.isPhrase &&
    compiled.squashed.length >= LOOSE_MIN_LENGTH &&
    squashedReadings.some((q) => q.includes(compiled.squashed));
  if (runTogether) return true;
  return compiled.tokens.every(
    (t) =>
      words.some((w) => t.pattern.test(w)) ||
      (t.canSubstring && squashedReadings.some((q) => q.includes(t.text)))
  );
}

// What an admin typed, reduced to the form it is stored and compared as.
// `problem` is set when it cannot safely be used as a keyword at all.
function inspectKeyword(raw) {
  const plain = normalizeTokens(raw, { collapse: false, mapDigits: false });
  const parts = plain.split(' ').filter(Boolean);
  const squashed = parts.join('');
  const isPhrase = parts.length > 1;

  let problem = null;
  if (!squashed) {
    problem = 'that has no letters or numbers in it';
  } else if (!isPhrase && squashed.length < 3) {
    problem = 'a single word needs at least 3 characters, or it matches far too much';
  } else if (isPhrase && parts.some((t) => t.length < 2)) {
    // Every word has to be present for a match, so a single letter among them
    // contributes nothing but noise.
    problem = 'every word needs at least 2 characters';
  } else if (isPhrase && squashed.length < 6) {
    problem = 'a multi-word keyword needs at least 6 characters in total';
  }

  return { plain, squashed, parts, isPhrase, normalized: squashed, problem };
}

// Whether anything already catches this word - a built-in rule or a custom
// keyword that is on the list. Asked by matching rather than by comparing
// strings, so a respelling ("Sp4rkl3 Bunny" for "sparkle bunny") is caught as
// the duplicate it is: the scan would have matched it either way, and a second
// entry would only double the score on every item that hits.
function alreadyCovered(raw, extraKeywords = []) {
  return findHits(raw, { extraKeywords })[0] || null;
}

function findHits(text, { assetTypeName = null, extraKeywords = [] } = {}) {
  const readings = [normalize(text), normalizeKeepingDigits(text)];
  const words = readings.flatMap((r) => [r, joinSpacedLetters(r)]);
  const squashed = readings.map((r) => r.replace(/ /g, ''));

  const hits = [];
  for (const rule of COMPILED) {
    // A scoped rule only applies in the slots it names. When the slot isn't
    // known it stays silent rather than guessing - the whole point of scoping
    // one of these is that the same word is ordinary everywhere else.
    if (rule.onlyAssetTypes && !rule.onlyAssetTypes.includes(assetTypeName)) continue;

    const matched =
      rule.word.find((t) => words.some((w) => t.pattern.test(w)))?.term ||
      rule.stem.find((t) => readings.some((r) => r.includes(t.needle)))?.term ||
      rule.loose.find((t) => squashed.some((q) => q.includes(t.needle)))?.term;
    if (matched) {
      hits.push({
        rule: rule.id,
        severity: rule.severity,
        score: rule.score,
        reason: rule.reason,
        term: matched,
      });
    }
  }

  for (const entry of extraKeywords) {
    const compiled = compileKeyword(entry);
    if (!compiled) continue;
    if (!keywordMatches(compiled, words, squashed)) continue;
    hits.push({
      rule: `custom:${entry.category}`,
      severity: 'suspect',
      score: entry.score,
      reason: entry.reason || 'custom keyword',
      term: entry.keyword,
    });
  }

  return hits;
}

// A single soft signal is worth a look but not a verdict - plenty of
// legitimate items mention a Discord server. Two independent ones, or
// anything from a `block` rule, is a candidate.
function verdictFor(hits) {
  if (hits.some((h) => h.severity === 'block')) return 'flag';
  const suspects = hits.filter((h) => h.severity === 'suspect').length;
  if (suspects >= 2) return 'flag';
  if (suspects === 1) return 'review';
  return 'clean';
}

// Creator names are checked too: the listing itself is sometimes clean
// while the account advertising it isn't.
function classifyItem({ name, description, creatorName, assetTypeName, extraKeywords } = {}) {
  const hits = findHits([name, description, creatorName].filter(Boolean).join(' \n '), {
    assetTypeName,
    extraKeywords,
  });
  const reasons = Array.from(new Set(hits.map((h) => h.reason)));

  return {
    verdict: verdictFor(hits),
    hits,
    reason: reasons.join('; ') || null,
  };
}

// Scans a single item name - what an inventory scan has to work with, since
// an owned item carries no description. Returns every category that matched
// and the score they add up to.
//
// This is a word list, not a judgement: it reads names, not the item itself,
// so it will miss things that are spelled innocently and will flag things
// that are perfectly fine. Whatever shows it must be presented as a guess.
function scanName(name, context = {}) {
  const hits = findHits(name, context);
  return {
    hits,
    score: hits.reduce((sum, h) => sum + h.score, 0),
    reasons: Array.from(new Set(hits.map((h) => h.reason))),
  };
}

module.exports = {
  classifyItem,
  scanName,
  inspectKeyword,
  alreadyCovered,
  normalize,
  normalizeKeepingDigits,
  normalizeTerm,
  joinSpacedLetters,
  RULES,
};
