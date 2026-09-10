// Read-only audit. Provide DATABASE_URL, BOT_TOKEN, GUILD_ID and GROUP_ID via environment.
const { Pool } = require("pg");
const { REST, Routes } = require("discord.js");
const { createRobloxGroupService } = require("../src/robloxGroupService");
const { UNWAVED_ROLE_ID, ENVISIONED_ROLE_ID, roleMap } = require("../src/config");

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const rest = new REST().setToken(process.env.BOT_TOKEN);
  const groups = createRobloxGroupService({ groupId: process.env.GROUP_ID });
  try {
    const { rows } = await db.query("SELECT discord_id,roblox_user_id,roblox_username FROM roblox_discord_links ORDER BY discord_id");
    const summary = { checked: 0, departed: 0, unwaved: 0, groupRemovalNeeded: 0, alreadyAbsent: 0, failures: 0 };
    const issues = [];
    for (const link of rows) {
      summary.checked++;
      try {
        let member;
        try { member = await rest.get(Routes.guildMember(process.env.GUILD_ID, link.discord_id)); }
        catch (error) { if (Number(error.code) !== 10007) throw error; }
        const unwaved = member && !member.user.bot && member.roles.includes(UNWAVED_ROLE_ID)
          && ![ENVISIONED_ROLE_ID, ...Object.values(roleMap)].some(id => member.roles.includes(id));
        if (member && !unwaved) continue;
        const membership = await groups.getMembership(link.roblox_user_id);
        summary[member ? "unwaved" : "departed"]++;
        summary[membership.isMember ? "groupRemovalNeeded" : "alreadyAbsent"]++;
        issues.push({ discordId: link.discord_id, robloxUserId: link.roblox_user_id,
          username: link.roblox_username, reason: member ? "unwaved" : "left", inGroup: membership.isMember });
      } catch (error) {
        summary.failures++;
        issues.push({ discordId: link.discord_id, code: String(error.code || "CHECK_FAILED") });
      }
    }
    console.log(JSON.stringify({ summary, issues }, null, 2));
  } finally { await db.end(); }
})().catch(error => { console.error("Membership audit failed:", error.code || error.name); process.exitCode = 1; });
