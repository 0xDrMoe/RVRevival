// What's new, shown at /changelog. Newest first. English, like the guide.
// Each entry is { date: "YYYY-MM-DD", title, items: [text] }.

export const CHANGELOG = [
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
