const test = require("node:test");
const assert = require("node:assert/strict");
const { createRobloxGroupService } = require("../src/robloxGroupService");
const { registerSlashCommands } = require("../src/registerSlashCommands");
const {
  buildApplicationReviewPayload,
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

test("only one staff reviewer can claim a pending application", async () => {
  const store = createMemoryStore();
  const created = await store.createSession(session({ applicationLimit: 2 }));
  const reserved = await store.reserveApplication({
    id: "TV-APP-CLAIM",
    waveId: created.id,
    discordId: "discord",
    robloxUserId: "123456",
    robloxUsername: "Builder_One",
    candidateAnswer: "A sufficiently complete candidate answer.",
    discoveryAnswer: "A friend invited me.",
  });
  assert.equal(reserved.application.status, "pending");
  assert.equal((await store.claimApplication(reserved.application.id, "staff-one")).ok, true);
  const secondClaim = await store.claimApplication(reserved.application.id, "staff-two");
  assert.equal(secondClaim.ok, false);
  assert.equal(secondClaim.application.reviewerDiscordId, "staff-one");
  await store.updateApplicationStatus(reserved.application.id, "accepted", "Approved", "staff-one");
  const approved = await store.findAcceptedApplication("discord", "123456");
  assert.equal(approved.id, reserved.application.id);
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

test("Roblox group membership uses the public recommended roles endpoint", async () => {
  const service = createRobloxGroupService({
    groupId: "99",
    cookie: "secret-cookie",
    async fetchImpl(url, options) {
      assert.equal(url, "https://groups.roblox.com/v2/users/123456/groups/roles");
      assert.equal(options.method, "GET");
      return {
        ok: true,
        async json() {
          return { data: [{ group: { id: 99 }, role: { id: 1, name: "Member" } }] };
        },
      };
    },
  });
  const membership = await service.getMembership("123456");
  assert.equal(membership.isMember, true);
  assert.equal(membership.role.name, "Member");
});

test("verified wave submissions wait for staff and approval points applicants to verifygroup", async () => {
  const activeSession = session({ applicationLimit: 5 });
  let reviewPayload;
  let updatedReviewPayload;
  let responseText;
  let reviewResponseText;
  let application;
  const privateMessages = [];
  const privateThread = {
    id: "private-thread",
    archived: false,
    members: { async add(userId) { assert.equal(userId, "discord"); } },
    async send(payload) { privateMessages.push(payload); },
  };
  const store = {
    type: "memory",
    async getSession() { return activeSession; },
    async reserveApplication(value) {
      application = {
        ...value,
        status: "pending",
        statusMessage: null,
        applicantThreadId: null,
        reviewerDiscordId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ok: true,
        application,
        session: { ...activeSession, applicationCount: 1 },
      };
    },
    async updateApplicationContext(id, context) {
      assert.equal(id, application.id);
      application = { ...application, ...context };
      return application;
    },
    async claimApplication(id, reviewerDiscordId) {
      assert.equal(id, application.id);
      application = { ...application, status: "processing", reviewerDiscordId };
      return { ok: true, application };
    },
    async updateApplicationStatus(id, status, statusMessage, reviewerDiscordId) {
      assert.equal(id, application.id);
      application = { ...application, status, statusMessage, reviewerDiscordId };
      return application;
    },
  };
  const service = createWaveService({
    client: {
      channels: {
        async fetch(channelId) {
          if (channelId === "channel") {
            return {
              type: 0,
              threads: { async create() { return privateThread; } },
            };
          }
          if (channelId === "review") {
            return { async send(payload) { reviewPayload = payload; } };
          }
          if (channelId === "private-thread") return privateThread;
          throw new Error(`Unexpected channel ${channelId}`);
        },
      },
    },
    store,
    robloxGroupUrl: "https://www.roblox.com/communities/99",
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
    async canReviewInteraction() { return true; },
  });
  const interaction = {
    customId: `wave|submit|${activeSession.id}`,
    user: {
      id: "discord",
      async send() {},
    },
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
  assert.equal(application.status, "pending");
  assert.equal(application.applicantThreadId, "private-thread");
  assert.ok(reviewPayload.components?.[0]);
  assert.match(responseText, /staff review/i);
  assert.match(privateMessages[0].content, /waiting for staff review/i);
  assert.match(privateMessages[0].content, /request to join the Roblox group/i);

  const reviewInteraction = {
    customId: `wave|review|accept|${application.id}`,
    user: { id: "staff" },
    message: { async edit(payload) { updatedReviewPayload = payload; } },
    async deferReply() {},
    async editReply(text) { reviewResponseText = text; },
  };
  assert.equal(await service.handleButton(reviewInteraction), true);
  assert.equal(application.status, "accepted");
  assert.match(privateMessages[1].content, /<@discord>.*accepted.*verifygroup/i);
  assert.equal(updatedReviewPayload.components[0].components[0].toJSON().disabled, true);
  assert.match(reviewResponseText, /accepted/i);
});

test("staff can deny a pending wave application without Roblox automation", async () => {
  let application = {
    id: "TV-APP-DENY",
    waveId: "TV-WAVE-TEST",
    discordId: "discord",
    robloxUserId: "123456",
    robloxUsername: "Builder_One",
    candidateAnswer: "A sufficiently complete candidate answer.",
    discoveryAnswer: "A friend invited me.",
    applicantThreadId: "private-thread",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let robloxCalled = false;
  let applicantMessage;
  const service = createWaveService({
    client: {
      channels: {
        async fetch() {
          return { async send(payload) { applicantMessage = payload.content; } };
        },
      },
    },
    store: {
      async claimApplication(id, reviewerDiscordId) {
        application = { ...application, status: "processing", reviewerDiscordId };
        return { ok: true, application };
      },
      async getSession() { return session(); },
      async updateApplicationStatus(id, status, statusMessage, reviewerDiscordId) {
        application = { ...application, status, statusMessage, reviewerDiscordId };
        return application;
      },
    },
    verificationService: { async lookup() { return { verified: true }; } },
    robloxGroupService: { async acceptJoinRequest() { robloxCalled = true; } },
    async canReviewInteraction() { return true; },
  });
  let responseText;
  const interaction = {
    customId: "wave|review|deny|TV-APP-DENY",
    user: { id: "staff" },
    message: { async edit() {} },
    async deferReply() {},
    async editReply(text) { responseText = text; },
  };

  assert.equal(await service.handleButton(interaction), true);
  assert.equal(robloxCalled, false);
  assert.equal(application.status, "denied");
  assert.match(applicantMessage, /<@discord>.*denied/i);
  assert.match(responseText, /denied/i);
});

test("wave button explains when a surviving Verified role has lost its saved link", async () => {
  let reply;
  const service = createWaveService({
    client: {},
    store: { async getSession() { return session({ applicationLimit: 5 }); } },
    verifiedRoleId: "verified-role",
    verificationService: { async lookup() { return { verified: false }; } },
  });
  const interaction = {
    customId: "wave|apply|TV-WAVE-TEST",
    user: { id: "discord" },
    member: { roles: { cache: { has(roleId) { return roleId === "verified-role"; } } } },
    async reply(payload) { reply = payload; },
  };

  assert.equal(await service.handleButton(interaction), true);
  assert.match(reply.content, /saved Roblox account link is missing/i);
  assert.match(reply.content, /repair/i);
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
  assert.ok(commands.map((command) => command.toJSON()).some((command) => command.name === "verifygroup"));
  assert.ok(commands.map((command) => command.toJSON()).some((command) => command.name === "unwave-all"));
  assert.ok(commands.map((command) => command.toJSON()).some((command) => command.name === "unverify-all"));
  const unwaveAll = commands.map((command) => command.toJSON()).find((command) => command.name === "unwave-all");
  const unverifyAll = commands.map((command) => command.toJSON()).find((command) => command.name === "unverify-all");
  assert.equal(unwaveAll.options.find((option) => option.name === "notificationchannel").required, true);
  assert.equal(unverifyAll.options.find((option) => option.name === "notificationchannel").required, true);
});

test("review payload exposes staff actions only while an application is pending", () => {
  const baseApplication = {
    id: "TV-APP-TEST",
    discordId: "discord",
    robloxUserId: "123456",
    robloxUsername: "Builder_One",
    candidateAnswer: "A sufficiently complete candidate answer.",
    discoveryAnswer: "A friend invited me.",
    createdAt: new Date().toISOString(),
  };
  const pending = buildApplicationReviewPayload(session(), {
    ...baseApplication,
    status: "pending",
  });
  assert.equal(pending.components[0].components[0].toJSON().disabled, false);
  const accepted = buildApplicationReviewPayload(session(), {
    ...baseApplication,
    status: "accepted",
  });
  assert.equal(accepted.components[0].components[0].toJSON().disabled, true);
});
