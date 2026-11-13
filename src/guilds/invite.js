// The link that adds the bot to a server, with the permissions every feature
// needs. Used by the dashboard and /botinfo. If a new feature needs more,
// change INVITE_PERMISSIONS here and in the README's setup steps.

export const INVITE_PERMISSIONS = "1495608192214";

export const inviteLink = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
