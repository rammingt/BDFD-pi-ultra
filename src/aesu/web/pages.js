'use strict';
const { config } = require('../config/index');

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ACCENT = {
  success: '#3ba55d',
  error: '#ed4245',
  info: '#5865f2',
};

/** Standalone page shown in the browser after the Roblox redirect. */
function renderPage(variant, heading, body) {
  const accent = ACCENT[variant];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #1e1f22; color: #f2f3f5;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    max-width: 30rem; width: 100%; background: #2b2d31; border: 1px solid #3f4147;
    border-top: 4px solid ${accent}; border-radius: 12px; padding: 32px;
  }
  h1 { margin: 0 0 12px; font-size: 1.4rem; }
  p { margin: 0 0 12px; color: #c7ccd1; }
  p:last-child { margin-bottom: 0; }
  code { background: #1e1f22; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .muted { color: #949ba4; font-size: 0.875rem; }
</style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(heading)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function successPage(displayName, username) {
  return renderPage(
    'success',
    'Roblox account linked',
    `<p>You are now linked as <strong>${escapeHtml(displayName)}</strong> (<code>${escapeHtml(username)}</code>).</p>
     <p>You can close this tab and go back to Discord. The bot will ping you the next time it sees you in a tracked game.</p>
     <p class="muted">Run <code>/disconnect</code> in Discord at any time to unlink.</p>`,
  );
}

function errorPage(message) {
  return renderPage(
    'error',
    'Could not link your account',
    `<p>${escapeHtml(message)}</p>
     <p class="muted">Run <code>/connect</code> in Discord to get a fresh link.</p>`,
  );
}

function landingPage() {
  return renderPage(
    'info',
    'Shift tracker',
    `<p>This is the OAuth endpoint for the Roblox shift tracking bot.</p>
     <p class="muted">Start from Discord with <code>/connect</code>.</p>`,
  );
}

const LAST_UPDATED = '17 September 2026';

/** Wider, plainer layout than the OAuth cards; these are documents, not notices. */
function renderDocument(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px; background: #1e1f22; color: #f2f3f5;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 32px 0 8px; color: #fff; }
  p, li { color: #c7ccd1; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 6px; }
  code { background: #2b2d31; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .updated { color: #949ba4; font-size: 0.875rem; margin: 0 0 8px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #3f4147; color: #949ba4; font-size: 0.875rem; }
  a { color: #8ea1ff; }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="updated">Last updated ${LAST_UPDATED}</p>
    ${body}
    <footer>Not affiliated with, endorsed by, or sponsored by Roblox Corporation or Discord Inc.</footer>
  </main>
</body>
</html>`;
}

function contactLine() {
  const contact = config.legal.contact;
  return contact
    ? `<p>${escapeHtml(contact)}</p>`
    : '<p>Contact an administrator in the Discord server where this bot is installed.</p>';
}

function privacyPage() {
  const operator = escapeHtml(config.legal.operator);
  return renderDocument(
    `${config.legal.operator} Shift Tracker - Privacy Policy`,
    `<p>${operator} Shift Tracker is a Discord bot that records how long staff spend on shift inside a
      Roblox game. This policy explains exactly what it stores and why.</p>

    <h2>What we collect</h2>
    <ul>
      <li><strong>Your Discord user ID</strong>, and the ID of the server you used the bot in.</li>
      <li><strong>Your Roblox user ID, username and display name</strong>, from the <code>openid</code> and
        <code>profile</code> scopes you approve when you authorise the app.</li>
      <li><strong>An access token and refresh token</strong> issued by Roblox, kept so the link can be
        verified and later revoked.</li>
      <li><strong>Which Roblox game you are currently in</strong>, read from Roblox's presence API. This is
        only visible to us when your own Roblox privacy settings allow it, and we never see anything else
        about your account.</li>
      <li><strong>Shift records</strong>: start and end times, break time, the kind of shift, and the game
        it was worked in.</li>
      <li><strong>Event sign-ups and attendance time</strong>, where your community runs events.</li>
      <li><strong>Promotion progress</strong>, which is worked out from the two above and your Roblox group rank.</li>
    </ul>

    <h2>What we do not collect</h2>
    <ul>
      <li>No email address, password or payment information.</li>
      <li>No Discord message content. The bot only sees the commands and buttons you use with it.</li>
      <li>Nothing about your Roblox account beyond your public profile and your join status.</li>
    </ul>

    <h2>Why we collect it</h2>
    <p>Solely to record time on shift and show it back to you and your staff team. Your data is never sold,
      rented, or used for advertising or profiling.</p>

    <h2>Where it is stored</h2>
    <p>In a private database operated by the community that runs this bot. Tokens are stored in that same
      database and are only ever sent back to Roblox.</p>

    <h2>How long we keep it</h2>
    <ul>
      <li>Your account link and tokens are kept until you unlink.</li>
      <li>Running <code>/disconnect</code> in Discord revokes the Roblox token and deletes the link
        immediately.</li>
      <li>Shift history is kept after unlinking, so team records stay intact. Ask an administrator if you
        want yours deleted as well.</li>
    </ul>

    <h2>Your choices</h2>
    <ul>
      <li>Run <code>/disconnect</code> at any time to unlink and stop all tracking.</li>
      <li>Restrict your Roblox join-status privacy setting to stop the bot seeing which game you are in.</li>
      <li>Ask a server administrator to delete your shift records.</li>
    </ul>

    <h2>Who else sees it</h2>
    <p>Discord and Roblox, as necessary to operate the bot, and the hosting provider that runs it. Where a
      community chooses to enable it, records may also be written to a private Google Sheet that only their
      staff can read. No other third party receives your data.</p>

    <h2>Children</h2>
    <p>This bot is used through Discord and Roblox, and you must meet the minimum age required by both of
      those services to use it.</p>

    <h2>Changes</h2>
    <p>If this policy changes, the date at the top of this page changes with it.</p>

    <h2>Contact</h2>
    ${contactLine()}`,
  );
}

function termsPage() {
  const operator = escapeHtml(config.legal.operator);
  return renderDocument(
    `${config.legal.operator} Shift Tracker - Terms of Service`,
    `<p>These terms cover your use of the ${operator} Shift Tracker Discord bot and the Roblox account link
      it offers. By authorising the app or using the bot's commands, you accept them.</p>

    <h2>What the service does</h2>
    <p>It links your Discord account to your Roblox account, watches whether you are in a configured Roblox
      game, and records that time as shifts your staff team can review.</p>

    <h2>Using it</h2>
    <ul>
      <li>Follow the Discord Terms of Service and the Roblox Terms of Use while using it.</li>
      <li>Link only a Roblox account you own.</li>
      <li>Do not try to falsify recorded time, interfere with the bot, or use it to harass anyone.</li>
      <li>Do not attempt to access records belonging to other members.</li>
    </ul>

    <h2>Your account link</h2>
    <p>You may unlink at any time with <code>/disconnect</code>, which revokes the token Roblox issued. You
      can also remove the app's access from your Roblox account settings.</p>

    <h2>Availability</h2>
    <p>The bot is provided as is, with no guarantee of uptime or of accuracy. Recorded time depends on
      Roblox's presence API and on your own privacy settings, and may be incomplete. Do not rely on it as
      the sole record of anything that matters.</p>

    <h2>Suspension</h2>
    <p>The community operating this bot may remove your access to it at any time, particularly if these
      terms are broken.</p>

    <h2>Liability</h2>
    <p>To the fullest extent the law allows, the operators are not liable for any loss arising from use of
      the bot, including lost or inaccurate shift records.</p>

    <h2>Not affiliated with Roblox or Discord</h2>
    <p>This is an independent community tool. It is not affiliated with, endorsed by, or sponsored by Roblox
      Corporation or Discord Inc. Roblox and Discord are trademarks of their respective owners.</p>

    <h2>Changes</h2>
    <p>If these terms change, the date at the top of this page changes with them. Continuing to use the bot
      means accepting the updated terms.</p>

    <h2>Contact</h2>
    ${contactLine()}`,
  );
}

module.exports = { renderPage, successPage, errorPage, landingPage, privacyPage, termsPage };
