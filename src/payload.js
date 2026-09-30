'use strict';
// Turns a command result from Engine.execute() into a message Discord accepts.
// Shared by the bot and by anything that sends a hook's output on its own.
const { AttachmentBuilder, MessageFlags } = require('discord.js');

// Discord refuses a container message with more than 4000 characters of text in
// total, so shorten the longest text blocks until it fits instead of failing.
function fitText(components, limit = 4000) {
  const texts = [];
  const walk = (list) => list.forEach((c) => {
    if (c.type === 10) texts.push(c);
    if (c.components) walk(c.components);
  });
  walk(components);
  let over = texts.reduce((n, t) => n + t.content.length, 0) - limit;
  while (over > 0) {
    const longest = texts.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    const cut = Math.min(over + 3, longest.content.length - 40);
    if (cut <= 3) break;
    longest.content = `${longest.content.slice(0, longest.content.length - cut)}...`;
    over -= cut - 3;
  }
  return components;
}

function payloadOf(r) {
  if (!r.content && !r.embeds.length && !r.files?.length && !r.layout?.length) return null;
  const files = (r.files || []).map((f) => new AttachmentBuilder(Buffer.from(f.content, f.encoding || 'utf8'), { name: f.name }));
  const allowedMentions = r.allowMentions ? undefined : { parse: [] };
  if (r.layout?.length) {
    // Container layout: no content or embeds allowed, so text becomes a text block
    // and files are shown with file blocks.
    if (r.embeds.length) console.warn(`[bdx] ${r.command || 'a command'} used embeds and containers together. The embed was left out.`);
    const components = [];
    if (r.content) components.push({ type: 10, content: r.content.slice(0, 4000) });
    components.push(...r.layout, ...r.components);
    // Files already shown somewhere, like a chart in a gallery, don't get a second file block.
    const used = JSON.stringify(components);
    for (const f of r.files) {
      if (!used.includes(`attachment://${f.name}`)) components.push({ type: 13, file: { url: `attachment://${f.name}` } });
    }
    return { components: fitText(components), files, flags: MessageFlags.IsComponentsV2, allowedMentions };
  }
  return { content: r.content ? r.content.slice(0, 2000) : undefined, embeds: r.embeds, components: r.components, files, allowedMentions };
}

// Add a line of text to a payload, in whichever layout it uses.
const withNote = (payload, note) => (payload.flags === MessageFlags.IsComponentsV2
  ? { ...payload, components: [{ type: 10, content: note }, ...payload.components] }
  : { ...payload, content: `${payload.content ? `${payload.content}\n` : ''}${note}`.slice(0, 2000) });

// An edit has to say what goes away too: a message moving from the old layout to
// containers must lose its content and embeds, and one moving back its components.
function asEdit(payload) {
  if (payload.flags === MessageFlags.IsComponentsV2) return { ...payload, content: null, embeds: [] };
  return { ...payload, content: payload.content ?? null, embeds: payload.embeds ?? [], components: payload.components ?? [] };
}

module.exports = { payloadOf, fitText, withNote, asEdit };
