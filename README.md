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
| [Automod](#automod) | `/settings automod …`, or the dashboard's Automod page | Manage Server |
| [Welcome and leave messages](#welcome-and-leave-messages) | `/welcome`, or the dashboard's Welcome & leave page | Manage Server |
| [Role panels](#role-panels) | `/rolepanel` | Manage Roles (members click the buttons) |
| [Custom commands](#custom-commands) | `/tag`, `/tags`, or the dashboard's Custom commands page | Everyone (`/tag`), Manage Messages or the mod role (`/tags`) |
| [Auto-responders](#auto-responders) | `/autoresponder`, or the dashboard's Auto-responders page | Manage Server |
| [Scheduled messages](#scheduled-messages) | `/schedule`, or the dashboard's Scheduled page | Manage Server |
| [Birthdays](#birthdays) | `/birthday`, or the dashboard's Birthdays page | Everyone (`set`, `remove`, `show`, `upcoming`), Manage Server (`setup`, `off`, removing someone else's) |
| [Reminders](#reminders) | `/remind` | Everyone |
| [Giveaways](#giveaways) | `/giveaway` | Manage Server or the mod role (members click Enter) |
| [Starboard](#starboard) | `/starboard`, or the dashboard's Starboard page | Manage Server (everyone stars messages) |
| [Support tickets](#support-tickets) | `/tickets` | Manage Server (`panel`, `off`), ticket staff (the rest); members click Open a ticket |
| [Raid protection](#raid-protection) | `/raid`, or the dashboard's Raid protection page | Manage Channels or the mod role (`lockdown`, `end`, `status`), Manage Server (`gate`, `gate-off`, `alert`) |
| [Temporary roles](#temporary-roles) | `/temprole` | Manage Roles or the mod role |
| [Quarantine](#quarantine) | `/quarantine` | Manage Roles or the mod role (`role`: Manage Server) |
| [Anti-nuke](#anti-nuke) | `/antinuke`, or the dashboard's Anti-nuke page | The server owner (`status`: Administrator) |
| [Join-to-create voice](#join-to-create-voice) | `/voice` | Manage Server (`setup`, `off`), the channel's owner (`lock`, `unlock`), anyone in the channel (`claim`) |
| [Leveling](#leveling) | `/rank`, `/leaderboard`, `/levels`, or the dashboard's Leveling page | Everyone (`/rank`, `/leaderboard`), Manage Server (`/levels`) |
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
- **`/settings automod …`** sets up automod (see [Automod](#automod)).
- **`/settings clear setting:<Staff role | /country channel | Logs channel | Mod-log channel | Server-log channel | Mod role | Switched-off log events | Ignored log channels | Automod>`** resets one setting. Clearing Automod switches it off and resets every automod setting. Clearing the logs channel stops logging; clearing the log events switches them all back on.
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

### Automod

Automod checks every new and edited message and acts on the first rule it breaks. It's off until an admin switches it on, and each rule is off until switched on.

| Rule | Catches |
| --- | --- |
| Banned words | A word or phrase from the server's list. Whole words only, unless it starts or ends with `*` (`bad*` catches "badly"). Capitals, accents and number swaps (`n00b`) don't hide a word. |
| Invite links | Discord invites to other servers (`discord.gg`, `discord.com/invite`, `dsc.gg`, `discord.me`). Invites to this server are allowed. |
| Links | Links to websites that aren't on the allowed list. GIFs from Tenor and Discord's own links are always allowed. |
| Mass mentions | A message mentioning at least N different members or roles (default 5). |
| Spam | N messages within S seconds (default 6 in 5). The whole burst is deleted. |
| Repeated messages | The same text sent N times within a minute (default 3). |
| Too many capitals | At least P% capitals (default 70%) in a message with at least L letters (default 15). |

Each rule's action is one of: **delete the message**, **delete and warn** (a warning case, DMed to the member), or **delete and time out** (a timeout case, default 10 minutes). Every time, the member is told in the channel (the notice disappears after a few seconds); deletions without a case are noted in the mod log. Cases are recorded with the bot as the moderator and `Automod · <rule>: "<message>"` as the reason, so `/modlogs` and the dashboard show them like any other. If the bot can't time out a member (their role is above the bot's), it warns instead. After it warns or times out a member, more broken rules in the next 10 seconds only delete, so one burst of spam doesn't stack up cases.

**Escalation** (off by default): once a member has N warnings in 24 hours (from automod or moderators), automod also times them out, kicks or bans them.

**Never checked:** bots, webhooks, members with **Manage Messages** in the channel or the mod role, exempt roles, exempt channels (including their threads, and every channel of an exempt category), and the `/country` channel.

Admins set it up on the dashboard's **Automod** page, or with:

- `/settings automod toggle enabled:<true | false>` switches automod on or off.
- `/settings automod rule rule:<rule> enabled:<true | false> action:<action>` switches a rule on or off and picks its action (left out: unchanged).
- `/settings automod limit setting:<limit> value:<number>` changes a number: mentions per message, spam messages and seconds, repeats, capitals percent and minimum letters, timeout length, escalation timeout length.
- `/settings automod word word:<word>` adds a banned word, or removes it if it's already listed (up to 200).
- `/settings automod allow-site site:<website>` allows links to a website and its subdomains, or stops allowing it.
- `/settings automod exempt-role role:<role>` and `exempt-channel channel:<channel or category>` add or remove an exemption.
- `/settings automod escalate warnings:<0-20> action:<Time out | Kick | Ban>` sets up escalation (0 switches it off).
- `/settings automod show` lists everything (banned words as spoilers).

Reading messages needs the **Message Content** intent; without it only spam and mention counts work. Deleting needs **Manage Messages**, timeouts **Moderate Members**, which the invite link already includes.

### Welcome and leave messages

When someone joins, the bot can post a welcome message in a channel, DM them, and give them **autoroles** (starter roles, up to 10). When someone leaves, it can post a leave message. Bots get none of this. If the server makes new members accept the rules first (membership screening), autoroles wait until they've accepted.

Messages can use `{user}` (a mention), `{username}`, `{server}` and `{count}` (the member count), up to 1000 characters. Only `{user}` pings anyone. Unset messages use a default in the server's language: *Welcome to {server}, {user}! You're member #{count}.* and *{username} has left the server.*

Admins set it up on the dashboard's **Welcome & leave** and **Autoroles** pages, or with:

- `/welcome channel channel:<channel>` and `/welcome leave-channel channel:<channel>` switch welcome or leave messages on, in that channel.
- `/welcome message text:<…>`, `/welcome leave-message text:<…>` and `/welcome dm text:<…>` set the messages. Type `\n` for a new line.
- `/welcome autorole role:<role>` adds an autorole, or removes it if it's already one. Bot roles, `@everyone` and roles with Administrator or Manage Server are refused.
- `/welcome off what:<Welcome messages | Leave messages | Welcome DM | Autoroles | Custom messages>` switches one off (custom messages go back to the default).
- `/welcome test` previews everything privately, with you as the new member. `/welcome show` lists the setup.

Giving roles needs **Manage Roles** and the bot's role above the autoroles.

**Roles on rejoin.** `/welcome persist enabled:true` (or the switch on the dashboard's **Autoroles** page) makes the bot remember members' roles when they leave and give them back when they rejoin, so leaving can't shake off a restricted role. Roles with moderator permissions (ban, kick, manage anything, mention everyone…), bot and booster roles, and roles above the bot are never given back automatically; the dashboard can also list roles to never give back. Saved roles are used once and forgotten after a year. Quarantined members keep their [quarantine](#quarantine) instead.

**Community servers should use Onboarding.** Discord's own Onboarding (Server Settings → Onboarding) gives new members roles and lets them pick their own, so on a Community server we recommend it over autoroles and role panels. `/welcome autorole`, `/welcome show`, `/rolepanel create` and the dashboard's Autoroles page say so when the server is a Community server. Autoroles and role panels are there for servers that don't use Onboarding.

### Role panels

A role panel is a message with a button per role. Members click a button to get the role, and click again to take it off. Good for platforms (PC, PlayStation, Xbox), regions, and ping roles for events or playtests. In **Pick only one role** mode, picking a role takes away the panel's other roles.

- `/rolepanel create channel:<channel> title:<…> description:<…> mode:<Pick any number | Pick only one>` posts a new, empty panel (up to 10 per server).
- `/rolepanel add panel:<panel> role:<role> emoji:<emoji> label:<text>` adds a button (up to 25 per panel); adding a role that's already there updates its emoji and label.
- `/rolepanel remove panel:<panel> role:<role>` removes a button; `/rolepanel delete panel:<panel>` deletes the panel and its message.
- `/rolepanel list` lists the panels. They're also shown (read-only) on the dashboard's Autoroles page.

Panels are edited in place; if the message was deleted, the next change posts it again. Roles with moderator or admin permissions (Administrator, Manage Server/Roles/Channels/Messages, Ban, Kick, Timeout, Mention Everyone and similar), bot roles, `@everyone`, roles above the bot and roles above your own top role can't go on a panel, and each click checks the role again.

### Custom commands

Saved answers that staff write once and anyone can post: the download link, how to report a bug, the FAQ.

- `/tag name:<tag> user:<member>` posts the saved answer in the channel. `user` is optional and pings that member above it; nothing in the saved text itself can ping anyone. Each member can post one every 5 seconds.
- `/tags add name:<name>` opens a form to write a new one (several lines are fine, up to 2000 characters). Names use lowercase letters, numbers and dashes, up to 32 characters; `Download Link` becomes `download-link`.
- `/tags edit name:<tag>` opens the form with the current text. `/tags remove name:<tag>` deletes one. `/tags list` lists them.

`/tags` needs **Manage Messages** or the mod role. Up to 50 per server. Admins can also add, edit and remove them on the dashboard's **Custom commands** page.

### Auto-responders

The bot answers messages that match a trigger, like "how do I download" or "server ip". Discord's own AutoMod can block or flag words but can't reply, so this fills that gap.

- `/autoresponder set trigger:<text> [match] [channel]` opens a form for the reply (several lines, up to 2000 characters). Using it with a trigger that already exists changes that one; leaving `match` or `channel` out keeps what was saved.
- `match`: **anywhere in the message** (default), **as whole words** ("ip" doesn't match "ship"), **the whole message** or **the start of the message**. Case and extra spaces don't matter. Triggers are up to 60 characters.
- `channel` limits it to one channel or category (threads count as their channel); without it, it answers everywhere.
- In the reply, `{user}` mentions the author without pinging, `{server}` is the server's name and `{channel}` the channel. Nothing in a reply can ping anyone.
- `/autoresponder remove trigger:<text>` deletes one; `/autoresponder list` lists them.

Needs **Manage Server**. Up to 25 per server. Each answers at most once every 30 seconds per channel, never answers bots, and skips messages automod acted on. Reading messages needs the **Message Content** intent. They're also on the dashboard's **Auto-responders** page.

### Scheduled messages

Messages the bot posts later, once or on repeat: event reminders, a weekly update, a rules refresher. Discord can schedule events, but not messages.

- `/schedule add channel:<channel> in:<duration> [every:<duration>]` opens a form for the message (several lines, up to 2000 characters). `in` is when it's first posted (1 minute to 1 year, like `30m`, `2h`, `1d12h`, `1w`); `every` repeats it (at least `1h`, at most a year). Without `every` it's posted once.
- `/schedule list` shows each message's number, channel, next post and repeat. `/schedule remove message:<number>` deletes one.
- Mentions in the message (`@everyone`, roles, members) only ping if whoever scheduled it has **Mention Everyone**; otherwise they show without pinging.
- Repeating messages keep their rhythm: runs missed while the bot was offline are skipped, not posted all at once. A message whose channel was deleted is deleted too; one the bot can't post (missing permissions) is logged in the console and tried again next time.

Needs **Manage Server**. Up to 25 per server. The bot needs View Channel and Send Messages in the channel. The dashboard's **Scheduled** page does the same, with the time picked in your own time zone.

### Birthdays

Members save their birthday; on the day, the bot posts a greeting and gives a birthday role. Discord has no birthday feature.

- `/birthday set month:<1-12> day:<1-31>` saves yours. Only the month and day are kept, never the year. `/birthday remove` forgets it, `/birthday show [user]` shows a saved one, and `/birthday upcoming` lists the next 10 in the server.
- `/birthday setup [channel] [role] [timezone] [message]` turns it on (a channel, a role, or both); options left out keep what was saved. The day starts at midnight in `timezone` (default UTC, suggested as you type). In `message`, `{user}` is the member (several on the same day are greeted together) and `{server}` the server's name; `\n` starts a new line. `/birthday off` turns it off; saved birthdays are kept.
- The birthday role is taken back the next day. It can't have moderator permissions and must be below the bot's highest role.
- 29 February birthdays are celebrated on the 28th in other years. Members who leave the server are forgotten (needs the Server Members intent).

Saving and viewing birthdays is open to everyone; `setup`, `off` and removing someone else's need **Manage Server**. The same settings are on the dashboard's **Birthdays** page.

### Reminders

Anyone can ask the bot to remind them about something later: a tournament check-in, a stream, an event.

- `/remind set in:<time> about:<text>` sets one. Times look like `10m`, `2h`, `1d 12h` or `90` (minutes), from 1 minute to 365 days ahead.
- When it's due, the bot posts it in the same channel and pings only that member. With `private:true` it comes by DM instead.
- `/remind list` shows your reminders in the server, and `/remind cancel reminder:<…>` cancels one (it suggests yours as you type).

Up to 25 per member per server. Reminders are saved in `data/bot.db`, so they survive restarts; one that came due while the bot was offline is sent as soon as it's back. If the bot can't post in the channel (when it's set, or later), the reminder comes by DM, and if the member's DMs are closed too, it's dropped.

### Giveaways

Staff post a giveaway, members click **🎉 Enter**, and the bot picks random winners when time is up.

- `/giveaway start prize:<…> duration:<time>` posts it in this channel. Optional: `winners` (1 to 20, default 1), `channel`, and `role` (only members with that role can enter). Durations go from 1 minute to 30 days.
- Members click **Enter** to join and click again to leave. The entry count on the message updates every few seconds.
- When it ends, the message shows the winners and the bot announces them in the channel, pinging only the winners. Winners are picked at random among entrants still in the server (and still holding the role, if one was required).
- `/giveaway end` ends one early, `/giveaway cancel` stops one without winners, `/giveaway reroll` picks new winners for an ended giveaway (never someone who already won it), and `/giveaway list` shows the running ones.

Needs **Manage Server** or the mod role. Up to 10 running per server. Giveaways are saved in `data/bot.db`, so they survive restarts; one that ended while the bot was offline is drawn as soon as it's back. Ended giveaways can be rerolled for 30 days. Entering isn't posted in the logs channel, so a big giveaway doesn't flood it.

### Starboard

When a message gets enough ⭐ reactions, the bot reposts it in a starboard channel with the author, text, first image and a **Jump to message** button, and keeps the star count up to date.

- `/starboard set channel:#starboard` turns it on. Optional: `threshold` (stars needed, 1 to 50, default 3) and `emoji` (default ⭐; a custom emoji from the server works too). Running it again changes those.
- `/starboard show` shows the settings and `/starboard off` turns it off (posts already on the board stay). The same settings are on the dashboard's **Starboard** page.
- The author's own star and bots don't count. If the stars drop below the threshold, the starboard post is deleted, and if the original message is deleted, so is its post. If staff delete a starboard post, that message never goes back on the board.
- Messages from channels @everyone can't see never go on a starboard @everyone can see, and messages from age-restricted channels only go on an age-restricted starboard. Messages in the starboard channel itself can't be starred onto it.

Needs **Manage Server**. The bot needs View Channel, Send Messages and Embed Links in the starboard channel, and Read Message History in the channels people star in. Message text needs the **Message Content** intent.

### Support tickets

Members open a private ticket with a button, and only they and the staff can see it. Discord has no ticket feature of its own, so each ticket is a **private thread** in the ticket channel.

- `/tickets panel channel:#support` posts the **🎫 Open a ticket** button there. Optional: `staff-role` (who answers tickets; default the mod role, or the staff role), `title` and `message` for the panel. Running it again replaces the old panel.
- A member clicks the button and says what they need help with. The bot opens a private thread named like `🎫 0007 · Name`, adds the member, pings the staff role into it (or adds up to 25 of its members one by one when the role can't be pinged), and posts their question with a **🔒 Close ticket** button.
- The member or staff close it with the button or `/tickets close [reason]`. The thread is locked and archived, so staff can still read it afterwards.
- `/tickets add member:@x` and `/tickets remove member:@x` bring someone in or take them out (never the person who opened it). `/tickets list` shows the open tickets. `/tickets off` removes the button; open tickets stay open.
- One open ticket per member and 50 per server. A ticket whose thread was deleted or archived counts as closed. Each member's tickets show on their dashboard **Members** page.
- **Transcripts:** closing a ticket saves the whole conversation (up to the newest 1,000 messages, with embeds and file links) and posts it as a `.txt` file in the mod-log channel (or the logs channel). The dashboard's **Tickets** page shows every ticket with its transcript. Tickets closed by deleting their thread have no transcript, since the messages are gone.

`panel` and `off` need **Manage Server**. Closing any ticket, `add`, `remove` and `list` need **Manage Threads**, Manage Server, the panel's staff role or the mod role. The bot needs View Channel, Send Messages, Embed Links, Create Private Threads, Send Messages in Threads and Manage Threads in the ticket channel (plus Read Message History and Attach Files in the mod-log channel and ticket channel for transcripts), and members need **Send Messages in Threads** there (they don't need Send Messages, so the channel can stay read-only apart from the threads).

### Raid protection

For when a server is flooded by bots or a coordinated group. Discord's own tools come first (Server Settings → Safety Setup: verification level, raid and DM-spam alerts); this adds what they don't have.

- `/raid lockdown [reason]` stops members posting in **every** public text, announcement and forum channel at once. It denies @everyone, and also any member role with its own allow in a channel (a role allow would beat an @everyone deny). Staff roles (the mod and staff roles, and roles with Manage Messages, Manage Channels, Moderate Members, Manage Server or Administrator) keep posting. Up to 250 channels.
- `/raid end [reason]` puts every locked channel back **exactly** as it was: the bot saved each changed permission before locking. Channels it couldn't edit are skipped and listed in the mod log.
- `/raid gate min-age:<days> [action]` kicks accounts younger than that when they join (they're DMed the reason, and a case is recorded), or with `action:alert` only flags them in the mod log. `/raid gate-off` turns it off.
- `/raid alert joins:<n>` posts an alert in the mod log when n members join within a minute (at most once every 10 minutes). `joins:0` turns it off.
- `/raid status` shows all of the above. The gate and alerts can also be set on the dashboard's **Raid protection** page, which shows a running lockdown too.

The bot needs **Manage Channels** and **Manage Roles** in the channels it locks (and its role above the member roles), and **Kick Members** for the gate. A short notice is posted in the server's system channel when a lockdown starts and ends.

### Join-to-create voice

Discord has no built-in way to give each group its own voice channel, so the bot makes them.

- `/voice setup hub:<voice channel> [category] [name] [limit]` turns it on. Joining the hub (for example "➕ Create a channel") makes a voice channel for that member, moves them into it, and deletes it as soon as it's empty. New channels go in `category` (default: the hub's category) and copy its permissions. `name` is the channel name, where `{name}` is the member's display name and `{username}` their username (default `🔊 {name}`); `limit` is the user limit (0 = none). `/voice off` turns it off; channels already made are still deleted once empty.
- The owner gets **Manage Channels** and **Move Members** on their channel, so they rename it, change the limit and disconnect people with Discord's own channel menus.
- `/voice lock` lets only the people inside (and staff) join; `/voice unlock` opens it again. `/voice claim` takes over a channel whose owner left.
- Someone who already has a channel and joins the hub again is moved back into theirs. At most 50 channels per server. Empty channels left over from a restart are deleted when the bot starts.

The bot needs **View Channel**, **Manage Channels**, **Manage Roles**, **Move Members** and **Connect** in the category. It uses the Guild Voice States intent, which isn't privileged.

### Temporary roles

Gives a role that's taken away again by itself: a muted role for a day, an event role for a week, a VIP role for a month.

- `/temprole add member role duration [reason]` gives the role for `30m`, `12h`, `3d`, `2w`… (1 minute to 365 days). Giving it again moves the end.
- `/temprole remove member role` takes it away now.
- `/temprole list [member]` shows temporary roles, soonest to end first.

Needs **Manage Roles** or the mod role, with the same rules as `/role`: nobody can hand out a role at or above their own highest role, or above the bot's. A role the member already has for good is refused, so the bot never takes away something it didn't give. The bot checks every 30 seconds and catches up after a restart; each role given, extended, removed or ended goes in the mod log. Up to 500 per server. Temporary roles show on the member's dashboard page.

### Quarantine

Takes a member's roles away while staff look into something (a possible alt, a compromised account), then gives every one of them back. The roles are saved in the database, so a restart changes nothing.

- `/quarantine add member [reason]` saves and takes every role the bot can (roles above the bot, bot roles and the booster role stay), and gives the quarantine role.
- `/quarantine release member [reason]` gives back every saved role that still exists and takes the quarantine role. If they left, it just clears the quarantine.
- `/quarantine list` shows who's quarantined.
- `/quarantine role [role]` sets the quarantine role (needs Manage Server; leave it empty for none). Make it a role that can only see one channel, like `#quarantine`. It's also on the dashboard's **Staff roles** page.

Someone who leaves and rejoins while quarantined gets the quarantine role back and no autoroles. Each quarantine and release goes in the mod log, and the member's dashboard page shows it. When [anti-nuke](#anti-nuke) takes someone's roles, it quarantines them, so `/quarantine release` gives the roles back.

### Anti-nuke

Stops someone with staff permissions, or a hacked bot, from wrecking the server. When one person goes over a limit in a minute, the bot steps in at once: it quarantines them, taking away every role it can (bots are kicked instead, since their own role can't be removed), or kicks or bans them if you chose that. It posts what happened in the mod log and DMs the server owner.

| Watched | Default limit per minute |
| --- | --- |
| Channels deleted | 3 |
| Channels created | 6 |
| Roles deleted | 3 |
| Bans | 8 |
| Kicks | 8 |
| Webhooks created | 3 |

- `/antinuke on` / `off` turns it on or off (off by default).
- `/antinuke limit action count` sets a limit (2 to 50 a minute).
- `/antinuke punishment type` picks take their roles, kick or ban.
- `/antinuke trust user` / `untrust user` lets a co-owner or a trusted bot go over the limits (up to 25).
- `/antinuke status` shows all of the above.

Only the **server owner** can change anti-nuke, on Discord or on the dashboard's **Anti-nuke** page, because trusted people can do anything; Administrators can see the status. The owner and this bot are never limited. Bans and kicks done through the bot's own commands count against the moderator who ran them.

Who did what comes from the audit log, so the bot needs **View Audit Log**. Its role must be above the roles it should take away: put it near the top of the role list. Anti-nuke doesn't rebuild deleted channels or roles.

### Leveling

Members earn XP for chatting and level up; reward roles are given automatically. Leveling is **off** until an admin turns it on with `/levels on` or on the dashboard's **Leveling** page.

- Each message earns 15 to 25 XP, at most once a minute per member, so spamming doesn't pay. Bots, webhooks and the `/country` channel never earn XP.
- Each level takes a little more XP than the last (100 to reach level 1, then 155, 220, 295…), up to level 500.
- `/rank [member]` shows a level, XP, progress to the next level and place on the leaderboard. `/leaderboard [page]` shows the top members, 10 per page. Both answer publicly.
- `/levels announce where:` picks where level-ups are posted: in the channel the member is chatting in (default), in one channel, by DM, or nowhere. `/levels message text:` changes the text (`{user}`, `{username}`, `{level}`, `{server}`); leave it empty for the default.
- `/levels reward-add level: role:` gives a role at a level (up to 25), `/levels reward-remove level:` takes it off the list. `/levels reward-mode` picks whether members keep every reward role they reached (default) or only the highest. Reward roles are checked again on every level-up, and the bot never gives bot roles or roles with Administrator or Manage Server.
- `/levels no-xp channel:` or `role:` switches XP off (or back on) in a channel, category or forum, or for members with a role.
- `/levels voice enabled:` lets members earn 10 XP a minute in voice channels (off by default). It only counts when at least two people (not bots) are in the channel, and never for deafened members, the AFK channel or no-XP channels and roles. Voice level-ups are announced in the voice channel's chat.
- `/levels boost multiplier:` gives server boosters more XP (for example `1.5`), and `/levels boost multiplier: role:` gives a role more XP (up to 10 roles). Boosts go from 1 to 5 in steps of 0.1; set `1` to remove one. Boosts don't add up: a member gets their highest one.
- `/levels set member: level:` moves someone to a level, `/levels reset member:` clears their XP. `/levels show` lists the settings, `/levels off` pauses leveling and keeps everyone's XP.

The dashboard's **Leveling** page has all the same settings plus the full leaderboard, and each member's history page shows their level and rank. `/levels` needs **Manage Server**; the bot needs **Manage Roles** (with its role above the reward roles) to give rewards.

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

A website where admins log in with Discord and manage the bot without slash commands. Each server has a sidebar grouped into General, Moderation, Protection, Community, Messages and Settings, with a green dot next to every feature that's switched on. **Ctrl+K** (⌘K on a Mac, or `/`) opens a search box that jumps to any page or server. On phones the sidebar becomes a menu behind the ☰ button. Pages switch without reloading.

- **Servers:** every server you can open, with a search box. Servers without the bot get an invite link.
- **Overview:** member and online counts, total cases, cases in the last 7 and 30 days, running temporary bans, which features are on (each links to its page), a setup checklist (hidden once everything is done), a chart of cases per day for the last 30 days (click the legend to hide actions), cases per action, the latest cases, the busiest moderators (each links to their cases) and the most moderated members (each links to their history).
- **Activity:** every change made on the dashboard, newest first, with who made it and what changed. Kept even when there's no logs channel (the newest 500 per server).
- **Cases:** every moderation case, newest first. Search reasons and names, pick one or more actions, and filter by member ID, moderator ID and date range; clicking a name shows only their cases. Active filters show as chips you can remove. **Export CSV** downloads the filtered list (up to 10,000 cases). Reasons can be edited (the mod-log post is updated too) and cases deleted.
- **Members:** find someone by the start of their username or nickname, or paste a user ID to find someone who left. Each person's page shows when their account was made (flagged if under 7 days old), when they joined, how many times they joined, their roles, a timeout or temporary ban in progress, Discord's ban reason if they're banned, every case as a timeline, their support tickets (with links to the threads), their level and leaderboard place, and their recent joins and leaves (the bot keeps the newest 50 per person). Each case in **Cases** has a *History* link to it.
- **Tickets:** every support ticket, newest first, filtered by open or closed and by member ID. Each ticket shows who opened and closed it, the reason, a link to its thread, and its transcript (also as a `.txt` download).
- **Automod:** the main switch, each rule with its action and numbers, banned words and allowed websites (one per line), timeout length and escalation, and exempt roles and channels (see [Automod](#automod)).
- **Anti-nuke:** the main switch, what happens to someone who goes over a limit, each limit, and trusted people. Only the server owner can change it (see [Anti-nuke](#anti-nuke)).
- **Raid protection:** the new-account gate, join-wave alerts, and a running lockdown (see [Raid protection](#raid-protection)).
- **Welcome & leave:** the welcome and leave channels and messages (empty boxes show the default) and the welcome DM.
- **Autoroles:** roles given on joining, giving roles back on rejoin (with roles to never give back), and the server's role panels (read-only; change them with `/rolepanel`). Community servers get a tip recommending Discord's Onboarding.
- **Starboard:** channel, stars needed and emoji.
- **Birthdays:** channel, role, time zone and greeting.
- **Leveling:** the main switch, where and how level-ups are announced, reward roles, voice XP and XP boosts, channels and roles that earn no XP, and the leaderboard with each member's level and progress (see [Leveling](#leveling)).
- **Country:** the `/country` channel.
- **Custom commands:** every saved answer for `/tag`, with its name and text; add, edit or remove them (see [Custom commands](#custom-commands)).
- **Auto-responders:** each trigger, match, channel and reply (see [Auto-responders](#auto-responders)).
- **Scheduled:** schedule a message (channel, first post in your own time zone, repeat), and see or delete the upcoming ones (see [Scheduled messages](#scheduled-messages)).
- **Staff roles:** staff and mod roles, the quarantine role, and the mod-log channel.
- **Logging:** the logs and server-log channels, a switch for each server-log event, and ignored channels or categories (with a filter).
- **Roles & access:** the **dashboard roles** (see below), and a table of every role with its color, its strongest permissions and what the bot uses it for, filterable by name or kind.

Settings pages show a save bar when something changed, and ask before you leave with unsaved changes.

**Dashboard roles.** Members with one of the roles ticked under *Roles & access* can open the server's Overview, Cases (view, edit reasons, delete, export) and Members without Manage Server. Only people with Manage Server can see or change settings. Roles are checked against Discord on every request (at most 30 seconds old), so removing someone's role takes their access away right away.

**Appearance.** The account menu (top right) picks a theme (match the device, light or dark), one of 8 accent colors and comfortable or compact spacing. It's remembered per browser.

Every change made on the dashboard is listed on the **Activity** page and posted in the server's logs channel with who made it, like commands are. The bot picks up dashboard changes within 5 seconds. The dashboard is in the same 7 languages as the bot (picked from the browser, or the account menu).

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
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1460709485718
   ```

   `permissions=1460709485718` is **Kick Members**, **Ban Members**, **Timeout Members**, **View Audit Log**, **Manage Roles**, **Manage Channels**, **Manage Nicknames**, **Manage Messages**, **Read Message History**, **View Channels**, **Send Messages**, **Send Messages in Threads**, **Create Private Threads**, **Manage Threads**, **Move Members**, **Connect**, **Embed Links** and **Attach Files**, which is what the current features need. If the bot was invited with fewer, either re-invite it with this link or give its role the missing permissions (for moderation: Kick Members, Ban Members, Timeout Members and View Audit Log server-wide, Read Message History for `/purge`, Create Private Threads and Manage Threads for tickets, Move Members and Connect for join-to-create voice). If a new feature needs more, update this number and re-invite the bot.

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
    automodSettings.js   Settings: /settings automod
    country.js           Country roles: /country
    countryPicker.js     Country roles: the guide's continent buttons, form and lists
    countryStaff.js      Country roles: /country-staff
    countryHelp.js       Country roles: /country-help
    moderation.js        Moderation: /ban, /unban, /kick, /timeout, /untimeout, /softban, /note, /warn
    purge.js             Moderation: /purge
    cases.js             Moderation: /case, /modlogs, /clearwarns
    channelTools.js      Channel tools: /lock, /unlock, /slowmode
    memberTools.js       Member tools: /role, /nick
    welcome.js           Community: /welcome
    rolePanel.js         Community: /rolepanel and its buttons
    tags.js              Custom commands: /tag, /tags and the form
    autoResponder.js     Auto-responders: /autoresponder and the reply form
    remind.js            Reminders: /remind
    schedule.js          Scheduled messages: /schedule and the message form
    birthday.js          Birthdays: /birthday
    giveaway.js          Giveaways: /giveaway and its Enter button
    starboard.js         Starboard: /starboard
    tickets.js           Support tickets: /tickets, the panel's button, the form and the Close button
    levels.js            Leveling: /rank, /leaderboard, /levels
    raid.js              Raid protection: /raid
    voice.js             Join-to-create voice: /voice
    commandHelpers.js    Shared start of moderation-style commands (language, permission check)
  countries/             Country roles: country list, name matching and search
  roles/                 Country roles: find, create, assign and remove roles
  channels/              Country roles: keeps the /country channel clean
  community/             Community: welcome and leave messages, autoroles (welcome.js), role panels (rolePanels.js), custom commands (tags.js), auto-responders (autoResponders.js), the starboard (starboard.js, starboardStore.js)
  giveaways/             Giveaways: saved in SQLite (giveawayStore.js), drawing winners (giveaways.js), ended on time (giveawayScheduler.js)
  tickets/               Support tickets: saved in SQLite (ticketStore.js), the panel, staff and messages (tickets.js), transcripts (transcript.js)
  raid/                  Raid protection: lockdown planning and restoring, the new-account gate and join alerts (raid.js)
  voice/                 Join-to-create voice: making and deleting channels (tempVoice.js), saved in SQLite (tempVoiceStore.js)
  leveling/              Leveling: settings and level math (config.js), XP in SQLite (levelStore.js), earning XP and rewards (leveling.js)
  members/               Member history: when members joined and left (memberEventStore.js)
  birthdays/             Birthdays: saved in SQLite (birthdayStore.js), greetings and the role each day (birthdays.js)
  scheduled/             Scheduled messages: saved in SQLite (scheduledMessageStore.js), posted when due (scheduler.js)
  reminders/             Reminders: saved in SQLite (reminderStore.js), sent when due (reminderScheduler.js)
  automod/               Automod: settings (config.js), what each rule matches (rules.js), acting on messages
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
- The bot uses the Guilds, Guild Messages, Guild Moderation, Guild Message Reactions (the starboard) and Guild Voice States (join-to-create voice) intents, plus the privileged Message Content intent (to show what edited and deleted messages said in the logs) and Server Members intent (joins, leaves and member changes). Message text is only ever copied into log channels. It uses only the permissions its features need (see the invite link in [Setup](#setup)). Roles it creates have zero permissions.
- The dashboard listens only on `127.0.0.1` and is reached through nginx or Caddy over HTTPS. It stores a hash of each login's session token, never the token itself, and the Discord access token encrypted with `DASHBOARD_SESSION_SECRET`. Every page sets a strict Content Security Policy, changes must come from the dashboard's own address, and requests are rate-limited. Members with a dashboard role only get the overview and cases; settings always need Manage Server. CSV exports prefix cells that start with `=`, `+`, `-` or `@` with `'` so spreadsheets don't run them as formulas.
