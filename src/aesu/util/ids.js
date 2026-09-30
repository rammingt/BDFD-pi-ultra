'use strict';
const { randomBytes, createHash } = require('node:crypto');

function randomId(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function base64Url(input) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE pair for the Roblox authorization-code flow. */
function createPkcePair() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

module.exports = { randomId, base64Url, createPkcePair };
