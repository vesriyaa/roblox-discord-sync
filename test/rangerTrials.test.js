const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createRangerTrialService, normalizeRoster, CHANNEL_ID } = require("../src/rangerTrialService");
const { buildSlashCommands } = require("../src/registerSlashCommands");
const { canRoleUseStaffCommand } = require("../staffCommandMatrix");

const id = "12345678-1234-1234-1234-123456789abc";
const characterId = "87654321-1234-1234-1234-123456789abc";
const roster = () => ({ id, owner: "99", ownerName: "Examiner", candidates: [{ userId: "123", name: "Candidate", slot: "2", characterId, result: "Pending" }] });

function fixture() {
  const rows = new Map(), grants = new Map(), messages = [];
  const pool = { async query(sql, args = []) {
    if (sql.startsWith("CREATE TABLE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO ranger_trial_reviews")) { if (!rows.has(args[0])) rows.set(args[0], { id: args[0], roster: args[1] }); return { rows: [] }; }
    if (sql.startsWith("SELECT id FROM")) return { rows: [] };
    if (sql.startsWith("SELECT * FROM") || sql.startsWith("SELECT roster FROM")) return { rows: rows.has(args[0]) ? [rows.get(args[0])] : [] };
    if (sql.startsWith("UPDATE ranger_trial_reviews")) { rows.get(args[0]).message_id = args[1]; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO ranger_trial_grants")) {
      const key = args[0] + args[1]; if (grants.has(key)) return { rowCount: 0, rows: [] };
      grants.set(key, { id: args[0], userId: args[1], slot: args[2], characterId: args[3], reviewerId: args[4] }); return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("SELECT trial_id")) return { rows: [...grants.values()].filter((g) => args[0].includes(g.userId) && !g.applied) };
    if (sql.startsWith("UPDATE ranger_trial_grants")) { const g = grants.get(args[0] + args[1]); if (g && g.characterId === args[2]) g.applied = true; return { rows: [] }; }
    throw new Error("Unexpected SQL: " + sql);
  } };
  const channel = { guildId: "guild", async send(message) { messages.push(message); return { id: "message" }; } };
  const service = createRangerTrialService({ client: { channels: { fetch: async () => channel } }, apiKey: "test-key", guildId: "guild", pool, canReview: async (i) => i.allowed });
  function interaction(allowed = true, userId = "123", channelId = CHANNEL_ID) {
    const replies = [];
    return { allowed, replies, channelId, guildId: "guild", user: { id: "staff" }, channel,
      options: { getString: (key) => key === "trial" ? id : userId },
      deferReply: async () => {}, reply: async (r) => replies.push(r), editReply: async (r) => replies.push(r) };
  }
  return { service, rows, grants, messages, interaction };
}

test("rosters validate unique members, slot identity and result", () => {
  assert.equal(normalizeRoster(roster()).candidates[0].slot, "2");
  const duplicate = roster(); duplicate.candidates.push(duplicate.candidates[0]);
  assert.throws(() => normalizeRoster(duplicate));
  const invalid = roster(); delete invalid.candidates[0].characterId;
  assert.throws(() => normalizeRoster(invalid));
});

test("channel and staff permission gates, duplicate protection, durable delivery ack", async (t) => {
  const f = fixture(); await f.service.init();
  const app = express(); app.use(express.json()); app.use(f.service.router);
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const request = async (path, body, key = "test-key") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request("/archive", roster(), "wrong")).status, 401);
  assert.equal((await request("/archive", roster())).body.data.archived, true);
  const changed = roster(); changed.candidates[0].slot = "3"; await request("/archive", changed);
  assert.equal(f.rows.get(id).roster.candidates[0].slot, "2", "archive cannot rewrite trial identity");
  for (const i of [f.interaction(false), f.interaction(true, "123", "wrong-channel"), f.interaction(true, "999")]) await f.service.handleCommand(i);
  assert.equal(f.grants.size, 0);
  await f.service.handleCommand(f.interaction()); await f.service.handleCommand(f.interaction());
  assert.equal(f.grants.size, 1);
  assert.equal((await request("/pending", { users: ["999"] })).body.data.length, 0);
  assert.equal((await request("/pending", { users: ["123"] })).body.data[0].characterId, characterId);
  await request("/ack", { id, userId: "123", characterId });
  assert.equal((await request("/pending", { users: ["123"] })).body.data.length, 0);
});

test("slash command registered and review follows staff hierarchy", () => {
  const commands = buildSlashCommands().map((c) => typeof c.toJSON === "function" ? c.toJSON() : c);
  assert(commands.some((c) => c.name === "ranger-pass"));
  assert.equal(canRoleUseStaffCommand("Mod", "ranger-pass"), false);
  assert.equal(canRoleUseStaffCommand("LoreTeam", "ranger-pass"), true);
});
