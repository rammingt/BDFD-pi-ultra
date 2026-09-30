'use strict';
// Turns records into plain objects of display text, so .bdx cards can print
// $json[worked] or $json[started] without doing any formatting themselves.
const { computeDurations } = require('./shifts/manager');
const { SHIFT_TYPES, shiftTypeMeta, shiftTypeLabel } = require('./shifts/types');
const { robloxGameUrl, robloxProfileUrl } = require('./roblox/games');
const { discordTimestamp, formatDuration, formatHours } = require('./util/time');
const { DECLINED_LABEL, DECLINED_ROLE_KEY, totalAttendance } = require('./events/types');

const yes = (v) => (v ? 'yes' : 'no');

const STATUS_LABEL = { active: 'On shift', on_break: 'On break', ended: 'Ended' };

const END_REASON_LABEL = {
  manual: 'Ended from the panel',
  left_game: 'Left the game',
  max_duration: 'Hit the maximum shift length',
  admin: 'Ended by a staff member',
  event_ended: 'Event finished',
};

const SOURCE_LABEL = { prompt: 'join prompt', panel: 'shift panel', event: 'event attendance', admin: 'admin adjustment' };

function gameLine(shift) {
  const name = shift.gameName ?? (shift.placeId ? `Place ${shift.placeId}` : null);
  if (!name) return 'Not detected';
  const url = robloxGameUrl(shift.placeId);
  return url ? `[${name}](${url})` : name;
}

function robloxLine(robloxId, robloxUsername) {
  return robloxId ? `[${robloxUsername ?? robloxId}](${robloxProfileUrl(robloxId)})` : 'Not linked';
}

/** formatDuration floors at 0m, which would show time taken away as nothing at all. */
function signed(ms) {
  return `${ms < 0 ? '-' : '+'}${formatDuration(Math.abs(ms))}`;
}

function shiftView(shift, now = Date.now()) {
  if (!shift) return null;
  const meta = shiftTypeMeta(shift.type);
  const { workedMs, breakMs, elapsedMs } = computeDurations(shift, now);
  const adjustment = shift.source === 'admin';
  return {
    id: shift.id,
    short: shift.id.slice(0, 8),
    discordId: shift.discordId,
    type: shift.type,
    typeLabel: meta?.label ?? shift.type,
    typeDescription: meta?.description ?? '',
    status: shift.status,
    statusLabel: STATUS_LABEL[shift.status] ?? shift.status,
    running: yes(shift.status !== 'ended'),
    onBreak: yes(shift.status === 'on_break'),
    started: discordTimestamp(shift.startedAt, 'f'),
    startedRelative: discordTimestamp(shift.startedAt, 'R'),
    startedDate: discordTimestamp(shift.startedAt, 'd'),
    ended: shift.endedAt ? discordTimestamp(shift.endedAt, 'f') : '',
    endedRelative: shift.endedAt ? discordTimestamp(shift.endedAt, 'R') : '',
    worked: adjustment ? signed(workedMs) : formatDuration(workedMs),
    workedHours: formatHours(workedMs),
    workedMs,
    elapsed: formatDuration(elapsedMs),
    breakTime: formatDuration(breakMs),
    breakCount: shift.breakCount,
    breaks: shift.breakCount === 0 ? 'None' : `${shift.breakCount} (${formatDuration(breakMs)})`,
    game: gameLine(shift),
    gameName: shift.gameName ?? '',
    gameUrl: robloxGameUrl(shift.placeId) ?? '',
    roblox: robloxLine(shift.robloxId, shift.robloxUsername),
    robloxUsername: shift.robloxUsername ?? '',
    robloxId: shift.robloxId ?? '',
    source: shift.source,
    sourceLabel: SOURCE_LABEL[shift.source] ?? shift.source,
    endReason: shift.endReason ?? '',
    endReasonLabel: shift.endReason ? END_REASON_LABEL[shift.endReason] ?? shift.endReason : '',
    adjusted: yes(adjustment),
    // what /shift history puts after the type
    note: adjustment ? ' *(adjusted)*' : shift.status === 'ended' ? '' : ' *(running)*',
  };
}

function typeView(meta, selected = null) {
  return { value: meta.value, label: meta.label, description: meta.description ?? '', selected: yes(meta.value === selected) };
}

/** What the shift panel shows: the running shift, or the picker with whatever is selected. */
function panelView(shift, selectedType = null, now = Date.now()) {
  const selected = !shift && selectedType ? shiftTypeMeta(selectedType) : null;
  return {
    state: shift ? shift.status : 'none',
    shift: shiftView(shift, now),
    selected: selected ? typeView(selected, selected.value) : null,
    types: SHIFT_TYPES.map((meta) => typeView(meta, shift ? null : selectedType)),
  };
}

const EVENT_STATUS_LABEL = { scheduled: 'Scheduled', running: 'Happening now', ended: 'Finished', cancelled: 'Cancelled' };

function eventUrl(event) {
  if (!event.guildId || !event.channelId || !event.messageId) return '';
  return `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
}

function signupView(signup, at) {
  return {
    discordId: signup.discordId,
    mention: `<@${signup.discordId}>`,
    roleKey: signup.roleKey,
    attended: formatDuration(totalAttendance(signup, at)),
    logged: yes(signup.shiftId !== null),
    gameName: signup.gameName ?? '',
  };
}

/**
 * An event with everything its post shows: one entry per sign up option with the
 * people in it, the ones who cannot make it, and who got time logged once it is over.
 */
function eventView(event, signups = [], now = Date.now()) {
  const at = event.endsAt ?? now;
  const people = (list) => list.map((signup) => signupView(signup, at));
  const declined = signups.filter((signup) => signup.roleKey === DECLINED_ROLE_KEY);
  const banked = signups.filter((signup) => signup.shiftId !== null);
  const open = event.status === 'scheduled' || event.status === 'running';
  return {
    id: event.id,
    name: event.name,
    details: event.details ?? '',
    imageUrl: event.imageUrl ?? '',
    hostId: event.hostId,
    host: `<@${event.hostId}>`,
    status: event.status,
    statusLabel: EVENT_STATUS_LABEL[event.status] ?? event.status,
    open: yes(open),
    ended: yes(event.status === 'ended'),
    starts: discordTimestamp(event.startsAt, 'F'),
    startsRelative: discordTimestamp(event.startsAt, 'R'),
    ends: event.endsAt === null ? '' : discordTimestamp(event.endsAt, 'f'),
    length: event.endsAt === null ? '' : formatDuration(event.endsAt - event.startsAt),
    shiftType: event.shiftType,
    shiftTypeLabel: shiftTypeLabel(event.shiftType),
    url: eventUrl(event),
    roles: event.roles.map((role) => {
      const taken = signups.filter((signup) => signup.roleKey === role.key);
      return {
        key: role.key,
        label: role.label,
        limit: role.limit ?? '',
        count: role.limit === null ? `${taken.length}` : `${taken.length}/${role.limit}`,
        full: yes(role.limit !== null && taken.length >= role.limit),
        people: people(taken),
      };
    }),
    declinedLabel: DECLINED_LABEL,
    declinedKey: DECLINED_ROLE_KEY,
    declined: people(declined),
    declinedCount: declined.length,
    banked: people(banked),
    bankedCount: banked.length,
    attending: people(signups.filter((signup) => signup.roleKey !== DECLINED_ROLE_KEY)),
    signupCount: signups.length,
  };
}

module.exports = {
  EVENT_STATUS_LABEL, eventView, signupView, eventUrl,
  STATUS_LABEL, END_REASON_LABEL, SOURCE_LABEL, yes, signed, gameLine, robloxLine,
  shiftView, typeView, panelView, shiftTypeLabel, formatDuration, formatHours, discordTimestamp,
};
