'use strict';
const { getMembership, isGroupConfigured, listRoles, robloxErrorMessage, setRank: setGroupRank } = require('../roblox/group');
const { createLogger, describeError } = require('../util/logger');
const { KeyedMutex } = require('../util/mutex');
const { effectiveMode, measureRank, nextRank, workedMinutesByType } = require('./types');

const log = createLogger('ranks');

/** The ladder outlives a restart here, so the sheet is not needed to answer a command. */
const LADDER_KEY = 'ranks.ladder';

/**
 * Every way a promotion request can end. Each case carries what the caller needs to
 * explain itself, so nothing downstream has to guess why it got this answer.
 */

/**
 * Owns the promotion ladder, which is the Roblox group's own rank list with
 * requirements written against it in the sheet.
 *
 * Progress is never stored. It is measured from the shift records and the events
 * table every time it is asked for, and somebody's current rank is read live from
 * Roblox, so this cannot drift away from either system. Rover syncs the Discord side
 * off the group rank, which is why promoting in the group is the whole job.
 */
class RankManager {
  locks = new KeyedMutex();
  ranks = [];

  constructor(
    store,
    shifts,
    events,
  ) {
    this.store = store;
    this.shifts = shifts;
    this.events = events;
  }

  async init() {
    const stored = await this.store.getSetting(LADDER_KEY);
    if (stored && stored.length > 0) {
      this.ranks = stored;
      log.info(`Loaded ${stored.length} rank(s) from storage`);
    }
  }

  /** Lowest first, which is the order everything shows them in. */
  list() {
    return [...this.ranks].sort((a, b) => a.rank - b.rank);
  }

  byRoleId(roleId) {
    return this.ranks.find((rank) => rank.roleId === roleId) ?? null;
  }

  async replace(ranks) {
    if (ranks.length === 0) {
      log.warn('Asked to replace the ladder with nothing; keeping the one already loaded');
      return;
    }
    this.ranks = ranks;
    await this.store.setSetting(LADDER_KEY, ranks);
  }

  /**
   * Re-reads the group's ranks. Names, rank numbers and member counts come from
   * Roblox; everything written against a rank is kept from what is already there,
   * keyed by role id so renaming a rank in Roblox does not lose it.
   */
  async syncFromGroup() {
    const roles = await listRoles(true);
    const existing = new Map(this.ranks.map((rank) => [rank.roleId, rank]));

    const ranks = roles.map((role) => {
      const kept = existing.get(role.id);
      return {
        roleId: role.id,
        rank: role.rank,
        name: role.name,
        memberCount: role.memberCount,
        requirements: kept?.requirements ?? [],
        general: kept?.general ?? [],
        // A rank nobody has configured is never self-service, so turning this on
        // cannot let anybody promote themselves before the requirements are written.
        mode: kept?.mode ?? 'manual',
        notes: kept?.notes ?? null,
      };
    });

    await this.replace(ranks);
    log.info(`Read ${ranks.length} rank(s) from the Roblox group`);
    return this.list();
  }

  /** What somebody has banked, measured against the rung above where they are now. */
  async progress(
    discordId,
    now = Date.now(),
  ) {
    // Every rank lives in the group, so without one there is nothing to measure against.
    if (!isGroupConfigured()) return { error: 'off' };

    const link = await this.store.getLinkByDiscordId(discordId);
    if (!link) return { error: 'not_linked' };

    const membership = await getMembership(link.robloxId);
    if (!membership) return { error: 'not_in_group' };

    const current = this.byRoleId(membership.id);
    const next = nextRank(this.list(), membership.rank);

    const shifts = await this.shifts.listShifts(discordId, { includeOpen: true });
    const hosted = await this.events.hostedCount(discordId);
    const measured = measureRank(next, workedMinutesByType(shifts, now), hosted.hosted);

    return {
      discordId,
      current: current ?? {
        roleId: membership.id,
        rank: membership.rank,
        name: membership.name,
        requirements: [],
        general: [],
        mode: 'manual',
        notes: null,
        memberCount: null,
      },
      next,
      ...measured,
    };
  }

  /**
   * Works out whether somebody may move up, and moves them when they may. Serialised
   * per member so a double click cannot promote anybody twice.
   */
  async requestPromotion(discordId, now = Date.now()) {
    if (!isGroupConfigured()) return { outcome: 'off' };

    return this.locks.run(discordId, async () => {
      let progress;
      try {
        progress = await this.progress(discordId, now);
      } catch (error) {
        return { outcome: 'failed', reason: robloxErrorMessage(error) };
      }

      if ('error' in progress) return { outcome: progress.error };
      if (!progress.next) return { outcome: 'top', progress };

      const rank = progress.next;
      // Not rank.mode: a rank with general requirements is forced to approval, so a
      // human still confirms the parts the bot cannot see.
      const mode = effectiveMode(rank);

      if (mode === 'manual') return { outcome: 'manual', rank, progress };
      if (rank.requirements.length === 0) return { outcome: 'unconfigured', rank, progress };
      if (!progress.ready) return { outcome: 'not_ready', rank, progress };
      if (mode === 'approval') return { outcome: 'needs_approval', rank, progress };

      const applied = await this.apply(discordId, rank);
      return applied.ok ? { outcome: 'promoted', rank, progress } : { outcome: 'failed', reason: applied.reason };
    });
  }

  /**
   * Sets the rank in the Roblox group. Rover picks the change up and moves their
   * Discord roles, so nothing here touches Discord.
   */
  async apply(discordId, rank) {
    const link = await this.store.getLinkByDiscordId(discordId);
    if (!link) return { ok: false, reason: 'They have not linked a Roblox account with `/connect`.' };

    try {
      await setGroupRank(link.robloxId, rank.roleId);
      log.info(`Promoted ${discordId} (${link.robloxUsername ?? link.robloxId}) to ${rank.name}`);
      return { ok: true };
    } catch (error) {
      log.error(`Could not promote ${discordId}: ${describeError(error)}`);
      return { ok: false, reason: robloxErrorMessage(error) };
    }
  }
}

module.exports = { RankManager };
