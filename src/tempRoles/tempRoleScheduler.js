// Takes temporary roles (/temprole) away when they end. The bot checks every
// 30 seconds; roles that ended while it was offline are taken as soon as it's
// back. Members who left, and roles that were deleted, are just forgotten.

import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";

// Options: client, store (TempRoleStore), modLog, logger
export function createTempRoleScheduler({ client, store, modLog = noModLog, logger, intervalMs = 30_000, now = Date.now }) {
  let timer;
  let running = false;

  async function expire(entry) {
    const guild = client.guilds.cache.get(entry.guildId);
    const role = guild?.roles.cache.get(entry.roleId);
    if (!guild || !role) {
      return;
    }
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (!member?.roles.cache.has(role.id)) {
      return;
    }
    try {
      await member.roles.remove(role.id, "Temporary role ended");
    } catch (error) {
      logger.warn("Couldn't take a temporary role away", { guildId: guild.id, error });
      return;
    }
    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({
        moderator: client.user ?? { id: "0", tag: "Temporary roles" },
        summary: `⏱️ **Temporary role ended** · <@&${role.id}> taken from <@${member.id}>`,
        lines: entry.reason ? [`Reason given: ${entry.reason}`] : [],
        color: 0x95a5a6,
      }),
    }));
  }

  // Takes away every role that has ended. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const entry of store.due(now())) {
        // Deleted first, so a crash can't loop on it.
        store.delete(entry.id);
        await expire(entry).catch((error) => logger.error("Ending a temporary role crashed", { guildId: entry.guildId, error }));
      }
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (timer) {
        return;
      }
      const run = () => sweep().catch((error) => logger.error("Checking temporary roles crashed", { error }));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
