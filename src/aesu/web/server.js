'use strict';
const { createServer } = require('node:http');
const { config, isOAuthConfigured } = require('../config/index');
const ui = require('../ui');
const { syncDutyRoles } = require('../discord/roles');
const { exchangeCode, fetchUserInfo } = require('../roblox/oauth');
const { createLogger, describeError } = require('../util/logger');
const { errorPage, landingPage, privacyPage, successPage, termsPage } = require('./pages');

const log = createLogger('web');

function send(response, status, body, contentType = 'text/html; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

/** The "connect linked" hook, DMed once the link is saved. */
async function notifyLinked(client, discordId, displayName, username) {
  await ui.dm(discordId, 'connect linked', { discordId, displayName, username });
}

async function handleOAuthCallback(url, response, deps) {
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const description = url.searchParams.get('error_description') ?? oauthError;
    log.warn(`Roblox returned an error on the callback: ${description}`);
    send(response, 400, errorPage(`Roblox rejected the authorisation: ${description}`));
    return;
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    send(response, 400, errorPage('The callback was missing its code or state parameter.'));
    return;
  }

  const stored = await deps.store.consumeOAuthState(state);
  if (!stored) {
    send(response, 400, errorPage('that link was already used or isnt from this bot'));
    return;
  }
  if (stored.expiresAt <= Date.now()) {
    send(response, 400, errorPage('That link expired. Links are only valid for 10 minutes.'));
    return;
  }

  let tokens;
  let profile;
  try {
    tokens = await exchangeCode(code, stored.codeVerifier);
    profile = await fetchUserInfo(tokens.access_token);
  } catch (error) {
    log.warn(`Token exchange failed for ${stored.discordId}: ${describeError(error)}`);
    send(response, 400, errorPage('Roblox would not exchange that authorisation code. It may have already been used.'));
    return;
  }

  const username = profile.preferred_username ?? profile.name ?? profile.sub;
  const displayName = profile.nickname ?? profile.name ?? username;
  const now = Date.now();

  await deps.store.upsertLink({
    discordId: stored.discordId,
    robloxId: profile.sub,
    robloxUsername: username,
    robloxDisplayName: displayName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    tokenExpiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
    linkedAt: now,
    updatedAt: now,
  });

  // Clear any stale presence bookkeeping so the next poll treats this as a fresh join.
  await deps.store.deleteWatchState(stored.discordId);

  log.info(`Linked Discord ${stored.discordId} to Roblox ${profile.sub} (${username})`);
  send(response, 200, successPage(displayName, username));
  void notifyLinked(deps.client, stored.discordId, displayName, username);
  // Somebody who has just linked is staff who happen to be off duty, so give them
  // that role now rather than only after their first shift ends.
  void syncDutyRoles(deps.client, deps.manager, stored.guildId, stored.discordId);
}

async function route(request, response, deps) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, errorPage('Method not allowed.'));
    return;
  }

  switch (url.pathname) {
    case '/health':
    case '/healthz': {
      const [links, openShifts] = await Promise.all([deps.store.listLinks(), deps.store.listOpenShifts()]);
      sendJson(response, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        discordReady: deps.client.isReady(),
        oauthConfigured: isOAuthConfigured(),
        trackedGames: config.tracking.universeIds.length + config.tracking.placeIds.length,
        linkedAccounts: links.length,
        openShifts: openShifts.length,
      });
      return;
    }

    case '/oauth/callback':
      await handleOAuthCallback(url, response, deps);
      return;

    // Roblox requires both of these as public HTTPS pages before an app is published.
    case '/privacy':
      send(response, 200, privacyPage());
      return;

    case '/terms':
      send(response, 200, termsPage());
      return;

    case '/':
      send(response, 200, landingPage());
      return;

    default:
      send(response, 404, errorPage('Nothing to see here.'));
  }
}

function createWebServer(deps) {
  return createServer((request, response) => {
    route(request, response, deps).catch((error) => {
      log.error(`Request to ${request.url} failed: ${describeError(error)}`);
      if (!response.headersSent) send(response, 500, errorPage('Something went wrong on our side. Try /connect again.'));
      else response.end();
    });
  });
}

module.exports = { createWebServer };
