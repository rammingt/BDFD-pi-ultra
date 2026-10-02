'use strict';
const assert = require('node:assert/strict');

const { after, before, describe, it } = require('node:test');

const { createWebServer } = require('../../../src/aesu/web/server');
const { JsonStore } = require('../../../src/aesu/db/jsonStore');
const { ShiftManager } = require('../../../src/aesu/shifts/manager');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/** Only isReady() and users.fetch() are exercised by the server. */
const stubClient = {
  isReady: () => true,
  users: { fetch: async () => ({ send: async () => undefined }) },
  // Linking hands the member their off-duty role, so the guild has to be reachable.
  guilds: { fetch: async () => { throw new Error('no guild in this test'); }, cache: new Map() },
};

const realFetch = globalThis.fetch;

/** Stands in for Roblox's token and userinfo endpoints. */
function stubRobloxApi() {
  globalThis.fetch = (async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/oauth/v1/token')) {
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/oauth/v1/userinfo')) {
      return new Response(JSON.stringify({ sub: '4242', preferred_username: 'aesu_tester', nickname: 'Aesu Tester' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${url}`);
  });
}

describe('web server', () => {
  let store;
  let dir;
  let origin;
  let close;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shift-tracker-web-'));
    store = new JsonStore(join(dir, 'data.json'));
    await store.init();

    const server = createWebServer({
      store,
      client: stubClient,
      manager: new ShiftManager(store),
      startedAt: Date.now(),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address()).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports health as JSON', async () => {
    const response = await realFetch(`${origin}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json());
    assert.equal(body.status, 'ok');
    assert.equal(body.discordReady, true);
    assert.equal(body.linkedAccounts, 0);
    assert.equal(body.openShifts, 0);
  });

  it('serves a landing page and a 404 for anything else', async () => {
    assert.equal((await realFetch(`${origin}/`)).status, 200);
    assert.equal((await realFetch(`${origin}/nope`)).status, 404);
  });

  it('rejects non-GET requests', async () => {
    assert.equal((await realFetch(`${origin}/oauth/callback`, { method: 'POST' })).status, 405);
  });

  it('rejects a callback with no code or state', async () => {
    assert.equal((await realFetch(`${origin}/oauth/callback`)).status, 400);
  });

  it('surfaces an error Roblox sends back', async () => {
    const response = await realFetch(`${origin}/oauth/callback?error=access_denied&error_description=User+said+no`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /User said no/);
  });

  it('escapes the error text it echoes back', async () => {
    const response = await realFetch(`${origin}/oauth/callback?error=${encodeURIComponent('<script>alert(1)</script>')}`);
    const html = await response.text();
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it('rejects a state it never issued', async () => {
    const response = await realFetch(`${origin}/oauth/callback?code=abc&state=made-up`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /already used or isnt from this bot/);
  });

  it('rejects an expired state and does not link anything', async () => {
    await store.createOAuthState({
      state: 'expired',
      discordId: 'u-expired',
      guildId: null,
      codeVerifier: 'verifier',
      createdAt: Date.now() - 900_000,
      expiresAt: Date.now() - 1_000,
    });

    const response = await realFetch(`${origin}/oauth/callback?code=abc&state=expired`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /expired/);
    assert.equal(await store.getLinkByDiscordId('u-expired'), null);
  });

  it('links the account on a valid callback and consumes the state', async () => {
    stubRobloxApi();
    await store.createOAuthState({
      state: 'good-state',
      discordId: 'u-good',
      guildId: 'g1',
      codeVerifier: 'verifier',
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    });

    const response = await realFetch(`${origin}/oauth/callback?code=abc&state=good-state`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Aesu Tester/);

    const link = await store.getLinkByDiscordId('u-good');
    assert.equal(link?.robloxId, '4242');
    assert.equal(link?.robloxUsername, 'aesu_tester');
    assert.equal(link?.refreshToken, 'refresh');
    assert.ok((link?.tokenExpiresAt ?? 0) > Date.now());

    // The same link must not work twice.
    assert.equal((await realFetch(`${origin}/oauth/callback?code=abc&state=good-state`)).status, 400);
  });
});
