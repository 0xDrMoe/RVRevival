# Rumbleverse Revival Bot

The Discord bot for the Rumbleverse Revival server. It is built as a set of independent features, each one a group of slash commands, so new features can be added without touching the existing ones.

## Features

| Feature | Commands | Who can use it |
| --- | --- | --- |
| [Country roles](#country-roles) | `/country`, `/country-channel`, `/country-help` | Everyone (`/country`), Manage Server (the rest) |

Every reply is translated into English, Spanish, German, French, Portuguese, Italian or Arabic (see [Languages](#languages)).

### Country roles

Members pick the country they live in and get a role named after it.

- **`/country country:<name>`** assigns a country role to the member who ran it.
  - Input is validated against the ISO 3166-1 list, so arbitrary text can never create a role.
  - Matching ignores case, spacing and accents, and accepts common aliases (`USA`, `UK`, `Turkey`).
  - The role is created if it doesn't exist yet. Existing roles are reused, and duplicates are never created, even under concurrent requests.
  - New roles have no permissions, no color, and are not hoisted or mentionable.
  - The bot never removes roles or touches anyone else's. Picking a second country adds that role and keeps the first.
  - Replies are only visible to the member.
- **`/country-channel set | clear | show`** (Manage Server only) limits `/country` to one channel.
- **`/country-help`** (Manage Server only) posts a public message in the current channel telling members how to use `/country`.

Needs: the **Manage Roles** permission, and the bot's role above every country role (see [Setup](#setup), step 3).

Country names are the English ISO names, with a few shortened (for example *United States*, *Russia*, *Taiwan*). These live in `NAME_OVERRIDES` in `src/countries/countries.js`. Renaming one after roles exist makes the bot create a new role, so rename the Discord role too.

## Requirements

- Node.js 24 LTS (22.12 or newer works)
- A Discord application with a bot user, invited to your server

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Copy the **Application ID** from *General Information*. On the **Bot** tab, click **Reset Token** and copy the token. Leave all privileged intents off.

2. **Invite it.** Replace `YOUR_CLIENT_ID` and open:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=268435456
   ```

   `permissions=268435456` is **Manage Roles**, the only permission the current features need. If a new feature needs more, update this number and re-invite the bot.

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
  interactionHandler.js  Routes interactions to commands; always answers the user
  commands/
    index.js             The list of all commands (add new ones here)
    country.js           Country roles: /country
    countryChannel.js    Country roles: /country-channel
    countryHelp.js       Country roles: /country-help
  countries/             Country roles: country list, name matching and search
  roles/                 Country roles: find, create and assign roles
  settings/              Per-server settings (saved to data/, git-ignored)
  i18n/                  Language selection and locales/*.json (all features)
  utils/                 Shared: logger with token redaction, keyed lock, Discord error codes
tests/                   Unit tests using in-memory Discord fakes
```

## Adding a feature

1. **Commands.** Create `src/commands/<name>.js` exporting a factory that returns `{ name, data, execute }` (and `autocomplete` if needed). `countryHelp.js` is a small example. Add it to the list in `src/commands/index.js`.
2. **Logic.** Put anything bigger than the command itself in its own folder under `src/` (like `countries/` and `roles/`), so features stay separate.
3. **Text.** Every user-facing string goes in all seven `src/i18n/locales/*.json` files with the same key. The tests fail if a language is missing a key.
4. **Permissions.** If the feature needs a new bot permission, update the invite link in [Setup](#setup) and re-invite the bot.
5. **Tests.** Add `tests/<name>.test.js`; `tests/helpers/fakes.js` has fake Discord objects.
6. **Docs.** Add a row to the [Features](#features) table and a section describing it.
7. Run `npm test`, then `npm run register` to publish the new commands.

## Languages

Replies use each user's Discord language when it's supported, otherwise English. `BOT_LANGUAGE` forces one language for everyone. Discord has no Arabic app language, so Arabic only works via `BOT_LANGUAGE=ar`. Public posts (such as `/country-help`) use the server's language instead of the person who ran the command. Country names stay in English everywhere. Translations have not been reviewed by native speakers yet.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Missing required environment variable ...` | Create `.env` in the project root from `.env.example`. |
| Commands don't appear | Run `npm run register`, check `DISCORD_GUILD_ID`, and make sure the bot was invited with `applications.commands`. |
| "The application did not respond" | The bot isn't running. Check the `npm start` terminal. |
| "I can't manage roles…" / role is above mine | Give the bot's role **Manage Roles** and move it above the country roles. |
| Role limit reached | The server has 250 roles. Remove unused ones. |

Set `LOG_LEVEL=debug` for more detail.

## Operational notes

- **Run one instance.** Some safeguards (like the duplicate-role guard) are in memory, so two instances could race.
- **Settings** are stored in `data/` next to the project. Keep that folder when moving or updating the bot.

## Security

- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` has placeholders only.
- Logs redact anything that looks like a Discord token, plus the configured token.
- Users only see fixed, friendly messages; errors and stack traces stay in the log.
- The bot uses only the non-privileged Guilds intent and the permissions its features need (currently Manage Roles). Roles it creates have zero permissions.
