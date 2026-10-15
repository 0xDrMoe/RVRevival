# Rumbleverse Revival Country Bot

A small Discord bot for the Rumbleverse Revival server. Members run `/country`, pick their country from autocomplete, and get a role named after it. The bot creates the role if it doesn't exist yet.

## Features

- **`/country country:<name>`** assigns a country role to the member who ran it.
  - Input is validated against the ISO 3166-1 list, so arbitrary text can never create a role.
  - Matching ignores case, spacing and accents, and accepts common aliases (`USA`, `UK`, `Turkey`).
  - Existing roles are reused; duplicates are never created, even under concurrent requests.
  - New roles have no permissions, no color, and are not hoisted or mentionable.
  - The bot never removes roles or touches anyone else's.
- **`/country-channel set | clear | show`** (Manage Server only) limits `/country` to one channel.
- **`/country-help`** (Manage Server only) posts a public message in the current channel telling members how to use `/country`.
- All other replies are ephemeral. Everything is translated into English, Spanish, German, French, Portuguese, Italian or Arabic.

## Requirements

- Node.js 24 LTS (22.12 or newer works)
- A Discord application with a bot user, invited to your server

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Copy the **Application ID** from *General Information*. On the **Bot** tab, click **Reset Token** and copy the token. Leave all privileged intents off.

2. **Invite it.** Replace `YOUR_CLIENT_ID` and open:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=268435456
   ```

   The only permission requested is **Manage Roles**.

3. **Fix the role hierarchy.** In *Server Settings > Roles*, drag the bot's role above any existing country roles (new ones are created below it automatically) and below your staff roles.

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

   Re-run `npm run register` only when a command's definition changes.

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
  register-commands.js   Registers slash commands
  config.js              Reads and validates .env
  interactionHandler.js  Routes interactions; always answers the user
  commands/              /country, /country-channel, /country-help
  countries/             Country list, name matching and search
  roles/                 Find, create and assign country roles
  settings/              Per-server channel setting (saved to data/, git-ignored)
  i18n/                  Language selection and locales/*.json
  utils/                 Logger with token redaction, keyed lock, Discord error codes
tests/                   Unit tests using in-memory Discord fakes
```

## Notes

- **Country names** are the English ISO names, with a few shortened (for example *United States*, *Russia*, *Taiwan*). These live in `NAME_OVERRIDES` in `src/countries/countries.js`. Renaming one after roles exist makes the bot create a new role, so rename the Discord role too.
- **Languages.** Messages live in `src/i18n/locales/`. Discord has no Arabic app language, so Arabic only works via `BOT_LANGUAGE=ar`. Country names stay in English everywhere. Translations have not been reviewed by native speakers yet.
- **Adding a command.** Create `src/commands/<name>.js` exporting `{ name, data, execute }` (see `country.js`), add it to `src/commands/index.js`, then run `npm run register`.
- **Run one instance.** The duplicate-role guard is in memory, so two instances could race on a brand-new role.
- **No role switching.** Picking a second country adds that role and keeps the first.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Missing required environment variable ...` | Create `.env` in the project root from `.env.example`. |
| `/country` doesn't appear | Run `npm run register`, check `DISCORD_GUILD_ID`, and make sure the bot was invited with `applications.commands`. |
| "The application did not respond" | The bot isn't running. Check the `npm start` terminal. |
| "I can't manage roles…" / role is above mine | Give the bot's role **Manage Roles** and move it above the country roles. |
| Role limit reached | The server has 250 roles. Remove unused ones. |

Set `LOG_LEVEL=debug` for more detail.

## Security

- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` has placeholders only.
- Logs redact anything that looks like a Discord token, plus the configured token.
- Users only see fixed, friendly messages; errors and stack traces stay in the log.
- The bot needs only Manage Roles and the non-privileged Guilds intent, and created roles have zero permissions.
