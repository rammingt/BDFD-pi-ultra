'use strict';
const pg = require('pg');
const { createLogger } = require('../util/logger');

const { Pool } = pg;
const log = createLogger('store:postgres');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roblox_links (
  discord_id          TEXT PRIMARY KEY,
  roblox_id           TEXT NOT NULL UNIQUE,
  roblox_username     TEXT NOT NULL,
  roblox_display_name TEXT NOT NULL,
  access_token        TEXT,
  refresh_token       TEXT,
  token_expires_at    BIGINT,
  linked_at           BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  discord_id    TEXT NOT NULL,
  guild_id      TEXT,
  code_verifier TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id               TEXT PRIMARY KEY,
  discord_id       TEXT NOT NULL,
  guild_id         TEXT,
  roblox_id        TEXT,
  roblox_username  TEXT,
  type             TEXT NOT NULL,
  status           TEXT NOT NULL,
  source           TEXT NOT NULL,
  started_at       BIGINT NOT NULL,
  ended_at         BIGINT,
  break_started_at BIGINT,
  break_ms         BIGINT NOT NULL DEFAULT 0,
  break_count      INTEGER NOT NULL DEFAULT 0,
  universe_id      TEXT,
  place_id         TEXT,
  game_name        TEXT,
  end_reason       TEXT,
  log_channel_id   TEXT,
  log_message_id   TEXT,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS shifts_member_idx ON shifts (discord_id, started_at DESC);
CREATE INDEX IF NOT EXISTS shifts_open_idx ON shifts (status) WHERE status <> 'ended';

CREATE TABLE IF NOT EXISTS watch_states (
  discord_id           TEXT PRIMARY KEY,
  session_key          TEXT,
  universe_id          TEXT,
  place_id             TEXT,
  game_name            TEXT,
  last_seen_in_game_at BIGINT,
  missing_since        BIGINT,
  prompt_status        TEXT NOT NULL DEFAULT 'none',
  prompt_sent_at       BIGINT,
  prompt_channel_id    TEXT,
  prompt_message_id    TEXT,
  updated_at           BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT,
  host_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  details    TEXT,
  image_url  TEXT,
  shift_type TEXT NOT NULL,
  status     TEXT NOT NULL,
  starts_at  BIGINT NOT NULL,
  ends_at    BIGINT,
  roles      JSONB NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_status_idx ON events (status, starts_at);

-- Events used to run for a fixed duration; now they run until the host ends them.
ALTER TABLE events ALTER COLUMN ends_at DROP NOT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_away_since BIGINT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_reminded_at BIGINT;

CREATE TABLE IF NOT EXISTS event_signups (
  event_id      TEXT NOT NULL,
  discord_id    TEXT NOT NULL,
  role_key      TEXT NOT NULL,
  roblox_id     TEXT,
  signed_up_at  BIGINT NOT NULL,
  attended_ms   BIGINT NOT NULL DEFAULT 0,
  present_since BIGINT,
  first_seen_at BIGINT,
  last_seen_at  BIGINT,
  universe_id   TEXT,
  place_id      TEXT,
  game_name     TEXT,
  shift_id      TEXT,
  PRIMARY KEY (event_id, discord_id)
);

-- Added when an admin panel gained the ability to correct somebody's banked time.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS adjustment_ms BIGINT NOT NULL DEFAULT 0;

-- Added when game nights started counting attendance outside the tracked games.
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS universe_id TEXT;
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS place_id TEXT;
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS game_name TEXT;

-- Holds the promotion ladder among other things, so a restart can answer a command
-- without going to Sheets or Roblox first.
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
`;

/** pg returns BIGINT as a string to protect precision; epoch milliseconds fit in a double. */
function num(value) {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toLink(row) {
  return {
    discordId: row.discord_id,
    robloxId: row.roblox_id,
    robloxUsername: row.roblox_username,
    robloxDisplayName: row.roblox_display_name,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: numOrNull(row.token_expires_at),
    linkedAt: num(row.linked_at),
    updatedAt: num(row.updated_at),
  };
}

function toShift(row) {
  return {
    id: row.id,
    discordId: row.discord_id,
    guildId: row.guild_id,
    robloxId: row.roblox_id,
    robloxUsername: row.roblox_username,
    type: row.type,
    status: row.status,
    source: row.source,
    startedAt: num(row.started_at),
    endedAt: numOrNull(row.ended_at),
    breakStartedAt: numOrNull(row.break_started_at),
    breakMs: num(row.break_ms),
    adjustmentMs: num(row.adjustment_ms),
    breakCount: num(row.break_count),
    universeId: row.universe_id,
    placeId: row.place_id,
    gameName: row.game_name,
    endReason: row.end_reason,
    logChannelId: row.log_channel_id,
    logMessageId: row.log_message_id,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toWatchState(row) {
  return {
    discordId: row.discord_id,
    sessionKey: row.session_key,
    universeId: row.universe_id,
    placeId: row.place_id,
    gameName: row.game_name,
    lastSeenInGameAt: numOrNull(row.last_seen_in_game_at),
    missingSince: numOrNull(row.missing_since),
    promptStatus: row.prompt_status,
    promptSentAt: numOrNull(row.prompt_sent_at),
    promptChannelId: row.prompt_channel_id,
    promptMessageId: row.prompt_message_id,
    updatedAt: num(row.updated_at),
  };
}

function toEvent(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    hostId: row.host_id,
    name: row.name,
    details: row.details,
    imageUrl: row.image_url,
    shiftType: row.shift_type,
    status: row.status,
    startsAt: num(row.starts_at),
    endsAt: numOrNull(row.ends_at),
    // jsonb comes back parsed, but a text column upgraded in place would not.
    roles: (typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles),
    channelId: row.channel_id,
    messageId: row.message_id,
    hostAwaySince: numOrNull(row.host_away_since),
    hostRemindedAt: numOrNull(row.host_reminded_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toSignup(row) {
  return {
    eventId: row.event_id,
    discordId: row.discord_id,
    roleKey: row.role_key,
    robloxId: row.roblox_id,
    signedUpAt: num(row.signed_up_at),
    attendedMs: num(row.attended_ms),
    presentSince: numOrNull(row.present_since),
    firstSeenAt: numOrNull(row.first_seen_at),
    lastSeenAt: numOrNull(row.last_seen_at),
    universeId: row.universe_id,
    placeId: row.place_id,
    gameName: row.game_name,
    shiftId: row.shift_id,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

class PostgresStore {
  pool;

  constructor(connectionString, ssl) {
    this.pool = new Pool({ connectionString, ssl, max: 5, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (error) => log.error(`Idle client error: ${error.message}`));
  }

  async init() {
    await this.pool.query(SCHEMA);
    log.info('Schema is ready');
  }

  async close() {
    await this.pool.end();
  }

  async getLinkByDiscordId(discordId) {
    const { rows } = await this.pool.query('SELECT * FROM roblox_links WHERE discord_id = $1', [discordId]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  async getLinkByRobloxId(robloxId) {
    const { rows } = await this.pool.query('SELECT * FROM roblox_links WHERE roblox_id = $1', [robloxId]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  async upsertLink(link) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // roblox_id is unique: drop any stale link from a different Discord account first.
      await client.query('DELETE FROM roblox_links WHERE roblox_id = $1 AND discord_id <> $2', [
        link.robloxId,
        link.discordId,
      ]);
      await client.query(
        `INSERT INTO roblox_links
           (discord_id, roblox_id, roblox_username, roblox_display_name, access_token, refresh_token,
            token_expires_at, linked_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (discord_id) DO UPDATE SET
           roblox_id = EXCLUDED.roblox_id,
           roblox_username = EXCLUDED.roblox_username,
           roblox_display_name = EXCLUDED.roblox_display_name,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at = EXCLUDED.updated_at`,
        [
          link.discordId,
          link.robloxId,
          link.robloxUsername,
          link.robloxDisplayName,
          link.accessToken,
          link.refreshToken,
          link.tokenExpiresAt,
          link.linkedAt,
          link.updatedAt,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteLink(discordId) {
    const { rows } = await this.pool.query('DELETE FROM roblox_links WHERE discord_id = $1 RETURNING *', [discordId]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  async listLinks() {
    const { rows } = await this.pool.query('SELECT * FROM roblox_links');
    return rows.map(toLink);
  }

  async createOAuthState(state) {
    await this.pool.query(
      `INSERT INTO oauth_states (state, discord_id, guild_id, code_verifier, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (state) DO NOTHING`,
      [state.state, state.discordId, state.guildId, state.codeVerifier, state.createdAt, state.expiresAt],
    );
  }

  async consumeOAuthState(state) {
    const { rows } = await this.pool.query('DELETE FROM oauth_states WHERE state = $1 RETURNING *', [state]);
    const row = rows[0];
    if (!row) return null;
    return {
      state: row.state,
      discordId: row.discord_id,
      guildId: row.guild_id,
      codeVerifier: row.code_verifier,
      createdAt: num(row.created_at),
      expiresAt: num(row.expires_at),
    };
  }

  async purgeExpiredOAuthStates(now) {
    await this.pool.query('DELETE FROM oauth_states WHERE expires_at <= $1', [now]);
  }

  async latestOAuthState(discordId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM oauth_states WHERE discord_id = $1 ORDER BY created_at DESC LIMIT 1',
      [discordId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      state: row.state,
      discordId: row.discord_id,
      guildId: row.guild_id,
      codeVerifier: row.code_verifier,
      createdAt: num(row.created_at),
      expiresAt: num(row.expires_at),
    };
  }

  async createShift(shift) {
    await this.pool.query(
      `INSERT INTO shifts
         (id, discord_id, guild_id, roblox_id, roblox_username, type, status, source, started_at, ended_at,
          break_started_at, break_ms, adjustment_ms, break_count, universe_id, place_id, game_name,
          end_reason, log_channel_id, log_message_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        shift.id,
        shift.discordId,
        shift.guildId,
        shift.robloxId,
        shift.robloxUsername,
        shift.type,
        shift.status,
        shift.source,
        shift.startedAt,
        shift.endedAt,
        shift.breakStartedAt,
        shift.breakMs,
        shift.adjustmentMs,
        shift.breakCount,
        shift.universeId,
        shift.placeId,
        shift.gameName,
        shift.endReason,
        shift.logChannelId,
        shift.logMessageId,
        shift.createdAt,
        shift.updatedAt,
      ],
    );
  }

  async updateShift(shift) {
    await this.pool.query(
      `UPDATE shifts SET
         guild_id = $2, roblox_id = $3, roblox_username = $4, type = $5, status = $6, source = $7,
         started_at = $8, ended_at = $9, break_started_at = $10, break_ms = $11, adjustment_ms = $12,
         break_count = $13, universe_id = $14, place_id = $15, game_name = $16, end_reason = $17,
         log_channel_id = $18, log_message_id = $19, updated_at = $20
       WHERE id = $1`,
      [
        shift.id,
        shift.guildId,
        shift.robloxId,
        shift.robloxUsername,
        shift.type,
        shift.status,
        shift.source,
        shift.startedAt,
        shift.endedAt,
        shift.breakStartedAt,
        shift.breakMs,
        shift.adjustmentMs,
        shift.breakCount,
        shift.universeId,
        shift.placeId,
        shift.gameName,
        shift.endReason,
        shift.logChannelId,
        shift.logMessageId,
        shift.updatedAt,
      ],
    );
  }

  async getShift(id) {
    const { rows } = await this.pool.query('SELECT * FROM shifts WHERE id = $1', [id]);
    return rows[0] ? toShift(rows[0]) : null;
  }

  async getOpenShift(discordId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM shifts WHERE discord_id = $1 AND status <> 'ended' ORDER BY started_at DESC LIMIT 1`,
      [discordId],
    );
    return rows[0] ? toShift(rows[0]) : null;
  }

  async listOpenShifts() {
    const { rows } = await this.pool.query(`SELECT * FROM shifts WHERE status <> 'ended' ORDER BY started_at ASC`);
    return rows.map(toShift);
  }

  async listShifts(discordId, query = {}) {
    const clauses = ['discord_id = $1'];
    const params = [discordId];

    if (!query.includeOpen) clauses.push(`status = 'ended'`);
    if (query.type) {
      params.push(query.type);
      clauses.push(`type = $${params.length}`);
    }
    if (query.since !== undefined) {
      params.push(query.since);
      clauses.push(`started_at >= $${params.length}`);
    }
    if (query.until !== undefined) {
      params.push(query.until);
      clauses.push(`started_at <= $${params.length}`);
    }

    let sql = `SELECT * FROM shifts WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC`;
    if (query.limit !== undefined) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map(toShift);
  }

  async getWatchState(discordId) {
    const { rows } = await this.pool.query('SELECT * FROM watch_states WHERE discord_id = $1', [discordId]);
    return rows[0] ? toWatchState(rows[0]) : null;
  }

  async upsertWatchState(state) {
    await this.pool.query(
      `INSERT INTO watch_states
         (discord_id, session_key, universe_id, place_id, game_name, last_seen_in_game_at, missing_since,
          prompt_status, prompt_sent_at, prompt_channel_id, prompt_message_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (discord_id) DO UPDATE SET
         session_key = EXCLUDED.session_key,
         universe_id = EXCLUDED.universe_id,
         place_id = EXCLUDED.place_id,
         game_name = EXCLUDED.game_name,
         last_seen_in_game_at = EXCLUDED.last_seen_in_game_at,
         missing_since = EXCLUDED.missing_since,
         prompt_status = EXCLUDED.prompt_status,
         prompt_sent_at = EXCLUDED.prompt_sent_at,
         prompt_channel_id = EXCLUDED.prompt_channel_id,
         prompt_message_id = EXCLUDED.prompt_message_id,
         updated_at = EXCLUDED.updated_at`,
      [
        state.discordId,
        state.sessionKey,
        state.universeId,
        state.placeId,
        state.gameName,
        state.lastSeenInGameAt,
        state.missingSince,
        state.promptStatus,
        state.promptSentAt,
        state.promptChannelId,
        state.promptMessageId,
        state.updatedAt,
      ],
    );
  }

  async deleteWatchState(discordId) {
    await this.pool.query('DELETE FROM watch_states WHERE discord_id = $1', [discordId]);
  }

  async createEvent(event) {
    await this.pool.query(
      `INSERT INTO events
         (id, guild_id, host_id, name, details, image_url, shift_type, status, starts_at, ends_at,
          roles, channel_id, message_id, host_away_since, host_reminded_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        event.id,
        event.guildId,
        event.hostId,
        event.name,
        event.details,
        event.imageUrl,
        event.shiftType,
        event.status,
        event.startsAt,
        event.endsAt,
        JSON.stringify(event.roles),
        event.channelId,
        event.messageId,
        event.hostAwaySince,
        event.hostRemindedAt,
        event.createdAt,
        event.updatedAt,
      ],
    );
  }

  async updateEvent(event) {
    await this.pool.query(
      `UPDATE events SET
         guild_id = $2, host_id = $3, name = $4, details = $5, image_url = $6, shift_type = $7,
         status = $8, starts_at = $9, ends_at = $10, roles = $11, channel_id = $12, message_id = $13,
         host_away_since = $14, host_reminded_at = $15, updated_at = $16
       WHERE id = $1`,
      [
        event.id,
        event.guildId,
        event.hostId,
        event.name,
        event.details,
        event.imageUrl,
        event.shiftType,
        event.status,
        event.startsAt,
        event.endsAt,
        JSON.stringify(event.roles),
        event.channelId,
        event.messageId,
        event.hostAwaySince,
        event.hostRemindedAt,
        event.updatedAt,
      ],
    );
  }

  async getEvent(id) {
    const { rows } = await this.pool.query('SELECT * FROM events WHERE id = $1', [id]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async listEvents(query = {}) {
    const clauses = [];
    const params = [];

    if (query.status && query.status.length > 0) {
      params.push(query.status);
      clauses.push(`status = ANY($${params.length})`);
    }
    if (query.guildId === null) {
      clauses.push('guild_id IS NULL');
    } else if (query.guildId !== undefined) {
      params.push(query.guildId);
      clauses.push(`guild_id = $${params.length}`);
    }
    if (query.hostId !== undefined) {
      params.push(query.hostId);
      clauses.push(`host_id = $${params.length}`);
    }

    let sql = 'SELECT * FROM events';
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY starts_at ASC';
    if (query.limit !== undefined) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map(toEvent);
  }

  async upsertSignup(signup) {
    await this.pool.query(
      `INSERT INTO event_signups
         (event_id, discord_id, role_key, roblox_id, signed_up_at, attended_ms, present_since,
          first_seen_at, last_seen_at, universe_id, place_id, game_name, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_id, discord_id) DO UPDATE SET
         role_key = EXCLUDED.role_key,
         roblox_id = EXCLUDED.roblox_id,
         attended_ms = EXCLUDED.attended_ms,
         present_since = EXCLUDED.present_since,
         first_seen_at = EXCLUDED.first_seen_at,
         last_seen_at = EXCLUDED.last_seen_at,
         universe_id = EXCLUDED.universe_id,
         place_id = EXCLUDED.place_id,
         game_name = EXCLUDED.game_name,
         shift_id = EXCLUDED.shift_id`,
      [
        signup.eventId,
        signup.discordId,
        signup.roleKey,
        signup.robloxId,
        signup.signedUpAt,
        signup.attendedMs,
        signup.presentSince,
        signup.firstSeenAt,
        signup.lastSeenAt,
        signup.universeId,
        signup.placeId,
        signup.gameName,
        signup.shiftId,
      ],
    );
  }

  async getSignup(eventId, discordId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM event_signups WHERE event_id = $1 AND discord_id = $2',
      [eventId, discordId],
    );
    return rows[0] ? toSignup(rows[0]) : null;
  }

  async listSignups(eventId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM event_signups WHERE event_id = $1 ORDER BY signed_up_at ASC',
      [eventId],
    );
    return rows.map(toSignup);
  }

  async getSetting(key) {
    const { rows } = await this.pool.query('SELECT value FROM bot_settings WHERE key = $1', [key]);
    const raw = rows[0]?.value;
    if (raw === undefined || raw === null) return null;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw);
  }

  async setSetting(key, value) {
    await this.pool.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), Date.now()],
    );
  }
}

module.exports = { PostgresStore };
