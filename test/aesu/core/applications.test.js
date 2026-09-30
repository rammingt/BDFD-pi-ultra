'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.APPLICATION_CHANNEL_ID = 'app-channel';
process.env.APPLICATION_SHEET_ID = 'sheet-1';
process.env.LOG_LEVEL = 'error';

// The card, the list and the buttons are commands/aesu/applications.bdx now, and are
// tested through it in test/aesu/applications.bdx.test.js.
const {
  applicantDiscordId,
  applicantUsername,
  applicationArgs,
  applicationView,
  isApplicationsConfigured,
  parseApplications,
} = require('../../../src/aesu/sheets/applications');

const FORM = [
  ['Timestamp', 'Roblox username', 'Discord', 'Why do you want to join?', 'Timezone', 'Optional extras'],
  ['2026-09-17 14:32:01', 'aesu_tester', '<@123456789012345678>', 'I like guarding the dam.', 'Asia/Seoul', ''],
  ['2026-09-17 15:02:44', 'other_person', '987654321098765432', 'Friends play here.', 'UTC', 'I stream.'],
];

describe('parseApplications', () => {
  it('pairs each answer with its question and skips blanks', () => {
    const [first, second] = parseApplications(FORM);

    assert.equal(parseApplications(FORM).length, 2);
    assert.equal(first?.rowIndex, 1);
    assert.equal(first?.submittedAt?.toISOString().slice(0, 10), '2026-09-17');
    assert.deepEqual(
      first?.answers.map((a) => a.question),
      ['Timestamp', 'Roblox username', 'Discord', 'Why do you want to join?', 'Timezone'],
      'the unanswered optional question is left out',
    );
    assert.equal(second?.answers.at(-1)?.answer, 'I stream.');
  });

  it('copes with a sheet that has only a header, or nothing at all', () => {
    assert.deepEqual(parseApplications([FORM[0]]), []);
    assert.deepEqual(parseApplications([]), []);
  });

  it('keeps a row whose timestamp cannot be read', () => {
    const [only] = parseApplications([FORM[0], ['not a date', 'someone', '', 'Because.', '', '']]);
    assert.equal(only?.submittedAt, null);
    assert.equal(only?.answers.length, 3, 'timestamp, username and the reason');
  });
});

describe('applicationView', () => {
  it('titles the card with the Roblox name and pings the applicant', () => {
    const [first] = parseApplications(FORM);
    const view = applicationView(first);

    assert.equal(view.title, 'aesu_tester');
    assert.equal(view.lead, '<@123456789012345678>', 'a pasted mention becomes a real ping');
    assert.equal(view.row, 1);
    assert.ok(view.answers.some((a) => a.question === 'Why do you want to join?'));
    assert.ok(!view.answers.some((a) => a.question === 'Timestamp'), 'the timestamp is shown on its own');
  });

  it('turns a bare id into a ping too', () => {
    const [, second] = parseApplications(FORM);
    assert.equal(applicationView(second).lead, '<@987654321098765432>');
  });

  it('keeps a huge form to 23 answers and says how many more there are', () => {
    const header = ['Timestamp', ...Array.from({ length: 40 }, (_, i) => `Question ${i}`)];
    const row = ['2026-09-17 10:00:00', ...Array.from({ length: 40 }, (_, i) => `Answer ${i}`)];
    const [big] = parseApplications([header, row]);
    const view = applicationView(big);

    assert.equal(view.answers.length, 23);
    assert.equal(view.hiddenCount, 17);
  });

  it('truncates an essay rather than being rejected for it', () => {
    const [long] = parseApplications([
      ['Timestamp', 'Essay'],
      ['2026-09-17 10:00:00', 'x'.repeat(3000)],
    ]);
    const value = applicationView(long).answers[0].answer;
    assert.ok(value.length <= 1024, `${value.length} characters`);
    assert.ok(value.endsWith('…'));
  });
});

describe('isApplicationsConfigured', () => {
  it('is on once a channel and a sheet are set', () => {
    assert.equal(isApplicationsConfigured(), true);
  });
});

describe('reading the applicant out of the answers', () => {
  it('takes an answer that is only a username', () => {
    const [first] = parseApplications(FORM);
    assert.equal(applicantUsername(first), 'aesu_tester');
    assert.equal(applicantDiscordId(first), '123456789012345678');
  });

  it('refuses a sentence, rather than guessing at a name in it', () => {
    const [vague] = parseApplications([
      ['Timestamp', 'Roblox username'],
      ['2026-09-17 10:00:00', 'my main is aesu_tester but I also play on alts'],
    ]);
    assert.equal(applicantUsername(vague), null, 'accepting the wrong person is worse than asking');
  });

  it('strips a leading @', () => {
    const [at] = parseApplications([
      ['Timestamp', 'Roblox username'],
      ['2026-09-17 10:00:00', '@aesu_tester'],
    ]);
    assert.equal(applicantUsername(at), 'aesu_tester');
  });
});

describe('applicationArgs', () => {
  it('carries everything the buttons need', () => {
    const [first] = parseApplications(FORM);
    assert.deepEqual(applicationArgs(first), ['1', 'aesu_tester', '123456789012345678']);
  });

  it('uses a placeholder when there is nothing to read, and stays inside 100 characters', () => {
    const [blank] = parseApplications([
      ['Timestamp', 'Why do you want to join?'],
      ['2026-09-17 10:00:00', 'Because I do.'],
    ]);
    const args = applicationArgs(blank);
    assert.deepEqual(args, ['1', '-', '-']);
    assert.ok(`aesu:app_accept:${args.join(':')}`.length <= 100);
  });
});
