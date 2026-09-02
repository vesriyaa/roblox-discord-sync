const test = require("node:test");
const assert = require("node:assert/strict");
const { createGroupAccessService } = require("../src/groupAccessService");

function buildService({ verified = true, acceptedApplication = true, isMember = false } = {}) {
  let acceptedUserId = null;
  let grantedMember = null;
  const service = createGroupAccessService({
    verificationService: {
      async lookup() {
        return verified
          ? { verified: true, robloxUserId: "123456", robloxUsername: "Builder_One" }
          : { verified: false };
      },
    },
    waveStore: {
      async findAcceptedApplication() {
        return acceptedApplication ? { id: "TV-APP-ACCEPTED", status: "accepted" } : null;
      },
    },
    robloxGroupService: {
      getGroupUrl() { return "https://www.roblox.com/communities/99"; },
      async getMembership() { return { isMember }; },
      async acceptJoinRequest(userId) { acceptedUserId = userId; },
    },
    async onAccessGranted(member) { grantedMember = member; },
  });
  return {
    service,
    getAcceptedUserId: () => acceptedUserId,
    getGrantedMember: () => grantedMember,
  };
}

test("verifygroup accepts a pending request only for an approved verified applicant", async () => {
  const state = buildService();
  const member = { id: "discord" };
  const result = await state.service.completeApprovedAccess({ discordId: "discord", member });
  assert.equal(result.acceptedJoinRequest, true);
  assert.equal(state.getAcceptedUserId(), "123456");
  assert.equal(state.getGrantedMember(), member);
});

test("verifygroup updates roles without another accept when the applicant is already a member", async () => {
  const state = buildService({ isMember: true });
  const result = await state.service.completeApprovedAccess({ discordId: "discord", member: {} });
  assert.equal(result.alreadyMember, true);
  assert.equal(state.getAcceptedUserId(), null);
});

test("verifygroup cannot bypass verification or staff approval", async () => {
  const unverified = buildService({ verified: false });
  await assert.rejects(
    unverified.service.completeApprovedAccess({ discordId: "discord", member: {} }),
    (err) => err.code === "NOT_VERIFIED"
  );

  const unapproved = buildService({ acceptedApplication: false });
  await assert.rejects(
    unapproved.service.completeApprovedAccess({ discordId: "discord", member: {} }),
    (err) => err.code === "APPLICATION_NOT_ACCEPTED"
  );
});
