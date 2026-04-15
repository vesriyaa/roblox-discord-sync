const express = require("express");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
} = require("discord.js");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.API_KEY;
const GROUP_ID = process.env.GROUP_ID;

// 🔹 ROLE IDS
const VERIFIED_ROLE_ID = "1477834795512893520";
const MOD_ROLE_ID = "1477872215801331763";

// 🔹 DISCORD ROLE SWAP
const WALD_ROLE_ID = "1415902349192331381";
const ENVISIONED_ROLE_ID = "1415902349192331383";
const WIPE_CHANNEL_ID = "1492143731921387520";
const DEATH_CHANNEL_ID = "1415902351985872908";

// 🔹 Team → Role mapping
const roleMap = {
  "Crimson Blades": "1477828058949091481",
  "Vanguard": "1477828166025220178",
  "Fame": "1477827943278317660",
  "Chasers": "1477828132269457559"
};

const verificationCodes = new Map();
const unlinkedUsers = new Set();
const adminActions = new Map();
const adminActionOrder = [];
const adminActionDedupe = new Map();
const adminActionWaiters = new Map();
const ADMIN_ACTION_WAIT_TIMEOUT_MS = 15000;
const ADMIN_ACTION_CLAIM_TIMEOUT_MS = 60000;
const ADMIN_ACTION_RETENTION_MS = 30 * 60 * 1000;

async function resolveDiscordMember(guild, input) {
  const rawInput = input.trim();
  const mentionMatch = rawInput.match(/^<@!?(\d+)>$/);
  const discordId = mentionMatch?.[1] ?? (/^\d+$/.test(rawInput) ? rawInput : null);

  if (discordId) {
    try {
      return await guild.members.fetch(discordId);
    } catch {
      return null;
    }
  }

  const normalizedInput = rawInput.replace(/^@/, "").toLowerCase();
  const members = await guild.members.fetch();

  return members.find((guildMember) => {
    const { user, displayName } = guildMember;
    const tag = user.discriminator === "0"
      ? user.username
      : `${user.username}#${user.discriminator}`;

    return user.username.toLowerCase() === normalizedInput
      || user.tag.toLowerCase() === normalizedInput
      || tag.toLowerCase() === normalizedInput
      || user.globalName?.toLowerCase() === normalizedInput
      || displayName?.toLowerCase() === normalizedInput;
  }) ?? null;
}

async function updateGroupAcceptRoles(member) {
  if (member.roles.cache.has(WALD_ROLE_ID)) {
    await member.roles.remove(WALD_ROLE_ID);
  }

  if (!member.roles.cache.has(ENVISIONED_ROLE_ID)) {
    await member.roles.add(ENVISIONED_ROLE_ID);
  }
}

function sendInteractionResponse(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }

  return interaction.reply({
    content,
    ephemeral: true
  });
}

function getRelayChannelId(service) {
  const relayChannels = {
    wipe: WIPE_CHANNEL_ID,
    death: DEATH_CHANNEL_ID,
  };

  return relayChannels[service] || null;
}

function buildRelayMessagePayload(body) {
  const messagePayload = {};
  const embeds = Array.isArray(body?.embeds)
    ? body.embeds
    : body?.embeds
      ? [body.embeds]
      : [];

  if (typeof body?.content === "string" && body.content.length > 0) {
    messagePayload.content = body.content;
  }

  if (embeds.length > 0) {
    messagePayload.embeds = embeds;
  }

  if (body?.allowedMentions) {
    messagePayload.allowedMentions = body.allowedMentions;
  }

  return messagePayload;
}

function hasModPermissions(member) {
  return member.roles.cache.has(MOD_ROLE_ID);
}

function getEmbedFieldValue(embed, fieldName) {
  const field = Array.isArray(embed?.fields)
    ? embed.fields.find((entry) => entry?.name === fieldName)
    : null;

  return typeof field?.value === "string" ? field.value : null;
}

function extractUserIdFromTargetField(targetFieldValue) {
  const match = typeof targetFieldValue === "string"
    ? targetFieldValue.match(/\((\d+)\)\s*$/)
    : null;

  return match?.[1] ?? null;
}

function buildRelayComponents(service, body) {
  const primaryEmbed = Array.isArray(body?.embeds) ? body.embeds[0] : body?.embeds;
  if (!primaryEmbed) {
    return [];
  }

  const targetUserId = extractUserIdFromTargetField(getEmbedFieldValue(primaryEmbed, "Target"));
  if (!targetUserId) {
    return [];
  }

  if (service === "death" && primaryEmbed.title === "Pending Permanent Death Wipe Triggered") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`adminAction|unwipe|${targetUserId}`)
          .setLabel("Unwipe")
          .setStyle(ButtonStyle.Success)
      ),
    ];
  }

  if (service === "wipe" && primaryEmbed.title === "Player Data Wiped") {
    const snapshotId = getEmbedFieldValue(primaryEmbed, "Snapshot ID");
    if (!snapshotId || snapshotId === "Unavailable") {
      return [];
    }

    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`adminAction|restore|${targetUserId}|${snapshotId}`)
          .setLabel("Restore")
          .setStyle(ButtonStyle.Primary)
      ),
    ];
  }

  return [];
}

function createAdminActionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupAdminActionRecords() {
  const cutoff = Date.now() - ADMIN_ACTION_RETENTION_MS;

  while (adminActionOrder.length > 0) {
    const oldestId = adminActionOrder[0];
    const record = adminActions.get(oldestId);
    if (!record) {
      adminActionOrder.shift();
      continue;
    }

    if ((record.status === "pending" || record.status === "claimed") || record.completedAt >= cutoff) {
      break;
    }

    adminActions.delete(oldestId);
    adminActionOrder.shift();
  }
}

function getActionLabel(actionType) {
  const labels = {
    wipe: "wipe",
    unwipe: "unwipe",
    restore: "restore",
  };

  return labels[actionType] || actionType;
}

function findExistingAdminAction(dedupeKey) {
  if (!dedupeKey) {
    return null;
  }

  const actionId = adminActionDedupe.get(dedupeKey);
  if (!actionId) {
    return null;
  }

  const record = adminActions.get(actionId);
  if (!record || (record.status !== "pending" && record.status !== "claimed")) {
    adminActionDedupe.delete(dedupeKey);
    return null;
  }

  return record;
}

function queueAdminAction(actionData) {
  cleanupAdminActionRecords();

  const existingRecord = findExistingAdminAction(actionData.dedupeKey);
  if (existingRecord) {
    return { record: existingRecord, duplicate: true };
  }

  const record = {
    ...actionData,
    id: createAdminActionId(),
    status: "pending",
    createdAt: Date.now(),
    claimedAt: null,
    completedAt: null,
    resultMessage: null,
    resultSuccess: null,
  };

  adminActions.set(record.id, record);
  adminActionOrder.push(record.id);

  if (record.dedupeKey) {
    adminActionDedupe.set(record.dedupeKey, record.id);
  }

  return { record, duplicate: false };
}

function waitForAdminActionCompletion(actionId, timeoutMs = ADMIN_ACTION_WAIT_TIMEOUT_MS) {
  const existingRecord = adminActions.get(actionId);
  if (!existingRecord) {
    return Promise.resolve(null);
  }

  if (existingRecord.status === "completed" || existingRecord.status === "failed") {
    return Promise.resolve(existingRecord);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      adminActionWaiters.delete(actionId);
      resolve(adminActions.get(actionId) || null);
    }, timeoutMs);

    adminActionWaiters.set(actionId, {
      resolve,
      timeout,
    });
  });
}

function resolveAdminActionWaiter(actionId, record) {
  const waiter = adminActionWaiters.get(actionId);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timeout);
  adminActionWaiters.delete(actionId);
  waiter.resolve(record);
}

function parseAdminActionCustomId(customId) {
  const [prefix, actionType, targetUserId, snapshotId] = String(customId || "").split("|");
  if (prefix !== "adminAction" || !actionType || !targetUserId) {
    return null;
  }

  const parsedUserId = Number.parseInt(targetUserId, 10);
  if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
    return null;
  }

  return {
    actionType,
    targetUserId: parsedUserId,
    snapshotId: snapshotId || null,
  };
}

function getAdminActionDescription(action) {
  if (action.actionType === "restore") {
    return `restore for Roblox user ${action.targetUserId}`;
  }

  if (action.actionType === "unwipe") {
    return `unwipe for Roblox user ${action.targetUserId}`;
  }

  if (action.actionType === "wipe") {
    return `wipe for Roblox user ${action.targetUserId}`;
  }

  return `admin action for Roblox user ${action.targetUserId}`;
}

async function disableSourceMessageButtons(record) {
  const source = record.sourceMessage;
  if (!source?.channelId || !source?.messageId) {
    return;
  }

  const channel = await client.channels.fetch(source.channelId);
  if (!channel?.messages?.fetch) {
    return;
  }

  const message = await channel.messages.fetch(source.messageId);
  if (!message) {
    return;
  }

  const disabledComponents = message.components.map((row) =>
    new ActionRowBuilder().addComponents(
      row.components.map((component) =>
        ButtonBuilder.from(component).setDisabled(true)
      )
    )
  );

  await message.edit({ components: disabledComponents });
}

async function postAdminActionResult(record) {
  if (!record.sourceMessage?.channelId) {
    return;
  }

  const channel = await client.channels.fetch(record.sourceMessage.channelId);
  if (!channel || typeof channel.send !== "function") {
    return;
  }

  const outcome = record.resultSuccess ? "completed" : "failed";
  await channel.send({
    content: `${record.requestedByTag} ${outcome} ${getActionLabel(record.actionType)} for Roblox user ${record.targetUserId}: ${record.resultMessage}`,
  });
}

async function finalizeAdminAction(record, report) {
  record.status = report.success ? "completed" : "failed";
  record.completedAt = Date.now();
  record.resultSuccess = report.success === true;
  record.resultMessage = typeof report.message === "string" && report.message.length > 0
    ? report.message
    : "No result message was provided.";

  if (record.dedupeKey) {
    adminActionDedupe.delete(record.dedupeKey);
  }

  resolveAdminActionWaiter(record.id, record);

  if (record.sourceMessage) {
    try {
      await disableSourceMessageButtons(record);
    } catch (err) {
      console.error("Failed disabling admin action buttons:", err);
    }

    try {
      await postAdminActionResult(record);
    } catch (err) {
      console.error("Failed posting admin action result:", err);
    }
  }
}

async function queueAndAwaitAdminAction(actionData, timeoutMs = ADMIN_ACTION_WAIT_TIMEOUT_MS) {
  const { record, duplicate } = queueAdminAction(actionData);
  const completedRecord = await waitForAdminActionCompletion(record.id, timeoutMs);

  return {
    duplicate,
    record: completedRecord || record,
  };
}

async function getInteractionMember(interaction) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(interaction.user.id);

  return { guild, member };
}

async function handleQueuedAdminAction(interaction, actionData) {
  await interaction.deferReply({ ephemeral: true });

  const { duplicate, record } = await queueAndAwaitAdminAction(actionData);
  if (record.status === "completed") {
    return interaction.editReply(record.resultMessage);
  }

  if (record.status === "failed") {
    return interaction.editReply(record.resultMessage);
  }

  if (duplicate) {
    return interaction.editReply(`That ${getActionLabel(record.actionType)} action is already queued by ${record.requestedByTag}.`);
  }

  return interaction.editReply(`Queued ${getAdminActionDescription(record)}. I will post the result once Studio processes it.`);
}


// ===============================
// BOT READY
// ===============================
client.once("ready", async () => {
  console.log("Bot is online");

  const guild = await client.guilds.fetch(GUILD_ID);

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Get a verification code for Roblox")
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Unlink a user's Roblox account")
      .addUserOption(option =>
        option.setName("user")
          .setDescription("User to unlink")
          .setRequired(true)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("getroles")
      .setDescription("Restore your team roles from Roblox")
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("groupaccept")
      .setDescription("Accept a Roblox group join request")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName("discorduser")
          .setDescription("Discord @username, mention, or user ID")
          .setRequired(true)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("wipe")
      .setDescription("Wipe a Roblox player's data")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName("reason")
          .setDescription("Optional wipe reason")
          .setRequired(false)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("unwipe")
      .setDescription("Clear a Roblox player's pending wipe flag")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("restore")
      .setDescription("Restore a Roblox player's data from a wipe snapshot")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName("snapshot")
          .setDescription("Snapshot ID or latest")
          .setRequired(false)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("grouprank")
      .setDescription("Change a Roblox member's group rank")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName("roleid")
          .setDescription("Roblox Group Role ID")
          .setRequired(true)
      )
  );
});


// ===============================
// SLASH COMMAND HANDLER
// ===============================
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const { member } = await getInteractionMember(interaction);
    if (!hasModPermissions(member)) {
      return interaction.reply({
        content: "You do not have permission to use this action.",
        ephemeral: true,
      });
    }

    const parsedAction = parseAdminActionCustomId(interaction.customId);
    if (!parsedAction) {
      return interaction.reply({
        content: "That action button is invalid.",
        ephemeral: true,
      });
    }

    return handleQueuedAdminAction(interaction, {
      ...parsedAction,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
      dedupeKey: `${parsedAction.actionType}:${parsedAction.targetUserId}:${parsedAction.snapshotId || "latest"}`,
      sourceMessage: {
        channelId: interaction.channelId,
        messageId: interaction.message.id,
      },
    });
  }

  if (!interaction.isChatInputCommand()) return;

  const { guild, member } = await getInteractionMember(interaction);

  // ===============================
  // VERIFY
  // ===============================
  if (interaction.commandName === "verify") {

    if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You are already verified. A moderator must unlink you first.",
        ephemeral: true
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(code, interaction.user.id);

    return interaction.reply({
      content: `Your verification code is: **${code}**\nEnter this in-game.`,
      ephemeral: true
    });
  }

  // ===============================
  // UNLINK
  // ===============================
  if (interaction.commandName === "unlink") {

    if (!member.roles.cache.has(MOD_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You do not have permission to use this command.",
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser("user");
    const targetMember = await guild.members.fetch(targetUser.id);

    try {
      await interaction.deferReply({ ephemeral: true });

      if (targetMember.roles.cache.has(VERIFIED_ROLE_ID)) {
        await targetMember.roles.remove(VERIFIED_ROLE_ID);
      }

      for (const roleId of Object.values(roleMap)) {
        if (targetMember.roles.cache.has(roleId)) {
          await targetMember.roles.remove(roleId);
        }
      }

      unlinkedUsers.add(targetUser.id);

      return sendInteractionResponse(interaction, `✅ Successfully unlinked ${targetUser.tag}`);

    } catch (err) {
      console.error("Unlink error:", err);
      return sendInteractionResponse(interaction, "❌ Failed to unlink user.");
    }
  }

  // ===============================
  // GROUP ACCEPT
  // ===============================
  if (interaction.commandName === "groupaccept") {

    if (!member.roles.cache.has(MOD_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxId = interaction.options.getString("robloxid");
    const discordUserInput = interaction.options.getString("discorduser");
    const targetMember = await resolveDiscordMember(guild, discordUserInput);

    if (!targetMember) {
      return interaction.reply({
        content: "Could not find that Discord user.",
        ephemeral: true
      });
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      const csrfResponse = await fetch("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: {
          "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`
        }
      });

      const csrfToken = csrfResponse.headers.get("x-csrf-token");

      const acceptResponse = await fetch(
        `https://groups.roblox.com/v1/groups/${GROUP_ID}/join-requests/users/${robloxId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
            "x-csrf-token": csrfToken
          }
        }
      );

      if (!acceptResponse.ok) {
        const errorText = await acceptResponse.text();
        return sendInteractionResponse(interaction, `❌ Accept failed:\n${errorText}`);
      }

      try {
        await updateGroupAcceptRoles(targetMember);
      } catch (roleError) {
        console.error("Group accept role update error:", roleError);
        return sendInteractionResponse(interaction, `User accepted, but Discord roles could not be updated for ${targetMember.user.tag}.`);
      }

      return sendInteractionResponse(interaction, `User accepted. Envisioned was applied and Wald was removed for ${targetMember.user.tag}.`);

    } catch (err) {
      console.error("Accept error:", err);
      return sendInteractionResponse(interaction, "❌ Unexpected error occurred.");
    }
  }

  // ===============================
  // WIPE
  // ===============================
  if (interaction.commandName === "wipe") {

    if (!hasModPermissions(member)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxInput = interaction.options.getString("robloxid");
    const reason = interaction.options.getString("reason") || "";

    return handleQueuedAdminAction(interaction, {
      actionType: "wipe",
      targetUserId: robloxInput,
      reason,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
      dedupeKey: `wipe:${String(robloxInput).toLowerCase()}:${reason.toLowerCase()}`,
    });
  }

  // ===============================
  // UNWIPE
  // ===============================
  if (interaction.commandName === "unwipe") {

    if (!hasModPermissions(member)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxInput = interaction.options.getString("robloxid");

    return handleQueuedAdminAction(interaction, {
      actionType: "unwipe",
      targetUserId: robloxInput,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
      dedupeKey: `unwipe:${String(robloxInput).toLowerCase()}`,
    });
  }

  // ===============================
  // RESTORE
  // ===============================
  if (interaction.commandName === "restore") {

    if (!hasModPermissions(member)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxInput = interaction.options.getString("robloxid");
    const snapshotId = interaction.options.getString("snapshot") || "latest";

    return handleQueuedAdminAction(interaction, {
      actionType: "restore",
      targetUserId: robloxInput,
      snapshotId,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
      dedupeKey: `restore:${String(robloxInput).toLowerCase()}:${snapshotId.toLowerCase()}`,
    });
  }

  // ===============================
  // GROUP RANK
  // ===============================
  if (interaction.commandName === "grouprank") {

    if (!member.roles.cache.has(MOD_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxId = interaction.options.getString("robloxid");
    const roleId = interaction.options.getInteger("roleid");

    try {
      await interaction.deferReply({ ephemeral: true });

      const csrfResponse = await fetch("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: {
          "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`
        }
      });

      const csrfToken = csrfResponse.headers.get("x-csrf-token");

      const roleResponse = await fetch(
        `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${robloxId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
            "x-csrf-token": csrfToken
          },
          body: JSON.stringify({ roleId })
        }
      );

      if (!roleResponse.ok) {
        const errorText = await roleResponse.text();
        return sendInteractionResponse(interaction, `❌ Rank change failed:\n${errorText}`);
      }

      return sendInteractionResponse(interaction, "✅ User rank updated successfully.");

    } catch (err) {
      console.error("Rank error:", err);
      return sendInteractionResponse(interaction, "❌ Unexpected error occurred.");
    }
  }

});


// ===============================
// VERIFY ENDPOINT
// ===============================
app.post("/verify", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { code } = req.body;
  const discordId = verificationCodes.get(code);

  if (!discordId) {
    return res.status(400).send("Invalid code");
  }

  verificationCodes.delete(code);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
      await member.roles.add(VERIFIED_ROLE_ID);
    }

    try {
      await member.send("✅ You have successfully verified your Roblox account!");
    } catch {}

  } catch (err) {
    console.error("Verification error:", err);
  }

  res.json({ discordId });
});

app.post("/checkUnlink", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { discordId } = req.body;
  if (!discordId) {
    return res.status(400).send("Missing discordId");
  }

  if (unlinkedUsers.has(discordId)) {
    unlinkedUsers.delete(discordId);
    return res.json({ unlinked: true });
  }

  res.json({ unlinked: false });
});

app.post("/updateRole", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { discordId, team } = req.body;
  if (!discordId || !team) {
    return res.status(400).send("Missing data");
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    const newRoleId = roleMap[team];
    if (!newRoleId) {
      return res.status(400).send("Invalid team");
    }

    // Remove existing team roles
    for (const roleId of Object.values(roleMap)) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }

    // Add correct role
    await member.roles.add(newRoleId);

    res.send("Role updated");

  } catch (err) {
    console.error("Role update error:", err);
    res.status(500).send("Error assigning role");
  }
});

app.post("/relayWebhook/:service", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  if (!client.isReady()) {
    return res.status(503).send("Bot not ready");
  }

  const service = String(req.params.service || "").toLowerCase();
  const channelId = getRelayChannelId(service);
  if (!channelId) {
    return res.status(404).send("Unknown relay service");
  }

  const messagePayload = buildRelayMessagePayload(req.body || {});
  const components = buildRelayComponents(service, req.body || {});
  if (components.length > 0) {
    messagePayload.components = components;
  }

  if (!messagePayload.content && (!Array.isArray(messagePayload.embeds) || messagePayload.embeds.length === 0)) {
    return res.status(400).send("Missing relay message payload");
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") {
      return res.status(500).send("Relay channel unavailable");
    }

    await channel.send(messagePayload);
    res.send("Relay posted");

  } catch (err) {
    console.error("Relay webhook error:", err);
    res.status(500).send("Error posting relay webhook");
  }
});

app.post("/adminActions/claim", (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  cleanupAdminActionRecords();

  const now = Date.now();
  const nextRecord = adminActionOrder
    .map((actionId) => adminActions.get(actionId))
    .find((record) =>
      record
      && (
        record.status === "pending"
        || (record.status === "claimed" && record.claimedAt && (now - record.claimedAt) >= ADMIN_ACTION_CLAIM_TIMEOUT_MS)
      )
    );

  if (!nextRecord) {
    return res.json({ action: null });
  }

  nextRecord.status = "claimed";
  nextRecord.claimedAt = now;

  return res.json({
    action: {
      id: nextRecord.id,
      actionType: nextRecord.actionType,
      targetUserId: nextRecord.targetUserId,
      snapshotId: nextRecord.snapshotId || null,
      reason: nextRecord.reason || "",
      requestedById: nextRecord.requestedById,
      requestedByTag: nextRecord.requestedByTag,
    },
  });
});

app.post("/adminActions/report", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const actionId = typeof req.body?.id === "string" ? req.body.id : null;
  if (!actionId) {
    return res.status(400).send("Missing action id");
  }

  const record = adminActions.get(actionId);
  if (!record) {
    return res.status(404).send("Action not found");
  }

  await finalizeAdminAction(record, {
    success: req.body?.success === true,
    message: typeof req.body?.message === "string" ? req.body.message : "",
  });

  res.send("Action report received");
});

// ===============================
client.login(BOT_TOKEN);

app.get("/", (req, res) => {
  res.send("Bot running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});



