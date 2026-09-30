'use strict';
// Mirrors every shift change into SHIFT_LOG_CHANNEL_ID by editing one message per
// shift, so the channel reads as one tidy record per shift. The entry itself is the
// "shift log" hook, and the DM for a shift that closed itself is "shift auto end".
const { config } = require('../config/index');
const { createLogger, describeError } = require('../util/logger');
const ui = require('../ui');
const { shiftView } = require('../views');

const log = createLogger('discord:shiftlog');

async function postNew(manager, shift) {
  const message = await ui.post(config.discord.logChannelId, 'shift log', shiftView(shift), { about: shift.discordId, guildId: shift.guildId });
  if (message) await manager.attachLogMessage(shift.id, message.channelId, message.id);
}

/** Tells a member their shift closed itself, since they are unlikely to be watching Discord. */
async function notifyAutoEnd(shift) {
  if (shift.endReason !== 'left_game' && shift.endReason !== 'max_duration') return;
  await ui.dm(shift.discordId, 'shift auto end', { ...shiftView(shift), maxHours: config.tracking.maxShiftHours });
}

function registerShiftLogging(manager) {
  manager.onChange(async (change, shift) => {
    if (config.discord.logChannelId) {
      try {
        const edited = change !== 'started' && shift.logChannelId && shift.logMessageId
          && await ui.edit(shift.logChannelId, shift.logMessageId, 'shift log', shiftView(shift), { about: shift.discordId, guildId: shift.guildId });
        if (!edited) await postNew(manager, shift);
      } catch (error) {
        log.error(`Failed to write the shift log for ${shift.id}: ${describeError(error)}`);
      }
    }

    if (change === 'ended') await notifyAutoEnd(shift);
  });
}

module.exports = { registerShiftLogging };
