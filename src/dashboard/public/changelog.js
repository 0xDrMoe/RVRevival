// What's new, shown at /changelog. Newest first. English, like the guide.
// Each entry is { date: "YYYY-MM-DD", title, items: [text] }.

export const CHANGELOG = [
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
