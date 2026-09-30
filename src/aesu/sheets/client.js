'use strict';
const { createSign } = require('node:crypto');
const { config } = require('../config/index');
const { base64Url } = require('../util/ids');
const { request, requestJson } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('sheets');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Reads the service account from the environment. Accepts the whole JSON key file
 * or the two fields separately, and repairs the escaped newlines that every
 * hosting dashboard turns the private key into.
 */
function readServiceAccount() {
  const raw = config.sheets.credentials;

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key) {
        return { clientEmail: parsed.client_email, privateKey: parsed.private_key.replace(/\\n/g, '\n') };
      }
      log.error('GOOGLE_SERVICE_ACCOUNT_JSON parsed but has no client_email / private_key');
      return null;
    } catch {
      log.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file, including the braces.');
      return null;
    }
  }

  const email = config.sheets.clientEmail;
  const key = config.sheets.privateKey.replace(/\\n/g, '\n');
  if (email && key) return { clientEmail: email, privateKey: key };
  return null;
}

function isSheetsConfigured() {
  return Boolean(config.sheets.spreadsheetId) && readServiceAccount() !== null;
}

let cachedToken = null;

/** Signs the assertion Google swaps for an access token. Valid an hour; cached. */
async function accessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = base64Url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64Url(
    Buffer.from(
      JSON.stringify({
        iss: account.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );

  const signature = base64Url(
    createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey),
  );

  const body = await requestJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }).toString(),
    retries: 1,
  });

  cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
  return body.access_token;
}

/** Everything a sheet hands back is text as far as we are concerned. */

/** One `batchUpdate` request. Shapes are Google's; we only ever build a handful. */

/**
 * A1 notation for a range on a named tab. The quoting is not optional: `Form Responses
 * 1!A1:Z` is not a range Sheets can parse, and an unquoted tab name with a space in it
 * fails every read and write against that tab.
 */
function a1(tab, cells) {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

/**
 * Pins a value as text whatever it looks like. A Discord ID parsed as a number loses
 * its last digits to floating point, which quietly ruins the row.
 */
function asLiteral(value) {
  return value === '' ? value : `'${value}`;
}

/**
 * Sheets reads a leading `=`, `+`, `-` or `@` as a formula. Names and notes come from
 * people, so they are pinned as text - both to keep the sheet readable and so nothing
 * anybody types can turn into a formula that runs in somebody else's browser.
 */
function asText(value) {
  if (!/^[=+\-@]/.test(value)) return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return `'${value}`;
}

class SheetsClient {
  constructor(
    account,
    spreadsheetId,
  ) {
    this.account = account;
    this.spreadsheetId = spreadsheetId;
  }

  async authed(path, init = {}) {
    const token = await accessToken(this.account);
    return request(`${SHEETS_API}/${this.spreadsheetId}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      retries: 1,
      timeoutMs: 20_000,
    });
  }

  /** Reads a range. A tab that does not exist yet comes back as no rows. */
  async read(range) {
    try {
      const response = await this.authed(`/values/${encodeURIComponent(range)}`);
      const body = (await response.json());
      return body.values ?? [];
    } catch (error) {
      if (String(error).includes('Unable to parse range')) return [];
      throw error;
    }
  }

  /**
   * `parse` lets Sheets interpret what it is given, so `85%` becomes a real percentage
   * and `2026-09-18 14:30` a real date rather than two pieces of text. Anything a
   * person wrote has to go through `asText` first.
   */
  async write(range, values, parse = false) {
    const how = parse ? 'USER_ENTERED' : 'RAW';
    await this.authed(`/values/${encodeURIComponent(range)}?valueInputOption=${how}`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    });
  }

  /** Clears then writes, so a shorter list does not leave old rows behind. */
  async replace(tab, values, parse = false) {
    await this.authed(`/values/${encodeURIComponent(a1(tab, 'A:Z'))}:clear`, { method: 'POST', body: '{}' });
    if (values.length > 0) await this.write(a1(tab, 'A1'), values, parse);
  }

  /** Titles alone. Formatting needs `tabs()`, which costs the same call. */
  async tabNames() {
    return (await this.tabs()).map((tab) => tab.title);
  }

  async tabs() {
    const response = await this.authed(
      '?fields=sheets(properties(sheetId,title),conditionalFormats)',
    );
    const body = (await response.json())

;

    return (body.sheets ?? [])
      .map((sheet) => ({
        title: sheet.properties?.title ?? '',
        sheetId: sheet.properties?.sheetId ?? 0,
        conditionalFormats: (sheet.conditionalFormats ?? []).length,
      }))
      .filter((tab) => tab.title !== '');
  }

  async batchUpdate(requests) {
    if (requests.length === 0) return;
    await this.authed(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
  }

  async createTab(title) {
    await this.batchUpdate([{ addSheet: { properties: { title } } }]);
  }

  /** Makes sure a tab exists, and says which ones it had to make. */
  async ensureTabs(titles) {
    const existing = new Set(await this.tabNames());
    const created = [];

    for (const title of titles) {
      if (!existing.has(title)) {
        await this.createTab(title);
        created.push(title);
        log.info(`Created the "${title}" tab`);
      }
    }
    return created;
  }
}

/** The Form's responses live in their own spreadsheet, hence the override. */
function createSheetsClient(spreadsheetId = config.sheets.spreadsheetId) {
  const account = readServiceAccount();
  if (!account || !spreadsheetId) return null;
  return new SheetsClient(account, spreadsheetId);
}

module.exports = { readServiceAccount, isSheetsConfigured, a1, asLiteral, asText, SheetsClient, createSheetsClient };
