# Rumbleverse Revival Bot

The Discord bot for the Rumbleverse Revival server. It is built as a set of independent features, each one a group of slash commands, so new features can be added without touching the existing ones.

## Features

| Feature | Commands | Who can use it |
| --- | --- | --- |
| [Settings](#settings) | `/settings` | Manage Server |
| [Logs channel](#logs-channel) | `/settings logs-channel` | Manage Server |
| [Moderation](#moderation) | `/ban`, `/unban`, `/softban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/note`, `/purge`, `/case`, `/modlogs`, `/clearwarns` | The matching Discord permission, or the mod role |
| [Channel and member tools](#channel-and-member-tools) | `/lock`, `/unlock`, `/slowmode`, `/role`, `/nick` | The matching Discord permission, or the mod role |
| [Server log](#server-log) | `/settings server-log-channel`, `/settings log-event`, `/settings log-ignore` | Manage Server |
| [Country roles](#country-roles) | `/country`, `/country-staff`, `/country-help` | Everyone (`/country`), the staff role (`/country-staff`), Manage Server (`/country-help`) |
| [Web dashboard](#web-dashboard) | https://rumbleverse.cedartechsolutions.ca | Manage Server, or a dashboard role |

Every reply is translated into English, Spanish, German, French, Portuguese, Italian or Arabic (see [Languages](#languages)).

### Settings

**`/settings`** (Manage Server only) holds every per-server setting. Replies are only visible to the admin.

- **`/settings staff-role role:<role>`** chooses the staff role. Only members with it can use `/country-staff`. `@everyone` is refused.
- **`/settings country-channel channel:<channel>`** limits `/country` to one channel (threads inside it work too) and keeps that channel clean: every message posted in it is deleted right away, including staff's and admins', so it only holds `/country` and the bot's own posts (like the `/country-help` guide). Threads inside it are not cleaned. The bot needs **View Channel** and **Manage Messages** there; `/settings` warns the admin if it doesn't have them. Messages already in the channel before it was set are left alone.
- **`/settings logs-channel channel:<channel>`** chooses the channel where the bot logs everything members do with it (see [Logs channel](#logs-channel)). The bot needs **View Channel**, **Send Messages**, **Embed Links** and **Attach Files** there; `/settings` warns the admin if it doesn't have them.
- **`/settings mod-log-channel channel:<channel>`** chooses where moderation cases are posted (see [Moderation](#moderation)). Without one, cases go to the logs channel.
- **`/settings server-log-channel channel:<channel>`** chooses where server events are logged (see [Server log](#server-log)). Nothing is logged until it's set.
- **`/settings mod-role role:<role>`** chooses the role that can use the moderation, channel and member commands without the Discord permission. Until one is set, the staff role does. `@everyone` is refused.
- **`/settings log-event event:<event> enabled:<true | false>`** switches one kind of server-log event off or back on: edited messages, deleted messages, bulk deletions, members joining, members leaving, or nickname, role and timeout changes.
- **`/settings log-ignore channel:<channel or category>`** stops logging edited and deleted messages from a channel (and its threads), or every channel in a category. Run it again on the same channel to log it again.
- **`/settings clear setting:<Staff role | /country channel | Logs channel | Mod-log channel | Server-log channel | Mod role | Switched-off log events | Ignored log channels>`** resets one setting. Clearing the logs channel stops logging; clearing the log events switches them all back on.
- **`/settings show`** lists the current settings.

Settings are saved in `data/bot.db` (see [Operational notes](#operational-notes)). If the staff role, the mod role or any of these channels is deleted, the bot forgets it automatically. The log channels need **View Channel**, **Send Messages**, **Embed Links** and **Attach Files**; `/settings` warns the admin if any is missing.

### Logs channel

Once an admin runs `/settings logs-channel`, the bot posts a compact embed there (member name and avatar, two or three lines, user ID in the footer) for:

- **Every command anyone runs**, with who ran it, the channel, the options they picked or typed, and how it ended:
  - **Success** (green): it did what was asked.
  - **Refused** (yellow): not allowed, bad input, or nothing to do (for example a second `/country`, an unknown country, or `/country-staff` without the staff role).
  - **Failed** (orange): allowed, but the bot couldn't do it, usually because of a missing permission or the role hierarchy.
  - **Error** (red): the command crashed, or Discord cancelled it. The details stay in the bot's console log.
  The embed includes the reply the member got, in English.
- **Every message deleted from the `/country` channel**, with its author, the full text exactly as written (in a code block, so it can't ping or format anything), every attachment and sticker, and the user and message IDs. Attachments are downloaded before the message is deleted and re-uploaded with the log entry, since their links stop working once the message is gone (up to 8 MB and 10 files per message; anything bigger is listed with its name and size). If the bot can't delete messages there, that is logged once until a delete works again.

Showing the text needs the **Message Content** intent (see [Setup](#setup), step 1). If it's off, the bot still starts, warns in the console, and logs deleted messages without their text.

Autocomplete suggestions aren't logged. Log entries are always in English, since only staff read them. Mentions in log entries never ping anyone, and typed text is shown as code, so it can't add formatting. The bot needs **View Channel**, **Send Messages**, **Embed Links** and **Attach Files** in the logs channel; without Attach Files, entries are posted without the saved files. If the bot can't post there at all, commands keep working and the console log warns once until posting works again. Log entries contain what members wrote, so make the logs channel visible to staff only.

### Moderation

Dyno-style moderation. Every action gets a numbered case (per server, never reused), is posted in the mod-log channel, and the member is DMed when possible. Replies to the moderator are private; the mod log is the public record.

| Command | What it does | Permission |
| --- | --- | --- |
| `/ban user [reason] [duration] [delete-messages]` | Bans a member, or anyone by pasted user ID. With a `duration` (`1d`, `2w`, up to `365d`) it's a temporary ban: the bot lifts it when it ends, even after a restart, and records an Unban case. `delete-messages` also deletes their last hour to 7 days of messages. | Ban Members |
| `/unban user [reason]` | Lifts a ban (paste the user ID). | Ban Members |
| `/softban member [reason] [delete-messages]` | Bans and immediately unbans a member to wipe their recent messages (the last day unless `delete-messages` says otherwise). They can rejoin with an invite. | Ban Members |
| `/kick member [reason]` | Removes a member; they can rejoin with an invite. | Kick Members |
| `/timeout member duration [reason]` | Discord's own timeout (`10m`, `1h`, `1d`, up to `28d`): no chatting, reacting or talking. | Timeout Members |
| `/untimeout member [reason]` | Ends a timeout early. | Timeout Members |
| `/warn member reason` | A warning: DMed to the member and kept in their history. | Timeout Members |
| `/note user note` | A private note in someone's history (they can have left). The member isn't told. | Timeout Members |
| `/purge amount [member]` | Deletes up to 100 recent messages in the channel, optionally only one member's. Pinned messages and messages older than 14 days (a Discord limit) are kept. The mod log gets a `.txt` transcript of what was deleted. | Manage Messages |
| `/case view number` | Shows a case. | Timeout Members |
| `/case reason number reason` | Changes a case's reason; its mod-log post is updated too. | Timeout Members |
| `/case delete number` | Deletes a case. | Manage Server |
| `/modlogs user` | A member's last 20 cases, newest first, with the total. | Timeout Members |
| `/clearwarns user` | Deletes all of a member's warnings (other cases stay). Posted in the mod log. | Manage Server |

- **Who can moderate.** Members with the permission in the table, **or** with the mod role from `/settings mod-role` (the staff role from `/settings staff-role` until a mod role is set). `/case delete` and `/clearwarns` always need Manage Server. Discord hides each command from members without its permission; to show the commands to the mod role too, add the role under *Server Settings > Integrations > the bot*, or give the role the permission.
- **Hierarchy.** Nobody can act on themselves, the server owner or the bot, or on anyone whose highest role is equal to or above theirs (the owner can act on anyone). The bot also refuses when the member's highest role is equal to or above its own, and Discord never allows timing out administrators. These are checked before anything happens.
- **DMs.** The member is DMed in the server's language: before a ban, softban or kick (afterwards there's no shared server), after a timeout, timeout removal or warning. Notes are never sent. If their DMs are closed, the action still happens; the reply and the case say the DM couldn't be sent.
- **Audit log.** Discord's audit log shows the reason followed by `(by <moderator>)`, since the bot is the one acting.
- **Actions done outside the bot** (right-click > Ban, Kick or Timeout in Discord, or another bot) still get a case, with the moderator and reason read from the audit log. This needs **View Audit Log**; without it the moderator shows as unknown, and kicks can't be told apart from members leaving, so they aren't recorded.
- **Storage.** Cases live in `data/bot.db`, an SQLite database using Node's built-in `node:sqlite` (no extra install). Node prints an "SQLite is an experimental feature" warning at startup; that's expected.

The mod-log embeds show the case number, action, member, moderator, duration and end time, reason, and whether the DM arrived. They are in English like the other logs; `/case view` and `/modlogs` reply in the moderator's language.

### Channel and member tools

| Command | What it does | Permission |
| --- | --- | --- |
| `/lock [channel] [reason]` | Stops `@everyone` from posting and creating threads in a channel (this one by default), and posts a notice there first. | Manage Channels |
| `/unlock [channel] [reason]` | Undoes `/lock`, resetting those permissions to the channel's default, and posts a notice. | Manage Channels |
| `/slowmode duration [channel]` | Members can post once per `duration` (`10s`, `5m`, `1h`, up to `6h`; `off` turns it off). | Manage Channels |
| `/role add\|remove member role [reason]` | Gives or takes a role. Nobody can hand out a role at or above their own highest role or the bot's, `@everyone`, or a role managed by a bot or integration. | Manage Roles |
| `/nick member [nickname]` | Changes a member's nickname; leave it empty to reset it. | Manage Nicknames |

The mod role can use these too, and the same hierarchy rules as moderation apply (moderators may change their own roles and nickname). Each change is posted in the mod-log channel. The bot needs **Manage Channels** and **Manage Roles** in the channel to lock it, **Manage Channels** for slowmode, and **Manage Nicknames** for `/nick`; replies say so when it can't.

### Server log

Once an admin runs `/settings server-log-channel`, the bot posts there when:

- **A message is edited** (before and after, with a link to it) or **deleted** (its text and attachment names). Messages the bot never saw (sent before it last started) are logged without their text.
- **Messages are bulk-deleted** by someone else, with a `.txt` transcript.
- **A member joins** (account age, flagged if under 7 days old, and member count) or **leaves** (when they joined and the roles they had).
- **A member's nickname or roles change.**

Admins can switch any of these off with `/settings log-event`, and stop logging messages from noisy channels or whole categories with `/settings log-ignore`. Messages from bots and webhooks, and messages the bot deletes itself (the `/country` channel and `/purge`, which are already logged), are skipped. Message text needs the **Message Content** intent; joins, leaves and member changes need the **Server Members** intent (see [Setup](#setup), step 1). If either is off, the bot still starts and logs what it can. Entries are in English and never ping anyone. Make this channel visible to staff only.

### Country roles

Members pick the country they live in and get a role named after it. They can only pick once; after that, only staff can change it.

- **The guide's buttons** (the easy way, no slash command). `/country-help` posts the guide with one button per continent (Africa, Asia, Europe, North America, South America, Oceania) and a **Type my country** button.
  - A continent button privately shows that continent's countries in A–Z lists (25 per list, Discord's limit, so Africa is split into three). The member picks theirs and gets the role. Central America and the Caribbean are under North America. Every country is under exactly one continent (`src/countries/continents.js`).
  - **Type my country** opens a small form with one box. An exact match (`Germany`, `USA`, `Deutschland`) gives the role right away. Otherwise the bot shows a list of close matches to pick from, and never guesses. If nothing is close, it shows a *Try again* button.
  - Members who already have a country are told so as soon as they click.
  - The same rules and checks apply as for `/country`: one country per member, ISO-validated names, replies only the member sees, and every result in the logs channel (as *Country picker buttons*, with what they typed). It works in any channel the guide is posted in.
  - **Translate this message** privately shows the guide in the member's Discord language, with a menu to switch to any of the bot's seven languages (each listed in its own name, so Arabic is reachable too). The translated copy has the same continent and **Type my country** buttons, so members can get their role from it. The lists and replies that follow use the member's Discord language. These clicks aren't logged.
  - The buttons keep working after the bot restarts. Guides posted before a button was added don't have it, so run `/country-help` again to post a new one.
- **`/country country:<name>`** assigns a country role to the member who ran it.
  - Input is validated against the ISO 3166-1 list, so arbitrary text can never create a role.
  - Matching ignores case, spacing and accents, and accepts common aliases (`USA`, `UK`, `Turkey`) and the country's name in any of the bot's languages (`Deutschland`, `Estados Unidos`, `Allemagne`). Roles are always named in English.
  - The role is created if it doesn't exist yet. Existing roles are reused, and duplicates are never created, even under concurrent requests.
  - New roles have no permissions, no color, and are not hoisted or mentionable.
  - A member who already has a country role can't pick another. The bot names the role they have and tells them to ask staff. Any role named after a country counts, including ones added by hand.
  - `/country` never removes roles or touches anyone else's.
  - Replies are only visible to the member.
- **`/country-staff set member:<member> country:<name>`** (staff role only) makes that country the member's only country role, removing any others. It also cleans up members who picked several countries before the one-country rule existed.
- **`/country-staff remove member:<member>`** (staff role only) removes every country role from the member, so they can pick again with `/country`.
  - Discord can't hide a command by role, so everyone sees `/country-staff`, but the bot refuses anyone without the staff role (server admins included, unless they have it). To hide it, use *Server Settings > Integrations > the bot > /country-staff*.
  - Nothing works until an admin runs `/settings staff-role`.
  - Every change is logged with who made it.
- **`/country-help`** (Manage Server only) posts a standalone message in the current channel telling members how to get their country, with the continent, **Type my country** and **Translate this message** buttons under it, and confirms privately to the admin. When posted in the `/country` channel, it also says that any other message there is deleted automatically.

Needs: the **Manage Roles** permission, and the bot's role above every country role (including ones staff remove) (see [Setup](#setup), step 3). `/country-help` also needs **View Channel**, **Send Messages** (or **Send Messages in Threads**) and **Embed Links** in the channel it posts to. Keeping the `/country` channel clean needs **Manage Messages** in that channel.

Country names are the English ISO names, with a few shortened (for example *United States*, *Russia*, *Taiwan*). These live in `NAME_OVERRIDES` in `src/countries/countries.js`. Renaming one after roles exist makes the bot create a new role, so rename the Discord role too.

### Web dashboard

A website where admins log in with Discord and manage the bot without slash commands. Each server has a sidebar with these pages:

- **Servers:** every server you can open, with a search box. Servers without the bot get an invite link.
- **Overview:** member and online counts, total cases, cases in the last 7 and 30 days, running temporary bans, a chart of cases per day for the last 30 days (click the legend to hide actions), cases per action, the latest cases, the busiest moderators and the most moderated members (each links to their cases), and a setup checklist with links to what isn't set yet.
- **Cases:** every moderation case, newest first. Search reasons and names, pick one or more actions, and filter by member ID, moderator ID and date range; clicking a name shows only their cases. Active filters show as chips you can remove. **Export CSV** downloads the filtered list (up to 10,000 cases). Reasons can be edited (the mod-log post is updated too) and cases deleted.
- **Moderation:** staff and mod roles, and the mod-log channel.
- **Logging:** the logs and server-log channels, a switch for each server-log event, and ignored channels or categories (with a filter).
- **Country:** the `/country` channel.
- **Roles & access:** the **dashboard roles** (see below), and a table of every role with its color, its strongest permissions and what the bot uses it for, filterable by name or kind.

Settings pages show a save bar when something changed, and ask before you leave with unsaved changes.

**Dashboard roles.** Members with one of the roles ticked under *Roles & access* can open the server's Overview and Cases (view, edit reasons, delete, export) without Manage Server. Only people with Manage Server can see or change settings. Roles are checked against Discord on every request (at most 30 seconds old), so removing someone's role takes their access away right away.

**Appearance.** The 🎨 button picks a theme (match the device, light or dark), one of 8 accent colors and comfortable or compact spacing. It's remembered per browser.

Every change made on the dashboard is posted in the server's logs channel with who made it, like commands are. The bot picks up dashboard changes within 5 seconds. The dashboard is in the same 7 languages as the bot (picked from the browser, or the menu at the top).

**How it works.** It's a second process (`npm run dashboard`, pm2 app `rv-dashboard`) that shares `data/bot.db` with the bot. It only listens on `127.0.0.1:3080`; nginx (or Caddy) puts it on the internet with HTTPS. Logging in uses Discord OAuth2 with the `identify` and `guilds` scopes only, so it can see your name, avatar and server list, nothing else. Permissions are re-checked against Discord on every request (your server list is re-read at most every 5 minutes, or when you press *Refresh list*). Logins last 7 days. The session cookie is HTTP-only and Secure, and changes are only accepted from the dashboard's own address.

**Setting it up on the VPS** (once):

1. **DNS.** At the DNS provider for `cedartechsolutions.ca`, add an `A` record: name `rumbleverse`, value the VPS's public IP address. (Add an `AAAA` record too if the VPS has IPv6.)
2. **Discord.** In the [Developer Portal](https://discord.com/developers/applications) > your application > **OAuth2**: copy the **Client Secret** (Reset Secret if you don't have it), and under **Redirects** add `https://rumbleverse.cedartechsolutions.ca/auth/callback`, then save.
3. **`.env`.** Add these lines to the bot's `.env` on the VPS:
   ```
   DISCORD_CLIENT_SECRET=<the client secret>
   DASHBOARD_URL=https://rumbleverse.cedartechsolutions.ca
   DASHBOARD_SESSION_SECRET=<output of: openssl rand -hex 32>
   ```
4. **Start it** next to the bot:
   ```
   pm2 start npm --name rv-dashboard -- run dashboard
   pm2 save
   ```
5. **HTTPS.** Ports 80 and 443 must be open (`sudo ufw allow 80,443/tcp` if ufw is on).
   - **With nginx** (what the VPS uses): put this in `/etc/nginx/sites-available/rumbleverse`, run `sudo ln -s /etc/nginx/sites-available/rumbleverse /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx`, then get the certificate with `sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d rumbleverse.cedartechsolutions.ca`:
     ```
     server {
         listen 80;
         listen [::]:80;
         server_name rumbleverse.cedartechsolutions.ca;

         location / {
             proxy_pass http://127.0.0.1:3080;
             proxy_http_version 1.1;
             proxy_set_header Host $host;
             proxy_set_header X-Real-IP $remote_addr;
             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
             proxy_set_header X-Forwarded-Proto $scheme;
         }
     }
     ```
   - **With Caddy** (if nothing else uses ports 80 and 443): install it (see https://caddyserver.com/docs/install#debian-ubuntu-raspbian), put this in `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. Caddy gets and renews the certificate by itself.
     ```
     rumbleverse.cedartechsolutions.ca {
         encode gzip
         reverse_proxy 127.0.0.1:3080
     }
     ```
6. Open https://rumbleverse.cedartechsolutions.ca and log in.

After that, updates are the usual `git pull && npm ci`, then `pm2 restart rv-bot rv-dashboard`.

## Requirements

- Node.js 24 LTS (22.13 or newer works; moderation cases use the built-in `node:sqlite`)
- A Discord application with a bot user, invited to your server

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Copy the **Application ID** from *General Information*. On the **Bot** tab, click **Reset Token** and copy the token. Under *Privileged Gateway Intents*, turn on **Server Members Intent** (joins, leaves, nickname, role and timeout changes) and **Message Content Intent** (what edited and deleted messages said), and leave Presence off. If one is off, the bot still starts without it and says so in the console.

2. **Invite it.** Replace `YOUR_CLIENT_ID` and open:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1374792314006
   ```

   `permissions=1374792314006` is **Kick Members**, **Ban Members**, **Timeout Members**, **View Audit Log**, **Manage Roles**, **Manage Channels**, **Manage Nicknames**, **Manage Messages**, **Read Message History**, **View Channels**, **Send Messages**, **Send Messages in Threads**, **Embed Links** and **Attach Files**, which is what the current features need. If the bot was invited with fewer, either re-invite it with this link or give its role the missing permissions (for moderation: Kick Members, Ban Members, Timeout Members and View Audit Log server-wide, Read Message History for `/purge`). If a new feature needs more, update this number and re-invite the bot.

3. **Fix the role hierarchy.** In *Server Settings > Roles*, drag the bot's role above any roles it manages (existing country roles; new ones are created below it automatically) and above every member it should be able to ban, kick or time out. Keep it below your admin roles so moderators can't use it on admins.

4. **Install and configure.**

   ```bash
   npm ci
   cp .env.example .env    # PowerShell: Copy-Item .env.example .env
   ```

   Fill in `.env` (no quotes, no `Bot ` prefix):

   | Variable | Required | Purpose |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | yes | Bot token. Treat it like a password. |
   | `DISCORD_CLIENT_ID` | for `register` | Application ID. |
   | `DISCORD_GUILD_ID` | for `register` | Server ID (enable Developer Mode, right-click the server, *Copy Server ID*). |
   | `BOT_LANGUAGE` | no | Force one language: `en`, `es`, `de`, `fr`, `pt`, `it` or `ar`. Empty uses each user's Discord language. |
   | `LOG_LEVEL` | no | `debug`, `info` (default), `warn` or `error`. |

5. **Register commands and start.**

   ```bash
   npm run register
   npm start
   ```

   Re-run `npm run register` whenever a command is added, removed, or its name, description or options change.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Run the bot. |
| `npm run register` | Register commands in `DISCORD_GUILD_ID` (instant). |
| `npm run register -- --global` | Register commands globally (can take up to an hour). |
| `npm run register -- --clear-guild` | Remove this bot's commands from `DISCORD_GUILD_ID`. |
| `npm run register -- --clear-global` | Remove this bot's global commands. |
| `npm run dashboard` | Run the web dashboard (see [Web dashboard](#web-dashboard)). |
| `npm test` | Run the unit tests (no Discord connection needed). |

If a command shows up twice, you have both guild and global copies; clear one of them.

## Project layout

```
src/
  index.js               Starts the bot
  register-commands.js   Registers every slash command
  config.js              Reads and validates .env
  interactionHandler.js  Routes commands, buttons and forms; always answers the user
  commands/
    index.js             The list of all commands (add new ones here)
    settings.js          Settings: /settings
    country.js           Country roles: /country
    countryPicker.js     Country roles: the guide's continent buttons, form and lists
    countryStaff.js      Country roles: /country-staff
    countryHelp.js       Country roles: /country-help
    moderation.js        Moderation: /ban, /unban, /kick, /timeout, /untimeout, /softban, /note, /warn
    purge.js             Moderation: /purge
    cases.js             Moderation: /case, /modlogs, /clearwarns
    channelTools.js      Channel tools: /lock, /unlock, /slowmode
    memberTools.js       Member tools: /role, /nick
    commandHelpers.js    Shared start of moderation-style commands (language, permission check)
  countries/             Country roles: country list, name matching and search
  roles/                 Country roles: find, create, assign and remove roles
  channels/              Country roles: keeps the /country channel clean
  logs/                  Logs channel, server log, and posting to log channels
  moderation/            Moderation: cases (SQLite), checks, actions, mod log, temporary bans
  settings/              Per-server settings (saved in data/bot.db)
  storage/               The SQLite database: opening it and schema migrations
  dashboard/             Web dashboard: server.js (start), app.js (routes), Discord login, sessions
    public/              The dashboard page (plain HTML, CSS and JavaScript, no build step) and its locales
  i18n/                  Language selection and locales/*.json (all features)
  utils/                 Shared: logger with token redaction, keyed lock, Discord error codes
tests/                   Unit tests using in-memory Discord fakes
```

## Adding a feature

1. **Commands.** Create `src/commands/<name>.js` exporting a factory that returns `{ name, data, execute }` (and `autocomplete` if needed). `countryHelp.js` is a small example. Buttons, forms and menus go in the command's `components` map, keyed by a fixed custom ID so they keep working after restarts (see `countryPicker.js`). Add it to the list in `src/commands/index.js`. Every command use is logged automatically; have `execute` return `result(Status.<SUCCESS | REFUSED | FAILED>, "<translation key>", values)` from `src/logs/actionLog.js` so the logs channel shows how it ended.
2. **Logic.** Put anything bigger than the command itself in its own folder under `src/` (like `countries/` and `roles/`), so features stay separate.
3. **Text.** Every user-facing string goes in all seven `src/i18n/locales/*.json` files with the same key. The tests fail if a language is missing a key.
4. **Permissions.** If the feature needs a new bot permission, update the invite link in [Setup](#setup) and re-invite the bot.
5. **Tests.** Add `tests/<name>.test.js`; `tests/helpers/fakes.js` has fake Discord objects.
6. **Docs.** Add a row to the [Features](#features) table and a section describing it.
7. Run `npm test`, then `npm run register` to publish the new commands.

## Languages

Replies use each user's Discord language when it's supported, otherwise English. `BOT_LANGUAGE` forces one language for everyone. Discord has no Arabic app language, so the bot can't detect Arabic speakers: set `BOT_LANGUAGE=ar` to reply in Arabic to everyone, or members can pick Arabic from the guide's **Translate this message** menu. Public posts (such as `/country-help`) use the server's language instead of the person who ran the command. Country roles are always named in English, but members can type a country's name in any of the bot's languages. Translations have not been reviewed by native speakers yet.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Missing required environment variable ...` | Create `.env` in the project root from `.env.example`. |
| Commands don't appear | Run `npm run register`, check `DISCORD_GUILD_ID`, and make sure the bot was invited with `applications.commands`. |
| "The application did not respond" | The bot isn't running. Check the `npm start` terminal. |
| "I can't manage roles…" / role is above mine | Give the bot's role **Manage Roles** and move it above the country roles. |
| Role limit reached | The server has 250 roles. Remove unused ones. |
| `/country-help` says it can't post | Give the bot **View Channel**, **Send Messages** and **Embed Links** in that channel. |
| Messages in the `/country` channel aren't deleted | Give the bot **View Channel** and **Manage Messages** in that channel (the log warns once when it can't). |
| `/country-staff` says no staff role is set | An admin runs `/settings staff-role`. |
| Nothing shows up in the logs channel | Check `/settings show`, then give the bot **View Channel**, **Send Messages**, **Embed Links** and **Attach Files** there (the console log warns once when it can't post). |
| Deleted messages are logged without their text | Turn on **Message Content Intent** in the Developer Portal (*Bot* tab), then restart the bot. |
| A member needs a different country | Staff run `/country-staff set`. |
| A moderation command says my role must be above theirs | Move the bot's role above the member's highest role in *Server Settings > Roles*. |
| `/lock` or `/nick` says I'm missing a permission | Re-invite the bot with the link in [Setup](#setup), or give its role **Manage Channels** and **Manage Nicknames**. |
| Moderators with the mod role can't see `/ban` etc. | Add the mod role to each command under *Server Settings > Integrations > the bot*, or give the role the Discord permission. |
| Bans or kicks from Discord's menu show "Unknown" moderator | Give the bot **View Audit Log**. |
| No joins, leaves or role changes in the server log | Turn on **Server Members Intent** in the Developer Portal (*Bot* tab), then restart the bot. |
| Temporary bans aren't lifted | The bot needs **Ban Members**; it keeps retrying and warns once in the console. |
| Dashboard login says "Invalid OAuth2 redirect_uri" | Add `<DASHBOARD_URL>/auth/callback` exactly under OAuth2 > Redirects in the Developer Portal. |
| Dashboard login loops back to the login page | `DASHBOARD_URL` must match the address in the browser exactly (https, no trailing slash). |
| The dashboard site doesn't load | Check `pm2 logs rv-dashboard`, that the DNS record points at the VPS (`dig rumbleverse.cedartechsolutions.ca`), and `sudo journalctl -u caddy` for certificate errors. |
| A server is missing from the dashboard | You need Manage Server there; press *Refresh list* after getting it. |

Set `LOG_LEVEL=debug` for more detail.

## Operational notes

- **Run one instance.** Some safeguards (like the duplicate-role guard) are in memory, so two instances could race.
- **Settings and moderation cases** are stored in `data/bot.db` (plus `bot.db-wal` and `bot.db-shm` while running). Back up the whole `data/` folder, and keep it when moving or updating the bot; to copy the database safely while the bot runs, use `sqlite3 data/bot.db ".backup backup.db"`.
- **Upgrading from older versions.** Settings saved in `data/settings.json` (or the even older `data/country-channels.json`) are copied into the database the first time the new version starts, and `settings.json` is renamed to `settings.json.migrated` as a backup. The database is upgraded in place; existing cases are kept.

## Security

- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` has placeholders only.
- Logs redact anything that looks like a Discord token, plus the configured token, client secret and session secret.
- Users only see fixed, friendly messages; errors and stack traces stay in the log.
- The bot uses the Guilds, Guild Messages and Guild Moderation intents, plus the privileged Message Content intent (to show what edited and deleted messages said in the logs) and Server Members intent (joins, leaves and member changes). Message text is only ever copied into log channels. It uses only the permissions its features need (see the invite link in [Setup](#setup)). Roles it creates have zero permissions.
- The dashboard listens only on `127.0.0.1` and is reached through nginx or Caddy over HTTPS. It stores a hash of each login's session token, never the token itself, and the Discord access token encrypted with `DASHBOARD_SESSION_SECRET`. Every page sets a strict Content Security Policy, changes must come from the dashboard's own address, and requests are rate-limited. Members with a dashboard role only get the overview and cases; settings always need Manage Server. CSV exports prefix cells that start with `=`, `+`, `-` or `@` with `'` so spreadsheets don't run them as formulas.
