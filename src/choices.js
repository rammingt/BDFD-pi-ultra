'use strict';
// Slash option choices that come from settings rather than being written in the
// file, like the shift types. "@option type:string:What kind:required:from shiftTypes"
// asks the source called shiftTypes for them when the commands are registered.
const sources = new Map();

/** fn returns [{ name, value }] */
function registerChoices(name, fn) {
  sources.set(name.toLowerCase(), fn);
}

function choicesFrom(name) {
  const fn = sources.get(String(name).toLowerCase());
  if (!fn) {
    console.warn(`[bdx] no choice list called "${name}", so that option has no choices`);
    return [];
  }
  try { return fn() || []; } catch (e) { console.warn(`[bdx] the "${name}" choices failed: ${e.message}`); return []; }
}

module.exports = { registerChoices, choicesFrom };
