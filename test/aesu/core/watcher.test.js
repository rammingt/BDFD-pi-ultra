'use strict';
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

// The watcher reads config at import time, so the environment has to be set first.
process.env.AESU_ENABLED = 'yes';
process.env.ROBLOX_COOKIE = 'test-cookie';
process.env.TRACKED_UNIVERSE_IDS = '111';
process.env.SHIFT_PROMPT_CHANNEL_ID = 'prompt-channel';
process.env.LEAVE_GRACE_SECONDS = '0';
process.env.LOG_LEVEL = 'error';

const { JsonStore } = require('../../../src/aesu/db/jsonStore');
const { ShiftManager } = require('../../../src/aesu/shifts/manager');
const { PresenceWatcher } = require('../../../src/aesu/watcher/presenceWatcher');

const sent = [];

function stubChannel(id) {
  return {
    id,
    isSendable: () => true,
    send: async (payload) => {
      const message = { id: `msg-${sent.length + 1}`, payload, edits: [] };
      sent.push(message);
      return { id: message.id, channelId: id, edit: async (edit) => void message.edits.push(edit) };
    },
    messages: {
      fetch: async (messageId) => {
        const message = sent.find((candidate) => candidate.id === messageId);
        if (!message) throw new Error('unknown message');
        return { id: message.id, edit: async (edit) => void message.edits.push(edit) };
      },
    },
  };
}

const stubClient = {
  channels: { fetch: async (id) => stubChannel(id) },
  users: { fetch: async (id) => ({ id, username: id, displayAvatarURL: () => '', send: async () => undefined }) },
  guilds: { cache: new Map() },
  user: { id: 'bot', username: 'bot', displayAvatarURL: () => '' },
};

// The prompts are drawn by the hooks in commands/aesu, the same as on the real bot.
const { Engine } = require('../../../src/engine');
require('../../../src/aesu/ui').attach(new Engine({ commandsDir: join(__dirname, '..', '..', '..', 'commands'), dataFile: null }), stubClient);

/** All the text a message payload shows, in the new layout or the old. */
const textOf = (payload) => {
  const out = [];
  const walk = (list) => (list || []).forEach((c) => { if (c.type === 10) out.push(c.content); walk(c.components); });
  walk(payload?.components);
  return out.join('\n');
};

/** What the next presence poll will report, keyed by Roblox user id. */
let presenceByUser = {};
const realFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('presence.roblox.com')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const userPresences = body.userIds
        .map((userId) => {
          const presence = presenceByUser[String(userId)];
          return presence ? { userId, rootPlaceId: null, gameId: null, lastLocation: null, ...presence } : null;
        })
        .filter(Boolean);
      return new Response(JSON.stringify({ userPresences }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('games.roblox.com')) {
      return new Response(JSON.stringify({ data: [{ id: 111, name: 'Aesu HQ', rootPlaceId: 222 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected request to ${url}`);
  });
}

const IN_TRACKED_GAME = {
  userPresenceType: 2,
  universeId: 111,
  placeId: 222,
  gameId: 'server-a',
  lastLocation: 'Aesu HQ',
};
const OFFLINE = { userPresenceType: 0, universeId: null, placeId: null };
const IN_UNTRACKED_GAME = {
  userPresenceType: 2,
  universeId: 999,
  placeId: 888,
  gameId: 'server-z',
  lastLocation: 'Random Obby',
};

describe('PresenceWatcher', () => {
  let dir;
  let store;
  let manager;
  let watcher;

  beforeEach(async () => {
    installFetchStub();
    sent.length = 0;
    presenceByUser = {};

    dir = await mkdtemp(join(tmpdir(), 'shift-tracker-watch-'));
    store = new JsonStore(join(dir, 'data.json'));
    await store.init();
    manager = new ShiftManager(store);
    watcher = new PresenceWatcher(stubClient, store, manager);

    const now = Date.now();
    await store.upsertLink({
      discordId: 'discord-1',
      robloxId: '777',
      robloxUsername: 'tester',
      robloxDisplayName: 'Tester',
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      linkedAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('prompts once when a member joins a tracked game', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();

    assert.equal(sent.length, 1);
    assert.match(textOf(sent[0]?.payload), /^<@discord-1>\n/);
    assert.deepEqual(sent[0]?.payload.allowedMentions, { users: ['discord-1'], roles: [] });

    const state = await store.getWatchState('discord-1');
    assert.ok(state?.sessionKey, 'a session is opened');
    assert.equal(state?.promptStatus, 'sent');
    assert.equal(state?.gameName, 'Aesu HQ');
    assert.equal(state?.universeId, '111');

    // Still in game on the next poll - must not ping again.
    await watcher.tick();
    assert.equal(sent.length, 1);
  });

  it('ignores a member playing an untracked game', async () => {
    presenceByUser['777'] = { userPresenceType: 2, universeId: 999, placeId: 888 };
    await watcher.tick();

    assert.equal(sent.length, 0);
    assert.equal(await store.getWatchState('discord-1'), null);
  });

  it('matches a tracked game by its root place id', async () => {
    process.env.TRACKED_PLACE_IDS = '';
    presenceByUser['777'] = { userPresenceType: 2, universeId: 111, placeId: 555, rootPlaceId: 222 };
    await watcher.tick();
    assert.equal(sent.length, 1, 'the universe id still matches');
  });

  it('does not prompt somebody who is already on shift, and backfills the game', async () => {
    const shift = await manager.start({ discordId: 'discord-1', guildId: null, type: 'shift_guard', source: 'panel' });
    assert.equal(shift.gameName, null);

    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();

    assert.equal(sent.length, 0, 'no prompt while a shift is running');
    assert.equal((await store.getWatchState('discord-1'))?.promptStatus, 'accepted');

    const open = await manager.getOpenShift('discord-1');
    assert.equal(open?.gameName, 'Aesu HQ');
    assert.equal(open?.placeId, '222');
  });

  it('ends the shift once the member has left, backdated to when they were last seen', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    await manager.start({ discordId: 'discord-1', guildId: null, type: 'deployment', source: 'prompt' });

    await watcher.tick();
    const lastSeen = (await store.getWatchState('discord-1'))?.lastSeenInGameAt;
    assert.ok(lastSeen);

    // First poll after leaving only opens the grace window.
    presenceByUser['777'] = OFFLINE;
    await watcher.tick();
    assert.ok(await manager.getOpenShift('discord-1'), 'still open during the grace window');
    assert.ok((await store.getWatchState('discord-1'))?.missingSince);

    // Second poll is past the (zero second) grace window.
    await watcher.tick();
    const open = await manager.getOpenShift('discord-1');
    assert.equal(open, null, 'the shift was closed automatically');

    const [ended] = await manager.listShifts('discord-1');
    assert.equal(ended?.endReason, 'left_game');
    assert.equal(ended?.endedAt, lastSeen, 'the grace window is not counted as worked time');

    const state = await store.getWatchState('discord-1');
    assert.equal(state?.sessionKey, null, 'the session is reset for the next join');
    assert.equal(state?.promptStatus, 'none');
  });

  it('expires the pending prompt when the member leaves without answering', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    assert.equal(sent[0]?.edits.length, 0);

    presenceByUser['777'] = OFFLINE;
    await watcher.tick();
    await watcher.tick();

    assert.equal(sent[0]?.edits.length, 1, 'the prompt is collapsed');
    assert.match(textOf(sent[0]?.edits[0]), /not logged/);
  });

  it('prompts again when the member rejoins later', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    presenceByUser['777'] = OFFLINE;
    await watcher.tick();
    await watcher.tick();

    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    assert.equal(sent.length, 2);
  });

  it('keeps a game night running in whatever game they are playing', async () => {
    await manager.start({ discordId: 'discord-1', guildId: null, type: 'game_night', source: 'panel' });

    presenceByUser['777'] = IN_UNTRACKED_GAME;
    await watcher.tick();

    const open = await manager.getOpenShift('discord-1');
    assert.ok(open, 'an untracked game does not end a game night');
    assert.equal(open?.gameName, 'Random Obby', 'the shift names the game they are actually in');
    assert.equal(open?.placeId, '888');
    assert.equal(sent.length, 0, 'an untracked game never triggers a prompt');

    // Leaving games altogether still closes it rather than running to the cap.
    presenceByUser['777'] = OFFLINE;
    await watcher.tick();
    await watcher.tick();
    assert.equal(await manager.getOpenShift('discord-1'), null);
    assert.equal((await manager.listShifts('discord-1'))[0]?.endReason, 'left_game');
  });

  it('still ends an ordinary shift when the member wanders into another game', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    await manager.start({ discordId: 'discord-1', guildId: null, type: 'shift_guard', source: 'prompt' });

    presenceByUser['777'] = IN_UNTRACKED_GAME;
    await watcher.tick();
    await watcher.tick();

    assert.equal(await manager.getOpenShift('discord-1'), null, 'only any-game types follow them out');
  });

  it('never ends a shift because presence data was missing', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    await manager.start({ discordId: 'discord-1', guildId: null, type: 'solo_shift', source: 'prompt' });

    // Roblox omits the member entirely - unknown, not offline.
    presenceByUser = {};
    await watcher.tick();
    await watcher.tick();

    assert.ok(await manager.getOpenShift('discord-1'), 'the shift survives missing presence data');
    assert.equal((await store.getWatchState('discord-1'))?.missingSince, null);
  });

  it('survives a presence API outage without touching any shift', async () => {
    presenceByUser['777'] = IN_TRACKED_GAME;
    await watcher.tick();
    await manager.start({ discordId: 'discord-1', guildId: null, type: 'game_night', source: 'prompt' });

    globalThis.fetch = (async () => new Response('down', { status: 500 }));
    await watcher.tick();

    assert.ok(await manager.getOpenShift('discord-1'));
  });
});
