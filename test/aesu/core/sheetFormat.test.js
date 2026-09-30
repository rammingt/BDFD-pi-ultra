'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.GOOGLE_SHEET_ID = 'sheet-1';
process.env.SHIFT_TYPES = 'Shift Guard, Game Night';
process.env.LOG_LEVEL = 'error';

const { asLiteral, asText } = require('../../../src/aesu/sheets/client');
const { RANK_WIDTHS, clearConditionalFormats, columnWidths, guideFormatRequests, rankFormatRequests, rgb } =
  require('../../../src/aesu/sheets/format');
const { GUIDE_VERSION, guideGrid, guideNeedsWriting } = require('../../../src/aesu/sheets/guide');
const { RANKS_HEADER } = require('../../../src/aesu/sheets/sync');
const { a1 } = require('../../../src/aesu/sheets/client');

function find(requests, key) {
  return requests.filter((request) => key in request);
}

describe('asLiteral', () => {
  it('pins a Discord ID as text, because a number would lose its last digits', () => {
    assert.equal(asLiteral('123456789012345678'), "'123456789012345678");
  });

  it('leaves an empty cell alone', () => {
    assert.equal(asLiteral(''), '');
  });
});

describe('asText', () => {
  it('leaves ordinary text alone', () => {
    assert.equal(asText('Low Rank'), 'Low Rank');
    assert.equal(asText('Finishing Orientation; Final Exam'), 'Finishing Orientation; Final Exam');
  });

  it('stops anything that would become a formula', () => {
    assert.equal(asText('=IMPORTXML("evil","//x")'), '\'=IMPORTXML("evil","//x")');
    assert.equal(asText('+1 for me'), "'+1 for me");
    assert.equal(asText('@everyone'), "'@everyone");
  });

  it('still lets a negative number through as a number', () => {
    assert.equal(asText('-5'), '-5');
    assert.equal(asText('-5 points'), "'-5 points");
  });
});

describe('a1', () => {
  it('quotes the tab name, because one with a space in it is not a parseable range', () => {
    assert.equal(a1('Form Responses 1', 'A1:Z1000'), "'Form Responses 1'!A1:Z1000");
    assert.equal(a1('Phases', 'A1:D50'), "'Phases'!A1:D50");
  });

  it('escapes a quote in the name rather than breaking the range', () => {
    assert.equal(a1("Bob's tab", 'A1'), "'Bob''s tab'!A1");
  });
});

describe('rgb', () => {
  it('turns hex into the 0-1 channels Sheets wants', () => {
    assert.deepEqual(rgb('#ffffff'), { red: 1, green: 1, blue: 1 });
    assert.deepEqual(rgb('#000000'), { red: 0, green: 0, blue: 0 });
    const blue = rgb('#4285f4');
    assert.ok(blue.blue > blue.red, 'a blue is mostly blue');
  });
});

describe('columnWidths', () => {
  it('sizes each column in turn', () => {
    const requests = columnWidths(7, [100, 200]);
    assert.equal(requests.length, 2);
    const second = requests[1];
    assert.equal(second.updateDimensionProperties.range.startIndex, 1);
    assert.equal(second.updateDimensionProperties.properties.pixelSize, 200);
    assert.equal(second.updateDimensionProperties.range.sheetId, 7);
  });
});

describe('clearConditionalFormats', () => {
  it('deletes index zero once per existing rule, so re-running does not stack them', () => {
    const requests = clearConditionalFormats(3, 4);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => (request).deleteConditionalFormatRule.index === 0));
  });

  it('asks for nothing when the tab has no rules yet', () => {
    assert.deepEqual(clearConditionalFormats(3, 0), []);
  });
});

describe('rankFormatRequests', () => {
  const requests = rankFormatRequests(11, 2);

  it('freezes the header row and the rank and name columns', () => {
    const properties = find(requests, 'updateSheetProperties')[0]?.updateSheetProperties.properties;
    assert.equal(properties.gridProperties.frozenRowCount, 1);
    assert.equal(properties.gridProperties.frozenColumnCount, 2);
  });

  it('sizes every column the header has', () => {
    assert.equal(find(requests, 'updateDimensionProperties').length, RANK_WIDTHS.length);
    assert.equal(RANK_WIDTHS.length, RANKS_HEADER.length, 'a width per column');
  });

  it('offers the three promotion modes as a dropdown rather than letting them be mistyped', () => {
    const validation = find(requests, 'setDataValidation')[0]?.setDataValidation;

    assert.equal(validation.range.startColumnIndex, 4, 'on the Promotion column');
    assert.deepEqual(
      validation.rule.condition.values.map((value) => value.userEnteredValue),
      ['auto', 'approval', 'manual'],
    );
  });

  it('clears the rules that are already there before adding its own', () => {
    assert.equal(find(requests, 'deleteConditionalFormatRule').length, 2);
    assert.equal(find(requests, 'addConditionalFormatRule').length, 3);
  });

  it('picks out the self-service ranks and the ones nobody has configured', () => {
    const formulas = find(requests, 'addConditionalFormatRule')
      .map((request) => request.addConditionalFormatRule.rule.booleanRule?.condition?.values?.[0]?.userEnteredValue)
      .filter(Boolean);

    assert.ok(formulas.includes('=$E2="auto"'), 'auto ranks are highlighted');
    assert.ok(formulas.includes('=$C2=""'), 'ranks with no requirements are highlighted');
  });
});

describe('guideFormatRequests', () => {
  it('hides the gridlines so the guide reads as a page', () => {
    const requests = guideFormatRequests(9);
    const properties = find(requests, 'updateSheetProperties')[0]?.updateSheetProperties.properties;
    assert.equal(properties.gridProperties.hideGridlines, true);
  });
});

describe('guideGrid', () => {
  const grid = guideGrid();

  it('leads with the title and the version', () => {
    assert.equal(grid[0]?.[0], 'How to edit');
    assert.match(grid[0]?.[1] ?? '', new RegExp(`guide ${GUIDE_VERSION}$`));
  });

  it('names the shift types that are actually configured', () => {
    const text = grid.flat().join('\n');
    assert.match(text, /shift_guard \(Shift Guard\)/);
    assert.match(text, /game_night \(Game Night\)/);
  });

  it('explains the three columns people own and the three promotion modes', () => {
    const text = grid.flat().join('\n').toLowerCase();
    for (const topic of ['requirements', 'promotion', 'notes', 'auto', 'approval', 'manual', 'events']) {
      assert.match(text, new RegExp(topic), `the guide mentions ${topic}`);
    }
  });

  it('has nothing Sheets would run as a formula', () => {
    for (const cell of grid.flat()) {
      assert.ok(!/^[=+@]/.test(cell), `${cell.slice(0, 20)} would be read as a formula`);
    }
  });
});

describe('guideNeedsWriting', () => {
  it('wants writing when the tab is empty', () => {
    assert.equal(guideNeedsWriting([]), true);
    assert.equal(guideNeedsWriting([[]]), true);
  });

  it('wants rewriting when the version has moved on', () => {
    assert.equal(guideNeedsWriting([['How to edit', 'AESU promotion requirements - guide v0']]), true);
  });

  it('leaves the current guide alone', () => {
    assert.equal(guideNeedsWriting(guideGrid()), false);
  });
});
