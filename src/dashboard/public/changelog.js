// What's new, shown at /changelog. Newest first. English, like the guide.
// Each entry is { date: "YYYY-MM-DD", title, items: [text] }.

export const CHANGELOG = [
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
