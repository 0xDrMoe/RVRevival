// What's new, shown at /changelog. Newest first. English, like the guide.
// Each entry is { date: "YYYY-MM-DD", title, items: [text] }.

export const CHANGELOG = [
  {
    date: "2026-11-13",
    title: "Channel automation",
    items: [
      "A new Channel automation page and /automate: auto-publish announcement posts, auto-threads under every post, threads that never auto-archive, and auto-delete after 1 minute to 7 days (pinned messages stay).",
      "Auto-slowmode switches slowmode on when a channel gets busy and puts it back once things calm down.",
      "Auto-reactions add up to 5 emoji to every new post, like 👍 👎 for feedback.",
      "A counting game channel that keeps the best run, and DISBOARD bump reminders 2 hours after each bump, with a role ping and your own text.",
      "Rabble's invite now asks for Add Reactions and Create Public Threads, which these need.",
    ],
  },
  {
    date: "2026-11-13",
    title: "Automod catches scams, emoji floods, walls of text and glitched text",
    items: [
      "New Scam links rule: fake Discord and Steam sites (like dlscord.gift), links whose text shows one website but open another, and \"free Nitro\" bait. It times out by default, since hacked accounts post these, and it's on in every preset.",
      "New rules for too many emoji (10 by default), too many lines (15) and glitched \"zalgo\" text. Normal accents and scripts like Hindi, Arabic and Thai are never caught.",
      "/settings automod limit now suggests the setting as you type, and covers the new emoji and line limits.",
    ],
  },
  {
    date: "2026-11-13",
    title: "A far more detailed server log",
    items: [
      "21 new kinds of event: pins, name and avatar changes, boosts, voice joins, leaves, moves and server mutes, and server changes (channels and permissions, roles, server settings, emojis and stickers, invites, webhooks, threads, events, bots and apps, and Discord AutoMod rules).",
      "Entries say who did it: who deleted a message, changed someone's roles, muted or moved them, or changed a channel or role, from the audit log.",
      "Edits highlight exactly what changed, joins show the invite used and who made it, leaves show how long the member stayed, and voice leaves show time spent.",
      "New log options: compact entries, show or hide IDs, log bots too, highlight edits, say who did it, and show the invite used. Members with ignored roles can be left out.",
      "Events come in four groups (messages, members, voice, server changes), each with its own on/off switches and its own channel if you want. In Discord: /settings log-event, log-ignore-role and log-option.",
    ],
  },
  {
    date: "2026-11-12",
    title: "Music: search, queue tools, DJ controls and playlists",
    items: [
      "/search shows the 5 best matches for what you type; pick one from the menu or a number button.",
      "/queue manages what's next: view, remove, move, skip to a song, shuffle, clear, remove duplicates and remove songs from people who left.",
      "/music gains back, seek, forward, rewind, replay, autoplay (related songs when the queue runs out), audio effects like bass boost and nightcore, lyrics, and grab to DM yourself the song. Now playing shows a progress bar and Back and Shuffle buttons.",
      "DJ controls: DJ-only mode, vote skip for members who aren't DJs, a longest-song limit and 24/7 mode, on the Music page or with /music settings.",
      "/playlist saves your own playlists (up to 25, 200 songs each) and plays them on any server.",
    ],
  },
  {
    date: "2026-11-12",
    title: "Music player",
    items: [
      "/play plays songs, playlists and audio files in your voice channel: search by name, or paste a SoundCloud, Bandcamp, Spotify, Apple Music or Deezer link, or a link to any audio file or stream.",
      "/radio plays internet radio from about 50,000 stations, suggested as you type.",
      "/music controls the queue: skip, pause, loop, shuffle, volume, remove and move. The Now playing message has buttons for the common ones.",
      "Set a DJ role, the starting volume, the queue size and when the bot leaves on the new Music page or with /music settings.",
      "Only sources that allow it are played. Spotify, Apple Music and Deezer songs are matched to free copies on SoundCloud, and YouTube isn't supported because YouTube doesn't allow it.",
    ],
  },
  {
    date: "2026-11-10",
    title: "Send test buttons",
    items: [
      "Check a message without waiting for the real thing: Send test on the Welcome & leave, Logging, Leveling, Birthdays and Starboard pages, and Test on each feed and scheduled message.",
      "Tests post where the real message goes, with you as the member, a small \"Test sent by\" line on top, and no pings.",
      "The Automod page has Try a message: type something and see which rules would catch it, without posting anything.",
      "In Discord, /test does the same: /test welcome, /test logs, /test level-up, /test automod and more.",
    ],
  },
  {
    date: "2026-11-10",
    title: "Welcome, leave and DM messages as embeds",
    items: [
      "The welcome message, the leave message and the welcome DM can each have an embed: a title, description, colour, big and small images (or the new member's avatar), footer and fields. Variables like {user} and {server} work in it.",
      "Build them on the Welcome & leave page with a live preview, or with /welcome embed. The colour defaults to your Branding colour.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Link previews for every page",
    items: [
      "Share a link to a guide page, a command's page, the status page or What's new, and the preview in Discord shows that page's own title and description instead of the home page's.",
      "Browser tabs are named after the page you're on, and search engines can find every guide page.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Error codes",
    items: ["When something breaks, the error message now shows a short code (like E-7F3A9C). Give it to staff or support and they can find exactly what went wrong."],
  },
  {
    date: "2026-11-09",
    title: "Dashboard: undo, server checkup and quick switches",
    items: [
      "Undo a settings change from the Activity page, and filter it by person or search it.",
      "The Overview has a Server checkup: missing permissions, roles above Rabble's, and deleted channels, each with a Fix link.",
      "Switch Automod, Leveling and Anti-nuke on or off right from the Overview.",
      "A Top commands card shows what your server uses most in the last 30 days.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Weekly leaderboard, clickable commands and a better welcome",
    items: [
      "A weekly leaderboard post every Monday, with an optional role for the week's top member. Set it on the Leveling page.",
      "Commands in /guide and the setup message are clickable: tap one to start typing it.",
      "The setup message Rabble posts when it joins has a quick setup checklist, a guide button, and warns when its role is missing permissions.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Moderation: reports, right-click apps and warning thresholds",
    items: [
      "Members can report a message to staff: right-click it, then Apps > Report message. Staff get Delete, Time out and Dismiss buttons.",
      "Right-click a member for User info or Moderation history, without typing a command.",
      "Warning thresholds: after a set number of warnings in a set number of days, Rabble times out, kicks or bans on its own. Set them on the Moderation page.",
      "The reason box on moderation commands suggests the reasons your staff use most.",
      "The join log flags new members who share an avatar or name with a banned account.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Tickets: claiming, auto-close, ratings and stats",
    items: [
      "Staff can claim a ticket with the 🙋 Claim button or /tickets claim, so everyone sees who is on it.",
      "Quiet tickets can close themselves: a warning first, then the close. Set it with /tickets auto-close.",
      "Members can rate the help from 1 to 5 stars by DM when their ticket closes (/tickets ratings).",
      "The Tickets page shows the last 30 days: tickets opened and closed, the average first reply time and the average rating.",
    ],
  },
  {
    date: "2026-11-09",
    title: "A status page, a clearer home page and a public guide",
    items: [
      "New status page at /status: live bot status, ping and 30 days of uptime, refreshed every minute.",
      "Uptime monitors can check /healthz/bot, which answers 503 while the bot is offline.",
      "The home page explains every permission Rabble asks for, and why it never needs Administrator.",
      "The guide is public at /guide, and every dashboard page has a clean address.",
      "Pages load faster on repeat visits: scripts and styles are cached until the next update.",
    ],
  },
  {
    date: "2026-11-09",
    title: "YouTube feeds, rebuilt",
    items: [
      "YouTube is one feed type with videos, Shorts and live switches.",
      "Feeds keep working when YouTube's own feed server fails, by reading the channel page instead.",
      "Channel links with /shorts, /videos, /streams or a share code are accepted.",
    ],
  },
  {
    date: "2026-11-08",
    title: "The big dashboard overhaul",
    items: [
      "Automod has a Simple view with presets and an Advanced view with per-rule tuning and a Log only action.",
      "Leveling has adjustable XP rates and a custom level curve with a graph.",
      "Each log type can go to its own channel.",
      "Tickets have a step-by-step panel wizard with a colour picker.",
      "Role panels can be made and edited on the dashboard.",
      "Every message box shares one list of variables, shown in the guide.",
      "Settings backups use a strict, checked format.",
    ],
  },
  {
    date: "2026-11-08",
    title: "Rabble is here",
    items: [
      "The bot is now Rabble, a public bot any server can add.",
      "Per-server branding: nickname, avatar, banner and embed colour.",
      "Feeds follow Twitch, Kick, YouTube live, Bluesky, Mastodon and GitHub releases.",
      "Role panels and the country picker ask before changing roles.",
    ],
  },
];
