const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const CHANNEL_ID = "1494456631126396988";
const GAME_URL = "https://www.roblox.com/games/98469964369358/Thornvale-Sword-and-Shield";
const PREFIX = "eventpanel";
const STATES = { scheduled: "Upcoming event", starting: "The event is starting", grace: "Grace period", live: "Event in progress", ended: "Event ended", cancelled: "Event cancelled" };
const CLOSED = new Set(["ended", "cancelled"]);

function parseTime(input, now = Date.now()) {
  const value = String(input || "").trim();
  const timestamp = value.match(/^(?:<t:)?(\d{10})(?::[tTdDfFR])?>?$/);
  const relative = value.match(/^in\s+(\d{1,5})(m|h|d)$/i);
  let date;
  if (timestamp) date = new Date(Number(timestamp[1]) * 1000);
  else if (relative) date = new Date(now + Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2].toLowerCase()]);
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error("Invalid calendar date.");
    date = new Date(value.replace(" ", "T"));
  }
  if (!date || !Number.isFinite(date.getTime())) throw new Error("Use a Discord timestamp, 'in 2h', or a date with timezone such as 2026-10-06T19:30-07:00.");
  if (date.getTime() <= now) throw new Error("Choose a future start time.");
  if (date.getTime() > now + 366 * 86400000) throw new Error("Schedule events within the next year.");
  return date.toISOString();
}

function buildPanel(event) {
  const timestamp = Math.floor(new Date(event.startsAt).getTime() / 1000);
  const closed = CLOSED.has(event.status);
  const scheduled = event.status === "scheduled";
  const color = closed ? 0x8f969d : event.locked ? 0xc17a7a : scheduled ? 0xd0ae73 : 0x95b99a;
  const embed = new EmbedBuilder().setTitle(event.title).setColor(color)
    .setDescription(event.description || "Gather for the next Thornvale event.")
    .addFields(
      { name: "When", value: `<t:${timestamp}:F> · <t:${timestamp}:R>` },
      { name: "Status", value: STATES[event.status], inline: true },
      { name: "RSVPs", value: String(event.count), inline: true },
      { name: "Server access", value: closed ? "Closed" : event.locked ? "Locked" : "Unlocked", inline: true },
    ).setFooter({ text: `Event ${event.id} · Thornvale` });
  const row = new ActionRowBuilder();
  if (scheduled) {
    row.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}|attend|${event.id}`).setLabel("Attend").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}|withdraw|${event.id}`).setLabel("Withdraw RSVP").setStyle(ButtonStyle.Secondary));
  } else {
    row.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}|join|${event.id}`)
      .setLabel(closed ? event.status === "cancelled" ? "Cancelled" : "Ended" : event.locked ? "Join · Locked" : "Join")
      .setStyle(ButtonStyle.Success).setDisabled(closed || event.locked));
  }
  return { content: "", embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function buildEventPanelCommand() {
  const command = new SlashCommandBuilder().setName("eventpanel").setDescription("Schedule events, collect RSVPs, and manage the event panel").setDMPermission(false);
  command.addSubcommand((s) => s.setName("create").setDescription("Post an upcoming event with Attend and RSVP count")
    .addStringOption((o) => o.setName("title").setDescription("Event title").setRequired(true).setMaxLength(150))
    .addStringOption((o) => o.setName("time").setDescription("Discord timestamp, in 2h, or 2026-10-06T19:30-07:00").setRequired(true).setMaxLength(50))
    .addStringOption((o) => o.setName("description").setDescription("Event details or rewards").setMaxLength(2500)));
  const eventOption = (s) => s.addStringOption((o) => o.setName("event").setDescription("Event ID from the footer, or the panel message ID").setRequired(true).setMaxLength(32));
  command.addSubcommand((s) => eventOption(s.setName("edit").setDescription("Edit the existing panel without losing RSVPs"))
    .addStringOption((o) => o.setName("title").setDescription("New title").setMaxLength(150))
    .addStringOption((o) => o.setName("time").setDescription("New start time including timezone, timestamp, or in 2h").setMaxLength(50))
    .addStringOption((o) => o.setName("description").setDescription("Replacement event details").setMaxLength(2500)));
  for (const [action, description] of Object.entries({ start: "Start the event and replace Attend with green Join", grace: "Mark the grace period", live: "Mark the event in progress", lock: "Mark the panel locked and disable Join", unlock: "Mark the panel unlocked and enable Join", end: "End the event and close Join", cancel: "Cancel the event and close attendance" })) {
    command.addSubcommand((s) => eventOption(s.setName(action).setDescription(description)));
  }
  command.addSubcommand((s) => s.setName("list").setDescription("List the latest event panels and their IDs"));
  return command;
}

function createEventPanelService({ client, store, guildId, canManage, logger = console }) {
  let ready = false, reconciliationRunning = false;
  const syncing = new Map();
  const queued = new Map();
  const link = (event) => `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
  async function publish(event) {
    const channel = await client.channels.fetch(event.channelId);
    if (!channel || channel.guildId !== guildId || channel.id !== CHANNEL_ID || typeof channel.send !== "function") throw new Error("Configured event channel is unavailable.");
    const payload = buildPanel(event);
    if (event.messageId) {
      let message;
      try { message = await channel.messages.fetch(event.messageId); }
      catch (error) { if (error.code !== 10008) throw error; }
      if (message) {
        if (message.author.id !== client.user.id) throw new Error("Panel message is not owned by this bot.");
        await message.edit(payload);
        return message.id;
      }
    }
    // Recover an uncertain send before creating a second public post.
    const history = await channel.messages.fetch({ limit: 100 });
    const existing = history.find((m) => m.author.id === client.user.id && m.embeds.some((e) => e.footer?.text === `Event ${event.id} · Thornvale`));
    if (existing) { await existing.edit(payload); return existing.id; }
    const message = await channel.send({ ...payload, nonce: event.id, enforceNonce: true });
    return message.id;
  }
  async function sync(id) {
    if (syncing.has(id)) return syncing.get(id);
    const task = store.sync(id, publish).finally(() => syncing.delete(id));
    syncing.set(id, task);
    return task;
  }
  function queueSync(id) {
    if (queued.has(id)) return;
    const timer = setTimeout(() => {
      queued.delete(id);
      void sync(id).catch((error) => logger.error("[EventPanels] Panel refresh deferred", error.code || error.message));
    }, 1000);
    queued.set(id, timer);
    timer.unref();
  }
  async function reconcile() {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      for (const row of await store.dirty()) {
        if (row.guild_id !== guildId) continue;
        await sync(row.id).catch((e) => logger.error("[EventPanels] Retry failed", e.code || e.message));
      }
    } finally { reconciliationRunning = false; }
  }
  async function handleCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (interaction.guildId !== guildId || !await canManage(interaction)) return interaction.editReply("You do not have permission to manage event panels in this server.");
    if (!ready) return interaction.editReply("Event storage is unavailable. Please try again later.");
    const action = interaction.options.getSubcommand();
    if (action === "list") {
      const events = await store.list(guildId);
      return interaction.editReply({ content: events.length ? events.map((e) => `\`${e.id}\` — ${e.title} · ${STATES[e.status]} · ${e.count} RSVP${e.count === 1 ? "" : "s"}${e.messageId ? ` · [Panel](${link(e)})` : " · Posting pending"}`).join("\n").slice(0, 1950) : "No event panels yet.", allowedMentions: { parse: [] } });
    }
    let event;
    if (action === "create") {
      let startsAt;
      try { startsAt = parseTime(interaction.options.getString("time", true)); }
      catch (error) { return interaction.editReply(error.message); }
      event = await store.create({ id: interaction.id, guildId, channelId: CHANNEL_ID, actorId: interaction.user.id,
        title: interaction.options.getString("title", true), description: interaction.options.getString("description") || "", startsAt });
    } else {
      const reference = interaction.options.getString("event", true);
      event = await store.get(reference, guildId);
      if (!event) return interaction.editReply("Event not found. Use /eventpanel list to find its ID.");
      if (CLOSED.has(event.status)) return interaction.editReply("This event is closed. Create a new panel for another event.");
      if (action === "start" && event.status !== "scheduled") return interaction.editReply("This event has already started.");
      if (["grace", "live"].includes(action) && event.status === "scheduled") return interaction.editReply("Start the event first.");
      const changes = {};
      if (action === "edit") {
        for (const name of ["title", "description"]) {
          const value = interaction.options.getString(name);
          if (value !== null) changes[name] = value;
        }
        const time = interaction.options.getString("time");
        if (time) {
          try { changes.startsAt = parseTime(time); } catch (error) { return interaction.editReply(error.message); }
        }
        if (!Object.keys(changes).length) return interaction.editReply("Provide a title, time, or description to change.");
      } else if (action === "lock" || action === "unlock") changes.locked = action === "lock";
      else changes.status = ({ start: "starting", grace: "grace", live: "live", end: "ended", cancel: "cancelled" })[action];
      if (action !== "edit" && changes.status === undefined && changes.locked === undefined) return interaction.editReply("Unknown event action.");
      event = await store.update(event.id, guildId, interaction.user.id, action, changes);
    }
    let rendered;
    try { rendered = await sync(event.id); }
    catch (error) { logger.error("[EventPanels] Sync deferred", error.code || error.message); }
    return interaction.editReply({ content: rendered?.messageId
      ? `Event saved: [Open panel](${link(rendered)}). ID: \`${event.id}\`.`
      : `Event \`${event.id}\` saved. The public panel update is pending; the bot will retry.`, allowedMentions: { parse: [] } });
  }
  async function handleButton(interaction) {
    if (!interaction.customId.startsWith(`${PREFIX}|`)) return false;
    await interaction.deferReply({ ephemeral: true });
    if (!ready) { await interaction.editReply("Event storage is unavailable. Please try again later."); return true; }
    const [prefix, action, id, extra] = interaction.customId.split("|");
    if (prefix !== PREFIX || extra || !["attend", "withdraw", "join"].includes(action) || interaction.guildId !== guildId || interaction.channelId !== CHANNEL_ID) {
      await interaction.editReply("This event control is invalid."); return true;
    }
    const event = await store.get(id, guildId);
    if (!event || event.messageId !== interaction.message.id) { await interaction.editReply("This is not the current event panel."); return true; }
    if (action === "join") {
      if (event.status === "scheduled" || CLOSED.has(event.status) || event.locked) { await interaction.editReply("Joining is not open for this event."); return true; }
      await interaction.editReply({ content: `${STATES[event.status]}. Join Thornvale below.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Thornvale").setStyle(ButtonStyle.Link).setURL(GAME_URL))] });
    } else {
      if (event.status !== "scheduled") { await interaction.editReply("RSVPs closed when this event started."); return true; }
      const result = await store.attend(id, guildId, interaction.user.id, action === "attend");
      queueSync(id);
      await interaction.editReply(result.attending ? result.changed ? "You're attending! Your RSVP is saved." : "You're already on the RSVP list." : result.changed ? "Your RSVP has been removed." : "You haven't RSVP'd for this event.");
    }
    return true;
  }
  return {
    isReady: () => ready,
    async init() {
      await store.init(); ready = true;
      void reconcile().catch((e) => logger.error("[EventPanels] Startup refresh failed", e.code || e.message));
      const timer = setInterval(() => void reconcile().catch((e) => logger.error("[EventPanels] Refresh failed", e.code || e.message)), 15000);
      timer.unref();
    },
    handleCommand, handleButton,
  };
}

module.exports = { CHANNEL_ID, GAME_URL, parseTime, buildPanel, buildEventPanelCommand, createEventPanelService };
