const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createVerificationService, VerificationServiceError } = require("../src/verificationService");
const { createGameApiRouter, getRequestApiKey, isAuthorizedRequest } = require("../src/gameApi");

function requestWith(headers) {
  return {
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

async function makeRequest(app, { path, method = "GET", headers = {}, body }) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    return await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(responseBody),
        }));
      });
      request.on("error", reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("Bearer auth is preferred and legacy x-api-key remains supported", () => {
  assert.equal(getRequestApiKey(requestWith({ authorization: "Bearer secret", "x-api-key": "old" })), "secret");
  assert.equal(getRequestApiKey(requestWith({ authorization: "secret" })), "secret");
  assert.equal(getRequestApiKey(requestWith({ "x-api-key": "secret" })), "secret");
  assert.equal(isAuthorizedRequest(requestWith({ authorization: "Bearer secret" }), "secret"), true);
  assert.equal(isAuthorizedRequest(requestWith({ authorization: "Bearer wrong" }), "secret"), false);
});

test("lookup resolves either side of a verification link", async () => {
  const record = {
    discordId: "20",
    robloxUserId: "10",
    robloxUsername: "Builder",
    robloxDisplayName: "Builder",
  };
  const service = createVerificationService({
    verificationDb: {
      async getVerificationByDiscordId(id) { return id === "20" ? record : null; },
      async getVerificationByRobloxUserId(id) { return id === "10" ? record : null; },
    },
  });

  assert.deepEqual(await service.lookup({ robloxUserId: 10 }), {
    verified: true,
    discordId: "20",
    robloxUserId: "10",
    robloxUsername: "Builder",
    robloxDisplayName: "Builder",
    verifiedAt: null,
    updatedAt: null,
    lastGameSeenAt: null,
    lastGameJoinedAt: null,
    lastGameLeftAt: null,
  });
  assert.deepEqual(await service.lookup({ discordId: "missing" }), { verified: false });
});

test("lookup rejects an empty query", async () => {
  const service = createVerificationService({ verificationDb: {} });
  await assert.rejects(
    service.lookup({}),
    (err) => err instanceof VerificationServiceError && err.code === "VALIDATION_ERROR"
  );
});

test("activity normalizes events and returns the linked IDs", async () => {
  let captured;
  const service = createVerificationService({
    verificationDb: {
      async recordGameActivity(activity) {
        captured = activity;
        return { discordId: "20", robloxUserId: activity.robloxUserId };
      },
    },
  });

  const result = await service.recordActivity({ robloxUserId: 10, eventType: "JOIN" });
  assert.equal(captured.eventType, "join");
  assert.equal(result.verification.discordId, "20");
});

test("versioned HTTP API returns a stable envelope", async () => {
  const verificationService = {
    async lookup({ robloxUserId }) {
      return { verified: true, robloxUserId, discordId: "20" };
    },
  };
  const userActionService = {
    async execute(payload) {
      return { method: payload.method, applied: true };
    },
  };
  const webhookService = { async execute() { return { messageId: "30" }; } };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createGameApiRouter({
    apiKey: "secret",
    verificationService,
    userActionService,
    webhookService,
  }));

  const unauthorized = await makeRequest(app, {
    path: "/api/v1/verifications/roblox/10",
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.code, "UNAUTHORIZED");

  const authorized = await makeRequest(app, {
    path: "/api/v1/verifications/roblox/10",
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body, {
    success: true,
    data: { verified: true, robloxUserId: "10", discordId: "20" },
  });

  const actionBody = JSON.stringify({ method: "GetRoles", robloxUserId: "10" });
  const action = await makeRequest(app, {
    path: "/api/v1/useraction",
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(actionBody),
    },
    body: actionBody,
  });
  assert.equal(action.status, 200);
  assert.deepEqual(action.body, {
    success: true,
    data: { method: "GetRoles", applied: true },
  });
});
