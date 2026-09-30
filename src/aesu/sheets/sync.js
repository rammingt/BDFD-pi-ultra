'use strict';
const { config } = require('../config/index');
const { formatGeneral, formatRequirements, parseGeneral, parseMode, parseRequirements } = require('../ranks/types');
const { isGroupConfigured } = require('../roblox/group');
const { createLogger, describeError } = require('../util/logger');
const { a1, asText, createSheetsClient } = require('./client');
const { rankFormatRequests, guideFormatRequests } = require('./format');
const { GUIDE_TAB, guideGrid, guideNeedsWriting } = require('./guide');

const log = createLogger('sheets:sync');

const RANKS_TAB = 'Ranks';

/** The bot owns Rank, Name and Members; people own the four in the middle. */
const RANKS_HEADER = [
  'Rank',
  'Name',
  'Requirements',
  'General requirements',
  'Promotion',
  'Notes',
  'Members',
];

function cell(row, index) {
  return (row?.[index] ?? '').trim();
}

/** What somebody wrote against one rank. Keyed by rank number, which Roblox keeps unique. */

/**
 * Reads the columns people own. The bot-written columns are ignored on the way in:
 * names and rank numbers come from the group, never from the sheet.
 */
function parseRankGrid(grid) {
  const edits = new Map();

  for (const [index, row] of grid.entries()) {
    const first = cell(row, 0);
    if (index === 0 && first.toLowerCase() === 'rank') continue;

    const rank = Number.parseInt(first, 10);
    if (!Number.isFinite(rank)) continue;

    const notes = cell(row, 5);
    edits.set(rank, {
      requirementsText: cell(row, 2),
      general: parseGeneral(cell(row, 3)),
      mode: parseMode(cell(row, 4)),
      notes: notes || null,
    });
  }

  return edits;
}

/** Merges what the group says with what the sheet says, and reports every typo. */
function applyEdits(ranks, edits) {
  const problems = [];

  const merged = ranks.map((rank) => {
    const edit = edits.get(rank.rank);
    if (!edit) return rank;

    const parsed = parseRequirements(edit.requirementsText);
    for (const problem of parsed.problems) problems.push(`${rank.name}: ${problem}`);

    return {
      ...rank,
      requirements: parsed.requirements,
      general: edit.general,
      mode: edit.mode,
      notes: edit.notes,
    };
  });

  return { ranks: merged, problems };
}

function rankGridFor(ranks) {
  return [
    RANKS_HEADER,
    ...ranks.map((rank) => [
      String(rank.rank),
      asText(rank.name),
      asText(formatRequirements(rank.requirements)),
      asText(formatGeneral(rank.general)),
      rank.mode,
      asText(rank.notes ?? ''),
      rank.memberCount === null ? '' : String(rank.memberCount),
    ]),
  ];
}

/**
 * Keeps the Ranks tab and the promotion ladder in step.
 *
 * The Roblox group is the source of truth for which ranks exist and what they are
 * called; the sheet is the source of truth for what each one requires. Neither side
 * ever writes the other's columns, so they cannot disagree.
 */
class SheetsSync {
  running = false;
  /** Formatting is cosmetic and costs several API calls, so it is not done every tick. */
  styled = false;

  constructor(
    client,
    ranks,
  ) {
    this.client = client;
    this.ranks = ranks;
  }

  async applyLook() {
    try {
      const tabs = new Map((await this.client.tabs()).map((tab) => [tab.title, tab]));
      const requests = [];

      const ranks = tabs.get(RANKS_TAB);
      if (ranks) requests.push(...rankFormatRequests(ranks.sheetId, ranks.conditionalFormats));

      const guide = tabs.get(GUIDE_TAB);
      if (guide) requests.push(...guideFormatRequests(guide.sheetId));

      await this.client.batchUpdate(requests);
      this.styled = true;
    } catch (error) {
      log.warn(`Could not format the sheet: ${describeError(error)}`);
    }
  }

  /** Writes the in-sheet guide when it is missing or out of date. */
  async ensureGuide() {
    try {
      const existing = await this.client.read(a1(GUIDE_TAB, 'A1:B1'));
      if (!guideNeedsWriting(existing)) return;

      await this.client.replace(GUIDE_TAB, guideGrid());
      log.info(`Wrote the "${GUIDE_TAB}" tab`);
    } catch (error) {
      log.warn(`Could not write the guide tab: ${describeError(error)}`);
    }
  }

  async syncNow(options = {}) {
    if (this.running) {
      log.debug('A sync is already in flight; skipping this one');
      return { ranks: 0, problems: [] };
    }
    this.running = true;

    try {
      const created = await this.client.ensureTabs([RANKS_TAB, GUIDE_TAB]);
      await this.ensureGuide();

      // 1. Which ranks exist, straight from the group. Falls back to the stored
      // ladder so a Roblox outage leaves the sheet alone rather than emptying it.
      let ladder = this.ranks.list();
      if (isGroupConfigured()) {
        try {
          ladder = await this.ranks.syncFromGroup();
        } catch (error) {
          log.warn(`Could not read the group's ranks; keeping the stored ladder: ${describeError(error)}`);
        }
      }

      if (ladder.length === 0) {
        log.warn('There are no ranks to sync. Set ROBLOX_GROUP_ID and run /promote sync.');
        return { ranks: 0, problems: [] };
      }

      // 2. What people wrote against them.
      const edits = parseRankGrid(await this.client.read(a1(RANKS_TAB, 'A1:G300')));
      const { ranks, problems } = applyEdits(ladder, edits);
      await this.ranks.replace(ranks);

      for (const problem of problems) log.warn(`Ignoring a requirement - ${problem}`);

      // 3. Write the whole tab back, highest rank first so the ladder reads downwards.
      await this.client.replace(RANKS_TAB, rankGridFor([...ranks].sort((a, b) => b.rank - a.rank)), true);

      if (!this.styled || options.reformat || created.length > 0) await this.applyLook();

      log.info(`Synced ${ranks.length} rank(s)`);
      return { ranks: ranks.length, problems };
    } finally {
      this.running = false;
    }
  }
}

function createSheetsSync(ranks) {
  const client = createSheetsClient();
  if (!client) return null;
  log.info(`Google Sheets sync is on, every ${config.sheets.syncIntervalMinutes} minute(s)`);
  return new SheetsSync(client, ranks);
}

module.exports = { RANKS_TAB, RANKS_HEADER, parseRankGrid, applyEdits, rankGridFor, SheetsSync, createSheetsSync };
