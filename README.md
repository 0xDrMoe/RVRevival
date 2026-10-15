# Rumbleverse Revival Bot

The Discord bot for the Rumbleverse Revival server. It is built as a set of independent features, each one a group of slash commands, so new features can be added without touching the existing ones.

## Features

| Feature | Commands | Who can use it |
| --- | --- | --- |
| [Settings](#settings) | `/settings` | Manage Server |
| [Logs channel](#logs-channel) | `/settings logs-channel` | Manage Server |
| [Country roles](#country-roles) | `/country`, `/country-staff`, `/country-help` | Everyone (`/country`), the staff role (`/country-staff`), Manage Server (`/country-help`) |

Every reply is translated into English, Spanish, German, French, Portuguese, Italian or Arabic (see [Languages](#languages)).

### Settings

**`/settings`** (Manage Server only) holds every per-server setting. Replies are only visible to the admin.

- **`/settings staff-role role:<role>`** chooses the staff role. Only members with it can use `/country-staff`. `@everyone` is refused.
- **`/settings country-channel channel:<channel>`** limits `/country` to one channel (threads inside it work too) and keeps that channel clean: every message posted in it is deleted right away, including staff's and admins', so it only holds `/country` and the bot's own posts (like the `/country-help` guide). Threads inside it are not cleaned. The bot needs **View Channel** and **Manage Messages** there; `/settings` warns the admin if it doesn't have them. Messages already in the channel before it was set are left alone.
- **`/settings logs-channel channel:<channel>`** chooses the channel where the bot logs everything members do with it (see [Logs channel](#logs-channel)). The bot needs **View Channel**, **Send Messages**, **Embed Links** and **Attach Files** there; `/settings` warns the admin if it doesn't have them.
- **`/settings clear setting:<Staff role | /country channel | Logs channel>`** resets one setting. Clearing the logs channel stops logging.
- **`/settings show`** lists the current settings.

If the staff role, the `/country` channel or the logs channel is deleted, the bot forgets it automatically.

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

### Country roles

Members pick the country they live in and get a role named after it. They can only pick once; after that, only staff can change it.

- **The guide's buttons** (the easy way, no slash command). `/country-help` posts the guide with one button per continent (Africa, Asia, Europe, North America, South America, Oceania) and a **Type my country** button.
  - A continent button privately shows that continent's countries in A–Z lists (25 per list, Discord's limit, so Africa is split into three). The member picks theirs and gets the role. Central America and the Caribbean are under North America. Every country is under exactly one continent (`src/countries/continents.js`).
  - **Type my country** opens a small form with one box. An exact match (`Germany`, `USA`, `Deutschland`) gives the role right away. Otherwise the bot shows a list of close matches to pick from, and never guesses. If nothing is close, it shows a *Try again* button.
  - Members who already have a country are told so as soon as they click.
  - The same rules and checks apply as for `/country`: one country per member, ISO-validated names, replies only the member sees, and every result in the logs channel (as *Country picker buttons*, with what they typed). It works in any channel the guide is posted in.
  - The buttons keep working after the bot restarts. Guides posted before this feature have no buttons, so run `/country-help` again to post a new one.
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
- **`/country-help`** (Manage Server only) posts a standalone message in the current channel telling members how to get their country, with the continent and **Type my country** buttons under it, and confirms privately to the admin. When posted in the `/country` channel, it also says that any other message there is deleted automatically.

Needs: the **Manage Roles** permission, and the bot's role above every country role (including ones staff remove) (see [Setup](#setup), step 3). `/country-help` also needs **View Channel**, **Send Messages** (or **Send Messages in Threads**) and **Embed Links** in the channel it posts to. Keeping the `/country` channel clean needs **Manage Messages** in that channel.

Country names are the English ISO names, with a few shortened (for example *United States*, *Russia*, *Taiwan*). These live in `NAME_OVERRIDES` in `src/countries/countries.js`. Renaming one after roles exist makes the bot create a new role, so rename the Discord role too.

## Requirements

- Node.js 24 LTS (22.12 or newer works)
- A Discord application with a bot user, invited to your server

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Copy the **Application ID** from *General Information*. On the **Bot** tab, click **Reset Token** and copy the token. Under *Privileged Gateway Intents*, turn on **Message Content Intent** (the logs channel uses it to show what deleted messages said) and leave the others off.

2. **Invite it.** Replace `YOUR_CLIENT_ID` and open:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=275146402816
   ```

   `permissions=275146402816` is **Manage Roles**, **Manage Messages**, **View Channels**, **Send Messages**, **Send Messages in Threads**, **Embed Links** and **Attach Files**, which is what the current features need. If the bot was invited with fewer, either re-invite it with this link or give its role the missing permissions in the channels that need them (**Manage Messages** in the `/country` channel, **Attach Files** in the logs channel). If a new feature needs more, update this number and re-invite the bot.

3. **Fix the role hierarchy.** In *Server Settings > Roles*, drag the bot's role above any roles it manages (existing country roles; new ones are created below it automatically) and below your staff roles.

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
  countries/             Country roles: country list, name matching and search
  roles/                 Country roles: find, create, assign and remove roles
  channels/              Country roles: keeps the /country channel clean
  logs/                  Logs channel: posts what members do with the bot
  settings/              Per-server settings (saved to data/settings.json, git-ignored)
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

Replies use each user's Discord language when it's supported, otherwise English. `BOT_LANGUAGE` forces one language for everyone. Discord has no Arabic app language, so Arabic only works via `BOT_LANGUAGE=ar`. Public posts (such as `/country-help`) use the server's language instead of the person who ran the command. Country roles are always named in English, but members can type a country's name in any of the bot's languages. Translations have not been reviewed by native speakers yet.

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

Set `LOG_LEVEL=debug` for more detail.

## Operational notes

- **Run one instance.** Some safeguards (like the duplicate-role guard) are in memory, so two instances could race.
- **Settings** are stored in `data/settings.json` next to the project. Keep the `data/` folder when moving or updating the bot. A `/country` channel saved by older versions in `data/country-channels.json` is carried over automatically the first time the new version starts.

## Security

- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` has placeholders only.
- Logs redact anything that looks like a Discord token, plus the configured token.
- Users only see fixed, friendly messages; errors and stack traces stay in the log.
- The bot uses the Guilds and Guild Messages intents, plus the privileged Message Content intent, which it only uses to copy messages it deletes from the `/country` channel into the logs channel. It uses only the permissions its features need (see the invite link in [Setup](#setup)). Roles it creates have zero permissions.
