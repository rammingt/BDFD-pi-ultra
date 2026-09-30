'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// Config is read at import time, so the environment has to be set first.
process.env.SHIFT_TYPES = 'Shift Guard, Game Night, Deployment';
process.env.LOG_LEVEL = 'error';

const {
  describeRequirement,
  findRank,
  formatRequirements,
  measureRank,
  nextRank,
  parseDuration,
  parseMode,
  parseRequirement,
  parseRequirements,
  effectiveMode,
  formatGeneral,
  parseGeneral,
  RankError,
} = require('../../../src/aesu/ranks/types');
// The promotion card itself is commands/aesu/promotions.bdx now, tested in test/aesu.
const { progressBar } = require('../../../src/aesu/views');
const { applyEdits, parseRankGrid, rankGridFor } = require('../../../src/aesu/sheets/sync');

function makeRank(overrides = {}) {
  return {
    roleId: 10,
    rank: 50,
    name: 'Guard',
    requirements: [],
    general: [],
    mode: 'manual',
    notes: null,
    memberCount: null,
    ...overrides,
  };
}

describe('parseDuration', () => {
  it('reads the ways people write a length of time', () => {
    assert.equal(parseDuration('90m'), 90);
    assert.equal(parseDuration('2h'), 120);
    assert.equal(parseDuration('1h30m'), 90);
    assert.equal(parseDuration('1h 30m'), 90);
    assert.equal(parseDuration('1.5h'), 90);
    assert.equal(parseDuration('2 hours'), 120);
    assert.equal(parseDuration('45 minutes'), 45);
    assert.equal(parseDuration('90'), 90, 'a bare number is minutes');
  });

  it('is zero when there is no time in it at all', () => {
    assert.equal(parseDuration('shift guard'), 0);
    assert.equal(parseDuration(''), 0);
  });
});

describe('parseRequirement', () => {
  it('does not care which way round the type and the time are written', () => {
    const a = parseRequirement('shift_guard 90m');
    const b = parseRequirement('90m shift guard');

    assert.deepEqual(a, b);
    assert.equal(a.kind, 'time');
    assert.equal(a.kind === 'time' && a.shiftType, 'shift_guard');
    assert.equal(a.kind === 'time' && a.minutes, 90);
  });

  it('matches a type by its label as well as its key', () => {
    for (const entry of ['Game Night 2h', 'game_night 2h', '2h game night']) {
      const requirement = parseRequirement(entry);
      assert.equal(requirement.kind === 'time' && requirement.shiftType, 'game_night', entry);
    }
  });

  it('counts every type together when none is named', () => {
    for (const entry of ['5h', 'any 5h', 'total 5h', '5h total']) {
      const requirement = parseRequirement(entry);
      assert.equal(requirement.kind === 'time' && requirement.shiftType, null, entry);
      assert.equal(requirement.kind === 'time' && requirement.minutes, 300, entry);
    }
  });

  it('names itself after the shift type, so the card reads properly', () => {
    assert.equal(parseRequirement('shift_guard 90m').label, 'Shift Guard time');
    assert.equal(parseRequirement('5h').label, 'Total time on shift');
    assert.equal(parseRequirement('3 events').label, 'Events hosted');
  });

  it('reads events hosted', () => {
    const requirement = parseRequirement('3 events');
    assert.equal(requirement.kind, 'events');
    assert.equal(requirement.kind === 'events' && requirement.count, 3);

    const one = parseRequirement('1 event');
    assert.equal(one.kind === 'events' && one.count, 1);
  });

  it('still reads the older Label | type | time form', () => {
    const requirement = parseRequirement('AVLO shift guard time | shift_guard | 90m');
    assert.equal(requirement.label, 'AVLO shift guard time');
    assert.equal(requirement.kind === 'time' && requirement.shiftType, 'shift_guard');
    assert.equal(requirement.kind === 'time' && requirement.minutes, 90);
  });

  it('refuses a shift type that does not exist rather than silently counting everything', () => {
    assert.throws(() => parseRequirement('patrol 90m'), RankError);
  });

  it('refuses an entry with no time in it', () => {
    assert.throws(() => parseRequirement('shift guard'), RankError);
    assert.throws(() => parseRequirement('   '), RankError);
  });
});

describe('parseRequirements', () => {
  it('splits a comma separated cell', () => {
    const { requirements, problems } = parseRequirements('shift_guard 90m, game night 2h, 5h, 3 events');

    assert.equal(problems.length, 0);
    assert.deepEqual(
      requirements.map((requirement) => requirement.label),
      ['Shift Guard time', 'Game Night time', 'Total time on shift', 'Events hosted'],
    );
  });

  it('takes semicolons and new lines too, because people use all three', () => {
    assert.equal(parseRequirements('90m; 2h\n3 events').requirements.length, 3);
  });

  it('keeps the entries it understood and reports the one it did not', () => {
    const { requirements, problems } = parseRequirements('shift_guard 90m, patrol 2h, 5h');

    assert.equal(requirements.length, 2, 'one bad entry does not take the rank down');
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /not a shift type/);
  });

  it('is empty for an empty cell', () => {
    assert.deepEqual(parseRequirements('').requirements, []);
    assert.deepEqual(parseRequirements('  ,  ').problems, []);
  });
});

describe('formatRequirements', () => {
  it('writes back something it can read again', () => {
    const text = formatRequirements(parseRequirements('shift_guard 90m, 5h, 3 events').requirements);

    assert.equal(text, 'shift_guard 1h30m, any 5h, 3 events');
    assert.equal(parseRequirements(text).problems.length, 0, 'and it round trips');
  });
});

describe('describeRequirement', () => {
  it('says it the way a person would', () => {
    assert.equal(describeRequirement(parseRequirement('shift_guard 90m')), '1h 30m of Shift Guard');
    assert.equal(describeRequirement(parseRequirement('5h')), '5h of any shift type');
    assert.equal(describeRequirement(parseRequirement('3 events')), '3 events hosted');
    assert.equal(describeRequirement(parseRequirement('1 event')), '1 event hosted');
  });
});

describe('measureRank', () => {
  const rank = { ...makeRank(), requirements: parseRequirements('shift_guard 90m, 5h, 2 events').requirements };
  const worked = new Map([
    ['shift_guard', 100],
    ['game_night', 260],
  ]);

  it('measures each requirement against what has been banked', () => {
    const measured = measureRank(rank, worked, 2);

    assert.deepEqual(
      measured.requirements.map((entry) => entry.met),
      [true, true, true],
    );
    assert.equal(measured.ready, true);
  });

  it('counts every shift type together for an untyped requirement', () => {
    const measured = measureRank(rank, new Map([['shift_guard', 100]]), 2);
    const total = measured.requirements[1];

    assert.equal(total?.done, 100);
    assert.equal(total?.met, false, '100 minutes is not the 5 hours asked for');
    assert.equal(measured.ready, false);
  });

  it('reports a part-finished requirement as a fraction, never over one', () => {
    const measured = measureRank(rank, new Map([['shift_guard', 45]]), 0);

    assert.equal(measured.requirements[0]?.fraction, 0.5);
    assert.equal(measureRank(rank, worked, 99).requirements[2]?.fraction, 1, 'clamped');
  });

  it('is not ready for a rank nobody has written requirements for', () => {
    const measured = measureRank(makeRank(), worked, 5);

    assert.equal(measured.ready, false, 'an empty rank must not mean everybody qualifies');
    assert.equal(measured.overall, 0);
  });

  it('is not ready when there is no rank above them at all', () => {
    assert.equal(measureRank(null, worked, 5).ready, false);
  });
});

describe('nextRank', () => {
  const ladder = [
    makeRank({ roleId: 1, rank: 0, name: 'Guest' }),
    makeRank({ roleId: 2, rank: 10, name: 'Trainee' }),
    makeRank({ roleId: 3, rank: 50, name: 'Guard' }),
    makeRank({ roleId: 4, rank: 255, name: 'Owner' }),
  ];

  it('finds the next rung up', () => {
    assert.equal(nextRank(ladder, 10)?.name, 'Guard');
    assert.equal(nextRank(ladder, 0)?.name, 'Trainee');
  });

  it('never promotes into the owner rank', () => {
    assert.equal(nextRank(ladder, 50), null);
  });

  it('works from a rank number nobody holds exactly', () => {
    assert.equal(nextRank(ladder, 25)?.name, 'Guard');
  });
});

describe('parseGeneral', () => {
  it('splits a cell into one line each', () => {
    assert.deepEqual(parseGeneral('Finishing Orientation; Final Exam; Approval of HR+'), [
      'Finishing Orientation',
      'Final Exam',
      'Approval of HR+',
    ]);
  });

  it('takes new lines too, and drops the empty gaps people leave', () => {
    assert.deepEqual(parseGeneral('Final Exam\n\nApproval of HR+;'), ['Final Exam', 'Approval of HR+']);
    assert.deepEqual(parseGeneral(''), []);
    assert.deepEqual(parseGeneral('  ;  ; '), []);
  });

  it('keeps commas, because a requirement may well contain one', () => {
    assert.deepEqual(parseGeneral('Interview, then a final exam'), ['Interview, then a final exam']);
  });

  it('round trips through the sheet', () => {
    const general = ['Final Exam', 'Approval of HR+'];
    assert.deepEqual(parseGeneral(formatGeneral(general)), general);
  });
});

describe('effectiveMode', () => {
  it('leaves a rank with nothing to confirm alone', () => {
    assert.equal(effectiveMode({ ...makeRank(), mode: 'auto' }), 'auto');
    assert.equal(effectiveMode({ ...makeRank(), mode: 'approval' }), 'approval');
    assert.equal(effectiveMode({ ...makeRank(), mode: 'manual' }), 'manual');
  });

  it('will not promote automatically past something only a person can check', () => {
    const rank = { ...makeRank(), mode: 'auto', general: ['Final Exam'] };

    assert.equal(effectiveMode(rank), 'approval', 'auto would walk straight past the exam');
  });

  it('does not drag a manual rank up to approval', () => {
    assert.equal(effectiveMode({ ...makeRank(), mode: 'manual', general: ['Final Exam'] }), 'manual');
  });
});

describe('parseMode', () => {
  it('reads the three modes, however they are typed', () => {
    assert.equal(parseMode('auto'), 'auto');
    assert.equal(parseMode('  Automatic '), 'auto');
    assert.equal(parseMode('approval'), 'approval');
    assert.equal(parseMode('Approve'), 'approval');
    assert.equal(parseMode('manual'), 'manual');
  });

  it('treats anything it does not recognise as manual, which changes nothing', () => {
    assert.equal(parseMode(''), 'manual');
    assert.equal(parseMode('sure why not'), 'manual');
  });
});

describe('the Ranks tab', () => {
  const grid = [
    ['Rank', 'Name', 'Requirements', 'General requirements', 'Promotion', 'Notes', 'Members'],
    ['50', 'Guard', 'shift_guard 90m, 5h', 'Final Exam; Approval of HR+', 'auto', 'the workhorse rank', '120'],
    ['10', 'Trainee', '30m', '', 'approval', '', '40'],
  ];

  it('reads only the columns people own', () => {
    const edits = parseRankGrid(grid);

    assert.equal(edits.size, 2);
    assert.equal(edits.get(50)?.mode, 'auto');
    assert.equal(edits.get(50)?.notes, 'the workhorse rank');
    assert.deepEqual(edits.get(50)?.general, ['Final Exam', 'Approval of HR+']);
    assert.deepEqual(edits.get(10)?.general, []);
    assert.equal(edits.get(10)?.requirementsText, '30m');
  });

  it('keeps the name and rank from the group, not from the sheet', () => {
    const ladder = [makeRank({ roleId: 3, rank: 50, name: 'Renamed In Roblox' })];
    const { ranks } = applyEdits(ladder, parseRankGrid(grid));

    assert.equal(ranks[0]?.name, 'Renamed In Roblox');
    assert.equal(ranks[0]?.mode, 'auto');
    assert.equal(ranks[0]?.requirements.length, 2);
  });

  it('reports a requirement it could not read, against the rank it was on', () => {
    const ladder = [makeRank({ rank: 50, name: 'Guard' })];
    const { problems } = applyEdits(ladder, parseRankGrid([grid[0], ['50', 'Guard', 'patrol 2h', '', 'auto', '', '']]));

    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^Guard: /);
  });

  it('leaves a rank the sheet says nothing about alone', () => {
    const ladder = [makeRank({ rank: 99, name: 'Unmentioned' })];
    assert.deepEqual(applyEdits(ladder, parseRankGrid(grid)).ranks, ladder);
  });

  it('writes a grid it can read back', () => {
    const ladder = [{ ...makeRank(), requirements: parseRequirements('shift_guard 90m').requirements, mode: 'auto' }];
    const written = rankGridFor(ladder);

    assert.deepEqual(written[0], [
      'Rank',
      'Name',
      'Requirements',
      'General requirements',
      'Promotion',
      'Notes',
      'Members',
    ]);
    assert.equal(parseRankGrid(written).get(50)?.mode, 'auto');
    assert.equal(applyEdits(ladder, parseRankGrid(written)).ranks[0]?.requirements.length, 1);
  });
});

describe('progressBar', () => {
  it('fills in proportion, and always to the same width', () => {
    assert.equal(progressBar(0), '░░░░░░░░░░░░');
    assert.equal(progressBar(1), '████████████');
    assert.equal(progressBar(0.5), '██████░░░░░░');
    assert.equal(progressBar(0.5).length, progressBar(0).length);
  });

  it('clamps rather than drawing a bar longer than the track', () => {
    assert.equal(progressBar(5), '████████████');
    assert.equal(progressBar(-1), '░░░░░░░░░░░░');
  });
});
