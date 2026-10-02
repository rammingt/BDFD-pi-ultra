'use strict';
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const { setup } = require('./harness');

const ME = '100000000000000001';
const realFetch = globalThis.fetch;
let about = '';

// Pretend Bloxlink and Roblox: Bloxlink knows ME as 55, and "someone" is 77.
function stubFetch() {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('api.blox.link')) return url.endsWith(`/${ME}`) ? json({ robloxID: '55' }) : json({ error: 'nope' }, 404);
    if (url.includes('/v1/usernames/users')) {
      const name = JSON.parse(init.body).usernames[0].toLowerCase();
      const users = { me_on_roblox: { id: 55, name: 'me_on_roblox', displayName: 'Me' }, someone: { id: 77, name: 'someone', displayName: 'Someone' } };
      return json({ data: users[name] ? [users[name]] : [] });
    }
    if (url.includes('users.roblox.com/v1/users/55')) return json({ id: 55, name: 'me_on_roblox', displayName: 'Me', description: '' });
    if (url.includes('users.roblox.com/v1/users/77')) return json({ id: 77, name: 'someone', displayName: 'Someone', description: about });
    if (url.includes('thumbnails.roblox.com')) return json({ data: [{ imageUrl: 'https://tr.example/a.png' }] });
    throw new Error(`unexpected request to ${url}`);
  };
}

describe('linking without Roblox OAuth', () => {
  let h;
  before(async () => {
    h = await setup({ AESU_BLOXLINK_KEY: 'key', AESU_BLOXLINK_GUILD_ID: '200000000000000002' });
    stubFetch();
  });
  after(() => { globalThis.fetch = realFetch; });

  it('asks somebody Bloxlink knows to confirm the account', async () => {
    const r = await h.run('connect', { options: {} });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /### Me\n@me_on_roblox/);
    assert.match(h.text(r), /this u\?/);
    const yes = await h.run('aesu:link_yes');
    assert.equal(yes.stopped, false, yes.content);
    assert.match(h.text(yes), /linked to Me \(@me_on_roblox\)/);
    assert.equal((await h.store.getLinkByDiscordId(ME)).robloxId, '55');
  });

  it('makes a typed username prove itself with a code in the About', async () => {
    const other = '100000000000000009';
    let r = await h.run('connect', { userId: other, options: { username: 'someone' } });
    assert.equal(r.stopped, false, r.content);
    const code = /`(AESU [A-Z0-9]{5})`/.exec(h.text(r))[1];
    r = await h.run('aesu:link_yes', { userId: other });
    assert.equal(r.stopped, true);
    assert.match(r.content, /isnt in someone About yet/);
    assert.equal(await h.store.getLinkByDiscordId(other), null);

    about = `hello there ${code.toLowerCase()} :)`;
    r = await h.run('aesu:link_yes', { userId: other });
    assert.equal(r.stopped, false, r.content);
    assert.equal((await h.store.getLinkByDiscordId(other)).robloxId, '77');
  });

  it('says so when there is no such user, or nothing to go on', async () => {
    let r = await h.run('connect', { userId: '100000000000000010', options: { username: 'nobody_here' } });
    assert.match(r.content, /no roblox acc called nobody_here/);
    r = await h.run('connect', { userId: '100000000000000010', options: {} });
    assert.match(r.content, /bloxlink doesnt know ur roblox/);
  });
});
