const test = require("node:test");
const assert = require("node:assert/strict");
const { createUserActionService, parseRoleIds } = require("../src/userActionService");
const { createWebhookService } = require("../src/webhookService");

test("role inputs accept arrays and space-separated IDs", () => {
  assert.deepEqual(parseRoleIds("10 20,30 invalid 20"), ["10", "20", "30"]);
  assert.deepEqual(parseRoleIds([10, "20", ""]), ["10", "20"]);
});

test("useraction skips Discord mutations when the Roblox user is unverified", async () => {
  let fetchedGuild = false;
  const service = createUserActionService({
    client: {
      isReady: () => true,
      guilds: { async fetch() { fetchedGuild = true; } },
    },
    verificationService: { async lookup() { return { verified: false }; } },
    defaultGuildId: "guild",
  });

  const result = await service.execute({ method: "GetRoles", robloxUserId: "10" });
  assert.deepEqual(result, {
    method: "GetRoles",
    applied: false,
    skipped: true,
    reason: "NOT_VERIFIED",
  });
  assert.equal(fetchedGuild, false);
});

test("SyncTeamRole removes an old mapped role and adds the selected role", async () => {
  const changes = [];
  const cache = new Map([
    ["guild", { id: "guild", name: "@everyone" }],
    ["old", { id: "old", name: "Old team" }],
  ]);
  const member = {
    roles: {
      cache,
      async remove(roleIds) { changes.push(["remove", roleIds]); },
      async add(roleIds) { changes.push(["add", roleIds]); },
    },
  };
  const service = createUserActionService({
    client: {
      isReady: () => true,
      guilds: { async fetch() { return { id: "guild", members: { async fetch() { return member; } } }; } },
    },
    verificationService: {
      async lookup() { return { verified: true, discordId: "20", robloxUserId: "10" }; },
    },
    defaultGuildId: "guild",
    roleMap: { Old: "old", Vanguard: "new" },
  });

  const result = await service.execute({ method: "SyncTeamRole", robloxUserId: "10", team: "Vanguard" });
  assert.equal(result.applied, true);
  assert.deepEqual(changes, [["remove", ["old"]], ["add", "new"]]);
});

test("moderation actions require an explicit state", async () => {
  const member = {
    roles: { cache: new Map() },
    voice: { async setMute() {}, async setDeaf() {} },
    async timeout() {},
  };
  const service = createUserActionService({
    client: {
      isReady: () => true,
      guilds: { async fetch() { return { id: "guild", members: { async fetch() { return member; } } }; } },
    },
    verificationService: { async lookup() { return { verified: true, discordId: "20" }; } },
    defaultGuildId: "guild",
  });

  await assert.rejects(service.execute({ method: "Timeout", robloxUserId: "10" }), /requires state/);
  await assert.rejects(service.execute({ method: "Mute", robloxUserId: "10" }), /boolean state/);
});

test("webhook methods share one delivery path", async () => {
  let sent;
  const service = createWebhookService({
    client: {
      isReady: () => true,
      channels: {
        async fetch(channelId) {
          assert.equal(channelId, "channel");
          return {
            async send(payload) {
              sent = payload;
              return { id: "message", channelId };
            },
          };
        },
      },
    },
    resolveRelayChannelId: (serviceName) => serviceName === "death" ? "channel" : null,
    buildRelayPayload: (source) => ({ ...source }),
  });

  const result = await service.execute({
    method: "Embed",
    service: "death",
    embedData: { title: "Death" },
  });
  assert.deepEqual(sent.embeds, [{ title: "Death" }]);
  assert.equal(result.messageId, "message");
});
