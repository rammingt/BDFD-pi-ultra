'use strict';
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
const { createLogger, describeError } = require('../util/logger');

const log = createLogger('store:json');

function emptyFile() {
  return {
    version: 1,
    links: {},
    oauthStates: {},
    shifts: {},
    watchStates: {},
    events: {},
    eventSignups: {},
    settings: {},
  };
}

function signupKey(eventId, discordId) {
  return `${eventId}|${discordId}`;
}

/**
 * File-backed store for local development and single-instance deploys without a
 * database. Everything lives in memory; writes are serialised and atomic.
 *
 * On Railway this needs a mounted volume to survive a redeploy - otherwise set
 * DATABASE_URL and use the Postgres driver instead.
 */
class JsonStore {
  path;
  data = emptyFile();
  writeChain = Promise.resolve();
  dirty = false;

  constructor(path) {
    this.path = resolve(path);
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const contents = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(contents);
      this.data = { ...emptyFile(), ...parsed };
      log.info(
        `Loaded ${Object.keys(this.data.links).length} link(s) and ${Object.keys(this.data.shifts).length} shift(s) from ${this.path}`,
      );
    } catch (error) {
      if ((error).code === 'ENOENT') {
        this.data = emptyFile();
        await this.flush();
        log.info(`Created a new data file at ${this.path}`);
      } else {
        throw error;
      }
    }
  }

  async close() {
    await this.writeChain;
    if (this.dirty) await this.flush();
  }

  persist() {
    this.dirty = true;
    this.writeChain = this.writeChain.then(() => this.flush()).catch((error) => {
      log.error(`Failed to write ${this.path}: ${describeError(error)}`);
    });
    return this.writeChain;
  }

  async flush() {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.path);
    this.dirty = false;
  }

  async getLinkByDiscordId(discordId) {
    return this.data.links[discordId] ?? null;
  }

  async getLinkByRobloxId(robloxId) {
    return Object.values(this.data.links).find((link) => link.robloxId === robloxId) ?? null;
  }

  async upsertLink(link) {
    // A Roblox account may only be attached to one Discord account at a time.
    for (const [discordId, existing] of Object.entries(this.data.links)) {
      if (existing.robloxId === link.robloxId && discordId !== link.discordId) {
        delete this.data.links[discordId];
      }
    }
    this.data.links[link.discordId] = link;
    await this.persist();
  }

  async deleteLink(discordId) {
    const existing = this.data.links[discordId] ?? null;
    if (existing) {
      delete this.data.links[discordId];
      await this.persist();
    }
    return existing;
  }

  async listLinks() {
    return Object.values(this.data.links);
  }

  async createOAuthState(state) {
    this.data.oauthStates[state.state] = state;
    await this.persist();
  }

  async consumeOAuthState(state) {
    const existing = this.data.oauthStates[state] ?? null;
    if (existing) {
      delete this.data.oauthStates[state];
      await this.persist();
    }
    return existing;
  }

  async purgeExpiredOAuthStates(now) {
    let removed = 0;
    for (const [key, value] of Object.entries(this.data.oauthStates)) {
      if (value.expiresAt <= now) {
        delete this.data.oauthStates[key];
        removed += 1;
      }
    }
    if (removed > 0) await this.persist();
  }

  async latestOAuthState(discordId) {
    const matches = Object.values(this.data.oauthStates)
      .filter((state) => state.discordId === discordId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return matches[0] ?? null;
  }

  async createShift(shift) {
    this.data.shifts[shift.id] = shift;
    await this.persist();
  }

  async updateShift(shift) {
    this.data.shifts[shift.id] = shift;
    await this.persist();
  }

  async getShift(id) {
    return this.data.shifts[id] ?? null;
  }

  async getOpenShift(discordId) {
    const open = Object.values(this.data.shifts)
      .filter((shift) => shift.discordId === discordId && shift.status !== 'ended')
      .sort((a, b) => b.startedAt - a.startedAt);
    return open[0] ?? null;
  }

  async listOpenShifts() {
    return Object.values(this.data.shifts).filter((shift) => shift.status !== 'ended');
  }

  async listShifts(discordId, query = {}) {
    const { since, until, limit, type, includeOpen = false } = query;
    return Object.values(this.data.shifts)
      .filter((shift) => shift.discordId === discordId)
      .filter((shift) => (includeOpen ? true : shift.status === 'ended'))
      .filter((shift) => (type ? shift.type === type : true))
      .filter((shift) => (since === undefined ? true : shift.startedAt >= since))
      .filter((shift) => (until === undefined ? true : shift.startedAt <= until))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
  }

  async getWatchState(discordId) {
    return this.data.watchStates[discordId] ?? null;
  }

  async upsertWatchState(state) {
    this.data.watchStates[state.discordId] = state;
    await this.persist();
  }

  async deleteWatchState(discordId) {
    if (this.data.watchStates[discordId]) {
      delete this.data.watchStates[discordId];
      await this.persist();
    }
  }

  async createEvent(event) {
    this.data.events[event.id] = event;
    await this.persist();
  }

  async updateEvent(event) {
    this.data.events[event.id] = event;
    await this.persist();
  }

  async getEvent(id) {
    return this.data.events[id] ?? null;
  }

  async listEvents(query = {}) {
    const { status, guildId, hostId, limit } = query;
    return Object.values(this.data.events)
      .filter((event) => (status ? status.includes(event.status) : true))
      .filter((event) => (guildId === undefined ? true : event.guildId === guildId))
      .filter((event) => (hostId === undefined ? true : event.hostId === hostId))
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
  }

  async upsertSignup(signup) {
    this.data.eventSignups[signupKey(signup.eventId, signup.discordId)] = signup;
    await this.persist();
  }

  async getSignup(eventId, discordId) {
    return this.data.eventSignups[signupKey(eventId, discordId)] ?? null;
  }

  async listSignups(eventId) {
    return Object.values(this.data.eventSignups)
      .filter((signup) => signup.eventId === eventId)
      .sort((a, b) => a.signedUpAt - b.signedUpAt);
  }

  async getSetting(key) {
    return (this.data.settings[key]) ?? null;
  }

  async setSetting(key, value) {
    this.data.settings[key] = value;
    await this.persist();
  }
}

module.exports = { JsonStore };
