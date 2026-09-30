'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { config } = require('../config/index');
const { resolveSendableChannel } = require('../discord/channels');
const { Actions, encodeId } = require('../discord/ids');
const { isRovuewConfigured } = require('../rovuew/client');
const { createLogger, describeError } = require('../util/logger');
const { a1, createSheetsClient } = require('./client');

const log = createLogger('applications');

/** How many data rows have already been posted. */
const CURSOR_KEY = 'applications.postedRows';

const COLOR = 0x5865f2;
const COLOR_ACCEPTED = 0x57f287;
const COLOR_DENIED = 0xed4245;
/** Discord allows 25 embed fields; one is held back for the decision, and the rest go in a closing line. */
const MAX_FIELDS = 23;
const MAX_FIELD_VALUE = 1024;

/** What a Roblox username may be, so a sentence is never mistaken for one. */
const ROBLOX_USERNAME = /^@?[A-Za-z0-9_]{3,20}$/;

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Google writes the timestamp in the sheet's own locale, so this stays lenient:
 * an unparseable value simply means no timestamp rather than a dropped application.
 */
function parseTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns the Form's responses tab into applications. Row one is the questions, and
 * every row after it is somebody's answers, in the same column order.
 */
function parseApplications(grid) {
  const [header, ...rows] = grid;
  if (!header || header.length === 0) return [];

  const questions = header.map((question) => question.trim());

  return rows
    .map((row, index) => {
      const answers = [];
      for (const [column, question] of questions.entries()) {
        const answer = (row[column] ?? '').trim();
        // An unanswered optional question is noise on the card.
        if (question && answer) answers.push({ question, answer });
      }
      return { rowIndex: index + 1, submittedAt: parseTimestamp(row[0] ?? ''), answers };
    })
    .filter((application) => application.answers.length > 0);
}

/** The first answer whose question mentions any of these words. */
function findAnswer(application, words) {
  for (const { question, answer } of application.answers) {
    const asked = question.toLowerCase();
    if (words.some((word) => asked.includes(word))) return answer;
  }
  return null;
}

/** A bare snowflake, or one pasted as a mention, becomes a real ping. */
function mentionFor(value) {
  const id = value?.match(/\d{17,20}/)?.[0];
  return id ? `<@${id}>` : null;
}

/** Whoever this application is from, as best the answers say. */
function applicationTitle(application) {
  const name = findAnswer(application, ['roblox', 'username', 'in-game', 'in game']);
  return truncate(name ?? findAnswer(application, ['discord']) ?? 'Unnamed application', 240);
}

/** One line for a list: who it is from, when it arrived, and who to ping. */
function applicationLine(application) {
  const mention = mentionFor(findAnswer(application, ['discord']));
  const when = application.submittedAt
    ? ` · <t:${Math.floor(application.submittedAt.getTime() / 1000)}:R>`
    : '';
  return `\`#${application.rowIndex}\` **${applicationTitle(application).slice(0, 60)}**${mention ? ` ${mention}` : ''}${when}`;
}

function applicationEmbed(application) {
  const name = findAnswer(application, ['roblox', 'username', 'in-game', 'in game']);
  const discord = findAnswer(application, ['discord']);
  const mention = mentionFor(discord);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(name ?? discord ?? 'New application', 240))
    .setFooter({ text: `Application #${application.rowIndex}` });

  const lead = [mention, name && discord && !mention ? `Discord: ${discord}` : null]
    .filter(Boolean)
    .join(' · ');
  if (lead) embed.setDescription(lead);

  if (application.submittedAt) embed.setTimestamp(application.submittedAt);

  // The timestamp column is already the embed's own timestamp, so skip it here.
  const shown = application.answers.filter((_, index) => index > 0 || !application.submittedAt);

  for (const { question, answer } of shown.slice(0, MAX_FIELDS)) {
    embed.addFields({
      name: truncate(question, 256),
      value: truncate(answer, MAX_FIELD_VALUE),
      inline: answer.length <= 40,
    });
  }

  const hidden = shown.length - MAX_FIELDS;
  if (hidden > 0) embed.addFields({ name: 'More', value: `${hidden} further answer(s) in the sheet.` });

  if (config.applications.formUrl) {
    embed.setURL(config.applications.formUrl);
  }

  return embed;
}

/**
 * The applicant's Roblox username, but only when the answer is unambiguously one.
 * "Bob" is a username; "my main is Bob" is not, and guessing at it could get the
 * wrong person accepted into the group.
 */
function applicantUsername(application) {
  const answer = findAnswer(application, ['roblox', 'username', 'in-game', 'in game']);
  if (!answer) return null;
  const trimmed = answer.trim();
  return ROBLOX_USERNAME.test(trimmed) ? trimmed.replace(/^@/, '') : null;
}

function applicantDiscordId(application) {
  return findAnswer(application, ['discord'])?.match(/\d{17,20}/)?.[0] ?? null;
}

/**
 * Accept / Deny under each application. Everything the buttons need travels in the
 * custom id, so they keep working after a restart without any stored state.
 */
function applicationComponents(application) {
  const args = [
    String(application.rowIndex),
    applicantUsername(application) ?? '-',
    applicantDiscordId(application) ?? '-',
  ];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(encodeId(Actions.AppAccept, ...args)).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(encodeId(Actions.AppDeny, ...args)).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  // Only offered when there is a Roblox username to look up; a button that can only
  // ever answer "I do not know who that is" is worse than no button.
  if (isRovuewConfigured() && applicantUsername(application)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId(Actions.AppCheck, ...args))
        .setLabel('Background check')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [row];
}

const DECISION_FIELDS = ['Accepted', 'Denied'];

/** True once somebody has decided this application, so a double click cannot stack. */
function isDecided(embed) {
  return (embed.fields ?? []).some((field) => DECISION_FIELDS.includes(field.name));
}

/** Recolours the posted card and records who decided it. */
function markDecided(
  embed,
  options,
) {
  return EmbedBuilder.from(embed)
    .setColor(options.accepted ? COLOR_ACCEPTED : COLOR_DENIED)
    .addFields({
      name: options.accepted ? 'Accepted' : 'Denied',
      value: truncate([`By <@${options.actorId}>`, options.note].filter(Boolean).join('\n'), MAX_FIELD_VALUE),
    });
}

function isApplicationsConfigured() {
  return Boolean(config.applications.channelId && config.applications.spreadsheetId);
}

/**
 * Posts each new row of the Form's response sheet to the applications channel.
 *
 * Google Forms has no API for reading responses, so the Form's linked spreadsheet is
 * the source. Rows only ever get appended, so remembering how many have been posted
 * is enough to avoid posting one twice.
 */
class ApplicationWatcher {
  running = false;

  constructor(
    client,
    store,
  ) {
    this.client = client;
    this.store = store;
  }

  /** Every application in the sheet, oldest first, as the rows are ordered. */
  async fetchAll() {
    return parseApplications(await this.client.read(a1(config.applications.tab, 'A1:Z1000')));
  }

  /** How many rows have been posted to the channel. Everything after this is unseen. */
  async cursor() {
    return (await this.store.getSetting(CURSOR_KEY)) ?? 0;
  }

  async setCursor(rows) {
    await this.store.setSetting(CURSOR_KEY, Math.max(0, rows));
  }

  /** Posts one card to the applications channel, buttons and all. */
  async postOne(discord, application) {
    const channel = await resolveSendableChannel(discord, config.applications.channelId);
    if (!channel) {
      log.warn(`Cannot post in the applications channel ${config.applications.channelId}`);
      return false;
    }

    try {
      await channel.send({
        embeds: [applicationEmbed(application)],
        components: applicationComponents(application),
      });
      return true;
    } catch (error) {
      log.error(`Could not post application #${application.rowIndex}: ${describeError(error)}`);
      return false;
    }
  }

  async poll(discord) {
    if (this.running) return 0;
    this.running = true;

    try {
      const channel = await resolveSendableChannel(discord, config.applications.channelId);
      if (!channel) {
        log.warn(`Cannot post in the applications channel ${config.applications.channelId}`);
        return 0;
      }

      const applications = await this.fetchAll();
      const posted = await this.cursor();

      if (applications.length < posted) {
        // Rows were deleted from the sheet; re-align rather than post everything again.
        log.warn(`The responses tab shrank from ${posted} to ${applications.length} rows; resetting the cursor`);
        await this.store.setSetting(CURSOR_KEY, applications.length);
        return 0;
      }

      const fresh = applications.slice(posted);
      if (fresh.length === 0) return 0;

      let sent = 0;
      for (const application of fresh) {
        try {
          await channel.send({
            embeds: [applicationEmbed(application)],
            components: applicationComponents(application),
          });
          sent += 1;
          // Save after each one, so a failure halfway does not repost the earlier ones.
          await this.store.setSetting(CURSOR_KEY, posted + sent);
        } catch (error) {
          log.error(`Could not post application #${application.rowIndex}: ${describeError(error)}`);
          break;
        }
      }

      if (sent > 0) log.info(`Posted ${sent} new application(s)`);
      return sent;
    } finally {
      this.running = false;
    }
  }

  /** Treats everything already in the sheet as seen, so a first run is not a flood. */
  async skipExisting() {
    const count = (await this.fetchAll()).length;
    await this.setCursor(count);
    return count;
  }

  async hasCursor() {
    return (await this.store.getSetting(CURSOR_KEY)) !== null;
  }
}

function createApplicationWatcher(store) {
  if (!isApplicationsConfigured()) return null;

  const client = createSheetsClient(config.applications.spreadsheetId);
  if (!client) return null;

  log.info(`Watching "${config.applications.tab}" for new applications`);
  return new ApplicationWatcher(client, store);
}

module.exports = { parseApplications, applicationTitle, applicationLine, applicationEmbed, applicantUsername, applicantDiscordId, applicationComponents, DECISION_FIELDS, isDecided, markDecided, isApplicationsConfigured, ApplicationWatcher, createApplicationWatcher };
