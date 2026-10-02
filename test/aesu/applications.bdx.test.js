'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

const STAFF = '100000000000000001';
const header = ['Timestamp', 'Roblox username', 'Discord', 'Why do you want to join?'];
const rows = Array.from({ length: 23 }, (_, i) => [`2026-09-17 10:${String(i).padStart(2, '0')}:00`, `applicant_${i + 1}`, i === 0 ? '<@123456789012345678>' : '', i === 0 ? 'I like dams.' : 'Because.']);

describe('application commands in BDX', () => {
  let h;
  before(async () => {
    h = await setup({ APPLICATION_CHANNEL_ID: '700000000000000011', APPLICATION_SHEET_ID: 'sheet', GROUP_STAFF_ROLE_ID: '333', APPLICATION_FORM_URL: 'https://forms.example/apply' });
    const { ApplicationWatcher } = require('../../src/aesu/sheets/applications');
    h.runtime.applications = new ApplicationWatcher({ read: async () => [header, ...rows] }, h.store);
    await h.runtime.applications.setCursor(20);
  });

  it('keeps applications to the group staff role', async () => {
    const r = await h.run('applications', { options: { action: 'list' } });
    assert.equal(r.content, 'Only <@&333> can read applications.');
  });

  it('lists the newest first, a page at a time, marking the unposted ones', async () => {
    const r = await h.run('applications', { options: { action: 'list' }, roles: ['333'] });
    assert.equal(r.stopped, false, r.content);
    const lines = h.text(r).split('\n').filter((line) => line.startsWith('`#'));
    assert.equal(lines.length, 10);
    assert.match(lines[0], /^`#23` \*\*applicant_23\*\*.*never posted/);
    assert.ok(!/never posted/.test(lines[3]), '#20 was the last one posted');
    assert.match(h.text(r), /1 to 10 of 23 · page 1\/3/);
    const [prev, next] = h.buttons(r);
    assert.equal(prev.disabled, true);
    assert.equal(next.custom_id, 'aesu:app_page:1:');
  });

  it('turns pages in place and keeps the search, colons and all', async () => {
    let r = await h.run('aesu:app_page', { args: ['1', ''], roles: ['333'] });
    assert.equal(r.update, true);
    assert.match(h.text(r), /11 to 20 of 23 · page 2\/3/);
    r = await h.run('aesu:app_page', { args: ['0', 'dams'], roles: ['333'] });
    assert.match(h.text(r), /Applications matching "dams"/);
    assert.match(h.text(r), /`#1` \*\*applicant_1\*\* <@123456789012345678>/);
    r = await h.run('aesu:app_page', { args: ['0', 'no', 'such'], roles: ['333'] });
    assert.match(h.text(r), /matching "no:such"/);
    assert.match(h.text(r), /Nothing matches that/);
  });

  it('posts a card with the buttons carrying who it is', async () => {
    const r = await h.run('applications', { options: { action: 'post', number: '1' }, roles: ['333'] });
    assert.equal(r.stopped, false, r.content);
    assert.equal(r.content, 'Posted 1 application(s) to <#700000000000000011>: **applicant_1**');
    const card = h.client.sent.at(-1);
    h.card = card;
    assert.match(h.text({ layout: card.payload.components }), /### applicant_1\n<@123456789012345678>/);
    assert.match(h.text({ layout: card.payload.components }), /\*\*Why do you want to join\?\*\*\nI like dams\./);
    const ids = h.buttons({ layout: card.payload.components }).map((b) => b.custom_id);
    assert.deepEqual(ids, ['aesu:app_accept:1:applicant_1:123456789012345678', 'aesu:app_deny:1:applicant_1:123456789012345678', 'aesu:app_check:1:applicant_1:123456789012345678']);
  });

  it('asks for a reason, then decides, tells the applicant and redraws the card', async () => {
    const args = ['1', 'applicant_1', '123456789012345678'];
    let r = await h.run('aesu:app_deny', { type: 'button', args, roles: ['333'], messageId: h.card.id, channelId: h.card.channelId });
    assert.equal(r.stopped, false, r.content);
    assert.equal(r.modal.custom_id, 'aesu:app_deny:1:applicant_1:123456789012345678');
    assert.equal(r.modal.components[0].components[0].required, true);

    r = await h.run('aesu:app_deny', { type: 'modal', args, roles: ['333'], messageId: h.card.id, channelId: h.card.channelId, inputs: { reason: 'Too young.' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /^Application denied\. Group management is off, so only the card was updated\. They have been told by DM\.$/);
    const dm = h.client.dms.at(-1);
    assert.equal(dm.userId, '123456789012345678');
    assert.match(h.text({ layout: dm.payload.components }), /not accepted[\s\S]*Too young\.\n\*\*Applying again\*\*\nhttps:\/\/forms\.example\/apply/);
    const redrawn = h.client.edits.at(-1);
    assert.match(h.text({ layout: redrawn.payload.components }), /\*\*Denied\*\* by <@100000000000000001>\nToo young\./);
    assert.equal(h.buttons({ layout: redrawn.payload.components }).length, 0);

    r = await h.run('aesu:app_accept', { type: 'button', args, roles: ['333'], messageId: h.card.id, channelId: h.card.channelId });
    assert.equal(r.content, 'That application has already been decided.');
    assert.equal(r.modal, null);
  });
});
