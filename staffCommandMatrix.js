const STAFF_ROLE_PRIORITIES = {
  Mod: 100,
  LoreTeam: 200,
  Admin: 300,
  Owner: 400,
};

const STAFF_COMMANDS_BY_ROLE = {
  Mod: [
    "unlink",
    "verificationsystem",
    "requestban",
  ],
  LoreTeam: [
    "unwipe",
    "wipe",
    "restore",
    "postpanel",
    "editpanel",
    "postevent",
    "refreshevent",
    "talents",
  ],
  Admin: [
    "groupaccept",
    "grouprank",
    "inactivecheck",
    "shutdown",
  ],
  Owner: [
    "*",
  ],
};

const ROLE_ORDER = Object.entries(STAFF_ROLE_PRIORITIES)
  .sort((left, right) => left[1] - right[1])
  .map(([role]) => role);

function normalizeCommandKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9*]+/g, "");
}

function getRolePriority(role) {
  return role ? (STAFF_ROLE_PRIORITIES[role] || 0) : 0;
}

function getMinimumRoleForCommand(commandName) {
  const normalizedCommand = normalizeCommandKey(commandName);
  if (!normalizedCommand) {
    return null;
  }

  for (const role of ROLE_ORDER) {
    const commands = STAFF_COMMANDS_BY_ROLE[role] || [];
    if (commands.includes("*") || commands.includes(normalizedCommand)) {
      return role;
    }
  }

  return null;
}

function canRoleUseStaffCommand(role, commandName) {
  const minimumRole = getMinimumRoleForCommand(commandName);
  if (!minimumRole) {
    return false;
  }

  return getRolePriority(role) >= getRolePriority(minimumRole);
}

module.exports = {
  STAFF_COMMANDS_BY_ROLE,
  STAFF_ROLE_PRIORITIES,
  canRoleUseStaffCommand,
  getMinimumRoleForCommand,
  getRolePriority,
  normalizeCommandKey,
};
