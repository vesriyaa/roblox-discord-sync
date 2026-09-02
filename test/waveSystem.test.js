const test = require("node:test");
const assert = require("node:assert/strict");
const { createRobloxGroupService } = require("../src/robloxGroupService");
const { registerSlashCommands } = require("../src/registerSlashCommands");
const {
  buildWavePayload,
  createWaveService,
  isMatchingVerification,
  parseWaveDuration,
  parseRobloxIdentity,
} = require("../src/waveService");
const { createMemoryStore } = require("../src/waveStore");

function session(overrides = {}) {
  return {
    id: "TV-WAVE-TEST",
    guildId: "guild",
    channelId: "channel",
    reviewChannelId: "review",
    createdByDiscordId: "staff",
    createdAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    applicationLimit: 1,
    applicationCount: 0,
    status: "open",
    closeReason: null,
    ...overrides,
  };
}

test("wave application identity must match the OAuth verification", () => {
  const identity = parseRobloxIdentity("Builder_One (123456)");
  assert.deepEqual(identity, { robloxUsername: "Builder_One", robloxUserId: "123456" });
  assert.equal(isMatchingVerification(identity, {
    verified: true,
    robloxUsername: "builder_one",
    robloxUserId: "123456",
  }), true);
  assert.equal(isMatchingVerification(identity, {
    verified: true,
    robloxUsername: "SomeoneElse",
    robloxUserId: "123456",
  }), false);
});

test("wave durations accept shorthand, compounds, and legacy minute values", () => {
  assert.equal(parseWaveDuration("30m"), 30 * 60_000);
  assert.equal(parseWaveDuration("1h"), 60 * 60_000);
  assert.equal(parseWaveDuration("1d"), 24 * 60 * 60_000);
  assert.equal(parseWaveDuration("1h30m"), 90 * 60_000);
  assert.equal(parseWaveDuration("1d 12h"), 36 * 60 * 60_000);
  assert.equal(parseWaveDuration("90"), 90 * 60_000);
  assert.equal(parseWaveDuration("1w"), 7 * 24 * 60 * 60_000);
  assert.equal(parseWaveDuration("30s"), null);
  assert.equal(parseWaveDuration("8d"), null);
  assert.equal(parseWaveDuration("tomorrow"), null);
});

test("wave store prevents duplicate applications and closes at capacity", async () => {
  const store = createMemoryStore();
  const created = await store.createSession(session());
  const application = {
    id: "TV-APP-1",
    waveId: created.id,
    discordId: "discord",
    robloxUserId: "123456",
    robloxUsername: "Builder_One",
    candidateAnswer: "A sufficiently complete candidate answer.",
    discoveryAnswer: "A friend.",
  };
  const reserved = await store.reserveApplication(application);
  assert.equal(reserved.ok, true);
  assert.equal(reserved.session.status, "closed");
  assert.equal(reserved.session.closeReason, "capacity");
  assert.equal(reserved.session.applicationCount, 1);

  const duplicate = await store.reserveApplication({ ...application, id: "TV-APP-2" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "WAVE_CLOSED");
});

test("closed wave panel is Thornvale branded and disables applications", () => {
  const payload = buildWavePayload(session({
    status: "closed",
    closeReason: "capacity",
    applicationCount: 1,
  }));
  const embed = payload.embeds[0].toJSON();
  const button = payload.components[0].components[0].toJSON();
  assert.match(embed.title, /Thornvale/);
  assert.match(embed.description, /application limit/);
  assert.equal(button.disabled, true);
  assert.equal(button.label, "Applications Closed");
});

test("Roblox group acceptance reuses one CSRF-aware service", async () => {
  const requests = [];
  const service = createRobloxGroupService({
    groupId: "99",
    cookie: "secret-cookie",
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (url.includes("auth.roblox.com")) {
        return { headers: { get: () => "csrf" } };
      }
      return { ok: true, status: 200 };
    },
  });
  const result = await service.acceptJoinRequest("123456");
  assert.equal(result.accepted, true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /groups\/99\/join-requests\/users\/123456/);
  assert.equal(requests[1].options.headers["x-csrf-token"], "csrf");
});

test("verified wave submissions accept the join request, update roles, and log answers", async () => {
  const activeSession = session({ applicationLimit: 5 });
  let acceptedUserId;
  let updatedMember;
  let reviewPayload;
  let responseText;
  const store = {
    type: "memory",
    async getSession() { return activeSession; },
    async reserveApplication(application) {
      return {
        ok: true,
        application,
        session: { ...activeSession, applicationCount: 1 },
      };
    },
    async updateApplicationStatus() {},
  };
  const member = { roles: {} };
  const service = createWaveService({
    client: {
      channels: {
        async fetch(channelId) {
          assert.equal(channelId, "review");
          return { async send(payload) { reviewPayload = payload; } };
        },
      },
    },
    store,
    verificationService: {
      async lookup() {
        return {
          verified: true,
          discordId: "discord",
          robloxUserId: "123456",
          robloxUsername: "Builder_One",
        };
      },
    },
    robloxGroupService: {
      async acceptJoinRequest(userId) { acceptedUserId = userId; },
    },
    async onAcceptedMember(value) { updatedMember = value; },
  });
  const interaction = {
    customId: `wave|submit|${activeSession.id}`,
    user: {
      id: "discord",
      async send() {},
    },
    guild: { members: { async fetch() { return member; } } },
    fields: {
      getTextInputValue(field) {
        return {
          roblox_identity: "Builder_One (123456)",
          candidate_answer: "I enjoy collaborative roleplay and helping new players.",
          discovery_answer: "A friend invited me.",
        }[field];
      },
    },
    async deferReply() {},
    async editReply(text) { responseText = text; },
  };

  assert.equal(await service.handleModal(interaction), true);
  assert.equal(acceptedUserId, "123456");
  assert.equal(updatedMember, member);
  assert.ok(reviewPayload.embeds?.length);
  assert.match(responseText, /accepted/i);
});

test("slash command registration includes the wave workflow", async () => {
  let commands;
  await registerSlashCommands({
    commands: {
      async set(value) { commands = value; },
    },
  });
  const wave = commands.map((command) => command.toJSON()).find((command) => command.name === "wave");
  assert.ok(wave);
  assert.deepEqual(wave.options.map((option) => option.name), ["start", "status", "close"]);
  const duration = wave.options[0].options.find((option) => option.name === "duration");
  assert.equal(duration.type, 3);
  assert.match(duration.description, /1h/);
});
