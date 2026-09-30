'use strict';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "2h 14m", "48m 03s", "0m" - short enough for an embed field. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** "12h 30m" style total used in summaries where hours matter more than seconds. */
function formatHours(ms) {
  const hours = ms / HOUR;
  return `${hours.toFixed(2)}h`;
}

/** Discord renders these in each viewer's own timezone. */
function discordTimestamp(epochMs, style = 'f') {
  return `<t:${Math.floor(epochMs / 1000)}:${style}>`;
}

function startOfUtcDay(epochMs) {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysAgo(days, now = Date.now()) {
  return now - days * 24 * HOUR;
}

module.exports = { formatDuration, formatHours, discordTimestamp, startOfUtcDay, daysAgo };
