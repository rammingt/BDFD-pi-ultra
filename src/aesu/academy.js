'use strict';
// The academy: who is in it and which phase they are on, kept in step with an
// Academy tab in the Google Sheet and with one Discord role per phase.
//
// Staff move people with /academy or by changing the Phase cell in the sheet. Either
// way the roles follow. The roster is stored in the database, so the bot works the
// same with the sheet switched off.
const { DiscordAPIError } = require('discord.js');
const { config } = require('./config/index');
const { isSheetsConfigured, createSheetsClient, a1 } = require('./sheets/client');
const { resolveGuild, explainRoleError } = require('./discord/roles');
const { KeyedMutex } = require('./util/mutex');
const { createLogger, describeError } = require('./util/logger');

const log = createLogger('academy');

const PHASES = [
  { key: 'orientation', number: 1, label: 'Orientation' },
  { key: 'academy', number: 2, label: 'Academy' },
  { key: 'final_exam', number: 3, label: 'Final exam' },
  { key: 'waiting', number: 4, label: 'Waiting for division' },
];

const ROSTER_KEY = 'academy.roster';
const TAB = 'Academy';
const HEADER = ['Discord ID', 'Name', 'Roblox', 'Phase', 'Phase since', 'Moved by', 'Notes'];

/** Reads a phase however somebody wrote it: "Final exam", "final_exam", "3", "Phase 3". */
function findPhase(text) {
  const wanted = String(text ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const number = /^(?:phase\s*)?(\d)$/.exec(wanted)?.[1];
  return PHASES.find((phase) => phase.key === wanted
    || phase.label.toLowerCase() === wanted
    || String(phase.number) === number
    || wanted.replace(/[^a-z]+/g, ' ').trim() === phase.label.toLowerCase()
    || wanted.startsWith(phase.label.toLowerCase())) ?? null;
}

const phaseRoleIds = () => PHASES.map((phase) => config.academy.roles[phase.key]).filter(Boolean);

function day(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

class Academy {
  locks = new KeyedMutex();

  constructor(store, client) {
    this.store = store;
    this.client = client;
    this.sheet = isSheetsConfigured() ? createSheetsClient(config.sheets.spreadsheetId) : null;
  }

  async roster() {
    return (await this.store.getSetting(ROSTER_KEY)) ?? {};
  }

  async save(roster) {
    await this.store.setSetting(ROSTER_KEY, roster);
  }

  async get(discordId) {
    return (await this.roster())[discordId] ?? null;
  }

  /**
   * Gives the member this phase's role and takes the other phase roles off. Passing
   * null takes them all off. Returns a sentence when something could not be done.
   */
  async applyRoles(discordId, phaseKey, guildId) {
    const wantedId = phaseKey ? config.academy.roles[phaseKey] : '';
    const all = phaseRoleIds();
    if (all.length === 0) return null;
    const guild = await resolveGuild(this.client, guildId);
    if (!guild) return 'cant tell which server, set DISCORD_GUILD_ID';
    try {
      const member = await guild.members.fetch(discordId);
      const stale = all.filter((id) => id !== wantedId && member.roles.cache.has(id));
      if (stale.length) await member.roles.remove(stale, 'Academy phase changed');
      if (wantedId && !member.roles.cache.has(wantedId)) await member.roles.add(wantedId, 'Academy phase changed');
      return null;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) return `They are not in ${guild.name}.`;
      log.error(`Could not change academy roles for ${discordId}: ${describeError(error)}`);
      return explainRoleError(error, guild, 'academy roles');
    }
  }

  /**
   * Puts somebody on a phase, adding them to the academy if they are new.
   * Returns { before, after, roleNote }.
   */
  async setPhase(discordId, phaseKey, { by = null, guildId = null, writeSheet = true } = {}) {
    const result = await this.locks.run('roster', async () => {
      const roster = await this.roster();
      const before = roster[discordId] ?? null;
      const now = Date.now();
      roster[discordId] = {
        ...(before ?? { notes: '', onSheet: false }),
        phase: phaseKey,
        since: before?.phase === phaseKey ? before.since : now,
        by,
      };
      await this.save(roster);
      return { before, after: roster[discordId] };
    });
    const roleNote = await this.applyRoles(discordId, phaseKey, guildId);
    log.info(`${discordId} is now on ${phaseKey}${by ? `, moved by ${by}` : ''}`);
    if (writeSheet) void this.syncSheet().catch((error) => log.warn(`Could not update the Academy tab: ${describeError(error)}`));
    return { ...result, roleNote };
  }

  async remove(discordId, { guildId = null, writeSheet = true } = {}) {
    const removed = await this.locks.run('roster', async () => {
      const roster = await this.roster();
      const entry = roster[discordId] ?? null;
      if (entry) {
        delete roster[discordId];
        await this.save(roster);
      }
      return entry;
    });
    if (!removed) return { removed: null, roleNote: null };
    const roleNote = await this.applyRoles(discordId, null, guildId);
    if (writeSheet) void this.syncSheet().catch((error) => log.warn(`Could not update the Academy tab: ${describeError(error)}`));
    return { removed, roleNote };
  }

  /** A row for each member: their Discord name and Roblox username, for people reading the sheet. */
  async displayNames(ids) {
    const names = new Map();
    for (const id of ids) {
      const user = this.client?.users?.cache?.get(id) ?? await this.client?.users?.fetch(id).catch(() => null);
      const link = await this.store.getLinkByDiscordId(id);
      names.set(id, { name: user ? user.globalName || user.username : '', roblox: link?.robloxUsername ?? '' });
    }
    return names;
  }

  /**
   * Two way sync with the Academy tab. People own Phase and Notes; the bot writes the
   * rest. A Phase cell somebody changed since the last write moves that member (and
   * their roles), a new row with a Discord ID adds them, and a row deleted from the
   * sheet takes them out. Then the whole tab is written back, sorted by phase.
   */
  async syncSheet() {
    if (!this.sheet) return { off: true };
    return this.locks.run('sheet', async () => {
      await this.sheet.ensureTabs([TAB]);
      const grid = await this.sheet.read(a1(TAB, 'A1:G500'));
      const rows = new Map();
      for (const [index, row] of grid.entries()) {
        const id = String(row?.[0] ?? '').replace(/\D/g, '');
        if (index === 0 && !id) continue;
        if (!/^\d{17,20}$/.test(id)) continue;
        rows.set(id, { phase: String(row[3] ?? '').trim(), notes: String(row[6] ?? '').trim() });
      }

      const changes = { added: 0, moved: 0, removed: 0 };
      const roster = await this.roster();

      for (const [id, row] of rows) {
        const phase = findPhase(row.phase);
        const entry = roster[id];
        if (entry) {
          if (row.notes !== (entry.notes ?? '')) {
            await this.locks.run('roster', async () => {
              const fresh = await this.roster();
              if (fresh[id]) { fresh[id].notes = row.notes; await this.save(fresh); }
            });
          }
          // The sheet still shows what the bot last wrote unless somebody changed it there.
          if (phase && phase.key !== entry.phase && row.phase !== entry.sheetPhase) {
            await this.setPhase(id, phase.key, { by: 'sheet', writeSheet: false });
            changes.moved += 1;
          }
        } else if (phase) {
          await this.setPhase(id, phase.key, { by: 'sheet', writeSheet: false });
          await this.locks.run('roster', async () => {
            const fresh = await this.roster();
            if (fresh[id]) { fresh[id].notes = row.notes; await this.save(fresh); }
          });
          changes.added += 1;
        }
      }

      // Somebody who was on the sheet and is not any more was taken off it on purpose.
      for (const [id, entry] of Object.entries(await this.roster())) {
        if (entry.onSheet && !rows.has(id)) {
          await this.remove(id, { writeSheet: false });
          changes.removed += 1;
        }
      }

      await this.writeSheet();
      return changes;
    });
  }

  async writeSheet() {
    const written = await this.locks.run('roster', async () => {
      const roster = await this.roster();
      const ids = Object.keys(roster);
      const names = await this.displayNames(ids);
      const order = (key) => PHASES.find((phase) => phase.key === key)?.number ?? 9;
      const sorted = ids.sort((x, y) => order(roster[x].phase) - order(roster[y].phase) || roster[x].since - roster[y].since);
      const values = [HEADER];
      for (const id of sorted) {
        const entry = roster[id];
        const label = PHASES.find((phase) => phase.key === entry.phase)?.label ?? entry.phase;
        const by = !entry.by ? '' : entry.by === 'sheet' ? 'Sheet' : names.get(entry.by)?.name || entry.by;
        // Written raw, so a Discord ID stays text and nothing anybody typed becomes a formula.
        values.push([id, names.get(id)?.name ?? '', names.get(id)?.roblox ?? '', label, day(entry.since), by, entry.notes ?? '']);
        entry.onSheet = true;
        entry.sheetPhase = label;
      }
      await this.save(roster);
      return values;
    });
    await this.sheet.replace(TAB, written);
  }
}

module.exports = { Academy, PHASES, findPhase, TAB, HEADER };
