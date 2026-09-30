'use strict';
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../../src/aesu/db/jsonStore');

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'shift-tracker-test-'));
  const store = new JsonStore(join(dir, 'data.json'));
  await store.init();
  try {
    return await run(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeShift(overrides = {}) {
  const now = Date.now();
  return {
    id: randomUUID(),
    discordId: 'user-1',
    guildId: 'guild-1',
    robloxId: '12345',
    robloxUsername: 'tester',
    type: 'shift_guard',
    status: 'ended',
    source: 'panel',
    startedAt: now - 60_000,
    endedAt: now,
    breakStartedAt: null,
    breakMs: 0,
    adjustmentMs: 0,
    breakCount: 0,
    universeId: '111',
    placeId: '222',
    gameName: 'Test Game',
    endReason: 'manual',
    logChannelId: null,
    logMessageId: null,
    createdAt: now - 60_000,
    updatedAt: now,
    ...overrides,
  };
}

module.exports = { withStore, makeShift };
