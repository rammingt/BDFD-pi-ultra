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

## Web panel

Edit commands and settings from a browser or your phone instead of the terminal.

* File list with every command, and an editor with colors and `$` suggestions
* **Save** puts a command live right away
* **Check** points out typos in function names, a `[` that's never closed, and a `$if` that's missing its `$endif`
* **Test** runs the code in the editor, even before saving, and shows what the bot would send, with embeds, buttons and files
* **Settings** edits `.env`. Passwords and keys are never shown, only replaced
* **Logs** shows what the bot printed, and there's a button to restart it
* **Functions** is a searchable list. Tap one to put it in the editor

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
| `@type prefix` | `prefix`, `slash`, `both`, `button`, `join`, `leave`, `ready`, `always` (every message), `interval`, `snippet` (shared code for `$include`) |
| `@aliases a, b` | Extra triggers |
| `@description ...` | Slash command description |
| `@option name:type:description:required` | Slash option (`string`, `integer`, `number`, `boolean`, `user`, `channel`, `role`) — read it with `$message[name]` |
| `@every 1h` | For `@type interval` (use `$useChannel[id]` to choose where it posts) |

**Buttons:** `$addButton[no;vote:yes;Yes;success]` + a command with `@type button` and `@name vote` handles every button whose ID is `vote` or starts with `vote:`. `$message[1]` is the part after the colon.

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
Operators: `== != > < >= <=`, joined with `&&` / `||`. Numbers compare numerically.

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
- **Files:** `$attachFile[name;content]` sends text as a file with the reply (up to 10)
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

## Differences from BDFD
- `$dm` works in buttons and slash commands too: the reply goes to DMs and the channel gets a short "Sent to your DMs".
- Mentions are **off by default** in replies (safer); use `$allowMention` to ping.
- Error messages name the failing function; `$suppressErrors[msg]` replaces them.
- A line that only has functions on it and prints nothing leaves no blank line in the message.
- `$stop` throws away text written before it. Use `$stop[message]` or `$onlyIf[condition;message]` to reply and stop.
- Scripts are sandboxed: no `eval`, loops capped, a step limit stops infinite loops.
