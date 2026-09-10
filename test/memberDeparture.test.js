const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemberDepartureService } = require("../src/memberDepartureService");
const { createMemberDepartureStore } = require("../src/memberDepartureStore");
const { paleColor, softenEmbed } = require("../src/webhookColors");
const { createMemoryStore: createWaveStore } = require("../src/waveStore");

function fixture() {
  const links = [{ discordId: "d1", robloxUserId: "r1", robloxUsername: "Player" }];
  const members = new Map();
  const groupMembers = new Set(["r1"]);
  const calls = { sends: [], edits: [], removals: [], revokes: [] };
  const state = { discordError: null, robloxError: null, sendError: null };
  const store = createMemberDepartureStore();
  const guild = { id: "guild", members: { async fetch({ user, force }) {
    assert.equal(force, true);
    if (state.discordError) throw state.discordError;
    if (!members.has(user)) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    return members.get(user);
  } } };
  const channel = { guildId: "guild", async send(payload) {
    if (state.sendError) throw state.sendError;
    calls.sends.push(payload); return { id: "message" };
  }, messages: { async edit(id, payload) { calls.edits.push({ id, payload }); } } };
  const options = {
    guildId: "guild", channelId: "channel", unwavedRoleId: "wald", wavedRoleIds: ["waved", "team"],
    client: { guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } },
    verificationDb: { getVerificationByDiscordId: async id => links.find(link => link.discordId === id), listVerifications: async () => links },
    waveStore: { revokeAcceptedApplications: async (...args) => { calls.revokes.push(args); } },
    robloxGroupService: {
      getMembership: async id => ({ isMember: groupMembers.has(id) }),
      async removeMember(id) {
        calls.removals.push(id);
        if (state.robloxError) throw state.robloxError;
        const removed = groupMembers.delete(id);
        return { removed, alreadyAbsent: !removed };
      },
    }, store, logger: { log() {}, error() {} },
  };
  return { ...state, state, options, service: createMemberDepartureService(options), store, calls, links, members, groupMembers, guild,
    member: (id = "d1") => ({ id, guild, user: { username: "Player" } }),
    present: roles => ({ user: {}, roles: { cache: new Set(roles) } }),
  };
}

test("uncached departures remove linked group access, revoke approval, and log without pings", async () => {
  const h = fixture();
  const result = await h.service.handleDeparture(h.member());
  assert.equal(result.completed, true);
  assert.deepEqual(h.calls.removals, ["r1"]);
  assert.deepEqual(h.calls.revokes, [["d1", "r1"]]);
  assert.deepEqual(h.calls.sends[0].allowedMentions, { parse: [] });
  assert.match(h.calls.sends[0].embeds[0].description, /removed from the Roblox group/);
});

test("unlinked departures and already absent members are still logged", async () => {
  const h = fixture();
  h.groupMembers.clear();
  await h.service.handleDeparture(h.member());
  await h.service.handleDeparture(h.member("unlinked"));
  assert.equal(h.calls.sends.length, 2);
  assert.match(h.calls.sends[0].embeds[0].description, /Already absent/);
  assert.match(h.calls.sends[1].embeds[0].description, /No linked Roblox account/);
});

test("Discord permission failures never count as a departure or revoke access", async () => {
  const h = fixture();
  h.state.discordError = Object.assign(new Error("Forbidden"), { code: 50013 });
  const summary = await h.service.reconcile();
  assert.equal(summary.failures, 1);
  assert.equal(summary.departed, 0);
  assert.deepEqual(h.calls.removals, []);
  assert.deepEqual(h.calls.revokes, []);
});

test("failed removals survive service restart and update their original log on retry", async () => {
  const h = fixture();
  h.state.robloxError = Object.assign(new Error("Forbidden"), { code: "ROBLOX_REMOVE_MEMBER_FAILED" });
  await h.service.handleDeparture(h.member());
  assert.equal((await h.store.listPending("guild")).length, 1);
  assert.match(h.calls.sends[0].embeds[0].description, /will retry/);
  h.state.robloxError = null;
  await createMemberDepartureService(h.options).reconcile();
  assert.equal((await h.store.listPending("guild")).length, 0);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.edits.length, 1);
  assert.match(h.calls.edits[0].payload.embeds[0].description, /removed from the Roblox group/);
});

test("log failures do not repeat completed Roblox removals", async () => {
  const h = fixture();
  h.state.sendError = new Error("No send permission");
  await h.service.handleDeparture(h.member());
  h.state.sendError = null;
  await h.service.reconcile();
  assert.equal(h.calls.removals.length, 1);
  assert.equal(h.calls.sends.length, 1);
});

test("catch-up removes departed and explicitly unwaved links but retains waved members and applicants", async () => {
  const h = fixture();
  for (const id of ["d2", "d3", "d4", "d5"]) {
    h.links.push({ discordId: id, robloxUserId: id }); h.groupMembers.add(id);
  }
  h.members.set("d2", h.present(["wald"]));
  h.members.set("d3", h.present(["wald", "waved"]));
  h.members.set("d4", h.present(["verified"]));
  h.members.set("d5", h.present(["wald"]));
  h.groupMembers.delete("d5"); // Approved applicant waiting to join.
  const summary = await h.service.reconcile();
  assert.equal(summary.removed, 2);
  assert.deepEqual(h.calls.removals, ["r1", "d2"]);
  assert.ok(!h.calls.revokes.some(([id]) => id === "d5"));
  assert.equal(h.calls.sends.length, 2);
  await h.service.reconcile();
  assert.equal(h.calls.sends.length, 2);
});

test("rejoined members and other guilds do not get removed", async () => {
  const h = fixture();
  h.members.set("d1", h.present(["waved"]));
  await h.service.handleDeparture(h.member());
  await h.service.handleDeparture({ ...h.member(), guild: { id: "other" } });
  assert.deepEqual(h.calls.removals, []);
  assert.deepEqual(h.calls.revokes, []);
});

test("revoked wave approval cannot be reused to regain group access", async () => {
  const store = createWaveStore();
  await store.createSession({ id: "wave", guildId: "guild", endsAt: new Date(Date.now() + 60000).toISOString(), applicationLimit: 5 });
  await store.reserveApplication({ id: "app", waveId: "wave", discordId: "d", robloxUserId: "r" });
  await store.updateApplicationStatus("app", "accepted", null, "staff");
  assert.ok(await store.findAcceptedApplication("d", "r"));
  await store.revokeAcceptedApplications("d", "r");
  assert.equal(await store.findAcceptedApplication("d", "r"), null);
});

test("webhook colors become pale once while embed content is preserved", () => {
  for (const color of [0x00ff00, 0xff0000, 0x2fb8df, 0x000000, 0xffaa00]) {
    const result = paleColor(color);
    assert.equal(paleColor(result), result);
    assert.ok(Math.min(result >> 16, (result >> 8) & 255, result & 255) >= 170);
  }
  const original = { title: "JOINED", fields: [{ name: "Place", value: "Camp" }], color: 0x00ff00 };
  const updated = softenEmbed(original);
  assert.equal(updated.fields, original.fields);
  assert.equal(original.color, 0x00ff00);
  assert.deepEqual(softenEmbed({ title: "No color" }), { title: "No color" });
});
