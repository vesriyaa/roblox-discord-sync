const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrivateNoticeService } = require("../src/privateNoticeService");

test("access notices use a locked, archived private thread", async () => {
  const events = [];
  const thread = {
    id: "notice-thread",
    members: { async add(id) { events.push(["member", id]); } },
    async send(payload) { events.push(["message", payload.content]); },
    async setLocked(value) { events.push(["locked", value]); },
    async setArchived(value) { events.push(["archived", value]); },
  };
  const channel = {
    type: 0,
    threads: {
      async create(options) {
        events.push(["created", options.type]);
        return thread;
      },
    },
  };
  const service = createPrivateNoticeService({ client: {} });
  const result = await service.sendAccessNotice({
    channel,
    member: { id: "discord", user: { username: "Applicant" } },
    kind: "unwaved",
  });

  assert.deepEqual(result, { deliveredBy: "private thread", threadId: "notice-thread" });
  assert.deepEqual(events.map(([event]) => event), ["created", "member", "message", "locked", "archived"]);
  assert.match(events[2][1], /only the \*\*Wald\*\*/);
});

test("successful group verification closes the existing application thread", async () => {
  const events = [];
  const thread = {
    id: "application-thread",
    archived: true,
    async setArchived(value) { events.push(["archived", value]); this.archived = value; },
    async send(payload) { events.push(["message", payload.content]); },
    async setLocked(value) { events.push(["locked", value]); },
  };
  const service = createPrivateNoticeService({
    client: { channels: { async fetch(id) { assert.equal(id, thread.id); return thread; } } },
  });
  const result = await service.closeApplicationThread({
    application: { id: "TV-APP-1", applicantThreadId: thread.id, discordId: "discord" },
    content: "Your group membership is active.",
  });

  assert.equal(result.closed, true);
  assert.deepEqual(events.map(([event]) => event), ["archived", "message", "locked", "archived"]);
  assert.deepEqual(events.filter(([event]) => event === "archived").map(([, value]) => value), [false, true]);
});
