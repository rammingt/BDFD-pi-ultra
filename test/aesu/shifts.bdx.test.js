'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

describe('shift commands in BDX', () => {
  let h;
  before(async () => { h = await setup(); });

  it('shows the picker when nobody is on shift', async () => {
    const r = await h.run('shift', { options: { action: 'manage' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /pick ur shift type below/);
    const start = h.buttons(r).find((b) => b.custom_id?.startsWith('aesu:panel_start'));
    assert.equal(start.disabled, true);
    const menu = h.buttons(r).find((b) => b.type === 3);
    assert.equal(menu.options.length, 4);
  });

  it('arms Start once a type is picked', async () => {
    const r = await h.run('aesu:panel_type', { selectValues: ['shift_guard'] });
    assert.equal(r.update, true);
    assert.match(h.text(r), /picked Shift Guard/);
    const start = h.buttons(r).find((b) => b.custom_id?.startsWith('aesu:panel_start'));
    assert.equal(start.custom_id, 'aesu:panel_start:shift_guard');
    assert.equal(start.disabled, false);
    assert.equal(h.buttons(r).find((b) => b.type === 3).options.find((o) => o.value === 'shift_guard').default, true);
  });

  it('starts, breaks, resumes and ends a shift, logging each step', async () => {
    let r = await h.run('aesu:panel_start', { args: ['shift_guard'] });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Shift Guard\non shift/);
    assert.equal(h.client.sent.length, 1, 'one log entry posted');
    assert.match(h.text({ content: '', layout: h.client.sent[0].payload.components }), /<@100000000000000001> · on shift/);

    r = await h.run('aesu:panel_start', { args: ['shift_guard'] });
    assert.equal(r.stopped, true);
    assert.match(r.content, /already got a shift running/);

    r = await h.run('aesu:panel_break');
    assert.match(h.text(r), /on break/);
    assert.ok(h.buttons(r).some((b) => b.custom_id === 'aesu:panel_resume'));
    r = await h.run('aesu:panel_resume');
    assert.ok(h.buttons(r).some((b) => b.custom_id === 'aesu:panel_break'));

    r = await h.run('aesu:panel_end');
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /shift done, \d+s banked on ur Shift Guard, 0s on break/);
    assert.equal(h.client.sent.length, 1, 'the log entry is edited, not posted again');
    assert.ok(h.client.edits.length >= 3);
    assert.match(h.text({ content: '', layout: h.client.edits.at(-1).payload.components }), /ended cuz: ended from the panel/);
  });

  it('refuses a break with nothing running', async () => {
    const r = await h.run('aesu:panel_break');
    assert.equal(r.stopped, true);
    assert.equal(r.content, 'u got no shift running');
  });

  it('lists history and totals', async () => {
    let r = await h.run('shift', { options: { action: 'history' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /\d+s · Shift Guard/);
    r = await h.run('checktime', { options: { range: 'week' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /shifts: 1/);
    assert.match(h.text(r), /· last 7 days/);
    assert.equal(r.ephemeral, true);
  });

  it('keeps other members totals to staff when a staff role is set', async () => {
    const { config } = require('../../src/aesu/config/index');
    config.discord.staffRoleId = '555';
    try {
      let r = await h.run('checktime', { options: { user: '100000000000000077' } });
      assert.equal(r.stopped, true);
      assert.match(r.content, /cant check other ppl time/);
      r = await h.run('checktime', { options: { user: '100000000000000077' }, roles: ['555'] });
      assert.equal(r.stopped, false, r.content);
    } finally {
      config.discord.staffRoleId = '';
    }
  });

  it('answers join prompts only for their owner', async () => {
    let r = await h.run('aesu:prompt_accept', { args: ['100000000000000055'] });
    assert.equal(r.content, 'not ur prompt');
    r = await h.run('aesu:prompt_accept', { args: ['100000000000000001'], messageId: '42' });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /pick what ur running/);
    assert.match(h.text({ content: '', layout: h.client.edits.at(-1).payload.components }), /logging it/);
    r = await h.run('aesu:prompt_decline', { args: ['100000000000000001'], messageId: '43' });
    assert.equal(r.content, 'ok nothing logged, `/shift action:manage` if u change ur mind');
  });

  it('asks for a username when Bloxlink has nothing', async () => {
    const r = await h.run('connect', { options: {} });
    assert.equal(r.stopped, true);
    assert.match(r.content, /do \/connect again with ur username/);
    const d = await h.run('disconnect', { options: {} });
    assert.equal(d.content, 'u got no roblox linked');
  });
});
