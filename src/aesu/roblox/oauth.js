'use strict';
const { config } = require('../config/index');
const { createPkcePair, randomId } = require('../util/ids');
const { HttpError, requestJson } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('roblox:oauth');

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const REVOKE_URL = 'https://apis.roblox.com/oauth/v1/token/revoke';

/** Builds the consent URL plus the PKCE material that has to be stored alongside it. */
function buildAuthorizationRequest() {
  const { verifier, challenge } = createPkcePair();
  const state = randomId(24);

  const params = new URLSearchParams({
    client_id: config.roblox.clientId,
    redirect_uri: config.roblox.redirectUri,
    scope: config.roblox.scopes,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state, codeVerifier: verifier };
}

async function postForm(url, body) {
  try {
    return await requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      retries: 1,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      log.warn(`${url} rejected the request: ${error.status} ${error.body.slice(0, 200)}`);
    }
    throw error;
  }
}

function exchangeCode(code, codeVerifier) {
  return postForm(
    TOKEN_URL,
    new URLSearchParams({
      client_id: config.roblox.clientId,
      client_secret: config.roblox.clientSecret,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
    }),
  );
}

function refreshAccessToken(refreshToken) {
  return postForm(
    TOKEN_URL,
    new URLSearchParams({
      client_id: config.roblox.clientId,
      client_secret: config.roblox.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}

async function revokeToken(token) {
  await postForm(
    REVOKE_URL,
    new URLSearchParams({
      client_id: config.roblox.clientId,
      client_secret: config.roblox.clientSecret,
      token,
    }),
  ).catch((error) => {
    // Revocation is best effort - the local link is removed either way.
    log.warn(`Token revoke failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function fetchUserInfo(accessToken) {
  return requestJson(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    retries: 1,
  });
}

module.exports = { buildAuthorizationRequest, exchangeCode, refreshAccessToken, revokeToken, fetchUserInfo };
