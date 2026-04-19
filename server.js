const express = require("express");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
} = require("discord.js");
const { createSpreadsheetPermissionService } = require("./spreadsheetPermissions");
const {
  canRoleUseStaffCommand,
  getMinimumRoleForCommand,
  normalizeCommandKey,
} = require("./staffCommandMatrix");
const {
  ADMIN_ACTION_CLAIM_TIMEOUT_MS,
  ADMIN_ACTION_RETENTION_MS,
  ADMIN_ACTION_WAIT_TIMEOUT_MS,
  ANTICHEAT_CHANNEL_ID,
  API_KEY,
  BOT_TOKEN,
  BOT_TRANSCRIPTS_CHANNEL_ID,
  DEATH_CHANNEL_ID,
  ENVISIONED_ROLE_ID,
  EVENT_LOGS_CHANNEL_ID,
  EVENT_SESSION_RETENTION_LIMIT,
  EVENT_STATUS_CHANNEL_ID,
  EXAM_SERVICE_CHANNEL_ID,
  GROUP_ID,
  GUILD_ID,
  INTERACTION_FOLLOW_UP_WINDOW_MS,
  MOD_ROLE_ID,
  TALENTS_CHANNEL_ID,
  TALENT_LOOKUP_CLAIM_TIMEOUT_MS,
  TALENT_LOOKUP_RETENTION_MS,
  TALENT_LOOKUP_WAIT_TIMEOUT_MS,
  VERIFIED_ROLE_ID,
  WALD_ROLE_ID,
  WIPE_CHANNEL_ID,
  roleMap,
} = require("./src/config");
const {
  adminActionDedupe,
  adminActionOrder,
  adminActionWaiters,
  adminActions,
  eventSessionOrder,
  eventSessions,
  talentLookupOrder,
  talentLookupRequests,
  talentLookupWaiters,
  unlinkedUsers,
  verificationCodes,
} = require("./src/state");
const { handleEditPanelCommand, handleEditablePostModalSubmit, handlePostPanelCommand } = require("./src/panels");
const { registerSlashCommands } = require("./src/registerSlashCommands");
const {
  buildDiscordMessageUrl,
  formatOptionalString,
  parsePositiveInteger,
  parseTimestamp,
} = require("./src/utils");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

const ADMIN_SHEET_URL = process.env.ADMIN_SHEET_URL
  || process.env.GOOGLE_SHEETS_ADMIN_URL
  || process.env.SPREADSHEET_ADMIN_URL
  || "";
const ADMIN_SHEET_CACHE_TTL_MS = Number.parseInt(process.env.ADMIN_SHEET_CACHE_TTL_MS || "", 10);
const ADMIN_SHEET_STRICT = String(process.env.ADMIN_SHEET_STRICT || "").toLowerCase() === "true";
const spreadsheetPermissionService = createSpreadsheetPermissionService({
  url: ADMIN_SHEET_URL,
  cacheTtlMs: ADMIN_SHEET_CACHE_TTL_MS,
  strictMode: ADMIN_SHEET_STRICT,
});
const EAGER_DEFERRED_COMMANDS = new Set([
  "unlink",
  "groupaccept",
  "wipe",
  "unwipe",
  "restore",
  "talents",
  "postevent",
  "refreshevent",
  "grouprank",
]);
// 🔹 ROLE IDS
// 🔹 DISCORD ROLE SWAP
// 🔹 Team → Role mapping
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

async function ensureEphemeralDefer(interaction) {
  if (interaction.deferred || interaction.replied) {
    return;
  }

  await interaction.deferReply({ ephemeral: true });
}

function createVerificationRequest(interaction) {
  return {
    discordId: interaction.user.id,
    applicationId: interaction.applicationId,
    interactionToken: interaction.token,
    createdAt: Date.now(),
  };
}

async function sendVerificationCompletionFollowUp(verificationRequest) {
  if (
    !verificationRequest
    || typeof verificationRequest.applicationId !== "string"
    || typeof verificationRequest.interactionToken !== "string"
  ) {
    return false;
  }

  if ((Date.now() - verificationRequest.createdAt) >= INTERACTION_FOLLOW_UP_WINDOW_MS) {
    return false;
  }

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${verificationRequest.applicationId}/${verificationRequest.interactionToken}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: "✅ You have successfully verified your Roblox account!",
        flags: 64,
      }),
    }
  );

  return response.ok;
}

function getRelayChannelId(service) {
  const relayChannels = {
    anticheat: ANTICHEAT_CHANNEL_ID,
    wipe: WIPE_CHANNEL_ID,
    death: DEATH_CHANNEL_ID,
    examservice: EXAM_SERVICE_CHANNEL_ID,
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

function normalizeEventResources(resources, existingResources = {}) {
  const normalizeValue = (value, fallback = 0) => {
    const parsedValue = Number.parseInt(String(value ?? fallback), 10);
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 0;
  };

  return {
    gasUsed: normalizeValue(resources?.gasUsed, existingResources.gasUsed),
    bladesUsed: normalizeValue(resources?.bladesUsed, existingResources.bladesUsed),
    bandagesUsed: normalizeValue(resources?.bandagesUsed, existingResources.bandagesUsed),
  };
}

function normalizeEventParticipant(participant) {
  const userId = parsePositiveInteger(participant?.userId);
  if (!userId) {
    return null;
  }

  const playerName = formatOptionalString(participant?.playerName, String(userId));
  const displayName = formatOptionalString(participant?.displayName, playerName);
  const loreName = formatOptionalString(participant?.loreName, playerName);
  const teamName = formatOptionalString(participant?.teamName, "Unknown");
  const updatedAt = parseTimestamp(participant?.updatedAt) ?? parseTimestamp(participant?.deathRecordedAt) ?? Date.now();

  return {
    userId,
    playerName,
    displayName,
    loreName,
    teamName,
    status: formatOptionalString(participant?.status).toLowerCase() === "injury" ? "injury" : "death",
    deathRecordedAt: parseTimestamp(participant?.deathRecordedAt) ?? updatedAt,
    updatedAt,
    restoredAt: parseTimestamp(participant?.restoredAt),
    restoreAction: formatOptionalString(participant?.restoreAction),
    moderatorName: formatOptionalString(participant?.moderatorName),
    moderatorUserId: parsePositiveInteger(participant?.moderatorUserId),
    snapshotId: formatOptionalString(participant?.snapshotId),
  };
}

function sortEventParticipants(participants) {
  participants.sort((left, right) => {
    if (left.deathRecordedAt !== right.deathRecordedAt) {
      return left.deathRecordedAt - right.deathRecordedAt;
    }

    return left.loreName.localeCompare(right.loreName);
  });

  return participants;
}

function normalizeEventParticipants(participants) {
  const sourceParticipants = Array.isArray(participants) ? participants : [];
  const normalizedParticipants = sourceParticipants
    .map(normalizeEventParticipant)
    .filter(Boolean);

  return sortEventParticipants(normalizedParticipants);
}

function mergeEventParticipants(incomingParticipants, existingParticipants = []) {
  const participantMap = new Map();

  for (const participant of existingParticipants) {
    participantMap.set(participant.userId, participant);
  }

  for (const participant of incomingParticipants) {
    const existingParticipant = participantMap.get(participant.userId);
    if (!existingParticipant) {
      participantMap.set(participant.userId, participant);
      continue;
    }

    if (participant.updatedAt > existingParticipant.updatedAt) {
      participantMap.set(participant.userId, participant);
      continue;
    }

    if (
      participant.updatedAt === existingParticipant.updatedAt
      && participant.status === "injury"
      && existingParticipant.status !== "injury"
    ) {
      participantMap.set(participant.userId, participant);
    }
  }

  return sortEventParticipants(Array.from(participantMap.values()));
}

function trackEventSessionOrder(eventId) {
  const existingIndex = eventSessionOrder.indexOf(eventId);
  if (existingIndex >= 0) {
    eventSessionOrder.splice(existingIndex, 1);
  }

  eventSessionOrder.push(eventId);
  while (eventSessionOrder.length > EVENT_SESSION_RETENTION_LIMIT) {
    const oldestEventId = eventSessionOrder.shift();
    if (oldestEventId) {
      eventSessions.delete(oldestEventId);
    }
  }
}

function upsertEventSession(payload) {
  const eventId = formatOptionalString(payload?.eventId);
  if (!eventId) {
    return null;
  }

  const existingSession = eventSessions.get(eventId);
  const incomingSourceUpdatedAt = parseTimestamp(payload?.updatedAt);
  if (
    existingSession
    && incomingSourceUpdatedAt
    && existingSession.sourceUpdatedAt
    && incomingSourceUpdatedAt < existingSession.sourceUpdatedAt
  ) {
    return existingSession;
  }

  const hasActiveFlag = typeof payload?.active === "boolean";
  const incomingParticipants = normalizeEventParticipants(
    payload?.participants ?? payload?.entries ?? payload?.deaths
  );
  const active = hasActiveFlag
    ? payload.active === true
    : existingSession?.active ?? false;
  const sourceUpdatedAt = incomingSourceUpdatedAt ?? existingSession?.sourceUpdatedAt ?? Date.now();
  const localUpdatedAt = existingSession?.localUpdatedAt ?? 0;
  const explicitEndedAt = parseTimestamp(payload?.endedAt);

  const session = {
    eventId,
    mapName: formatOptionalString(payload?.mapName, existingSession?.mapName || "Unknown Map"),
    active,
    startedAt: parseTimestamp(payload?.startedAt) ?? existingSession?.startedAt ?? Date.now(),
    endedAt: active
      ? null
      : explicitEndedAt ?? existingSession?.endedAt ?? (hasActiveFlag ? Date.now() : null),
    sourceUpdatedAt,
    localUpdatedAt,
    updatedAt: Math.max(sourceUpdatedAt, localUpdatedAt),
    resources: normalizeEventResources(payload?.resources, existingSession?.resources),
    participants: mergeEventParticipants(incomingParticipants, existingSession?.participants),
    eventAnnouncement: existingSession?.eventAnnouncement || null,
    postedSummary: existingSession?.postedSummary || null,
  };

  eventSessions.set(eventId, session);
  trackEventSessionOrder(eventId);
  return session;
}

function findLatestEventParticipantSession(targetUserId) {
  const parsedUserId = parsePositiveInteger(targetUserId);
  if (!parsedUserId) {
    return null;
  }

  for (let index = eventSessionOrder.length - 1; index >= 0; index -= 1) {
    const eventId = eventSessionOrder[index];
    const session = eventSessions.get(eventId);
    if (!session) {
      continue;
    }

    const participant = Array.isArray(session.participants)
      ? session.participants.find((entry) => entry.userId === parsedUserId)
      : null;
    if (participant) {
      return { session, participant };
    }
  }

  return null;
}

async function syncResolvedEventParticipant(record) {
  if (record.actionType !== "unwipe" && record.actionType !== "restore") {
    return null;
  }

  const resolvedUserId = parsePositiveInteger(record.resolvedTargetUserId) ?? parsePositiveInteger(record.targetUserId);
  if (!resolvedUserId) {
    return null;
  }

  const matchedEvent = findLatestEventParticipantSession(resolvedUserId);
  if (!matchedEvent) {
    return null;
  }

  const { session, participant } = matchedEvent;
  const resolvedAt = Date.now();
  participant.status = "injury";
  participant.updatedAt = resolvedAt;
  participant.restoredAt = resolvedAt;
  participant.restoreAction = record.actionType;

  const moderatorName = formatOptionalString(record.requestedByTag);
  if (moderatorName) {
    participant.moderatorName = moderatorName;
  }

  const snapshotId = formatOptionalString(record.snapshotId);
  if (snapshotId) {
    participant.snapshotId = snapshotId;
  }

  session.localUpdatedAt = resolvedAt;
  session.updatedAt = Math.max(session.sourceUpdatedAt || 0, resolvedAt);
  trackEventSessionOrder(session.eventId);

  if (!client.isReady()) {
    return session;
  }

  if (session.postedSummary?.messageId) {
    try {
      await refreshEventSummary(session);
    } catch (err) {
      console.error("Failed refreshing resolved event summary:", err);
    }
  }

  if (session.eventAnnouncement?.messageId) {
    try {
      await syncEventAnnouncement(session);
    } catch (err) {
      console.error("Failed syncing resolved event announcement:", err);
    }
  }

  return session;
}

function formatEventParticipantLine(participant, strikeThrough = false) {
  const baseLine = `${participant.loreName} | ${participant.teamName}`;
  return strikeThrough ? `*~~${baseLine}~~*` : `*${baseLine}*`;
}

function buildEventDeathsSection(participants) {
  if (participants.length === 0) {
    return ["*None!*"];
  }

  return participants.map((participant) =>
    formatEventParticipantLine(participant, participant.status === "injury")
  );
}

function buildEventInjuriesSection(participants) {
  const filteredParticipants = participants.filter((participant) => participant.status === "injury");
  if (filteredParticipants.length === 0) {
    return ["*None!*"];
  }

  return filteredParticipants.map((participant) => formatEventParticipantLine(participant));
}

function buildEventSummaryMessage(session) {
  const introLine = session.active
    ? `*An event is active in: **${session.mapName}***`
    : `*An event has ended in: **${session.mapName}***`;

  return [
    introLine,
    "",
    "**DEATHS:**",
    ...buildEventDeathsSection(session.participants),
    "",
    "**INJURIES:**",
    ...buildEventInjuriesSection(session.participants),
    "",
    `*Gas Used: ${session.resources.gasUsed}*`,
    `*Blades Used: ${session.resources.bladesUsed}*`,
    `*Bandages Used: ${session.resources.bandagesUsed}*`,
  ].join("\n");
}

function formatDiscordTimestamp(timestamp) {
  const parsedTimestamp = parseTimestamp(timestamp);
  if (!parsedTimestamp) {
    return "Unknown";
  }

  return `<t:${parsedTimestamp}:F>`;
}

function buildEventStatusMessage(session) {
  return [
    "**Event Tracker**",
    `Event ID: \`${session.eventId}\``,
    `Map: **${session.mapName}**`,
    `Status: **${session.active ? "Active" : "Ended"}**`,
    `Started: ${formatDiscordTimestamp(session.startedAt)}`,
    `Ended: ${session.active ? "Pending" : formatDiscordTimestamp(session.endedAt)}`,
    `Last Update: ${formatDiscordTimestamp(session.updatedAt)}`,
    `Summary Command: \`/postevent eventid:${session.eventId}\``,
  ].join("\n");
}

async function postEventAnnouncement(session) {
  const channel = await client.channels.fetch(EVENT_STATUS_CHANNEL_ID);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Event status channel unavailable");
  }

  const message = await channel.send({
    content: buildEventStatusMessage(session),
  });

  session.eventAnnouncement = {
    channelId: channel.id,
    messageId: message.id,
    updatedAt: Date.now(),
  };

  return message;
}

async function syncEventAnnouncement(session) {
  const currentAnnouncement = session.eventAnnouncement;
  if (!currentAnnouncement?.channelId || !currentAnnouncement?.messageId) {
    return postEventAnnouncement(session);
  }

  const channel = await client.channels.fetch(currentAnnouncement.channelId);
  if (!channel?.messages?.fetch) {
    return postEventAnnouncement(session);
  }

  try {
    const message = await channel.messages.fetch(currentAnnouncement.messageId);
    await message.edit({
      content: buildEventStatusMessage(session),
    });

    session.eventAnnouncement.updatedAt = Date.now();
    return message;
  } catch {
    return postEventAnnouncement(session);
  }
}

async function postEventSummary(session) {
  const channel = await client.channels.fetch(EVENT_LOGS_CHANNEL_ID);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Event logs channel unavailable");
  }

  const message = await channel.send({
    content: buildEventSummaryMessage(session),
  });

  session.postedSummary = {
    channelId: channel.id,
    messageId: message.id,
    postedAt: Date.now(),
  };

  return message;
}

async function refreshEventSummary(session) {
  const postedSummary = session.postedSummary;
  if (!postedSummary?.channelId || !postedSummary?.messageId) {
    return postEventSummary(session);
  }

  const channel = await client.channels.fetch(postedSummary.channelId);
  if (!channel?.messages?.fetch) {
    return postEventSummary(session);
  }

  try {
    const message = await channel.messages.fetch(postedSummary.messageId);
    await message.edit({
      content: buildEventSummaryMessage(session),
    });
    return message;
  } catch {
    return postEventSummary(session);
  }
}

function hasModPermissions(member) {
  return member.roles.cache.has(MOD_ROLE_ID);
}

async function hasAdminPermissions(member, commandName = "admin") {
  const access = await spreadsheetPermissionService.getMemberAccess(member);
  const commandKey = normalizeCommandKey(commandName) || "admin";
  const minimumRole = getMinimumRoleForCommand(commandKey);

  if (!minimumRole) {
    return false;
  }

  const fallbackRole = hasModPermissions(member) ? "Mod" : null;

  if (access.record) {
    const grantedRole = access.record.botRole || access.record.role;
    const hasCommandGrant = access.record.allCommands
      || access.record.commandKeys.includes(commandKey);
    const hasRoleGrant = canRoleUseStaffCommand(grantedRole, commandKey);

    if (hasCommandGrant || hasRoleGrant) {
      return true;
    }

    if (access.strictMode) {
      return false;
    }
  } else if (access.strictMode && access.configured) {
    return false;
  }

  return canRoleUseStaffCommand(fallbackRole, commandKey);
}

async function ensureAdminPermission(interaction, member, commandName, deniedMessage = "❌ You do not have permission.") {
  if (await hasAdminPermissions(member, commandName)) {
    return true;
  }

  if (interaction.deferred || interaction.replied) {
    await sendInteractionResponse(interaction, deniedMessage);
  } else {
    await interaction.reply({
      content: deniedMessage,
      ephemeral: true,
    });
  }

  return false;
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

function createTalentLookupId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupTalentLookupRecords() {
  const cutoff = Date.now() - TALENT_LOOKUP_RETENTION_MS;

  while (talentLookupOrder.length > 0) {
    const oldestId = talentLookupOrder[0];
    const record = talentLookupRequests.get(oldestId);
    if (!record) {
      talentLookupOrder.shift();
      continue;
    }

    if ((record.status === "pending" || record.status === "claimed") || record.completedAt >= cutoff) {
      break;
    }

    talentLookupRequests.delete(oldestId);
    talentLookupOrder.shift();
  }
}

function queueTalentLookup(lookupData) {
  cleanupTalentLookupRecords();

  const record = {
    ...lookupData,
    id: createTalentLookupId(),
    status: "pending",
    createdAt: Date.now(),
    claimedAt: null,
    completedAt: null,
    resultSuccess: null,
    resultMessage: null,
    resolvedTargetUserId: null,
    playerName: null,
    online: null,
    talents: [],
    postedResult: null,
  };

  talentLookupRequests.set(record.id, record);
  talentLookupOrder.push(record.id);
  return record;
}

function waitForTalentLookupCompletion(lookupId, timeoutMs = TALENT_LOOKUP_WAIT_TIMEOUT_MS) {
  const existingRecord = talentLookupRequests.get(lookupId);
  if (!existingRecord) {
    return Promise.resolve(null);
  }

  if (existingRecord.status === "completed" || existingRecord.status === "failed") {
    return Promise.resolve(existingRecord);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      talentLookupWaiters.delete(lookupId);
      resolve(talentLookupRequests.get(lookupId) || null);
    }, timeoutMs);

    talentLookupWaiters.set(lookupId, {
      resolve,
      timeout,
    });
  });
}

function resolveTalentLookupWaiter(lookupId, record) {
  const waiter = talentLookupWaiters.get(lookupId);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timeout);
  talentLookupWaiters.delete(lookupId);
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

function getAdminActionSourceLabel(action) {
  return action.sourceMessage ? "button press" : "slash command";
}

function buildSourceMessageUrl(sourceMessage) {
  if (!sourceMessage?.channelId || !sourceMessage?.messageId) {
    return null;
  }

  return `https://discord.com/channels/${GUILD_ID}/${sourceMessage.channelId}/${sourceMessage.messageId}`;
}

function formatTranscriptTimestamp(timestampMs) {
  const unixSeconds = Math.floor(Number(timestampMs || Date.now()) / 1000);
  return `<t:${unixSeconds}:F>`;
}

function formatTranscriptValue(value, fallback = "N/A") {
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (trimmedValue.length > 0) {
      return trimmedValue.length > 900
        ? `${trimmedValue.slice(0, 897)}...`
        : trimmedValue;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function formatTalentLookupList(talents) {
  if (!Array.isArray(talents) || talents.length === 0) {
    return "*No saved talents found.*";
  }

  let formattedList = "";
  for (const talent of talents) {
    const formattedTalent = `\`${String(talent)}\``;
    const candidate = formattedList.length > 0
      ? `${formattedList}, ${formattedTalent}`
      : formattedTalent;

    if (candidate.length > 1700) {
      return formattedList.length > 0 ? `${formattedList}, ...` : `${formattedTalent.slice(0, 1697)}...`;
    }

    formattedList = candidate;
  }

  return formattedList;
}

function buildTalentLookupContent(record) {
  const resolvedUserId = parsePositiveInteger(record.resolvedTargetUserId) ?? parsePositiveInteger(record.targetUserId);
  const targetLabel = record.playerName
    ? `${record.playerName}${resolvedUserId ? ` (${resolvedUserId})` : ""}`
    : formatTranscriptValue(record.targetUserId);

  const lines = [
    `**Talent Lookup ${record.resultSuccess ? "Completed" : "Failed"}**`,
    `Requested By: ${record.requestedByTag} (<@${record.requestedById}>)`,
    `Requested At: ${formatTranscriptTimestamp(record.createdAt)}`,
    `Target: ${targetLabel}`,
  ];

  if (record.resultSuccess) {
    lines.push(`Status: ${record.online ? "Online" : "Offline"}`);
    lines.push(`Talents: ${formatTalentLookupList(record.talents)}`);
  } else {
    lines.push(`Result: ${formatTranscriptValue(record.resultMessage, "Talent lookup failed.")}`);
  }

  return lines.join("\n");
}

async function postTalentLookupResult(record) {
  const channel = await client.channels.fetch(TALENTS_CHANNEL_ID);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Talents channel unavailable");
  }

  const message = await channel.send({
    content: buildTalentLookupContent(record),
  });

  record.postedResult = {
    channelId: message.channelId,
    messageId: message.id,
  };

  return message;
}

async function postAdminActionTranscript(lines) {
  const channel = await client.channels.fetch(BOT_TRANSCRIPTS_CHANNEL_ID);
  if (!channel || typeof channel.send !== "function") {
    return;
  }

  await channel.send({
    content: lines.join("\n"),
  });
}

async function logAdminActionRequest(actionData, duplicateRecord = null) {
  const lines = [
    `**Admin Action ${duplicateRecord ? "Duplicate Request" : "Queued"}**`,
    `Date/Time: ${formatTranscriptTimestamp(Date.now())}`,
    `Moderator: ${actionData.requestedByTag} (<@${actionData.requestedById}>)`,
    `Source: ${getAdminActionSourceLabel(actionData)}`,
    `Command: ${getActionLabel(actionData.actionType)}`,
    `Target: ${formatTranscriptValue(actionData.targetUserId)}`,
  ];

  if (actionData.snapshotId) {
    lines.push(`Snapshot: ${formatTranscriptValue(actionData.snapshotId)}`);
  }

  if (actionData.reason) {
    lines.push(`Reason: ${formatTranscriptValue(actionData.reason)}`);
  }

  const sourceMessageUrl = buildSourceMessageUrl(actionData.sourceMessage);
  if (sourceMessageUrl) {
    lines.push(`Source Message: ${sourceMessageUrl}`);
  }

  if (duplicateRecord) {
    lines.push(`Already Queued By: ${duplicateRecord.requestedByTag} (<@${duplicateRecord.requestedById}>)`);
    lines.push(`Original Queue Time: ${formatTranscriptTimestamp(duplicateRecord.createdAt)}`);
  }

  await postAdminActionTranscript(lines);
}

async function logAdminActionCompletion(record) {
  const lines = [
    `**Admin Action ${record.resultSuccess ? "Completed" : "Failed"}**`,
    `Date/Time: ${formatTranscriptTimestamp(record.completedAt || Date.now())}`,
    `Moderator: ${record.requestedByTag} (<@${record.requestedById}>)`,
    `Source: ${getAdminActionSourceLabel(record)}`,
    `Command: ${getActionLabel(record.actionType)}`,
    `Target: ${formatTranscriptValue(record.targetUserId)}`,
    `Requested At: ${formatTranscriptTimestamp(record.createdAt)}`,
    `Result: ${formatTranscriptValue(record.resultMessage, "No result message was provided.")}`,
  ];

  if (
    record.resolvedTargetUserId
    && String(record.resolvedTargetUserId) !== String(record.targetUserId)
  ) {
    lines.push(`Resolved Roblox ID: ${formatTranscriptValue(record.resolvedTargetUserId)}`);
  }

  if (record.snapshotId) {
    lines.push(`Snapshot: ${formatTranscriptValue(record.snapshotId)}`);
  }

  if (record.reason) {
    lines.push(`Reason: ${formatTranscriptValue(record.reason)}`);
  }

  const sourceMessageUrl = buildSourceMessageUrl(record.sourceMessage);
  if (sourceMessageUrl) {
    lines.push(`Source Message: ${sourceMessageUrl}`);
  }

  await postAdminActionTranscript(lines);
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
  record.resolvedTargetUserId = parsePositiveInteger(report.resolvedUserId)
    ?? record.resolvedTargetUserId
    ?? parsePositiveInteger(record.targetUserId);

  if (record.dedupeKey) {
    adminActionDedupe.delete(record.dedupeKey);
  }

  if (record.resultSuccess) {
    try {
      await syncResolvedEventParticipant(record);
    } catch (err) {
      console.error("Failed syncing resolved event participant:", err);
    }
  }

  resolveAdminActionWaiter(record.id, record);

  try {
    await logAdminActionCompletion(record);
  } catch (err) {
    console.error("Failed posting admin action transcript:", err);
  }

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

async function finalizeTalentLookup(record, report) {
  record.status = report.success ? "completed" : "failed";
  record.completedAt = Date.now();
  record.resultSuccess = report.success === true;
  record.resultMessage = typeof report.message === "string" && report.message.length > 0
    ? report.message
    : "No result message was provided.";
  record.resolvedTargetUserId = parsePositiveInteger(report.resolvedUserId)
    ?? record.resolvedTargetUserId
    ?? parsePositiveInteger(record.targetUserId);
  record.playerName = formatOptionalString(report.playerName, record.playerName || "");
  record.online = report.online === true;
  record.talents = Array.isArray(report.talents)
    ? report.talents.map((talent) => formatOptionalString(String(talent))).filter(Boolean)
    : [];

  if (client.isReady()) {
    try {
      await postTalentLookupResult(record);
    } catch (err) {
      console.error("Failed posting talent lookup result:", err);
    }
  }

  resolveTalentLookupWaiter(record.id, record);
}

async function getInteractionMember(interaction) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(interaction.user.id);

  return { guild, member };
}

async function handleQueuedAdminAction(interaction, actionData) {
  await ensureEphemeralDefer(interaction);

  const { duplicate, record } = queueAdminAction(actionData);

  try {
    await logAdminActionRequest(actionData, duplicate ? record : null);
  } catch (err) {
    console.error("Failed posting admin action transcript:", err);
  }

  const completedRecord = await waitForAdminActionCompletion(record.id, ADMIN_ACTION_WAIT_TIMEOUT_MS);
  const resolvedRecord = completedRecord || record;
  if (resolvedRecord.status === "completed") {
    return interaction.editReply(resolvedRecord.resultMessage);
  }

  if (resolvedRecord.status === "failed") {
    return interaction.editReply(resolvedRecord.resultMessage);
  }

  if (duplicate) {
    return interaction.editReply(`That ${getActionLabel(record.actionType)} action is already queued by ${record.requestedByTag}.`);
  }

  return interaction.editReply(`Queued ${getAdminActionDescription(record)}. I will post the result once Studio processes it.`);
}

async function handleQueuedTalentLookup(interaction, lookupData) {
  await ensureEphemeralDefer(interaction);

  const record = queueTalentLookup(lookupData);
  const completedRecord = await waitForTalentLookupCompletion(record.id, TALENT_LOOKUP_WAIT_TIMEOUT_MS);
  const resolvedRecord = completedRecord || record;
  if (resolvedRecord.status === "completed") {
    const messageUrl = buildDiscordMessageUrl(
      resolvedRecord.postedResult?.channelId,
      resolvedRecord.postedResult?.messageId
    );

    return interaction.editReply(messageUrl
      ? `Posted talents for ${resolvedRecord.playerName || resolvedRecord.targetUserId}: ${messageUrl}`
      : `Resolved talents for ${resolvedRecord.playerName || resolvedRecord.targetUserId}, but I could not post them in <#${TALENTS_CHANNEL_ID}>.`);
  }

  if (resolvedRecord.status === "failed") {
    return interaction.editReply(resolvedRecord.resultMessage);
  }

  return interaction.editReply(`Queued a talent lookup for ${lookupData.targetUserId}. I will post the result in <#${TALENTS_CHANNEL_ID}> once Studio responds.`);
}

async function handleEventSummaryCommand(interaction, mode, member) {
  await ensureEphemeralDefer(interaction);

  if (!await ensureAdminPermission(interaction, member, mode === "refresh" ? "refreshevent" : "postevent")) {
    return;
  }

  const eventId = formatOptionalString(interaction.options.getString("eventid"));
  const session = eventSessions.get(eventId);
  if (!session) {
    return interaction.reply({
      content: "❌ That event ID was not found in the bot cache yet.",
      ephemeral: true,
    });
  }

  try {
    const message = mode === "refresh"
      ? await refreshEventSummary(session)
      : await postEventSummary(session);
    const messageUrl = buildDiscordMessageUrl(message.channelId, message.id);
    const actionLabel = mode === "refresh" ? "Refreshed" : "Posted";
    return interaction.editReply(messageUrl
      ? `${actionLabel} event ${eventId}: ${messageUrl}`
      : `${actionLabel} event ${eventId}.`);
  } catch (err) {
    console.error("Event summary command error:", err);
    return interaction.editReply("❌ Failed to post that event summary.");
  }
}


// ===============================
// BOT READY
// ===============================
client.once("clientReady", async () => {
  console.log("Bot is online");

  const guild = await client.guilds.fetch(GUILD_ID);
  await registerSlashCommands(guild);

  try {
    await spreadsheetPermissionService.refreshNow();
    const permissionSheetError = spreadsheetPermissionService.getLastError?.();
    if (permissionSheetError) {
      console.warn("Spreadsheet permission warmup warning:", permissionSheetError);
    }
  } catch (err) {
    console.error("Spreadsheet permission warmup error:", err);
  }

  const refreshIntervalMs = Math.max(ADMIN_SHEET_CACHE_TTL_MS || 180000, 30000);
  setInterval(async () => {
    try {
      await spreadsheetPermissionService.refreshNow();
      const permissionSheetError = spreadsheetPermissionService.getLastError?.();
      if (permissionSheetError) {
        console.warn("Spreadsheet permission refresh warning:", permissionSheetError);
      }
    } catch (err) {
      console.error("Spreadsheet permission refresh error:", err);
    }
  }, refreshIntervalMs).unref();
});


// ===============================
// SLASH COMMAND HANDLER
// ===============================
client.on("interactionCreate", async (interaction) => {
  try {
  if (interaction.isModalSubmit()) {
    const handled = await handleEditablePostModalSubmit({
      interaction,
      client,
      getInteractionMember,
      hasCommandPermission: hasAdminPermissions,
    });
    if (handled) {
      return;
    }
  }

  if (interaction.isButton()) {
    const parsedAction = parseAdminActionCustomId(interaction.customId);
    if (!parsedAction) {
      return interaction.reply({
        content: "That action button is invalid.",
        ephemeral: true,
      });
    }

    await ensureEphemeralDefer(interaction);
    const { member } = await getInteractionMember(interaction);
    if (!await ensureAdminPermission(interaction, member, parsedAction.actionType, "You do not have permission to use this action.")) {
      return;
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
  if (EAGER_DEFERRED_COMMANDS.has(interaction.commandName)) {
    await ensureEphemeralDefer(interaction);
  }

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
    verificationCodes.set(code, createVerificationRequest(interaction));

    return interaction.reply({
      content: `Your verification code is: **${code}**\nEnter this in-game.`,
      ephemeral: true
    });
  }

  // ===============================
  // UNLINK
  // ===============================
  if (interaction.commandName === "unlink") {

    if (!await ensureAdminPermission(interaction, member, "unlink", "❌ You do not have permission to use this command.")) {
      return;
    }

    const targetUser = interaction.options.getUser("user");
    const targetMember = await guild.members.fetch(targetUser.id);

    try {
      await ensureEphemeralDefer(interaction);

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

    if (!await ensureAdminPermission(interaction, member, "groupaccept")) {
    return;
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
      await ensureEphemeralDefer(interaction);

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

    if (!await ensureAdminPermission(interaction, member, "wipe")) {
    return;
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

    if (!await ensureAdminPermission(interaction, member, "unwipe")) {
    return;
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

    if (!await ensureAdminPermission(interaction, member, "restore")) {
    return;
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
  // TALENTS
  // ===============================
  if (interaction.commandName === "talents") {

    if (!await ensureAdminPermission(interaction, member, "talents")) {
    return;
    }

    const robloxInput = interaction.options.getString("robloxid");

    return handleQueuedTalentLookup(interaction, {
      targetUserId: robloxInput,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
    });
  }

  // ===============================
  // POST PANEL
  // ===============================
  if (interaction.commandName === "postpanel") {
    return handlePostPanelCommand({
      interaction,
      member,
      client,
      ensureCommandPermission: ensureAdminPermission,
    });
  }

  // ===============================
  // EDIT PANEL
  // ===============================
  if (interaction.commandName === "editpanel") {
    return handleEditPanelCommand({
      interaction,
      member,
      client,
      ensureCommandPermission: ensureAdminPermission,
    });
  }

  // ===============================
  // POST EVENT
  // ===============================
  if (interaction.commandName === "postevent") {
    return handleEventSummaryCommand(interaction, "post", member);
  }

  // ===============================
  // REFRESH EVENT
  // ===============================
  if (interaction.commandName === "refreshevent") {
    return handleEventSummaryCommand(interaction, "refresh", member);
  }

  // ===============================
  // GROUP RANK
  // ===============================
  if (interaction.commandName === "grouprank") {

    if (!await ensureAdminPermission(interaction, member, "grouprank")) {
    return;
    }

    const robloxId = interaction.options.getString("robloxid");
    const roleId = interaction.options.getInteger("roleid");

    try {
      await ensureEphemeralDefer(interaction);

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

  } catch (err) {
    console.error("Interaction handler error:", err);
    if (interaction.isRepliable()) {
      try {
        await sendInteractionResponse(interaction, "❌ Something went wrong while handling that interaction.");
      } catch (replyErr) {
        console.error("Interaction error response failed:", replyErr);
      }
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
  const verificationRequest = verificationCodes.get(code);
  const discordId = typeof verificationRequest === "string"
    ? verificationRequest
    : verificationRequest?.discordId;

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
      const followUpSent = await sendVerificationCompletionFollowUp(verificationRequest);
      if (!followUpSent) {
        console.warn("Verification follow-up could not be delivered for Discord user:", discordId);
      }
    } catch (followUpErr) {
      console.error("Verification follow-up error:", followUpErr);
    }

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

app.post("/eventSessions/sync", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const session = upsertEventSession(req.body || {});
  if (!session) {
    return res.status(400).send("Missing event session payload");
  }

  if (client.isReady()) {
    try {
      await syncEventAnnouncement(session);
    } catch (err) {
      console.error("Event announcement sync error:", err);
    }
  }

  res.json({
    ok: true,
    eventId: session.eventId,
    active: session.active,
    participants: session.participants.length,
  });
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
    resolvedUserId: req.body?.resolvedUserId,
  });

  res.send("Action report received");
});

app.post("/talentLookups/claim", (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  cleanupTalentLookupRecords();

  const now = Date.now();
  const nextRecord = talentLookupOrder
    .map((lookupId) => talentLookupRequests.get(lookupId))
    .find((record) =>
      record
      && (
        record.status === "pending"
        || (record.status === "claimed" && record.claimedAt && (now - record.claimedAt) >= TALENT_LOOKUP_CLAIM_TIMEOUT_MS)
      )
    );

  if (!nextRecord) {
    return res.json({ lookup: null });
  }

  nextRecord.status = "claimed";
  nextRecord.claimedAt = now;

  return res.json({
    lookup: {
      id: nextRecord.id,
      targetUserId: nextRecord.targetUserId,
      requestedById: nextRecord.requestedById,
      requestedByTag: nextRecord.requestedByTag,
    },
  });
});

app.post("/talentLookups/report", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const lookupId = typeof req.body?.id === "string" ? req.body.id : null;
  if (!lookupId) {
    return res.status(400).send("Missing lookup id");
  }

  const record = talentLookupRequests.get(lookupId);
  if (!record) {
    return res.status(404).send("Lookup not found");
  }

  await finalizeTalentLookup(record, {
    success: req.body?.success === true,
    message: typeof req.body?.message === "string" ? req.body.message : "",
    resolvedUserId: req.body?.resolvedUserId,
    playerName: typeof req.body?.playerName === "string" ? req.body.playerName : "",
    online: req.body?.online === true,
    talents: Array.isArray(req.body?.talents) ? req.body.talents : [],
  });

  res.send("Talent lookup report received");
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




