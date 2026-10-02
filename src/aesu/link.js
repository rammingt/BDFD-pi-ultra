'use strict';
// Linking a Roblox account without Roblox's OAuth.
//
// 1. Bloxlink is asked who the member is. They have already proven that account to
//    Bloxlink, so all they do is confirm it is the right one.
// 2. Otherwise they type their username, and prove it is theirs by putting a short
//    code in their Roblox profile's About. Without that anyone could link somebody
//    else's account, and promotions rank whichever account is linked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { findUserById, findUserByUsername } = require('./roblox/group');
const { requestJson, HttpError } = require('./util/http');
const { createLogger, describeError } = require('./util/logger');

const log = createLogger('link');

const PENDING_MS = 15 * 60 * 1000;
// discord id -> { robloxId, name, displayName, via: 'bloxlink' | 'code', code, expiresAt }
const pending = new Map();

/** Reads one setting from Verify's .env, so the Bloxlink key only has to be set once. */
function fromVerify(name) {
  const file = process.env.VERIFY_ENV_FILE || path.join(os.homedir(), 'Verify', '.env');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no Verify on this machine */ }
  return '';
}

function bloxlinkSettings(guildId) {
  const key = process.env.AESU_BLOXLINK_KEY || process.env.BLOXLINK_KEY || fromVerify('BLOXLINK_KEY');
  const guild = process.env.AESU_BLOXLINK_GUILD_ID || process.env.BLOXLINK_GUILD_ID || fromVerify('BLOXLINK_GUILD_ID') || guildId;
  return key && guild ? { key, guild } : null;
}

/** The Roblox id Bloxlink has for this member, or null when it has none or is not set up. */
async function bloxlinkLookup(discordId, guildId) {
  const settings = bloxlinkSettings(guildId);
  if (!settings) return null;
  try {
    const body = await requestJson(`https://api.blox.link/v4/public/guilds/${settings.guild}/discord-to-roblox/${discordId}`, {
      headers: { Authorization: settings.key, Accept: 'application/json' },
      retries: 1,
    });
    return body?.robloxID ? String(body.robloxID) : null;
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404)) log.warn(`Bloxlink lookup failed: ${describeError(error)}`);
    return null;
  }
}

async function avatarUrl(robloxId) {
  try {
    const body = await requestJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`, { retries: 1 });
    return body?.data?.[0]?.imageUrl ?? '';
  } catch {
    return '';
  }
}

/** "AESU" and five letters and digits, easy to type and not a real word. */
function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const byte of crypto.randomBytes(5)) out += letters[byte % letters.length];
  return `AESU ${out}`;
}

function view(entry) {
  return {
    robloxId: entry.robloxId,
    username: entry.name,
    displayName: entry.displayName,
    profile: `https://www.roblox.com/users/${entry.robloxId}/profile`,
    avatar: entry.avatar,
    via: entry.via,
    code: entry.code ?? '',
  };
}

/**
 * Starts linking. Returns { status, ...view } where status is:
 *   confirm   Bloxlink (or the username they typed, matching Bloxlink) found the account; ask them to confirm
 *   code      they typed a username Bloxlink does not vouch for; they put the code in their About
 *   ask       Bloxlink has nothing for them and they typed nothing; ask for a username
 *   not_found no Roblox account has that username
 */
async function start(discordId, guildId, username = '') {
  const viaBloxlink = await bloxlinkLookup(discordId, guildId);
  let user = null;
  if (username) {
    user = await findUserByUsername(username.trim().replace(/^@/, ''));
    if (!user) return { status: 'not_found', username };
  } else if (viaBloxlink) {
    user = await findUserById(viaBloxlink);
  }
  if (!user) return { status: 'ask' };

  const trusted = viaBloxlink && viaBloxlink === user.id;
  const entry = {
    robloxId: user.id, name: user.name, displayName: user.displayName, avatar: await avatarUrl(user.id),
    via: trusted ? 'bloxlink' : 'code', code: trusted ? null : newCode(), expiresAt: Date.now() + PENDING_MS,
  };
  pending.set(discordId, entry);
  return { status: trusted ? 'confirm' : 'code', ...view(entry) };
}

/** What the member is part way through linking, or null once it has run out. */
function current(discordId) {
  const entry = pending.get(discordId);
  if (!entry || entry.expiresAt < Date.now()) {
    pending.delete(discordId);
    return null;
  }
  return entry;
}

/** Whether the code is in their Roblox profile's About right now. */
async function codeIsInProfile(entry) {
  const body = await requestJson(`https://users.roblox.com/v1/users/${entry.robloxId}`, { retries: 1 });
  const about = String(body?.description ?? '').toUpperCase().replace(/\s+/g, ' ');
  return about.includes(entry.code);
}

function cancel(discordId) {
  pending.delete(discordId);
}

module.exports = { start, current, codeIsInProfile, cancel, view, bloxlinkSettings };
