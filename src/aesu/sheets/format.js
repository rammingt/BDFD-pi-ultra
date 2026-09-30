'use strict';

/** Sheets wants colour channels as 0-1 floats, not the hex everybody thinks in. */
function rgb(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return {
    red: ((value >> 16) & 255) / 255,
    green: ((value >> 8) & 255) / 255,
    blue: (value & 255) / 255,
  };
}

/** The same palette the progress card is drawn in, so the two look related. */
const PALETTE = {
  header: '#4285f4',
  headerText: '#ffffff',
  stripe: '#f4f7fb',
  readyFill: '#e6f4ea',
  readyText: '#137333',
  low: '#fce8e6',
  mid: '#fef7e0',
  high: '#e6f4ea',
  note: '#5f6368',
};

const HEADER_ROW = { startRowIndex: 0, endRowIndex: 1 };

/** Row 1 picked out: bold white on the card's own blue. */
function headerStyle(sheetId, columns) {
  return {
    repeatCell: {
      range: { sheetId, ...HEADER_ROW, startColumnIndex: 0, endColumnIndex: columns },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb(PALETTE.header),
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
          textFormat: { bold: true, fontSize: 11, foregroundColor: rgb(PALETTE.headerText) },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)',
    },
  };
}

/** A styled header row that stays put, with the first few columns pinned too. */
function headerRequests(sheetId, columns, frozenColumns = 0) {
  return [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: frozenColumns } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
    headerStyle(sheetId, columns),
  ];
}

function columnWidths(sheetId, widths) {
  return widths.map((pixelSize, index) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }));
}

/** A whole-column format below the header, e.g. "this one is a percentage". */
function columnFormat(
  sheetId,
  column,
  format,
  fields,
) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
      cell: { userEnteredFormat: format },
      fields,
    },
  };
}

function centred(sheetId, column, pattern) {
  return columnFormat(
    sheetId,
    column,
    { horizontalAlignment: 'CENTER', ...(pattern ? { numberFormat: pattern } : {}) },
    pattern ? 'userEnteredFormat(horizontalAlignment,numberFormat)' : 'userEnteredFormat.horizontalAlignment',
  );
}

function wrapped(sheetId, column) {
  return columnFormat(
    sheetId,
    column,
    { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' },
    'userEnteredFormat(wrapStrategy,verticalAlignment)',
  );
}

/**
 * Conditional formats stack up every time they are applied, so the existing ones are
 * cleared first. Deleting index 0 repeatedly walks the whole list.
 */
function clearConditionalFormats(sheetId, count) {
  return Array.from({ length: count }, () => ({ deleteConditionalFormatRule: { sheetId, index: 0 } }));
}

function formulaRule(
  sheetId,
  columns,
  formula,
  format,
  index,
) {
  return {
    addConditionalFormatRule: {
      index,
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns }],
        booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format },
      },
    },
  };
}

/** Every other row tinted, so the eye can follow a row across ten columns. */
function stripes(sheetId, columns, index) {
  return formulaRule(sheetId, columns, '=ISEVEN(ROW())', { backgroundColor: rgb(PALETTE.stripe) }, index);
}

const RANK_WIDTHS = [70, 200, 380, 300, 120, 230, 90];
const GUIDE_WIDTHS = [190, 760];

/**
 * The Ranks tab: a frozen header, the requirements column wide enough to read, and a
 * dropdown on Promotion so the three modes cannot be mistyped into meaning `manual`.
 */
function rankFormatRequests(sheetId, existingRules) {
  const columns = RANK_WIDTHS.length;

  return [
    ...headerRequests(sheetId, columns, 2),
    ...columnWidths(sheetId, RANK_WIDTHS),
    centred(sheetId, 0),
    wrapped(sheetId, 2),
    wrapped(sheetId, 3),
    centred(sheetId, 4),
    wrapped(sheetId, 5),
    centred(sheetId, 6),

    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: ['auto', 'approval', 'manual'].map((value) => ({ userEnteredValue: value })),
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },

    ...clearConditionalFormats(sheetId, existingRules),
    stripes(sheetId, columns, 0),
    // Anything people can promote themselves into is worth seeing at a glance.
    formulaRule(
      sheetId,
      columns,
      '=$E2="auto"',
      { backgroundColor: rgb(PALETTE.readyFill), textFormat: { bold: true, foregroundColor: rgb(PALETTE.readyText) } },
      0,
    ),
    formulaRule(sheetId, columns, '=$C2=""', { backgroundColor: rgb(PALETTE.low) }, 0),
  ];
}

/** The guide reads as a page, not a table, so the gridlines go. */
function guideFormatRequests(sheetId) {
  return [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, hideGridlines: true } },
        fields: 'gridProperties.frozenRowCount,gridProperties.hideGridlines',
      },
    },
    headerStyle(sheetId, 2),
    ...columnWidths(sheetId, GUIDE_WIDTHS),
    columnFormat(
      sheetId,
      0,
      { verticalAlignment: 'TOP', textFormat: { bold: true } },
      'userEnteredFormat(verticalAlignment,textFormat)',
    ),
    wrapped(sheetId, 1),
  ];
}

module.exports = { rgb, PALETTE, headerStyle, headerRequests, columnWidths, clearConditionalFormats, RANK_WIDTHS, GUIDE_WIDTHS, rankFormatRequests, guideFormatRequests };
