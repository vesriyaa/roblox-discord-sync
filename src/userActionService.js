const { GameApiError } = require("./gameApiError");

const METHOD_ALIASES = new Map([
  ["getlink", "GetLink"],
  ["getroles", "GetRoles"],
  ["syncteamrole", "SyncTeamRole"],
  ["addroles", "AddRoles"],
  ["removeroles", "RemoveRoles"],
  ["timeout", "Timeout"],
  ["mute", "Mute"],
  ["deafen", "Deafen"],
]);

function normalizeMethod(value) {
  return METHOD_ALIASES.get(String(value || "").replace(/[^a-z]/gi, "").toLowerCase()) || "";
}

function parseRoleIds(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);
  return Array.from(new Set(values
    .map((roleId) => String(roleId || "").trim())
    .filter((roleId) => /^\d+$/.test(roleId))));
}

function createUserActionService({ client, verificationService, defaultGuildId, roleMap = {} }) {
  if (!client || !verificationService) {
    throw new TypeError("client and verificationService are required");
  }

  async function resolveVerification(input) {
    const discordId = String(input.discordId || "").trim();
    const robloxUserId = String(
      input.robloxUserId ?? input.userId ?? input.userid ?? ""
    ).trim();
    if (!discordId && !robloxUserId) {
      throw new GameApiError(400, "VALIDATION_ERROR", "Provide robloxUserId or discordId.");
    }
    return verificationService.lookup(discordId ? { discordId } : { robloxUserId });
  }

  async function execute(input = {}) {
    const method = normalizeMethod(input.method);
    if (!method) {
      throw new GameApiError(
        400,
        "UNKNOWN_METHOD",
        "Use GetLink, GetRoles, SyncTeamRole, AddRoles, RemoveRoles, Timeout, Mute, or Deafen."
      );
    }

    const verification = await resolveVerification(input);
    if (method === "GetLink") {
      return { method, ...verification };
    }
    if (!verification.verified) {
      return { method, applied: false, skipped: true, reason: "NOT_VERIFIED" };
    }
    if (typeof client.isReady === "function" && !client.isReady()) {
      throw new GameApiError(503, "BOT_NOT_READY", "The Discord bot is not ready.");
    }

    const guildId = String(input.guildId ?? input.serverId ?? input.serverid ?? defaultGuildId ?? "").trim();
    if (!guildId) {
      throw new GameApiError(400, "VALIDATION_ERROR", "Provide guildId or configure a default guild.");
    }

    let guild;
    let member;
    try {
      guild = await client.guilds.fetch(guildId);
      member = await guild.members.fetch(verification.discordId);
    } catch (err) {
      throw new GameApiError(404, "DISCORD_MEMBER_NOT_FOUND", "The verified Discord member is not in this guild.");
    }

    if (method === "GetRoles") {
      const roles = Array.from(member.roles.cache.values())
        .filter((role) => role.id !== guild.id)
        .map((role) => ({ id: role.id, name: role.name }));
      return { method, applied: false, discordId: verification.discordId, roles };
    }

    if (method === "SyncTeamRole") {
      const team = String(input.team || "").trim();
      const nextRoleId = roleMap[team];
      if (!nextRoleId) {
        throw new GameApiError(400, "INVALID_TEAM", "The supplied team does not map to a Discord role.");
      }
      const currentTeamRoleIds = Object.values(roleMap)
        .filter((roleId) => roleId !== nextRoleId && member.roles.cache.has(roleId));
      if (currentTeamRoleIds.length > 0) {
        await member.roles.remove(currentTeamRoleIds);
      }
      if (!member.roles.cache.has(nextRoleId)) {
        await member.roles.add(nextRoleId);
      }
      return { method, applied: true, discordId: verification.discordId, team, roleId: nextRoleId };
    }

    if (method === "AddRoles" || method === "RemoveRoles") {
      const roleIds = parseRoleIds(input.roles ?? input.roleIds);
      if (roleIds.length === 0) {
        throw new GameApiError(400, "VALIDATION_ERROR", "Provide one or more Discord role IDs.");
      }
      if (method === "AddRoles") {
        await member.roles.add(roleIds);
      } else {
        await member.roles.remove(roleIds);
      }
      return { method, applied: true, discordId: verification.discordId, roleIds };
    }

    if (method === "Timeout") {
      if (!Object.prototype.hasOwnProperty.call(input, "state")) {
        throw new GameApiError(400, "VALIDATION_ERROR", "Timeout requires state in milliseconds; use 0 to clear it.");
      }
      const requestedState = input.state;
      const durationMs = requestedState === false || Number(requestedState) === 0
        ? null
        : Number(requestedState);
      if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 2419200000)) {
        throw new GameApiError(400, "VALIDATION_ERROR", "Timeout state must be milliseconds from 0 through 2419200000.");
      }
      await member.timeout(durationMs);
      return { method, applied: true, discordId: verification.discordId, state: durationMs || 0 };
    }

    const normalizedState = String(input.state).toLowerCase();
    if (typeof input.state !== "boolean" && normalizedState !== "true" && normalizedState !== "false") {
      throw new GameApiError(400, "VALIDATION_ERROR", `${method} requires a boolean state.`);
    }
    const enabled = input.state === true || normalizedState === "true";
    if (method === "Mute") {
      await member.voice.setMute(enabled);
    } else {
      await member.voice.setDeaf(enabled);
    }
    return { method, applied: true, discordId: verification.discordId, state: enabled };
  }

  return { execute };
}

module.exports = {
  createUserActionService,
  normalizeMethod,
  parseRoleIds,
};
