# BDX — BDFD Pi Ultra

A **Bot Designer for Discord–style language** that runs on your own Raspberry Pi.
If you know BDFD, you already know BDX: `$functions[with;arguments]`, `$if`, `$onlyIf`, variables, embeds, buttons.

### Why it's faster than hosted BDFD
- **Runs next to the bot.** No shared hosting queue; commands typically finish in **~1 ms** plus Discord's network time.
- **Compiled once.** Each command is parsed into a tree when loaded (and on hot-reload), not re-parsed every message.
- **O(1) command lookup** by trigger/alias instead of checking every command.
- **Variables in RAM**, saved to disk in batches (atomic writes, easy on the SD card).
- **Non-blocking `$wait`**: one sleeping command never holds up the others.
- **Lazy `$if`/`$onlyIf`**: branches that don't run are never evaluated (no wasted API calls).

## Setup on a Raspberry Pi
```bash
git clone <this repo> bdfd-pi-ultra && cd bdfd-pi-ultra
./deploy/install-pi.sh          # installs Node 22, deps, and a systemd service
nano .env                       # set DISCORD_TOKEN (and PREFIX if you want)
sudo systemctl start bdx
journalctl -u bdx -f            # logs
```
In the Discord Developer Portal enable the **Message Content** and **Server Members** intents.

## RoVuew

`commands/rovuew.bdx` is the RoVuew bot, rebuilt on BDX. The checks, the flag list, the automatic name scan, catalog search and share links are RoVuew's own code (in `src/rovuew/`), so they behave exactly the same. The commands are ordinary BDX you can edit in the panel.

| Command | What it does |
|---|---|
| `/check user type? discord?` | Checks accessories (or `type:` clothing or badges) against the flag list, plus the automatic name scan. `type:full` checks all three at once, plus XTracker, Server Sweep and TASE |
| `/searchcatalog` | Searches the catalog and lets you add results to the flag list from a menu (admins) |
| `/resolvelink` | Turns a share link into an asset ID, name and link |
| `/flag action:add, remove or list` | The flag list (adding and removing needs an admin) |
| `/autoflag action:add, remove or list` | Custom keywords for the automatic name scan (admins) |

Admins are people with Manage Server, the `ROVUEW_ADMIN_ROLE_ID` role, or an ID in `ROVUEW_ACCEPTED_USERS`. Every "View full list (JSON)" button DMs the file to whoever ran the command.

BDX also runs RoVuew's HTTP API (`/check`, `/checkclothes`, `/checkbadges`, `/fullcheck`, `/resolvelink`) on `ROVUEW_API_PORT` when `ROVUEW_API_KEYS` is set, so Verify keeps working. Stop the old RoVuew first, since both want the same port.

**Moving over from the old RoVuew:** copy its `data` folder (`flags.json` and `keywords.json`) into `data/rovuew`, and copy `ROBLOX_API_KEY`, `SERVERSWEEP_API_KEY` and `XTRACKER_API_KEY` from its `.env`. Its `API_KEYS` becomes `ROVUEW_API_KEYS`, `PORT` becomes `ROVUEW_API_PORT`, `ADMIN_ROLE_ID` becomes `ROVUEW_ADMIN_ROLE_ID` and `ACCEPTED_USER` becomes `ROVUEW_ACCEPTED_USERS`.

## Web panel

Edit commands and settings from a browser or your phone instead of the terminal.

* File list with every command, and an editor with colors and `$` suggestions
* **Save** puts a command live right away
* **Check** points out typos in function names, a `[` that's never closed, and a `$if` that's missing its `$endif`
* **Test** runs the code in the editor, even before saving, and shows what the bot would send, with embeds, buttons and files
* **Settings** edits `.env`. Passwords and keys are never shown, only replaced
* **Logs** shows what the bot printed, and there's a button to restart it
* **Functions** is a searchable list. Tap one to put it in the editor
* **RoVuew** edits the flag list (add, edit, remove, search) and the custom keywords, runs a quick check, and imports `flags.json` or `keywords.json` from an old RoVuew
* **Verify** runs a check by Discord ID and shows the same report the bot posts, and edits Verify's settings (`~/Verify/.env`, or `VERIFY_ENV_FILE`)

Turn it on by setting a password in `.env`, then restart:

```
PANEL_PASSWORD=pick a long password
PANEL_PORT=3200
```

Open `http://<your pi>:3200` on the same Wi-Fi, or `http://aesu:3200` from anything on your Tailscale. On a phone, use **Add to Home Screen** (Safari: share button; Chrome: menu) and it opens like an app.

The panel can change your bot's code and settings, so keep it private. Don't put it on Tailscale Funnel or open its port on your router.

## Writing commands
Put `.bdx` files anywhere in `commands/`. Files **hot-reload** on save — no restart.

```
@aliases p
@description Check the bot latency
$reply
🏓 Pong! $ping ms
```
That's a whole command: `!ping` (or `!p`). The name defaults to the file name.

Several commands per file? Separate them with a `---` line.

### Directives
| Directive | Meaning |
|---|---|
| `@name ping` | Command name (default: file name) |
| `@type prefix` | `prefix`, `slash`, `both`, `button`, `select` (menu picks), `modal` (form answers), `join`, `leave`, `ready`, `always` (every message), `interval`, `snippet` (shared code for `$include`), `hook` (a message the bot's own code sends, see below) |
| `@aliases a, b` | Extra triggers |
| `@description ...` | Slash command description |
| `@option name:type:description:required:choices` | Slash option (`string`, `integer`, `number`, `boolean`, `user`, `channel`, `role`), read it with `$message[name]`. Choices look like `badge=Badge\|accessory=Accessory`, or `from shiftTypes` for a list that follows your settings. Write `\:` for a colon inside a description |
| `@name flag add` | A space makes a slash subcommand: `/flag add`. Each one is listed on its own in Discord, so for a long list, one command with an `action` option is easier to find (see `commands/aesu/group.bdx`) |
| `@parent Manage flags` | Description of the `/flag` group (optional) |
| `@every 1h` | For `@type interval` (use `$useChannel[id]` to choose where it posts) |

**Buttons:** `$addButton[no;vote:yes;Yes;success]` + a command with `@type button` and `@name vote` handles every button whose ID is `vote` or starts with `vote:`. `$message[1]` is the part after the colon. A name can have colons in it too: `@name aesu:event_join` handles `aesu:event_join:abc:guard`, with `$message[1]` = `abc` and `$message[2]` = `guard`. Put `$updateMessage` in a button or menu command to redraw the message it was on instead of sending a new one.

**Forms:** a button or slash command can answer with a form instead: `$showModal[report:$authorID;Report a problem]` then `$addTextInput[what;What happened?;paragraph;yes]`. What gets typed goes to the `@type modal` command named like the form (`report`), which reads it with `$input[what]`.

**Hooks:** some messages aren't answers to anyone, like a shift log entry the bot posts when somebody starts a shift. The code that sends them runs a `@type hook` command by name and sends what it makes, so the wording and layout stay editable here. A hook reads what it is about with `$json[...]`. To try one in the panel, open it, press Test and type sample data as JSON in the arguments box. A hook that ends with `$stop` sends nothing.

**Switching a folder on and off:** a `when.txt` in a folder of `commands/` holding a setting name (like `AESU_ENABLED`) loads that folder only while the setting is `yes`.

### Conditions
Block form (BDFD 2 style) or inline:
```
$if[$message[1]==hi]
  Hello!
$elseif[$message[1]==bye]
  Goodbye!
$else
  ?
$endif

$if[$getUserVar[money]>=100;rich;poor]
```
Operators: `== != > < >= <=`, joined with `&&` / `||`. Numbers compare numerically. `==` and `!=` are looked for first, so a value with `<` or `>` in it, like a mention, compares as a whole.

### Variables
- `$var[name;value]` / `$var[name]` — temporary, this run only
- `$setUserVar` / `$getUserVar`, `$setServerVar` / `$getServerVar`, `$setVar` / `$getVar` — saved
- Defaults go in `commands/variables.json`: `{ "money": "0" }`
- `$userLeaderboard[money;10]` for leaderboards

### Useful tools
```bash
npx bdx check                 # validate all commands
npx bdx run daily             # run a command locally, no Discord needed
npx bdx run pay @someone 50
npx bdx repl                  # try code interactively
npx bdx functions             # list every function
npm test
```

## Functions (overview)
- **Control:** `$if $elseif $else $endif $onlyIf $stop $and $or $not $repeat $index $wait $c $suppressErrors`
- **Message:** `$message $message[n] $message[>] $argsCount $argsCheck $mentioned $noMentionMessage $customID $prefix $commandName`
- **Text:** `$replaceText $toUppercase $toLowercase $toTitleCase $length $cropText $trimSpace $checkContains $isNumber $isInteger $textSplit $splitText $getTextSplitLength $joinSplitText $repeatMessage $url`
- **Math:** `$math $calculate $sum $sub $multi $divide $modulo $round $floor $ceil $abs $sqrt $min $max $random $randomText $randomString $numberSeparator`
- **Time/limits:** `$ping $executionTime $uptime $date $time $getTimestamp $cooldown $serverCooldown $globalCooldown`
- **Users/server:** `$authorID $userID $username $displayName $userAvatar $authorAvatar $isBot $creationDate $findUser $serverName $guildID $membersCount $serverIcon $channelID $channelName $messageID $botID $hasRole $hasPerms $onlyPerms $onlyForIDs $onlyForServers`
- **Embeds:** `$title $description $color $footer $author $addField $thumbnail $image $addTimestamp`
- **Containers:** `$addContainer[id?;color?;spoiler?] $addTextDisplay[text;containerID?] $addSection[text;thumbnail URL?;containerID?] $addSeparator[divider yes/no?;small/large?;containerID?] $addMediaGallery[url;url...] $closeContainer`. Discord's newer message layout: a card with a colored edge, headings (`## Title`), small text (`-# note`), a picture beside text, image galleries, and buttons inside the card. Pieces go into the container you name, or the last one you opened. `$addButton` after `$addContainer` puts the button inside the card; use `$closeContainer` to put it below instead. A message that uses containers can't have embeds, and its text over 4000 characters is shortened to fit.
- **Response:** `$reply $ephemeral $deleteCommand $dm $useChannel $allowMention $addReactions $addButton $sendMessage $channelSendMessage`
- **Moderation:** `$ban $unban $kick $timeout $giveRole $takeRole $clear`
- **JSON/web:** `$jsonParse $json $jsonPretty $jsonSet $jsonStringify $httpAddHeader $httpGet $httpStatus $httpResult`
- **Files:** `$attachFile[name;content;base64?]` sends a file with the reply (up to 10). Add `base64` for pictures from an API, then show one in a card with `$addMediaGallery[attachment://name.png]`
- **Lists:** `$jsonList[path;template;limit?;separator?;more text?]` repeats a template for every item in a list: `{name}` reads a field, `{flag.url}` a nested one, `{#}` is the position, `{name|fallback}` fills in when a field is empty. `$jsonCount[path]` counts a list
- **Saving for later:** `$jsonStash[time?]` keeps the current JSON (15 minutes by default) and returns a token to put in a button's ID. `$jsonUnstash[token;ownerOnly?]` loads it back and returns `ok`, `expired` or `notyours`
- **Menus:** `$addSelectMenu[customID;placeholder?;min?;max?]`, then `$addSelectOption[label;value;description?]` or `$addSelectOptions[path;label template;value template;description template?;default template?]` to fill it from a list. Picks go to a `@type select` command named like the menu, which reads them with `$selectedValues[separator?]`
- **Buttons from a list:** `$addButtons[path;customID template;label template;style?;new row first?]` adds one button per item, five to a row
- **Forms:** `$showModal[customID;title] $addTextInput[box ID;label;short/paragraph?;required?;placeholder?;prefilled?;min?;max?] $input[box ID]`, and `$updateMessage` for buttons and menus
- **Shift tracker:** `$shift... $event... $promo... $squad... $group... $app... $admin... $aesu...` (see the shift tracker section)
- **RoVuew:** `$rvCheck $rvCooldown $rvIsAdmin $rvFlags $rvFlagAdd $rvFlagRemove $rvKeywords $rvKeywordAdd $rvKeywordRemove $rvSearch $rvSearchAdd $rvResolveLink` (see the RoVuew section)
- **Reuse:** `$include[name]` runs a `@type snippet` command in place, sharing variables, the HTTP result and the embed
- **Settings:** `$env[BDX_NAME]` reads a value from `.env`. Only names starting with `BDX_` work, so a command can't print your bot token.

In cooldown error messages, `%time%` is replaced with the time left. Use `\;`, `\]`, `\[`, `\$` to write those characters literally.

## Roblox verification (Verify)

`commands/verify.bdx` uses the Verify API running on the same Pi:

| Part | Who | What it does |
|---|---|---|
| `!verify` | Everyone | Checks their own account, gives the verified role if they pass, and logs the result for staff |
| `!check @user` | Staff with Manage Roles | Full report: Roblox profile, Discord account and server info, RoVuew, TASE, Server Sweep, XTracker and worn items, one card each |
| Join check | Automatic | Checks everyone who joins, posts the report in the log channel, and gives the role if they pass |
| Badge review button | Staff with Manage Roles | Most played games, badges from flagged or removed games, farming bursts and a badge timeline picture |
| Risk breakdown button | Staff with Manage Roles | A score for profile, inventory, badges, Discord and background checks, with the reason for every point |
| Full results button | Staff with Manage Roles | Under every report. DMs RoVuew's whole reply and Verify's whole reply as `.json` files to whoever pressed it. If their DMs are closed, it shows them there instead |

The report is one container card, kept in a snippet (`verifyreport`), so `!check` and the join check always look the same.

Add these to `.env` and restart with `sudo systemctl restart bdx`:

```
BDX_VERIFY_URL=http://localhost:8080
BDX_VERIFY_KEY=the API_KEY from ~/Verify/.env
BDX_VERIFIED_ROLE_ID=the role to give
BDX_VERIFY_LOG_CHANNEL=the staff channel for reports
```

The bot's role has to sit above the verified role in your server settings, or Discord won't let it give the role. The join check needs the **Server Members** intent, which BDX already asks for. Because both run on the Pi, BDX talks to Verify directly and nothing has to be public.

Buttons and slash commands that take longer than 2 seconds are deferred automatically, so a slow check doesn't fail with "This interaction failed".

## AESU shift tracker

The shift tracker is rebuilt on BDX. Its engine (the database, the presence watcher, events, ranks, squads, Google Sheets, the Roblox group, `/connect`'s web page) is the old tracker's own code in `src/aesu`, turned into plain JavaScript with its logic and comments kept, and it uses the **same database and tables**, so every link, shift and event carries over. Everything people see is BDX in `commands/aesu`, which you can edit in the panel like any other command.

Each area is one slash command with an `action` option (`/group action:promote player:...`), so the command list stays short. The code for each action is a snippet named after it, like `group_promote`, right under the command.

| File | Commands |
|---|---|
| `shifts.bdx` | `/shift action:manage or history`, `/checktime`, `/connect`, `/disconnect`, the shift panel buttons, join prompts, the shift log, the auto end DM |
| `events.bdx` | `/event action:create, list, info, end or cancel`, the event post and its sign up buttons, the start ping, the host away ping |
| `promotions.bdx` | `/promote action:request, check, ranks or sync`, the request card with Approve and Deny |
| `squads.bdx` | `/squad action:info, set, clear or roster` |
| `group.bdx` | `/group action:pending, accept, decline, rank, promote, demote, exile, info or roles`, the group log |
| `applications.bdx` | `/applications action:list or post`, the application card, the reason form, background checks, the applicant's DM |
| `admin.bdx` | `/admin action:panel, endshift, endevent, addtime or removetime`, the admin log |
| `diagnose.bdx` | `/diagnose` |
| `academy.bdx` | `/academy action:info, set, remove, list or sync`, with the four phases: Orientation (1), Academy (2), Final exam (3) and Waiting for division (4) |

The folder only loads while `AESU_ENABLED=yes`. The panel's **Shifts** page shows who is on shift (and can end a shift), and brings the old tracker's settings over in one paste.

The academy keeps an Academy tab in your Google Sheet. Staff move people with `/academy action:set` or by changing the Phase cell in the sheet, and each phase's Discord role follows either way. Adding a row with a Discord ID and a phase adds them; deleting the row takes them out. The sheet is read every few minutes, or straight away with `/academy action:sync`. Set the four roles with `ACADEMY_ROLE_ORIENTATION`, `ACADEMY_ROLE_ACADEMY`, `ACADEMY_ROLE_FINAL_EXAM` and `ACADEMY_ROLE_WAITING`, and who may move people with `ACADEMY_STAFF_ROLE_ID`.

Linking no longer uses Roblox's sign in page. `/connect` asks Bloxlink who the member is and they confirm it. If Bloxlink doesn't know them, they run `/connect username:...` and prove the account is theirs by putting a short code in their Roblox profile About. The Bloxlink key is read from Verify's settings, or set `BLOXLINK_KEY` and `BLOXLINK_GUILD_ID`.

Button IDs are the same as the old tracker's, so buttons on posts the old bot already made keep working if BDX logs in as that same bot. Background checks now go straight to the RoVuew inside BDX.

### Moving over from the old tracker

The old tracker runs as `aesu-shift-tracker` from `/opt/aesu-shift-tracker`. This moves it into BDX without losing anything, and the last step undoes it if you need to. Paste each box into the Pi's terminal one at a time.

**1. Pick which bot runs it.** BDX can only log in as one bot. Two choices:

* **Recommended: BDX logs in as the tracker's bot.** Everyone already knows that bot, its roles are set up, and buttons on old event posts, applications and promotion cards keep working. Put the tracker bot's token in BDX's Settings as `DISCORD_TOKEN`. Your Verify and RoVuew commands move to that bot too, so it has to be in the same servers.
* **Keep BDX's own bot.** Invite it to the AESU server and give its role **Manage Roles**, placed above the duty and squad roles. Buttons on posts the old bot made stop working. Kick the old bot afterwards, or its dead commands stay in the list.

**2. Update BDX.**
```bash
cd ~/bdfd-pi-ultra
git pull
npm install
```

**3. Copy the old settings over.** Show them:
```bash
sudo cat /opt/aesu-shift-tracker/.env
```
Copy everything it prints. Open the panel, go to **Shifts**, then **Import old settings**, paste, and press **Import**. Say **no** to restarting for now. `PORT` becomes `AESU_PORT`, anything BDX already uses gets an `AESU_` name so both keep working, and the old bot token and RoVuew address are left out.

**4. Stop the old tracker** (both want port 3000), and put its service file aside so the Pi panel doesn't keep warning that it's down:
```bash
sudo systemctl stop aesu-shift-tracker
sudo systemctl disable aesu-shift-tracker
sudo mv /etc/systemd/system/aesu-shift-tracker.service /opt/aesu-shift-tracker/aesu-shift-tracker.service.bak
sudo systemctl daemon-reload
```

**5. Start BDX with the tracker.**
```bash
sudo systemctl restart bdx
journalctl -u bdx -n 80 --no-pager
```
Look for `Shift tracker started`, `HTTP server listening on :3000` and `Roblox presence account`. Then run `/diagnose` in Discord: every section should be ✅, apart from ones you never set up.

The OAuth page, `/health` and the privacy and terms pages are on the same port as before, so the Tailscale Funnel address and the Roblox app's redirect URI don't change. The Pi agent (`aesu-agent`) keeps running as it is. Its "Shift bot" row will say *Not installed*, since that service is now BDX (`sudo systemctl status bdx`).

**Going back**, if something is wrong:
```bash
sudo systemctl stop bdx
sudo mv /opt/aesu-shift-tracker/aesu-shift-tracker.service.bak /etc/systemd/system/aesu-shift-tracker.service
sudo systemctl daemon-reload
sudo systemctl enable --now aesu-shift-tracker
```
Then set `AESU_ENABLED=no` in BDX's Settings and start BDX again with `sudo systemctl start bdx`. Nothing in the database was changed by the move, so the old tracker carries on from where BDX left off.

### The functions behind it

Each one does the work and leaves what it found in `$json`, like RoVuew's. Actions return `ok` or a short reason word, with the reason in plain words in `$json[error]`, so a command can show that or its own text:

```
$var[r;$shiftStart[$message[1];panel]]
$onlyIf[$var[r]==ok;$json[error]]
```

`$shiftPanel $shiftStart $shiftBreak $shiftResume $shiftEnd $shiftHistory $shiftTime $shiftPromptAnswer $connectLink $disconnect $robloxLink`, `$eventCreate $eventList $eventInfo $eventEnd $eventCancel $eventSignup`, `$promoCheck $promoRequest $promoRanks $promoSync $promoDecide`, `$squadInfo $squadSet $squadClear $squadRoster`, `$groupOn $groupPending $groupDecide $groupRank $groupStep $groupExile $groupInfo $groupRoles`, `$appOn $appList $appPost $appCard $appCheck $appDecide`, `$adminPanel $adminEndShift $adminEndEvent $adminAdjust`, and `$aesuOn $aesuAllowed[staff|admin|promotion|group|squad] $aesuRole $aesuJoinWarning $aesuDiagnose`. The comment above each one in `src/aesu/bdx.js` lists what it puts in `$json`.

## Differences from BDFD
- `$dm` works in buttons and slash commands too: the reply goes to DMs and the channel gets a short "Sent to your DMs".
- Mentions are **off by default** in replies (safer); use `$allowMention` to ping.
- Error messages name the failing function; `$suppressErrors[msg]` replaces them.
- A line that only has functions on it and prints nothing leaves no blank line in the message.
- `$stop` throws away text written before it. Use `$stop[message]` or `$onlyIf[condition;message]` to reply and stop.
- Scripts are sandboxed: no `eval`, loops capped, a step limit stops infinite loops.
