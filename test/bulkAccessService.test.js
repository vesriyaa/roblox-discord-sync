const test = require("node:test");
const assert = require("node:assert/strict");
const { createBulkAccessService } = require("../src/bulkAccessService");

function member(id, roleIds, { bot = false } = {}) {
  const roles = new Set(roleIds);
  return {
    id,
    user: { bot },
    roles: {
      cache: { has(roleId) { return roles.has(roleId); } },
      async remove(values) {
        for (const roleId of Array.isArray(values) ? values : [values]) roles.delete(roleId);
      },
      async add(roleId) { roles.add(roleId); },
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

test("unwave everyone removes waved access but preserves verification", async () => {
  const waved = member("waved", ["verified", "envisioned", "team"]);
  const verifiedOnly = member("verified", ["verified"]);
  const staff = member("staff", ["verified", "envisioned", "staff-role"]);
  const sheetStaff = member("sheet-staff", ["verified", "envisioned"]);
  const service = createBulkAccessService({
    verificationDb: { async deleteAllVerifications() { return []; } },
    verifiedRoleId: "verified",
    envisionedRoleId: "envisioned",
    unwavedRoleId: "unwaved",
    teamRoleIds: ["team"],
    defaultUnwaveExemptRoleIds: ["staff-role"],
    async isUnwaveExemptMember(value) { return value.id === "sheet-staff"; },
  });

  const result = await service.unwaveEveryone(guildWithMembers([waved, verifiedOnly, staff, sheetStaff]));
  assert.deepEqual({ targeted: result.targeted, updated: result.updated }, { targeted: 1, updated: 1 });
  assert.equal(result.skippedExempt, 2);
  assert.equal(waved.hasRole("envisioned"), false);
  assert.equal(waved.hasRole("team"), false);
  assert.equal(waved.hasRole("verified"), true);
  assert.equal(waved.hasRole("unwaved"), true);
  assert.equal(verifiedOnly.hasRole("verified"), true);
  assert.equal(staff.hasRole("envisioned"), true);
  assert.equal(sheetStaff.hasRole("envisioned"), true);
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
