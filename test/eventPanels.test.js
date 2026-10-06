const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_ID, GAME_URL, parseTime, buildPanel, buildEventPanelCommand, createEventPanelService } = require("../src/eventPanelService");
const { createEventPanelStore } = require("../src/eventPanelStore");
const { canRoleUseStaffCommand } = require("../staffCommandMatrix");
const BASE = { id: "123456789012345678", guildId: "guild", channelId: CHANNEL_ID, messageId: "message", title: "Ranger Trial", description: "Bring your patrol.", startsAt: "2026-12-01T20:00:00Z", status: "scheduled", locked: false, count: 0, revision: 0 };

function fixture() {
  const events = new Map([[BASE.id, { ...BASE }]]), attendees = new Map(), edits = [], sends = [];
  const store = {
    init: async () => {}, dirty: async () => [],
    get: async (id, guild) => { const event = [...events.values()].find((e) => (e.id === id || e.messageId === id) && e.guildId === guild); return event ? { ...event } : null; },
    list: async () => [...events.values()],
    create: async (event) => { const row = { ...BASE, ...event, count: 0, messageId: null }; events.set(row.id, row); return row; },
    update: async (id, guild, actor, action, changes) => { const row = events.get(id); Object.assign(row, changes); row.revision++; return { ...row }; },
    attend: async (id, guild, user, attending) => {
      const row = events.get(id); assert.equal(row.status, "scheduled");
      const key = id + user, was = attendees.has(key);
      if (attending) attendees.set(key, true); else attendees.delete(key);
      row.count += was === attending ? 0 : attending ? 1 : -1;
      return { changed: was !== attending, attending };
    },
    sync: async (id, publish) => { const row = events.get(id); row.messageId = await publish({ ...row }); return { ...row }; },
  };
  const message = { id: "message", author: { id: "bot" }, embeds: [], edit: async (p) => edits.push(p) };
  const channel = { id: CHANNEL_ID, guildId: "guild", messages: { fetch: async (arg) => typeof arg === "object" ? new Map() : message }, send: async (p) => { sends.push(p); return message; } };
  const service = createEventPanelService({ client: { user: { id: "bot" }, channels: { fetch: async () => channel } }, store, guildId: "guild", canManage: async (i) => i.staff === true, logger: { error() {} } });
  function interaction(action, values = {}, staff = true) {
    const responses = [];
    return { id: "987654321012345678", staff, guildId: "guild", channelId: CHANNEL_ID, user: { id: "member" }, message,
      responses, customId: `eventpanel|${action}|${BASE.id}`,
      options: { getSubcommand: () => action, getString: (key) => Object.hasOwn(values, key) ? values[key] : key === "event" ? BASE.id : null },
      deferReply: async () => {}, editReply: async (p) => responses.push(p) };
  }
  return { service, store, events, attendees, edits, sends, interaction };
}

test("time parser requires unambiguous timezone, validates dates and future time", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(parseTime("2026-10-06T19:30-07:00", now), "2026-10-07T02:30:00.000Z");
  assert.equal(parseTime("in 2h", now), "2026-10-06T14:00:00.000Z");
  assert.equal(parseTime(`<t:${Math.floor(now / 1000) + 3600}:F>`, now), "2026-10-06T13:00:00.000Z");
  for (const invalid of ["tomorrow at 7", "2026-10-06T19:30", "2026-02-30T19:30Z", "in 0h", "in 999d"]) assert.throws(() => parseTime(invalid, now));
});

test("panels show saved RSVP totals, localized time, and green Join only after start", () => {
  const upcoming = buildPanel({ ...BASE, count: 42 });
  assert.equal(upcoming.embeds[0].toJSON().fields.find((f) => f.name === "RSVPs").value, "42");
  assert.equal(upcoming.components[0].toJSON().components[0].label, "Attend");
  assert.deepEqual(upcoming.allowedMentions.parse, []);
  const live = buildPanel({ ...BASE, status: "grace" }).components[0].toJSON().components[0];
  assert.equal(live.label, "Join"); assert.equal(live.style, 3); assert.equal(live.disabled, false);
  for (const state of [{ status: "live", locked: true }, { status: "ended" }, { status: "cancelled" }]) assert.equal(buildPanel({ ...BASE, ...state }).components[0].toJSON().components[0].disabled, true);
});

test("RSVPs are idempotent, independent per member, and can be withdrawn", async () => {
  const f = fixture(); await f.service.init();
  await f.service.handleButton(f.interaction("attend")); await f.service.handleButton(f.interaction("attend"));
  const second = f.interaction("attend"); second.user.id = "second"; await f.service.handleButton(second);
  assert.equal(f.events.get(BASE.id).count, 2);
  await f.service.handleButton(f.interaction("withdraw")); await f.service.handleButton(f.interaction("withdraw"));
  assert.equal(f.events.get(BASE.id).count, 1);
});

test("foreign guild/channel/message and unrelated controls cannot change attendance", async () => {
  const f = fixture(); await f.service.init();
  for (const change of [{ guildId: "foreign" }, { channelId: "elsewhere" }, { message: { id: "copied" } }]) await f.service.handleButton(Object.assign(f.interaction("attend"), change));
  assert.equal(f.attendees.size, 0);
  const unrelated = f.interaction("attend"); unrelated.customId = "wave|join";
  assert.equal(await f.service.handleButton(unrelated), false);
});

test("start closes RSVPs; lock checks fresh state even for an old green button", async () => {
  const f = fixture(); await f.service.init();
  await f.service.handleCommand(f.interaction("start"));
  assert.equal(f.events.get(BASE.id).status, "starting");
  await f.service.handleButton(f.interaction("attend")); assert.equal(f.attendees.size, 0);
  let i = f.interaction("join"); await f.service.handleButton(i);
  assert.equal(i.responses[0].components[0].toJSON().components[0].url, GAME_URL);
  await f.service.handleCommand(f.interaction("lock")); i = f.interaction("join"); await f.service.handleButton(i);
  assert.equal(i.responses[0], "Joining is not open for this event.");
  await f.service.handleCommand(f.interaction("unlock")); await f.service.handleCommand(f.interaction("grace"));
  assert.equal(f.events.get(BASE.id).status, "grace");
  await f.service.handleCommand(f.interaction("end")); i = f.interaction("join"); await f.service.handleButton(i);
  assert.equal(i.responses[0], "Joining is not open for this event.");
});

test("staff checks protect create and edits; edits preserve attendees and same message", async () => {
  const f = fixture(); await f.service.init();
  await f.service.handleCommand(f.interaction("start", {}, false)); assert.equal(f.events.get(BASE.id).status, "scheduled");
  const foreign = f.interaction("start"); foreign.guildId = "other"; await f.service.handleCommand(foreign);
  assert.equal(f.events.get(BASE.id).status, "scheduled");
  await f.service.handleButton(f.interaction("attend"));
  await f.service.handleCommand(f.interaction("edit", { title: "Supply Run" }));
  assert.equal(f.events.get(BASE.id).count, 1); assert.equal(f.events.get(BASE.id).messageId, "message");
  assert.equal(f.edits[0].embeds[0].toJSON().title, "Supply Run"); assert.equal(f.sends.length, 0);
  assert.equal(canRoleUseStaffCommand("Mod", "eventpanel"), false);
  assert.equal(canRoleUseStaffCommand("LoreTeam", "eventpanel"), true);
});

test("stored panels and RSVPs work after service restart; edits fail closed if database unavailable", async () => {
  const f = fixture(); await f.service.init(); await f.service.handleButton(f.interaction("attend"));
  const restarted = createEventPanelService({ store: f.store, client: {}, guildId: "guild", canManage: async () => true, logger: { error() {} } });
  const blocked = f.interaction("attend"); await restarted.handleButton(blocked);
  assert.equal(blocked.responses[0], "Event storage is unavailable. Please try again later.");
  await restarted.init(); const i = f.interaction("attend"); await restarted.handleButton(i);
  assert.equal(i.responses[0], "You're already on the RSVP list."); assert.equal(f.events.get(BASE.id).count, 1);
});

test("Postgres attendance serializes against stage changes and rolls back closed RSVPs", async () => {
  const statements = []; let state = "scheduled", present = false;
  const c = { release() {}, async query(sql) {
    statements.push(sql);
    if (sql.startsWith("SELECT status")) return { rows: [{ status: state }] };
    if (sql.startsWith("INSERT INTO event_panel_attendees")) { const rowCount = present ? 0 : 1; present = true; return { rowCount }; }
    return { rows: [] };
  } };
  const store = createEventPanelStore({ pool: { connect: async () => c } });
  assert.equal((await store.attend(BASE.id, "guild", "member", true)).changed, true);
  assert.equal((await store.attend(BASE.id, "guild", "member", true)).changed, false);
  assert(statements.some((s) => s.includes("FOR UPDATE")));
  assert.equal(statements.filter((s) => s.startsWith("UPDATE event_panels")).length, 1);
  state = "starting"; await assert.rejects(store.attend(BASE.id, "guild", "member", true), /RSVPs are closed/);
  assert.equal(statements.at(-1), "ROLLBACK");
});

test("Discord slash definition has valid staff actions and required event references", () => {
  const definition = buildEventPanelCommand().toJSON();
  assert.equal(definition.name, "eventpanel");
  assert.equal(definition.options.length, 10);
  for (const action of definition.options.filter((s) => !["create", "list"].includes(s.name))) assert.equal(action.options[0].required, true);
});
