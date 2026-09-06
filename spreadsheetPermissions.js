const DEFAULT_CACHE_TTL_MS = 3 * 60 * 1000;

const ROLE_PRIORITIES = {
  Mod: 100,
  LoreTeam: 200,
  Admin: 300,
  Owner: 400,
};

const ROLE_ALIASES = {
  lore: "LoreTeam",
  loreteam: "LoreTeam",
  lorestaff: "LoreTeam",
  loredev: "LoreTeam",
  mod: "Mod",
  moderator: "Mod",
  admin: "Admin",
  administrator: "Admin",
  owner: "Owner",
};

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLookupKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeId(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function normalizeRole(value) {
  const normalized = normalizeLookupKey(value).replace(/[\s_-]+/g, "");
  return ROLE_ALIASES[normalized] || null;
}

function normalizeCommandKey(value) {
  const normalized = normalizeLookupKey(value).replace(/[^a-z0-9*]+/g, "");
  return normalized || null;
}

function parseBoolean(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = normalizeLookupKey(value);
  if (!normalized) {
    return fallback;
  }

  if (["true", "1", "yes", "y", "enabled", "active"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "disabled", "inactive"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => toStringList(entry))
      .filter(Boolean);
  }

  if (value == null) {
    return [];
  }

  if (typeof value === "string") {
    return value
      .split(/[\n,;|]/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value === "number") {
    return [String(value)];
  }

  return [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function pickFirst(source, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }

    const value = source[key];
    if (value == null) {
      continue;
    }

    if (typeof value === "string" && value.trim() === "") {
      continue;
    }

    return value;
  }

  return undefined;
}

function collectValues(source, keys) {
  const values = [];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }

    values.push(...toStringList(source[key]));
  }

  return unique(values);
}

function normalizeMatrixRow(rawRow) {
  if (Array.isArray(rawRow)) {
    return rawRow.map((cell) => normalizeText(cell)).filter(Boolean);
  }

  if (rawRow && typeof rawRow === "object" && Array.isArray(rawRow.values)) {
    return rawRow.values.map((cell) => normalizeText(cell)).filter(Boolean);
  }

  return null;
}

function parseRobloxIdentityCell(value) {
  const cleaned = normalizeText(value);
  if (!cleaned) {
    return {};
  }

  const parts = cleaned.split("|").map((entry) => entry.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      robloxUserId: normalizeId(parts[0]),
      robloxUsername: parts.slice(1).join(" | "),
    };
  }

  if (/^\d+$/.test(cleaned)) {
    return {
      robloxUserId: cleaned,
      robloxUsername: "",
    };
  }

  const idPrefixMatch = cleaned.match(/^(\d+)\s+(.+)$/);
  if (idPrefixMatch) {
    return {
      robloxUserId: normalizeId(idPrefixMatch[1]),
      robloxUsername: idPrefixMatch[2].trim(),
    };
  }

  return {
    robloxUserId: "",
    robloxUsername: cleaned,
  };
}

function convertSheetMatrixToRecords(rows) {
  let currentRole = null;
  const records = [];

  for (const rawRow of rows) {
    const cells = normalizeMatrixRow(rawRow);
    if (!cells || cells.length === 0) {
      continue;
    }

    if (cells.length === 1) {
      const role = normalizeRole(cells[0]);
      if (role) {
        currentRole = role;
      }
      continue;
    }

    const explicitRole = normalizeRole(cells[0]);
    const role = explicitRole || currentRole;
    if (!role) {
      continue;
    }

    const identityCell = cells.find((cell) => cell.includes("|") || /^\d+(\s+\S.*)?$/.test(cell));
    const discordCell = cells.find((cell, index) => index > 0 && normalizeId(cell));
    if (!identityCell || !discordCell) {
      continue;
    }

    const identity = parseRobloxIdentityCell(identityCell);
    if (!identity.robloxUserId && !identity.robloxUsername) {
      continue;
    }

    records.push({
      role,
      botRole: role,
      studioRole: role,
      robloxUserId: identity.robloxUserId,
      robloxUsername: identity.robloxUsername,
      discordId: normalizeId(discordCell),
      enabled: true,
    });
  }

  return records;
}

function extractEntries(payload) {
  const directRows = normalizeMatrixRow(payload?.[0]) ? payload : null;
  if (directRows) {
    return convertSheetMatrixToRecords(directRows);
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const candidateKeys = [
    "entries",
    "permissions",
    "admins",
    "rows",
    "data",
    "members",
    "users",
  ];

  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) {
      if (normalizeMatrixRow(payload[key][0])) {
        return convertSheetMatrixToRecords(payload[key]);
      }
      return payload[key];
    }
  }

  for (const key of candidateKeys) {
    if (payload[key] && typeof payload[key] === "object") {
      for (const nestedKey of candidateKeys) {
        if (Array.isArray(payload[key][nestedKey])) {
          if (normalizeMatrixRow(payload[key][nestedKey][0])) {
            return convertSheetMatrixToRecords(payload[key][nestedKey]);
          }
          return payload[key][nestedKey];
        }
      }
    }
  }

  return [];
}

function normalizeRecord(rawRecord) {
  if (!rawRecord || typeof rawRecord !== "object") {
    return null;
  }

  const role = normalizeRole(
    pickFirst(rawRecord, [
      "role",
      "Role",
      "adminRole",
      "AdminRole",
      "studioRole",
      "StudioRole",
      "permissionRole",
      "PermissionRole",
    ])
  );

  const botRole = normalizeRole(
    pickFirst(rawRecord, [
      "botRole",
      "BotRole",
      "discordRole",
      "DiscordRole",
      "botPermissionRole",
      "BotPermissionRole",
    ])
  ) || role;

  const studioRole = normalizeRole(
    pickFirst(rawRecord, [
      "studioRole",
      "StudioRole",
      "robloxRole",
      "RobloxRole",
    ])
  ) || role;

  const commandKeys = unique(
    collectValues(rawRecord, [
      "commands",
      "Commands",
      "botCommands",
      "BotCommands",
      "commandAccess",
      "CommandAccess",
      "botPermissions",
      "BotPermissions",
    ])
      .map((entry) => normalizeCommandKey(entry))
      .filter(Boolean)
  );

  const allCommands = commandKeys.includes("*")
    || commandKeys.includes("all")
    || commandKeys.includes("allcommands");

  const discordIds = unique(
    collectValues(rawRecord, [
      "discordId",
      "DiscordId",
      "discordUserId",
      "DiscordUserId",
      "discord_id",
      "discord_user_id",
    ])
      .map((value) => normalizeId(value))
      .filter(Boolean)
  );

  const discordNames = unique(
    collectValues(rawRecord, [
      "discordUsername",
      "DiscordUsername",
      "discordName",
      "DiscordName",
      "discordTag",
      "DiscordTag",
      "discordDisplayName",
      "DiscordDisplayName",
    ])
      .map((value) => normalizeLookupKey(value))
      .filter(Boolean)
  );

  const robloxUserIds = unique(
    collectValues(rawRecord, [
      "robloxUserId",
      "RobloxUserId",
      "robloxId",
      "RobloxId",
      "playerUserId",
      "PlayerUserId",
    ])
      .map((value) => normalizeId(value))
      .filter(Boolean)
  );

  const robloxNames = unique(
    collectValues(rawRecord, [
      "robloxUsername",
      "RobloxUsername",
      "robloxName",
      "RobloxName",
      "playerName",
      "PlayerName",
      "username",
      "Username",
    ])
      .map((value) => normalizeLookupKey(value))
      .filter(Boolean)
  );

  const enabled = parseBoolean(
    pickFirst(rawRecord, [
      "enabled",
      "Enabled",
      "active",
      "Active",
      "isActive",
      "IsActive",
      "status",
      "Status",
    ]),
    true
  );

  if (
    !role
    && !botRole
    && !studioRole
  ) {
    return null;
  }

  if (
    discordIds.length === 0
    && discordNames.length === 0
    && robloxUserIds.length === 0
    && robloxNames.length === 0
  ) {
    return null;
  }

  return {
    enabled,
    role,
    botRole,
    studioRole,
    allCommands,
    commandKeys,
    discordIds,
    discordNames,
    robloxUserIds,
    robloxNames,
    note: normalizeText(
      pickFirst(rawRecord, ["note", "Note", "notes", "Notes", "comment", "Comment"])
    ),
    raw: rawRecord,
  };
}

function createSpreadsheetPermissionService(options = {}) {
  const config = {
    url: normalizeText(options.url),
    cacheTtlMs: Number.isFinite(Number(options.cacheTtlMs))
      ? Math.max(Number(options.cacheTtlMs), 1000)
      : DEFAULT_CACHE_TTL_MS,
    strictMode: options.strictMode === true,
    fetchImpl: typeof options.fetchImpl === "function" ? options.fetchImpl : fetch,
  };

  const state = {
    records: [],
    lastFetchedAt: 0,
    lastError: null,
    refreshPromise: null,
  };

  function hasConfiguredUrl() {
    return config.url.length > 0;
  }

  function getRolePriority(role) {
    return role ? (ROLE_PRIORITIES[role] || 0) : 0;
  }

  async function refreshRecords(forceRefresh = false) {
    const now = Date.now();
    const cacheValid = (now - state.lastFetchedAt) < config.cacheTtlMs;

    if (!forceRefresh && state.records.length > 0 && cacheValid) {
      return state.records;
    }

    if (!hasConfiguredUrl()) {
      state.records = [];
      state.lastFetchedAt = now;
      state.lastError = null;
      return state.records;
    }

    if (state.refreshPromise) {
      return state.refreshPromise;
    }

    state.refreshPromise = (async () => {
      try {
        const url = new URL(config.url);
        url.searchParams.set("_ts", String(Date.now()));

        const response = await config.fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`Permission sheet fetch failed with ${response.status}`);
        }

        const payload = await response.json();
        const records = extractEntries(payload)
          .map((entry) => normalizeRecord(entry))
          .filter(Boolean);

        state.records = records;
        state.lastFetchedAt = Date.now();
        state.lastError = typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : null;
        return state.records;
      } catch (error) {
        state.lastFetchedAt = Date.now();
        state.lastError = error instanceof Error ? error.message : String(error);
        return state.records;
      } finally {
        state.refreshPromise = null;
      }
    })();

    return state.refreshPromise;
  }

  function doesRecordMatchMember(record, member) {
    if (!record?.enabled || !member?.user) {
      return false;
    }

    const discordId = normalizeId(member.user.id);
    if (discordId && record.discordIds.includes(discordId)) {
      return true;
    }

    const memberNames = unique([
      normalizeLookupKey(member.user.username),
      normalizeLookupKey(member.user.tag),
      normalizeLookupKey(member.user.globalName),
      normalizeLookupKey(member.displayName),
    ]);

    return memberNames.some((entry) => record.discordNames.includes(entry));
  }

  async function getMemberAccess(member) {
    if (state.records.length === 0) {
      await refreshRecords(false);
    } else {
      void refreshRecords(false);
    }

    const matchingRecords = state.records
      .filter((record) => doesRecordMatchMember(record, member))
      .sort((left, right) => {
        const roleDelta = getRolePriority(right.botRole || right.role) - getRolePriority(left.botRole || left.role);
        if (roleDelta !== 0) {
          return roleDelta;
        }

        const commandDelta = Number(right.allCommands) - Number(left.allCommands);
        if (commandDelta !== 0) {
          return commandDelta;
        }

        return right.commandKeys.length - left.commandKeys.length;
      });

    return {
      configured: hasConfiguredUrl(),
      strictMode: config.strictMode,
      record: matchingRecords[0] || null,
      error: state.lastError,
      fetchedAt: state.lastFetchedAt,
    };
  }

  return {
    getMemberAccess,
    // Sensitive reviews require a fresh, exact Discord ID registration. Never
    // accept display-name matches or fall back to cached access after a failure.
    async getRegisteredAccess(discordId) {
      await refreshRecords(true);
      const record = state.records.filter((entry) => entry.enabled && entry.discordIds.includes(String(discordId)))
        .sort((a, b) => getRolePriority(b.botRole || b.role) - getRolePriority(a.botRole || a.role))[0] || null;
      return { configured: hasConfiguredUrl(), record, error: state.lastError, fetchedAt: state.lastFetchedAt };
    },
    getRolePriority,
    hasConfiguredUrl,
    isStrictMode: () => config.strictMode,
    normalizeCommandKey,
    refreshNow: () => refreshRecords(true),
    getLastError: () => state.lastError,
  };
}

module.exports = {
  createSpreadsheetPermissionService,
};
