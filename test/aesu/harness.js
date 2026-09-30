'use strict';
// Runs the commands in commands/aesu against a JSON store and a pretend Discord,
// so the .bdx side can be tested without a bot token.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function fakeUser(id) {
  return { id, username: `user${id.slice(-3)}`, globalName: `User ${id.slice(-3)}`, bot: false, createdTimestamp: 0, displayAvatarURL: () => `https://cdn.example/${id}.png` };
}

/** A Discord client that remembers what was sent and edited. */
function fakeClient() {
  const sent = [];
  const edits = [];
  const dms = [];
  let next = 1000;
  const channel = (id) => ({
    id,
    isSendable: () => true,
    send: async (payload) => { const m = { id: String(next++), channelId: id, payload }; sent.push(m); return m; },
    messages: { fetch: async (messageId) => ({ id: messageId, edit: async (payload) => { edits.push({ channelId: id, messageId, payload }); } }) },
  });
  return {
    sent, edits, dms,
    user: fakeUser('999000000000000999'),
    isReady: () => true,
    users: { fetch: async (id) => ({ ...fakeUser(id), send: async (payload) => { dms.push({ userId: id, payload }); } }) },
    channels: { fetch: async (id) => channel(id) },
    guilds: { cache: new Map(), fetch: async () => null },
  };
}

async function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aesu-bdx-'));
  Object.assign(process.env, {
    AESU_ENABLED: 'yes', AESU_DATA_FILE: path.join(dir, 'data.json'), LOG_LEVEL: 'error',
    SHIFT_LOG_CHANNEL_ID: '700000000000000007', SHIFT_PROMPT_CHANNEL_ID: '700000000000000008', EVENT_CHANNEL_ID: '700000000000000009',
    SHIFT_ROLE_ON_DUTY: '', SHIFT_ROLE_ON_BREAK: '', SHIFT_ROLE_OFF_DUTY: '',
  }, env);
  const { Engine } = require(path.join(ROOT, 'src/engine'));
  const { runtime } = require(path.join(ROOT, 'src/aesu'));
  const { JsonStore } = require(path.join(ROOT, 'src/aesu/db/jsonStore'));
  const { ShiftManager } = require(path.join(ROOT, 'src/aesu/shifts/manager'));
  const { EventManager } = require(path.join(ROOT, 'src/aesu/events/manager'));
  const { RankManager } = require(path.join(ROOT, 'src/aesu/ranks/manager'));
  const { registerShiftLogging } = require(path.join(ROOT, 'src/aesu/discord/shiftLog'));
  const { registerEventPosts } = require(path.join(ROOT, 'src/aesu/discord/eventLog'));
  const ui = require(path.join(ROOT, 'src/aesu/ui'));

  const engine = new Engine({ commandsDir: path.join(ROOT, 'commands'), dataFile: null });
  const client = fakeClient();
  const store = new JsonStore(path.join(dir, 'data.json'));
  await store.init();
  const manager = new ShiftManager(store);
  const events = new EventManager(store, manager);
  const ranks = new RankManager(store, manager, events);
  await ranks.init();
  Object.assign(runtime, { started: true, startedAt: Date.now(), store, manager, events, ranks, sheets: null, applications: null, client });
  ui.attach(engine, client);
  registerShiftLogging(manager);
  registerEventPosts(events);

  /** Runs a command by name as `userId`, with slash options or button arguments. */
  async function run(name, { userId = '100000000000000001', options = null, args = [], selectValues = [], inputs = {}, messageId = '', roles = [], admin = false, channelId = '300000000000000003' } = {}) {
    const cmd = engine.commands.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cmd) throw new Error(`no command ${name}`);
    const member = { roles: { cache: new Map(roles.map((r) => [r, true])) }, permissions: { has: (p) => admin && p === 'Administrator' } };
    const u = fakeUser(userId);
    const r = await engine.execute(cmd, {
      author: { id: u.id, username: u.username, displayName: u.globalName, avatar: u.displayAvatarURL(), bot: false },
      guild: { id: '200000000000000002', name: 'Test', memberCount: 3 },
      channel: { id: channelId, name: 'general' },
      discord: { client, member, guild: null, channel: null },
      options, args: options ? Object.values(options) : args, selectValues, inputs, messageId,
      users: new Map([[u.id, { ...u, displayName: u.globalName, avatar: u.displayAvatarURL() }]]),
    });
    return r;
  }

  /** Every text block in a result, joined, for easy asserting. */
  function text(r) {
    const out = [r.content];
    const walk = (list) => (list || []).forEach((c) => { if (c.type === 10) out.push(c.content); walk(c.components); });
    walk(r.layout);
    return out.join('\n');
  }
  function buttons(r) {
    const out = [];
    const walk = (list) => (list || []).forEach((c) => { if (c.type === 2 || c.type === 3) out.push(c); walk(c.components); });
    walk(r.layout); walk(r.components);
    return out;
  }

  return { engine, client, store, manager, events, ranks, runtime, run, text, buttons, dir };
}

module.exports = { setup, fakeClient };
