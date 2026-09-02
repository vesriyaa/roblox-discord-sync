const test = require("node:test");
const assert = require("node:assert/strict");
const { createBulkAccessService } = require("../src/bulkAccessService");

function member(id, roleIds, { bot = false } = {}) {
  const roles = new Set(roleIds);
  return {
    id,
    user: { bot },
    roles: {
      cache: {
        has(roleId) { return roles.has(roleId); },
        values() { return Array.from(roles, (roleId) => ({ id: roleId }))[Symbol.iterator](); },
      },
      async remove(values) {
        for (const roleId of Array.isArray(values) ? values : [values]) roles.delete(roleId);
      },
      async add(roleId) { roles.add(roleId); },
      async set(values) {
        roles.clear();
        for (const roleId of values) roles.add(roleId);
      },
    },
    hasRole(roleId) { return roles.has(roleId); },
  };
}

function guildWithMembers(members) {
  return {
    members: {
      async fetch() { return new Map(members.map((value) => [value.id, value])); },
    },
  };
}

test("unwave everyone strips a waved member down to Wald and notifies them", async () => {
  const waved = member("waved", ["verified", "envisioned", "team", "unrelated"]);
  const verifiedOnly = member("verified", ["verified"]);
  const staff = member("staff", ["verified", "envisioned", "staff-role"]);
  const sheetStaff = member("sheet-staff", ["verified", "envisioned"]);
  const removedFromGroup = [];
  const service = createBulkAccessService({
    verificationDb: {
      async deleteAllVerifications() { return []; },
      async getVerificationByDiscordId(discordId) {
        return discordId === "waved" ? { robloxUserId: "123456" } : null;
      },
    },
    verifiedRoleId: "verified",
    envisionedRoleId: "envisioned",
    unwavedRoleId: "unwaved",
    teamRoleIds: ["team"],
    defaultUnwaveExemptRoleIds: ["staff-role"],
    async isUnwaveExemptMember(value) { return value.id === "sheet-staff"; },
    robloxGroupService: {
      async removeMember(robloxUserId) {
        removedFromGroup.push(robloxUserId);
        return { removed: true, alreadyAbsent: false };
      },
    },
  });

  const notified = [];
  const result = await service.unwaveEveryone(guildWithMembers([waved, verifiedOnly, staff, sheetStaff]), {
    async onMemberUpdated(value) {
      notified.push(value.id);
      return { deliveredBy: "private thread" };
    },
  });
  assert.deepEqual({ targeted: result.targeted, updated: result.updated }, { targeted: 1, updated: 1 });
  assert.equal(result.skippedExempt, 2);
  assert.equal(waved.hasRole("envisioned"), false);
  assert.equal(waved.hasRole("team"), false);
  assert.equal(waved.hasRole("verified"), false);
  assert.equal(waved.hasRole("unrelated"), false);
  assert.equal(waved.hasRole("unwaved"), true);
  assert.equal(verifiedOnly.hasRole("verified"), true);
  assert.equal(staff.hasRole("envisioned"), true);
  assert.equal(sheetStaff.hasRole("envisioned"), true);
  assert.deepEqual(notified, ["waved"]);
  assert.equal(result.notificationsDelivered, 1);
  assert.deepEqual(removedFromGroup, ["123456"]);
  assert.equal(result.groupRemoved, 1);
  assert.equal(result.groupAlreadyAbsent, 0);
  assert.equal(result.groupUnlinked, 0);
  assert.deepEqual(result.groupFailures, []);
});

test("unwave still completes when a Roblox member is absent or removal fails", async () => {
  const absent = member("absent", ["verified", "envisioned"]);
  const failed = member("failed", ["verified", "envisioned"]);
  const notices = [];
  const service = createBulkAccessService({
    verificationDb: {
      async getVerificationByDiscordId(discordId) {
        return { robloxUserId: discordId === "absent" ? "111" : "222" };
      },
    },
    envisionedRoleId: "envisioned",
    unwavedRoleId: "unwaved",
    robloxGroupService: {
      async removeMember(robloxUserId) {
        if (robloxUserId === "111") return { removed: false, alreadyAbsent: true };
        throw new Error("Roblox temporarily unavailable");
      },
    },
  });

  const result = await service.unwaveEveryone(guildWithMembers([absent, failed]), {
    async onMemberUpdated(value) {
      notices.push(value.id);
      return { deliveredBy: "dm" };
    },
  });

  assert.equal(result.updated, 2);
  assert.equal(absent.hasRole("unwaved"), true);
  assert.equal(failed.hasRole("unwaved"), true);
  assert.equal(result.groupAlreadyAbsent, 1);
  assert.equal(result.groupRemoved, 0);
  assert.equal(result.groupFailures.length, 1);
  assert.equal(result.groupFailures[0].discordId, "failed");
  assert.deepEqual(notices.sort(), ["absent", "failed"]);
});

test("unwave everyone accepts extra exempt roles for a single run", async () => {
  const exempt = member("event-host", ["envisioned", "event-role"]);
  const service = createBulkAccessService({
    verificationDb: { async deleteAllVerifications() { return []; } },
    envisionedRoleId: "envisioned",
    unwavedRoleId: "unwaved",
  });

  const result = await service.unwaveEveryone(guildWithMembers([exempt]), {
    exemptRoleIds: ["event-role"],
  });
  assert.equal(result.targeted, 0);
  assert.equal(result.skippedExempt, 1);
  assert.equal(exempt.hasRole("envisioned"), true);
});

test("unverify everyone removes verified/team roles and deletes every link", async () => {
  const first = member("first", ["verified", "team"]);
  const second = member("second", ["verified", "envisioned"]);
  const removed = [];
  const service = createBulkAccessService({
    verificationDb: {
      async deleteAllVerifications() {
        return [{ discordId: "first" }, { discordId: "outside-guild" }];
      },
    },
    verifiedRoleId: "verified",
    envisionedRoleId: "envisioned",
    unwavedRoleId: "unwaved",
    teamRoleIds: ["team"],
    async onVerificationRemoved(record) { removed.push(record.discordId); },
  });

  const result = await service.unverifyEveryone(guildWithMembers([first, second]));
  assert.deepEqual(
    { targeted: result.targeted, updated: result.updated, linksDeleted: result.linksDeleted },
    { targeted: 2, updated: 2, linksDeleted: 2 }
  );
  assert.equal(first.hasRole("verified"), false);
  assert.equal(first.hasRole("team"), false);
  assert.equal(second.hasRole("verified"), false);
  assert.equal(second.hasRole("envisioned"), true);
  assert.deepEqual(removed, ["first", "outside-guild"]);
});
