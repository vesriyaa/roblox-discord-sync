const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrivateNoticeService } = require("../src/privateNoticeService");

test("access notices are delivered by DM without creating a thread", async () => {
  let directMessage;
  const service = createPrivateNoticeService({ client: {} });
  const result = await service.sendAccessNotice({
    member: {
      id: "discord",
      user: {
        async send(payload) { directMessage = payload.content; },
      },
    },
    kind: "unwaved",
  });

  assert.deepEqual(result, { deliveredBy: "DM", threadId: null });
  assert.match(directMessage, /only the \*\*Wald\*\*/);
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
