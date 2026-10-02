'use strict';
const { config } = require('../config/index');
const { SHIFT_TYPE_VALUES, shiftTypeLabel } = require('../shifts/types');

const GUIDE_TAB = 'How to edit';

/** Bumped whenever the text below changes, so an existing tab gets rewritten. */
const GUIDE_VERSION = 'v3';

const TITLE = 'How to edit';

/** `shift_guard (Shift Guard)`, so both the key and the label people know are here. */
function shiftTypeList() {
  return SHIFT_TYPE_VALUES.map((key) => `${key} (${shiftTypeLabel(key)})`).join(', ');
}

/**
 * The guide the bot writes into the spreadsheet itself, because the person editing
 * the sheet is usually not the person who read the README.
 */
function guideGrid() {
  const every = `${config.sheets.syncIntervalMinutes} minute(s)`;
  const firstType = SHIFT_TYPE_VALUES[0] ?? 'shift_guard';
  const secondType = SHIFT_TYPE_VALUES[1] ?? firstType;

  return [
    [TITLE, `AESU promotion requirements - guide ${GUIDE_VERSION}`],

    [
      'What this is',
      'One row per rank in the Roblox group. Write what a rank needs and the bot checks it when somebody runs ' +
        '/promote action:request, then promotes them in the group. Rover moves their Discord roles from there.',
    ],

    [
      'Who owns what',
      'You own four columns: Requirements, General requirements, Promotion and Notes. Rank, Name and Members come ' +
        'from the Roblox group and are rewritten on every sync, so editing those does nothing.',
    ],

    ['Do not add columns', 'The whole tab is rewritten on every sync, so a column of your own is wiped. Use Notes.'],

    ['When it syncs', `Every ${every}. Run /promote action:sync in Discord to do it immediately.`],

    ['A rank is missing', 'Run /promote action:sync. Ranks are read from the group itself, so the sheet follows whatever is there.'],

    ['---', ''],

    [
      'Requirements',
      'Comma separated. Each one is a length of time and, optionally, which shift type it has to be. ' +
        `For example: ${firstType} 90m, ${secondType} 2h, 5h, 3 events`,
    ],

    ['Order does not matter', `"${firstType} 90m" and "90m ${firstType}" mean the same thing.`],

    ['Times', '90m, 2h, 1h30m, 1.5h, or a bare number for minutes.'],

    ['Any shift type', 'Leave the type out, or write any: "5h" and "any 5h" both mean five hours of anything.'],

    ['Shift types', shiftTypeList()],

    ['Events', '"3 events" means three events they hosted and ran to the end with /event. Cancelled ones do not count.'],

    ['Nothing written', 'A rank with an empty Requirements cell is highlighted red and nobody can be promoted into it.'],

    ['A typo', 'Only the entry that could not be read is skipped, and the reason goes into the deploy logs. The rest of the row still works.'],

    ['---', ''],

    [
      'General requirements',
      'The things the bot cannot measure: an exam passed, an interview done, a sign-off given. ' +
        'Separated by semicolons: Finishing Orientation; Final Exam; Approval of HR+',
    ],

    [
      'How they are checked',
      'They are not. They are listed on the promotion check so the candidate knows about them, and on the request ' +
        'so whoever approves it knows what to confirm. Nobody ticks them off anywhere.',
    ],

    [
      'They force approval',
      'A rank with anything in this column can never promote automatically, whatever Promotion says. Nothing here ' +
        'can tell whether somebody passed their exam, so a person always has the last word.',
    ],

    ['---', ''],

    [
      'Promotion: auto',
      'Anybody who meets the requirements is promoted the moment they run /promote action:request. These rows are green.',
    ],

    [
      'Promotion: approval',
      'Meeting the requirements posts a request with Approve and Deny buttons in the promotions channel. ' +
        'Use this for ranks that need a human to sign off.',
    ],

    [
      'Promotion: manual',
      'Not available through /promote at all. Staff move people with /group action:rank. This is the default for a new rank, ' +
        'so nobody can promote themselves into a rank before you have said they may.',
    ],

    ['---', ''],

    [
      'Time counts forever',
      'Requirements are cumulative: "5h total" means five hours ever logged, not five hours since the last promotion. ' +
        'So each rank should ask for more than the one below it.',
    ],

    [
      'Who gets checked',
      'Anybody who has linked their Roblox account with /connect and is in the group. There is no roster to keep: ' +
        'their current rank is read from Roblox every time.',
    ],

    ['Do not', 'Rename or reorder the columns, or delete the header row. The bot finds every column by position.'],
  ];
}

/** True when the tab is missing the guide, or has an older one. */
function guideNeedsWriting(grid) {
  const [first] = grid;
  return first?.[0] !== TITLE || first?.[1] !== `AESU promotion requirements - guide ${GUIDE_VERSION}`;
}

module.exports = { GUIDE_TAB, GUIDE_VERSION, guideGrid, guideNeedsWriting };
