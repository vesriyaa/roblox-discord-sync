const express = require("express");
const crypto = require("crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
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
  COMMAND_BAR_LOG_CHANNEL_ID,
  DEATH_CHANNEL_ID,
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  DISCORD_OAUTH_REDIRECT_URI,
  DISCORD_OAUTH_SCOPES,
  ENVISIONED_ROLE_ID,
  EVENT_LOGS_CHANNEL_ID,
  EVENT_SESSION_RETENTION_LIMIT,
  EVENT_STATUS_CHANNEL_ID,
  EXAM_SERVICE_CHANNEL_ID,
  GROUP_ID,
  GUILD_ID,
  INACTIVITY_CONFIRM_LIMIT,
  INACTIVITY_DAYS,
  INACTIVITY_EXEMPT_ROLE_IDS,
  INACTIVITY_MAX_LIMIT,
  INACTIVITY_NEAR_DAYS,
  INTERACTION_FOLLOW_UP_WINDOW_MS,
  MOD_ROLE_ID,
  PUBLIC_BASE_URL,
  ROBLOX_OAUTH_CLIENT_ID,
  ROBLOX_OAUTH_CLIENT_SECRET,
  ROBLOX_OAUTH_REDIRECT_URI,
  ROBLOX_OAUTH_SCOPES,
  TALENTS_CHANNEL_ID,
  TALENT_LOOKUP_CLAIM_TIMEOUT_MS,
  TALENT_LOOKUP_RETENTION_MS,
  TALENT_LOOKUP_WAIT_TIMEOUT_MS,
  UNWAVED_ROLE_ID,
  VERIFIED_ROLE_ID,
  VERIFICATION_CHANNEL_ID,
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
  revaluationSessionOrder,
  revaluationSessions,
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
  parseChannelIdInput,
  parsePositiveInteger,
  parseTimestamp,
} = require("./src/utils");
const { createVerificationDatabase } = require("./src/verificationDatabase");
const { createVerificationService } = require("./src/verificationService");
const { createGameApiRouter, isAuthorizedRequest } = require("./src/gameApi");
const { createGameApiDocsHtml, createGameApiOpenApiSpec } = require("./src/gameApiDocs");
const { createUserActionService } = require("./src/userActionService");
const { createWebhookService } = require("./src/webhookService");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const verificationDb = createVerificationDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

const verificationService = createVerificationService({ verificationDb });
const userActionService = createUserActionService({
  client,
  verificationService,
  defaultGuildId: GUILD_ID,
  roleMap,
});
const webhookService = createWebhookService({
  client,
  resolveRelayChannelId: getRelayChannelId,
  buildRelayPayload: buildRelayMessagePayload,
  buildRelayComponents,
});
const gameApiSpec = createGameApiOpenApiSpec(PUBLIC_BASE_URL);

app.get("/api/openapi.json", (req, res) => res.json(gameApiSpec));
app.get("/docs", (req, res) => res.type("html").send(createGameApiDocsHtml()));
app.use("/api/v1", createGameApiRouter({
  apiKey: API_KEY,
  verificationService,
  userActionService,
  webhookService,
  onVerifiedJoin: refreshVerifiedRoleForLink,
}));

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
  "dm",
  "groupaccept",
  "inactive-check",
  "wipe",
  "unwipe",
  "restore",
  "talents",
  "postevent",
  "refreshevent",
  "shutdown",
  "grouprank",
]);
const MEMBER_COMMAND_ROLE_ID = process.env.MEMBER_COMMAND_ROLE_ID || "1415902349192331383";
const MEMBER_ALLOWED_COMMANDS = new Set(["verify", "getroles"]);
const REVIEW_DISCORD_ID_PREFIX = "oauth-review:";
let commandBarLogChannelPromise = null;

function truncateText(value, limit = 1000) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function formatCommandBarArg(value) {
  if (value == null) {
    return "nil";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function formatCommandBarArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return "None";
  }

  return args
    .map((value, index) => `${index + 1}. ${formatCommandBarArg(value)}`)
    .join("\n");
}

function getCommandBarLogColor(status) {
  if (status === "denied") {
    return 0xED4245;
  }

  if (status === "failed") {
    return 0xFEE75C;
  }

  return 0x57F287;
}

async function getCommandBarLogChannel() {
  if (!COMMAND_BAR_LOG_CHANNEL_ID) {
    return null;
  }

  if (!commandBarLogChannelPromise) {
    commandBarLogChannelPromise = client.channels.fetch(COMMAND_BAR_LOG_CHANNEL_ID).catch((err) => {
      commandBarLogChannelPromise = null;
      throw err;
    });
  }

  const channel = await commandBarLogChannelPromise;
  return channel && typeof channel.send === "function" ? channel : null;
}

async function postCommandBarLog(payload) {
  if (payload?.staffCommand !== true) {
    return {
      skipped: true,
      reason: "not_staff_command",
    };
  }

  const channel = await getCommandBarLogChannel();
  if (!channel) {
    throw new Error("Command bar log channel unavailable");
  }

  const player = payload?.player && typeof payload.player === "object" ? payload.player : {};
  const commandName = truncateText(payload?.commandName || "unknown", 256);
  const status = String(payload?.status || "executed").toLowerCase();
  const placeName = truncateText(payload?.placeName || "", 256);
  const placeId = payload?.placeId ? String(payload.placeId) : "unknown";
  const jobId = payload?.jobId ? String(payload.jobId) : "unknown";
  const profileUrl = player.userId ? `https://www.roblox.com/users/${player.userId}/profile` : "Unknown";

  const embed = new EmbedBuilder()
    .setTitle(status === "denied" ? "Command Bar Denied" : "Command Bar Used")
    .setColor(getCommandBarLogColor(status))
    .setTimestamp(new Date())
    .addFields(
      {
        name: "Command",
        value: truncateText(commandName, 256),
        inline: true,
      },
      {
        name: "Status",
        value: truncateText(status, 128),
        inline: true,
      },
      {
        name: "Executor",
        value: truncateText(`${player.name || "Unknown"} (${player.userId || "unknown"})\n${profileUrl}`, 512),
        inline: false,
      },
      {
        name: "Staff Role",
        value: truncateText(payload?.role || "Unknown", 256),
        inline: true,
      },
      {
        name: "Place",
        value: truncateText(placeName ? `${placeName} (${placeId})` : placeId, 256),
        inline: true,
      },
      {
        name: "Job ID",
        value: truncateText(jobId, 256),
        inline: false,
      },
      {
        name: "Arguments",
        value: truncateText(formatCommandBarArgs(payload?.args), 1024),
        inline: false,
      }
    );

  const message = payload?.message || payload?.reason;
  if (message) {
    embed.addFields({
      name: status === "denied" ? "Reason" : "Message",
      value: truncateText(message, 1024),
      inline: false,
    });
  }

  await channel.send({ embeds: [embed] });
  return {
    skipped: false,
  };
}
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
  if (member.roles.cache.has(UNWAVED_ROLE_ID)) {
    await member.roles.remove(UNWAVED_ROLE_ID);
  }

  if (!member.roles.cache.has(ENVISIONED_ROLE_ID)) {
    await member.roles.add(ENVISIONED_ROLE_ID);
  }
}

async function ensureVerifiedRole(member) {
  if (member && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
    // Verification is additive: roles assigned by Dyno or other systems must survive.
    await member.roles.add(VERIFIED_ROLE_ID);
  }
}

async function refreshVerifiedRoleForLink(record) {
  if (!record?.discordId || !client.isReady()) {
    return;
  }

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(record.discordId);
  await ensureVerifiedRole(member);
}

async function safeSendDm(user, content) {
  if (!user || typeof user.send !== "function") {
    return false;
  }

  try {
    await user.send({ content });
    return true;
  } catch (err) {
    console.warn("Failed to send DM:", user.id, err?.message || err);
    return false;
  }
}

function getInactiveRoleRemovalIds() {
  return Array.from(new Set([
    VERIFIED_ROLE_ID,
    ENVISIONED_ROLE_ID,
    ...Object.values(roleMap),
  ].filter(Boolean)));
}

function isMemberInactivityExempt(member) {
  if (!member) {
    return false;
  }

  for (const roleId of INACTIVITY_EXEMPT_ROLE_IDS) {
    if (member.roles.cache.has(roleId)) {
      return true;
    }
  }

  return false;
}

async function applyInactiveDiscordRoles(member) {
  if (!member) {
    return { removed: 0, unwaved: false };
  }

  const removableRoleIds = getInactiveRoleRemovalIds()
    .filter((roleId) => roleId !== UNWAVED_ROLE_ID && member.roles.cache.has(roleId));

  if (removableRoleIds.length > 0) {
    await member.roles.remove(removableRoleIds);
  }

  if (UNWAVED_ROLE_ID && !member.roles.cache.has(UNWAVED_ROLE_ID)) {
    await member.roles.add(UNWAVED_ROLE_ID);
  }

  return {
    removed: removableRoleIds.length,
    unwaved: Boolean(UNWAVED_ROLE_ID),
  };
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

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createRandomToken(byteLength = 32) {
  return base64Url(crypto.randomBytes(byteLength));
}

function createCodeChallenge(codeVerifier) {
  return base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRobloxOAuthConfigured() {
  return ROBLOX_OAUTH_CLIENT_ID
    && ROBLOX_OAUTH_CLIENT_SECRET
    && ROBLOX_OAUTH_REDIRECT_URI;
}

function isDiscordOAuthConfigured() {
  return DISCORD_OAUTH_CLIENT_ID
    && DISCORD_OAUTH_CLIENT_SECRET
    && DISCORD_OAUTH_REDIRECT_URI;
}

function buildDiscordAuthorizeUrl(session) {
  const params = new URLSearchParams({
    client_id: DISCORD_OAUTH_CLIENT_ID,
    redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES,
    state: session.state,
    prompt: "consent",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function buildRobloxAuthorizeUrl(session) {
  const params = new URLSearchParams({
    client_id: ROBLOX_OAUTH_CLIENT_ID,
    redirect_uri: ROBLOX_OAUTH_REDIRECT_URI,
    scope: ROBLOX_OAUTH_SCOPES,
    response_type: "code",
    state: session.state,
    nonce: session.nonce,
    code_challenge: createCodeChallenge(session.codeVerifier),
    code_challenge_method: "S256",
  });

  return `https://apis.roblox.com/oauth/v1/authorize?${params.toString()}`;
}

async function createDiscordAuthorizationUrl() {
  const session = {
    state: createRandomToken(32),
  };
  await verificationDb.createDiscordOAuthSession(session);

  return buildDiscordAuthorizeUrl(session);
}

function buildVerificationPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle("Verification System")
    .setDescription("Welcome to Thornvale. Open the verification app to connect Discord first, then Roblox, and unlock verified access.")
    .setColor(0x2fb8df)
    .setFooter({ text: "Verification System" })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verification|begin")
      .setLabel("Open Verification App")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

function buildVerificationLinkPayload(authorizationUrl) {
  return {
    content: "Open the Thornvale verification app to connect Discord first, then Roblox.",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Open Verification App")
          .setStyle(ButtonStyle.Link)
          .setURL(authorizationUrl)
      ),
    ],
    ephemeral: true,
  };
}

function getPublicAppUrl(path = "/oauth/roblox/start") {
  const callbackUrl = DISCORD_OAUTH_REDIRECT_URI || ROBLOX_OAUTH_REDIRECT_URI || "";
  const fallbackBase = callbackUrl.replace(/\/oauth\/(?:discord|roblox)\/callback$/i, "");
  const baseUrl = (PUBLIC_BASE_URL || fallbackBase || "").replace(/\/$/, "");
  if (!baseUrl) {
    return "";
  }

  return `${baseUrl}${path}`;
}

function isRobloxReviewSession(session) {
  return typeof session?.discordId === "string"
    && session.discordId.startsWith(REVIEW_DISCORD_ID_PREFIX);
}

async function createRobloxReviewAuthorizationUrl() {
  const session = {
    state: createRandomToken(32),
    nonce: createRandomToken(24),
    codeVerifier: createRandomToken(64),
    discordId: `${REVIEW_DISCORD_ID_PREFIX}${createRandomToken(16)}`,
    discordTag: "Roblox OAuth reviewer",
  };
  await verificationDb.createOAuthSession(session);

  return buildRobloxAuthorizeUrl(session);
}

async function createRobloxAuthorizationUrlForDiscord(discordIdentity) {
  const session = {
    state: createRandomToken(32),
    nonce: createRandomToken(24),
    codeVerifier: createRandomToken(64),
    discordId: discordIdentity.id,
    discordTag: discordIdentity.tag,
  };
  await verificationDb.createOAuthSession(session);

  return buildRobloxAuthorizeUrl(session);
}

async function sendVerificationAppLink(interaction, member) {
  const verificationUrl = getPublicAppUrl();
  if (!verificationUrl) {
    return interaction.reply({
      content: "Verification app URL is not configured yet. Set PUBLIC_BASE_URL in Railway.",
      ephemeral: true,
    });
  }

  const existing = await verificationDb.getVerificationByDiscordId(interaction.user.id);
  if (existing) {
    await ensureVerifiedRole(member);
  }

  const payload = buildVerificationLinkPayload(verificationUrl);
  if (existing || member?.roles.cache.has(VERIFIED_ROLE_ID)) {
    payload.content = "You are already verified. Open the Thornvale verification app to view your linked accounts.";
  }

  return interaction.reply(payload);
}

async function exchangeRobloxOAuthCode(code, session) {
  const response = await fetch("https://apis.roblox.com/oauth/v1/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: ROBLOX_OAUTH_CLIENT_ID,
      client_secret: ROBLOX_OAUTH_CLIENT_SECRET,
      redirect_uri: ROBLOX_OAUTH_REDIRECT_URI,
      code_verifier: session.codeVerifier,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Roblox token exchange failed.";
    throw new Error(message);
  }

  return payload;
}

async function exchangeDiscordOAuthCode(code) {
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: DISCORD_OAUTH_CLIENT_ID,
      client_secret: DISCORD_OAUTH_CLIENT_SECRET,
      redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Discord token exchange failed.";
    throw new Error(message);
  }

  return payload;
}

async function fetchRobloxUserInfo(accessToken) {
  const response = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Roblox userinfo request failed.";
    throw new Error(message);
  }

  return payload;
}

async function fetchDiscordUserInfo(accessToken) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error_description || payload.error || "Discord userinfo request failed.";
    throw new Error(message);
  }

  return payload;
}

function getRobloxIdentity(userInfo) {
  const robloxUserId = userInfo?.sub ? String(userInfo.sub) : "";
  if (!robloxUserId) {
    return null;
  }

  return {
    robloxUserId,
    robloxUsername: userInfo.preferred_username || userInfo.nickname || userInfo.name || "",
    robloxDisplayName: userInfo.name || userInfo.nickname || userInfo.preferred_username || "",
  };
}

function getDiscordIdentity(userInfo) {
  const id = userInfo?.id ? String(userInfo.id) : "";
  if (!id) {
    return null;
  }

  const username = userInfo.username || "";
  const discriminator = userInfo.discriminator && userInfo.discriminator !== "0"
    ? `#${userInfo.discriminator}`
    : "";
  const globalName = userInfo.global_name || userInfo.display_name || "";

  return {
    id,
    username,
    displayName: globalName || username,
    tag: `${username}${discriminator}` || id,
    avatarUrl: userInfo.avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${userInfo.avatar}.${String(userInfo.avatar).startsWith("a_") ? "gif" : "png"}?size=128`
      : "",
  };
}

function getPublicReviewDiscordIdentity(discordIdentity) {
  return {
    id: `${REVIEW_DISCORD_ID_PREFIX}${createRandomToken(16)}`,
    tag: `Discord OAuth reviewer: ${discordIdentity.tag}`,
  };
}

async function fetchThornvaleMember(discordId) {
  if (!GUILD_ID) {
    return null;
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    return await guild.members.fetch(discordId);
  } catch {
    return null;
  }
}

function sendOAuthHtml(res, title, message, statusCode = 200) {
  return renderResultPage(res, {
    title,
    message,
    statusCode,
  });
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
  const hasFallbackEmbed = !body?.embeds && (
    typeof body?.title === "string"
    || typeof body?.description === "string"
    || (Array.isArray(body?.fields) && body.fields.length > 0)
  );
  const fallbackEmbed = hasFallbackEmbed
    ? Object.fromEntries(Object.entries({
      title: body.title,
      description: body.description,
      color: body.color,
      fields: Array.isArray(body.fields) ? body.fields : undefined,
    }).filter(([, value]) => value !== undefined))
    : null;

  const content = formatOptionalString(
    body?.content ?? body?.message ?? body?.text ?? body?.summary
  );

  if (content) {
    messagePayload.content = content.slice(0, 2000);
  }

  if (embeds.length > 0) {
    messagePayload.embeds = embeds;
  } else if (fallbackEmbed) {
    messagePayload.embeds = [fallbackEmbed];
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
    aetherBulletsUsed: normalizeValue(
      resources?.aetherBulletsUsed ?? resources?.bladesUsed,
      existingResources.aetherBulletsUsed ?? existingResources.bladesUsed
    ),
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
    `*Aether Bullets Used: ${session.resources.aetherBulletsUsed}*`,
    `*Bandages Used: ${session.resources.bandagesUsed}*`,
  ].join("\n");
}

function formatUnixDiscordTimestamp(timestamp, style = "F") {
  const parsedTimestamp = parseTimestamp(timestamp);
  if (!parsedTimestamp) {
    return "Unknown";
  }

  const discordTimestamp = parsedTimestamp > 10000000000
    ? Math.floor(parsedTimestamp / 1000)
    : parsedTimestamp;

  return `<t:${discordTimestamp}:${style}>`;
}

function buildEventStatusMessage(session) {
  return [
    "**Event Tracker**",
    `Event ID: \`${session.eventId}\``,
    `Map: **${session.mapName}**`,
    `Status: **${session.active ? "Active" : "Ended"}**`,
    `Started: ${formatUnixDiscordTimestamp(session.startedAt)}`,
    `Ended: ${session.active ? "Pending" : formatUnixDiscordTimestamp(session.endedAt)}`,
    `Last Update: ${formatUnixDiscordTimestamp(session.updatedAt)}`,
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

const REVALUATION_SESSION_RETENTION_LIMIT = 250;

function normalizeRevaluationParticipant(participant) {
  const userId = parsePositiveInteger(participant?.userId ?? participant?.robloxUserId);
  if (!userId) {
    return null;
  }

  const results = typeof participant?.results === "object" && participant.results !== null
    ? participant.results
    : {};

  return {
    userId,
    playerName: formatOptionalString(participant?.playerName, String(userId)),
    displayName: formatOptionalString(participant?.displayName, participant?.playerName || String(userId)),
    loreName: formatOptionalString(participant?.loreName ?? participant?.characterName, ""),
    evaluation: formatOptionalString(participant?.evaluation, ""),
    status: formatOptionalString(participant?.status, "Pending"),
    stage: formatOptionalString(participant?.stage, ""),
    updatedAt: parseTimestamp(participant?.updatedAt) ?? Date.now(),
    results: {
      trainerPassed: results.trainerPassed === true,
      speedCompleted: results.speedCompleted === true,
      speedTime: Number.isFinite(Number(results.speedTime)) ? Number(results.speedTime) : null,
      speedReached: Number.parseInt(String(results.speedReached ?? 0), 10) || 0,
      titanDummyNapes: Number.parseInt(String(results.titanDummyNapes ?? 0), 10) || 0,
      titanDummyElapsedTime: Number.isFinite(Number(results.titanDummyElapsedTime)) ? Number(results.titanDummyElapsedTime) : null,
      titanKills: Number.parseInt(String(results.titanKills ?? 0), 10) || 0,
      titanTotal: Number.parseInt(String(results.titanTotal ?? 0), 10) || 0,
      titanCleared: results.titanCleared === true,
      titanElapsedTime: Number.isFinite(Number(results.titanElapsedTime)) ? Number(results.titanElapsedTime) : null,
    },
  };
}

function normalizeRevaluationParticipants(participants) {
  return (Array.isArray(participants) ? participants : [])
    .map(normalizeRevaluationParticipant)
    .filter(Boolean)
    .sort((left, right) => left.playerName.localeCompare(right.playerName));
}

function mergeRevaluationParticipants(incomingParticipants, existingParticipants = []) {
  const participantMap = new Map();

  for (const participant of existingParticipants) {
    participantMap.set(participant.userId, participant);
  }

  for (const participant of incomingParticipants) {
    const existingParticipant = participantMap.get(participant.userId);
    if (!existingParticipant || participant.updatedAt >= existingParticipant.updatedAt) {
      participantMap.set(participant.userId, participant);
    }
  }

  return Array.from(participantMap.values())
    .sort((left, right) => left.playerName.localeCompare(right.playerName));
}

function trackRevaluationSessionOrder(sessionId) {
  const existingIndex = revaluationSessionOrder.indexOf(sessionId);
  if (existingIndex >= 0) {
    revaluationSessionOrder.splice(existingIndex, 1);
  }

  revaluationSessionOrder.push(sessionId);
  while (revaluationSessionOrder.length > REVALUATION_SESSION_RETENTION_LIMIT) {
    const oldestSessionId = revaluationSessionOrder.shift();
    if (oldestSessionId) {
      revaluationSessions.delete(oldestSessionId);
    }
  }
}

function upsertRevaluationSession(payload) {
  const sessionId = formatOptionalString(payload?.sessionId ?? payload?.id);
  if (!sessionId) {
    return null;
  }

  const existingSession = revaluationSessions.get(sessionId);
  const incomingUpdatedAt = parseTimestamp(payload?.updatedAt);
  if (
    existingSession
    && incomingUpdatedAt
    && existingSession.sourceUpdatedAt
    && incomingUpdatedAt < existingSession.sourceUpdatedAt
  ) {
    return existingSession;
  }

  const hasActiveFlag = typeof payload?.active === "boolean";
  const active = hasActiveFlag ? payload.active === true : existingSession?.active ?? true;
  const sourceUpdatedAt = incomingUpdatedAt ?? existingSession?.sourceUpdatedAt ?? Date.now();
  const explicitEndedAt = parseTimestamp(payload?.endedAt);

  const session = {
    sessionId,
    name: formatOptionalString(payload?.name ?? payload?.sessionName, existingSession?.name || sessionId),
    active,
    startedAt: parseTimestamp(payload?.startedAt) ?? existingSession?.startedAt ?? Date.now(),
    endedAt: active
      ? null
      : explicitEndedAt ?? existingSession?.endedAt ?? (hasActiveFlag ? Date.now() : null),
    sourceUpdatedAt,
    updatedAt: sourceUpdatedAt,
    participants: mergeRevaluationParticipants(
      normalizeRevaluationParticipants(payload?.participants ?? payload?.entries),
      existingSession?.participants
    ),
    statusMessage: existingSession?.statusMessage || null,
  };

  revaluationSessions.set(sessionId, session);
  trackRevaluationSessionOrder(sessionId);
  return session;
}

function formatRevaluationResult(participant) {
  const results = participant.results || {};
  const trainer = results.trainerPassed ? "Trainer Pass" : "Trainer Fail";
  const speed = results.speedCompleted
    ? (typeof results.speedTime === "number" ? `Speed ${results.speedTime.toFixed(2)}s` : "Speed Done")
    : `Speed ${results.speedReached || 0}/4`;
  const dummies = `Dummies ${results.titanDummyNapes || 0}`;
  const titans = `Titans ${results.titanKills || 0}/${results.titanTotal || 0}`;
  return `${trainer} | ${speed} | ${dummies} | ${titans}`;
}

function buildRevaluationStatusMessage(session) {
  const lines = [
    `**${session.name}**`,
    `Session ID: \`${session.sessionId}\``,
    `Status: **${session.active ? "Active" : "Ended"}**`,
    `Started: ${formatUnixDiscordTimestamp(session.startedAt)}`,
    `Ended: ${session.active ? "Pending" : formatUnixDiscordTimestamp(session.endedAt)}`,
    "",
    "**Scores**",
  ];

  if (session.participants.length === 0) {
    lines.push("*No participants sent yet.*");
  } else {
    for (const participant of session.participants.slice(0, 35)) {
      const stage = participant.stage || participant.status || "Pending";
      const loreName = participant.loreName ? ` / *${participant.loreName}*` : "";
      const evaluation = participant.evaluation ? ` | Eval **${participant.evaluation}**` : "";
      lines.push(`- **${participant.playerName}**${loreName}${evaluation}: ${stage} - ${formatRevaluationResult(participant)}`);
    }

    if (session.participants.length > 35) {
      lines.push(`*And ${session.participants.length - 35} more participant(s).*`);
    }
  }

  lines.push("", `Last Update: ${formatUnixDiscordTimestamp(session.updatedAt)}`);
  return lines.join("\n").slice(0, 1900);
}

async function postRevaluationStatus(session) {
  const channel = await client.channels.fetch(EXAM_SERVICE_CHANNEL_ID);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Exam service channel unavailable");
  }

  const message = await channel.send({
    content: buildRevaluationStatusMessage(session),
  });

  session.statusMessage = {
    channelId: channel.id,
    messageId: message.id,
    updatedAt: Date.now(),
  };

  return message;
}

async function syncRevaluationStatus(session) {
  const currentMessage = session.statusMessage;
  if (!currentMessage?.channelId || !currentMessage?.messageId) {
    return postRevaluationStatus(session);
  }

  const channel = await client.channels.fetch(currentMessage.channelId);
  if (!channel?.messages?.fetch) {
    return postRevaluationStatus(session);
  }

  try {
    const message = await channel.messages.fetch(currentMessage.messageId);
    await message.edit({
      content: buildRevaluationStatusMessage(session),
    });

    session.statusMessage.updatedAt = Date.now();
    return message;
  } catch {
    return postRevaluationStatus(session);
  }
}

function hasModPermissions(member) {
  return member.roles.cache.has(MOD_ROLE_ID);
}

function hasMemberCommandRole(member) {
  return Boolean(MEMBER_COMMAND_ROLE_ID && member.roles.cache.has(MEMBER_COMMAND_ROLE_ID));
}

async function ensureChatInputCommandAccess(interaction, member) {
  const commandKey = normalizeCommandKey(interaction.commandName);
  const access = await spreadsheetPermissionService.getMemberAccess(member);

  if (access.record || hasModPermissions(member)) {
    return true;
  }

  if (MEMBER_ALLOWED_COMMANDS.has(commandKey) && hasMemberCommandRole(member)) {
    return true;
  }

  await sendInteractionResponse(interaction, "❌ You do not have permission to use this command.");
  return false;
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
    shutdown: "shutdown",
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

  if (action.actionType === "shutdown") {
    return "shutdown for all active Thornvale places";
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

function getStudioQueueStatus() {
  const countRecords = (records, status) =>
    Array.from(records.values()).filter((record) => record?.status === status).length;

  return {
    ok: true,
    botReady: client.isReady(),
    uptimeSeconds: Math.floor(process.uptime()),
    adminActions: {
      pending: countRecords(adminActions, "pending"),
      claimed: countRecords(adminActions, "claimed"),
      completed: countRecords(adminActions, "completed"),
      failed: countRecords(adminActions, "failed"),
    },
    talentLookups: {
      pending: countRecords(talentLookupRequests, "pending"),
      claimed: countRecords(talentLookupRequests, "claimed"),
      completed: countRecords(talentLookupRequests, "completed"),
      failed: countRecords(talentLookupRequests, "failed"),
    },
    eventSessions: eventSessions.size,
    revaluationSessions: revaluationSessions.size,
  };
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
  const targetText = record.actionType === "shutdown"
    ? "all active Thornvale places"
    : `Roblox user ${record.targetUserId}`;
  await channel.send({
    content: `${record.requestedByTag} ${outcome} ${getActionLabel(record.actionType)} for ${targetText}: ${record.resultMessage}`,
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

function getSlashInteger(interaction, name, fallback, min, max) {
  return clampInteger(interaction.options.getInteger(name), fallback, min, max);
}

function getInactiveCutoffIso(days, now = Date.now()) {
  return new Date(now - (days * MS_PER_DAY)).toISOString();
}

function getDaysSinceIso(iso, now = Date.now()) {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((now - timestamp) / MS_PER_DAY));
}

function formatDiscordTimestamp(iso, style = "R") {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

function formatInactiveCandidate(record, index, now = Date.now()) {
  const daysSince = getDaysSinceIso(record.lastGameSeenAt, now);
  const daysText = daysSince == null ? "unknown days" : `${daysSince} day${daysSince === 1 ? "" : "s"}`;
  const robloxLabel = record.robloxUsername
    ? `${record.robloxUsername} (${record.robloxUserId})`
    : record.robloxUserId;

  return `${index + 1}. <@${record.discordId}> | ${robloxLabel} | last seen ${formatDiscordTimestamp(record.lastGameSeenAt)} (${daysText})`;
}

function formatNearInactiveCandidate(record, index, days) {
  const lastSeen = new Date(record.lastGameSeenAt).getTime();
  const inactiveAt = Number.isFinite(lastSeen)
    ? new Date(lastSeen + (days * MS_PER_DAY)).toISOString()
    : null;
  const robloxLabel = record.robloxUsername
    ? `${record.robloxUsername} (${record.robloxUserId})`
    : record.robloxUserId;

  return `${index + 1}. <@${record.discordId}> | ${robloxLabel} | inactive ${inactiveAt ? formatDiscordTimestamp(inactiveAt) : "unknown"}`;
}

function trimDiscordMessage(lines, limit = 1900) {
  let output = "";
  for (const line of lines) {
    const next = output ? `${output}\n${line}` : line;
    if (next.length > limit) {
      return `${output}\n...`;
    }
    output = next;
  }

  return output;
}

async function queueInactiveWipe(interaction, record, days) {
  const daysSince = getDaysSinceIso(record.lastGameSeenAt);
  const reason = `Automatic inactivity unwave: no in-game activity for ${daysSince ?? days}+ days.`;
  const actionData = {
    actionType: "wipe",
    targetUserId: record.robloxUserId,
    reason,
    requestedById: interaction.user.id,
    requestedByTag: interaction.user.tag,
    dedupeKey: `inactivity-wipe:${record.robloxUserId}`,
  };
  const queued = queueAdminAction(actionData);

  try {
    await logAdminActionRequest(actionData, queued.duplicate ? queued.record : null);
  } catch (err) {
    console.error("Failed posting inactivity wipe transcript:", err);
  }

  return queued;
}

async function handleInactiveCheckCommand(interaction, guild) {
  const subcommand = interaction.options.getSubcommand();
  const days = getSlashInteger(interaction, "days", INACTIVITY_DAYS, 1, 3650);
  const limit = getSlashInteger(interaction, "limit", INACTIVITY_CONFIRM_LIMIT, 1, INACTIVITY_MAX_LIMIT);
  const now = Date.now();
  const inactiveCutoffIso = getInactiveCutoffIso(days, now);

  if (subcommand === "preview") {
    const records = await verificationDb.listInactiveCandidates(inactiveCutoffIso, limit);
    if (records.length === 0) {
      return sendInteractionResponse(interaction, `No verified users are past the ${days}-day inactivity cutoff.`);
    }

    const lines = [
      "**Inactive Preview**",
      `Cutoff: ${days}+ days without joining/leaving in-game.`,
      `Showing ${records.length} user${records.length === 1 ? "" : "s"}. Use \`/inactive-check confirm\` to unwave this cutoff.`,
      "",
      ...records.map((record, index) => formatInactiveCandidate(record, index, now)),
    ];
    return sendInteractionResponse(interaction, trimDiscordMessage(lines));
  }

  if (subcommand === "near") {
    const within = getSlashInteger(interaction, "within", INACTIVITY_NEAR_DAYS, 1, days);
    const nearCutoffIso = getInactiveCutoffIso(Math.max(0, days - within), now);
    const records = await verificationDb.listNearlyInactiveCandidates(nearCutoffIso, inactiveCutoffIso, limit);
    if (records.length === 0) {
      return sendInteractionResponse(interaction, `No verified users are within ${within} day${within === 1 ? "" : "s"} of the ${days}-day inactivity cutoff.`);
    }

    const lines = [
      "**Nearly Inactive**",
      `Cutoff: ${days} days. Window: next ${within} day${within === 1 ? "" : "s"}.`,
      `Showing ${records.length} user${records.length === 1 ? "" : "s"}.`,
      "",
      ...records.map((record, index) => formatNearInactiveCandidate(record, index, days)),
    ];
    return sendInteractionResponse(interaction, trimDiscordMessage(lines));
  }

  if (subcommand !== "confirm") {
    return sendInteractionResponse(interaction, "Unknown inactive-check action.");
  }

  const records = await verificationDb.listInactiveCandidates(inactiveCutoffIso, limit);
  if (records.length === 0) {
    return sendInteractionResponse(interaction, `No verified users are past the ${days}-day inactivity cutoff.`);
  }

  const processed = [];
  const skipped = [];
  const failed = [];

  for (const record of records) {
    const targetMember = await guild.members.fetch(record.discordId).catch(() => null);
    if (targetMember && isMemberInactivityExempt(targetMember)) {
      skipped.push(`<@${record.discordId}>`);
      continue;
    }

    try {
      const queued = await queueInactiveWipe(interaction, record, days);
      if (targetMember) {
        await applyInactiveDiscordRoles(targetMember);
        await safeSendDm(
          targetMember.user,
          `You have been marked as Unwaved in Thornvale because no in-game activity was recorded for ${getDaysSinceIso(record.lastGameSeenAt) ?? days}+ days. Your verification was removed and your character data has been queued for wipe.`
        );
      }

      unlinkedUsers.add(record.discordId);
      await verificationDb.deleteVerificationByDiscordId(record.discordId);
      processed.push(`${queued.duplicate ? "already queued" : "queued"} ${record.robloxUsername || record.robloxUserId} (<@${record.discordId}>)`);
    } catch (err) {
      console.error("Inactive confirm error:", record, err);
      failed.push(`${record.robloxUsername || record.robloxUserId} (<@${record.discordId}>)`);
    }
  }

  const lines = [
    "**Inactive Confirm Complete**",
    `Processed: ${processed.length}`,
    `Skipped exempt: ${skipped.length}`,
    `Failed: ${failed.length}`,
  ];

  if (processed.length > 0) {
    lines.push("", "**Processed**", ...processed.slice(0, 20));
  }
  if (skipped.length > 0) {
    lines.push("", "**Skipped**", ...skipped.slice(0, 10));
  }
  if (failed.length > 0) {
    lines.push("", "**Failed**", ...failed.slice(0, 10));
  }

  return sendInteractionResponse(interaction, trimDiscordMessage(lines));
}

async function handleEventSummaryCommand(interaction, mode, member) {
  await ensureEphemeralDefer(interaction);

  if (!await ensureAdminPermission(interaction, member, mode === "refresh" ? "refreshevent" : "postevent")) {
    return;
  }

  const eventId = formatOptionalString(interaction.options.getString("eventid"));
  const session = eventSessions.get(eventId);
  if (!session) {
    return sendInteractionResponse(interaction, "That event ID was not found in the bot cache yet.");
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
    await verificationDb.init();
    console.log(`Verification database ready (${verificationDb.type}).`);
  } catch (err) {
    console.error("Verification database failed to initialize:", err);
  }

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
    if (interaction.customId === "verification|begin") {
      const { member } = await getInteractionMember(interaction);
      return sendVerificationAppLink(interaction, member);
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

  if (!await ensureChatInputCommandAccess(interaction, member)) {
    return;
  }

  // ===============================
  // VERIFY
  // ===============================
  if (interaction.commandName === "verify") {
    return sendVerificationAppLink(interaction, member);
  }

  if (interaction.commandName === "verification-system") {
    if (!await ensureAdminPermission(interaction, member, "verification-system")) {
      return;
    }

    const channelInput = interaction.options.getString("channelid");
    const channelId = parseChannelIdInput(channelInput) || VERIFICATION_CHANNEL_ID || interaction.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") {
      return interaction.reply({
        content: "Could not find a channel I can post the verification panel in.",
        ephemeral: true,
      });
    }

    const message = await channel.send(buildVerificationPanelPayload());
    const messageUrl = buildDiscordMessageUrl(message.channelId, message.id);
    return interaction.reply({
      content: messageUrl ? `Verification panel posted: ${messageUrl}` : "Verification panel posted.",
      ephemeral: true,
    });
  }

  // ===============================
  // GET ROLES
  // ===============================
  if (interaction.commandName === "getroles") {
    if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You need to verify before restoring roles. Use /verify first.",
        ephemeral: true
      });
    }

    return interaction.reply({
      content: "✅ Your roles sync from your in-game team. If a team role is missing, join the game and let it refresh your team once.",
      ephemeral: true
    });
  }

  // ===============================
  // INACTIVE CHECK
  // ===============================
  if (interaction.commandName === "inactive-check") {
    if (!await ensureAdminPermission(interaction, member, "inactivecheck")) {
      return;
    }

    return handleInactiveCheckCommand(interaction, guild);
  }

  // ===============================
  // UNLINK
  // ===============================
  if (interaction.commandName === "unlink") {

    if (!await ensureAdminPermission(interaction, member, "unlink", "❌ You do not have permission to use this command.")) {
      return;
    }
  }

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
      await verificationDb.deleteVerificationByDiscordId(targetUser.id);

      return sendInteractionResponse(interaction, `✅ Successfully unlinked ${targetUser.tag}`);

    } catch (err) {
      console.error("Unlink error:", err);
      return sendInteractionResponse(interaction, "❌ Failed to unlink user.");
    }
  }

  // ===============================
  // DIRECT MESSAGE
  // ===============================
  if (interaction.commandName === "dm") {
    if (!await ensureAdminPermission(interaction, member, "dm")) {
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const message = String(interaction.options.getString("message", true) || "").trim();
    if (!message) {
      return sendInteractionResponse(interaction, "A message is required.");
    }

    const delivered = await safeSendDm(targetUser, message);
    if (!delivered) {
      return sendInteractionResponse(
        interaction,
        `Could not DM ${targetUser.tag}. They may have direct messages disabled.`
      );
    }

    return sendInteractionResponse(interaction, `Message sent to ${targetUser.tag}.`);
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

      await safeSendDm(
        targetMember.user,
        "You have been accepted into Thornvale. Your Discord roles have been updated."
      );

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
  // SHUTDOWN
  // ===============================
  if (interaction.commandName === "shutdown") {
    if (!await ensureAdminPermission(interaction, member, "shutdown")) {
      return;
    }

    const reason = interaction.options.getString("reason") || "";

    return handleQueuedAdminAction(interaction, {
      actionType: "shutdown",
      targetUserId: "all",
      reason,
      requestedById: interaction.user.id,
      requestedByTag: interaction.user.tag,
      dedupeKey: "shutdown:all-active-places",
    });
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
app.get("/oauth/roblox/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query || {};
  if (error) {
    return sendOAuthHtml(
      res,
      "Verification Cancelled",
      String(errorDescription || error || "Roblox authorization was cancelled."),
      400
    );
  }

  if (typeof code !== "string" || typeof state !== "string") {
    return sendOAuthHtml(res, "Verification Failed", "Missing Roblox OAuth callback data.", 400);
  }

  const session = await verificationDb.consumeOAuthSession(state);
  if (!session) {
    return sendOAuthHtml(res, "Verification Expired", "That verification link expired. Please return to Discord and click Get Verified Role again.", 400);
  }

  try {
    const tokenPayload = await exchangeRobloxOAuthCode(code, session);
    const userInfo = await fetchRobloxUserInfo(tokenPayload.access_token);
    const identity = getRobloxIdentity(userInfo);
    if (!identity) {
      return sendOAuthHtml(res, "Verification Failed", "Roblox did not return a usable user id.", 400);
    }

    if (isRobloxReviewSession(session)) {
      return sendOAuthHtml(
        res,
        "Verification Flow Complete",
        "Discord OAuth and Roblox OAuth returned valid accounts. This public review flow does not change Discord roles unless the Discord account is already in the Thornvale server."
      );
    }

    const existingRobloxLink = await verificationDb.getVerificationByRobloxUserId(identity.robloxUserId);
    if (existingRobloxLink && existingRobloxLink.discordId !== session.discordId) {
      return sendOAuthHtml(
        res,
        "Already Linked",
        "That Roblox account is already verified to another Discord account. Ask a moderator to unlink it first.",
        409
      );
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(session.discordId);

    const linkedRecord = await verificationDb.upsertVerification({
      discordId: session.discordId,
      robloxUserId: identity.robloxUserId,
      robloxUsername: identity.robloxUsername,
      robloxDisplayName: identity.robloxDisplayName,
    });
    unlinkedUsers.delete(session.discordId);

    await ensureVerifiedRole(member);

    return renderLinkedAccountPage(
      res,
      {
        discordIdentity: {
          id: session.discordId,
          tag: session.discordTag,
          displayName: session.discordTag,
        },
        record: linkedRecord,
        message: "Your Roblox account is now linked and your Discord verified role has been applied.",
      }
    );
  } catch (err) {
    console.error("Roblox OAuth verification error:", err);
    return sendOAuthHtml(res, "Verification Failed", "Something went wrong while verifying your Roblox account. Please try again.", 500);
  }
});

app.post("/verify", async (req, res) => {
  res.set("Deprecation", "true");
  res.set("Link", "</docs>; rel=\"deprecation\"");
  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  const {
    code,
    robloxUserId,
    robloxUsername,
    robloxDisplayName,
  } = req.body;
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

    await ensureVerifiedRole(member);

    if (robloxUserId) {
      await verificationDb.upsertVerification({
        discordId,
        robloxUserId: String(robloxUserId),
        robloxUsername: typeof robloxUsername === "string" ? robloxUsername : "",
        robloxDisplayName: typeof robloxDisplayName === "string" ? robloxDisplayName : "",
      });
      unlinkedUsers.delete(discordId);
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

  res.json({ discordId, robloxUserId: robloxUserId ? String(robloxUserId) : null });
});

app.post("/checkUnlink", async (req, res) => {
  res.set("Deprecation", "true");
  res.set("Link", "</docs>; rel=\"deprecation\"");
  if (!isAuthorizedRequest(req, API_KEY)) {
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

  try {
    const record = await verificationDb.getVerificationByDiscordId(discordId);
    return res.json({ unlinked: !record });
  } catch (err) {
    console.error("Persistent unlink check error:", err);
    return res.status(500).send("Unlink check failed");
  }
});

app.post("/verification/lookup", async (req, res) => {
  res.set("Deprecation", "true");
  res.set("Link", "</docs>; rel=\"deprecation\"");
  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  const discordId = req.body?.discordId ? String(req.body.discordId) : "";
  const robloxUserId = req.body?.robloxUserId ? String(req.body.robloxUserId) : "";
  if (!discordId && !robloxUserId) {
    return res.status(400).send("Missing discordId or robloxUserId");
  }

  try {
    return res.json(await verificationService.lookup({ discordId, robloxUserId }));
  } catch (err) {
    console.error("Verification lookup error:", err);
    return res.status(500).send("Verification lookup failed");
  }
});

app.post("/activity/game", async (req, res) => {
  res.set("Deprecation", "true");
  res.set("Link", "</docs>; rel=\"deprecation\"");
  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  const robloxUserId = req.body?.robloxUserId ? String(req.body.robloxUserId) : "";
  if (!robloxUserId) {
    return res.status(400).send("Missing robloxUserId");
  }

  try {
    const result = await verificationService.recordActivity(req.body);
    const record = result.verification;
    if (!record.verified) {
      return res.json({ ok: true, verified: false });
    }

    if (result.eventType === "join") {
      try {
        await refreshVerifiedRoleForLink(record);
      } catch (roleErr) {
        console.error("Game activity role refresh error:", roleErr);
      }
    }

    return res.json({
      ok: true,
      verified: true,
      discordId: record.discordId,
      robloxUserId: record.robloxUserId,
      lastGameSeenAt: record.lastGameSeenAt,
    });
  } catch (err) {
    console.error("Game activity update error:", err);
    return res.status(500).send("Game activity update failed");
  }
});

app.post("/updateRole", async (req, res) => {
  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }
  res.set("Deprecation", "true");
  res.set("Link", "</api/v1/useraction>; rel=successor-version");
  try {
    const result = await userActionService.execute({ method: "SyncTeamRole", ...req.body });
    if (result.skipped) {
      return res.status(404).send("Roblox account is not verified");
    }
    return res.send("Role updated");
  } catch (err) {
    console.error("Role update error:", err);
    return res.status(Number.isInteger(err?.status) ? err.status : 500).send(err?.message || "Error assigning role");
  }
});

app.post("/relayWebhook/:service", async (req, res) => {
  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }
  res.set("Deprecation", "true");
  res.set("Link", "</api/v1/webhook>; rel=successor-version");
  try {
    const result = await webhookService.execute({
      method: "Payload",
      service: req.params.service,
      payload: req.body || {},
    });
    return res.json({
      ok: true,
      service: result.service,
      channelId: result.channelId,
      messageId: result.messageId,
    });
  } catch (err) {
    console.error("Relay webhook error:", err);
    return res.status(Number.isInteger(err?.status) ? err.status : 500).json({
      ok: false,
      error: err?.message || "Error posting relay webhook",
    });
  }
});

app.post("/commandBar/log", async (req, res) => {

  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  if (!client.isReady()) {
    return res.status(503).send("Bot not ready");
  }

  if (!req.body || typeof req.body !== "object") {
    return res.status(400).send("Missing command log payload");
  }

  try {
    const result = await postCommandBarLog(req.body);
    res.json({
      ok: true,
      channelId: COMMAND_BAR_LOG_CHANNEL_ID,
      skipped: result?.skipped === true,
      reason: result?.reason || null,
    });

  } catch (err) {
    console.error("Command bar log error:", err);
    res.status(500).json({
      ok: false,
      error: "Error posting command bar log",
    });
  }
});

app.post("/eventSessions/sync", async (req, res) => {

  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  const session = upsertEventSession(req.body || {});
  if (!session) {
    return res.status(400).send("Missing event session payload");
  }

  let discordSynced = false;
  let syncError = null;
  if (client.isReady()) {
    try {
      await syncEventAnnouncement(session);
      discordSynced = true;
    } catch (err) {
      console.error("Event announcement sync error:", err);
      syncError = "Event announcement sync failed";
    }
  } else {
    syncError = "Bot not ready";
  }

  res.json({
    ok: true,
    eventId: session.eventId,
    active: session.active,
    participants: session.participants.length,
    discordSynced,
    syncError,
  });
});

app.post("/revaluationSessions/sync", async (req, res) => {

  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  const session = upsertRevaluationSession(req.body || {});
  if (!session) {
    return res.status(400).send("Missing revaluation session payload");
  }

  let discordSynced = false;
  let syncError = null;
  if (client.isReady()) {
    try {
      await syncRevaluationStatus(session);
      discordSynced = true;
    } catch (err) {
      console.error("Revaluation status sync error:", err);
      syncError = "Revaluation status sync failed";
    }
  } else {
    syncError = "Bot not ready";
  }

  res.json({
    ok: true,
    sessionId: session.sessionId,
    active: session.active,
    participants: session.participants.length,
    discordSynced,
    syncError,
  });
});

app.post("/studio/status", (req, res) => {

  if (!isAuthorizedRequest(req, API_KEY)) {
    return res.status(403).send("Unauthorized");
  }

  cleanupAdminActionRecords();
  cleanupTalentLookupRecords();

  res.json(getStudioQueueStatus());
});
app.post("/adminActions/claim", (req, res) => {

  if (!isAuthorizedRequest(req, API_KEY)) {
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

  if (!isAuthorizedRequest(req, API_KEY)) {
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

  if (!isAuthorizedRequest(req, API_KEY)) {
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

  if (!isAuthorizedRequest(req, API_KEY)) {
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

const LEGAL_EFFECTIVE_DATE = "July 6, 2026";

function renderDustMotes() {
  const motes = [
    [5, 56, 2, 34, 0, 18],
    [8, 82, 1, 42, 3, -12],
    [12, 44, 3, 48, 6, 24],
    [16, 74, 2, 38, 2, -20],
    [19, 20, 1, 46, 7, 16],
    [23, 64, 2, 41, 1, -16],
    [27, 36, 1, 50, 8, 22],
    [31, 87, 2, 45, 4, -18],
    [34, 15, 1, 37, 5, 14],
    [38, 58, 3, 44, 9, -26],
    [42, 29, 2, 52, 2, 20],
    [46, 78, 1, 39, 6, -14],
    [51, 48, 2, 47, 3, 18],
    [55, 19, 1, 43, 8, -22],
    [59, 68, 3, 49, 0, 24],
    [63, 33, 1, 40, 4, -18],
    [67, 91, 2, 54, 7, 16],
    [71, 52, 1, 36, 1, -12],
    [75, 24, 3, 46, 5, 26],
    [79, 72, 2, 51, 9, -20],
    [83, 39, 1, 42, 2, 14],
    [87, 84, 2, 48, 6, -24],
    [91, 57, 1, 44, 3, 22],
    [95, 31, 2, 53, 8, -16],
    [14, 93, 1, 57, 10, 18],
    [49, 94, 2, 60, 11, -18],
    [72, 8, 1, 55, 12, 12],
    [97, 70, 3, 58, 13, -22],
  ];

  return motes
    .map(([x, y, size, duration, delay, drift]) => (
      `<span class="dust" style="--x:${x};--y:${y};--size:${size}px;--duration:${duration}s;--delay:${delay}s;--drift:${drift}px"></span>`
    ))
    .join("");
}

function renderBasePage(res, title, body, options = {}) {
  const scripts = options.scripts || "";
  const statusLabel = options.statusLabel || "Not Verified";

  res.status(options.statusCode || 200).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background: #050403;
    }

    body {
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(circle at 50% 60%, rgba(120, 72, 28, 0.2), rgba(5, 4, 3, 0) 32rem),
        radial-gradient(circle at 20% 18%, rgba(43, 48, 91, 0.18), rgba(5, 4, 3, 0) 22rem),
        linear-gradient(180deg, #050403 0%, #0b0805 50%, #030302 100%);
      color: #eee6d8;
      font-family: Georgia, "Times New Roman", serif;
      line-height: 1.6;
      letter-spacing: 0;
      overflow-x: hidden;
    }

    body::before {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      content: "";
      background:
        linear-gradient(90deg, rgba(184, 137, 35, 0.04), rgba(184, 137, 35, 0) 18%, rgba(184, 137, 35, 0) 82%, rgba(184, 137, 35, 0.04)),
        radial-gradient(circle at center, rgba(255, 229, 154, 0.04), rgba(255, 229, 154, 0) 38rem);
    }

    a {
      color: #d6a824;
      text-decoration-color: rgba(214, 168, 36, 0.45);
      text-underline-offset: 4px;
    }

    a:hover {
      color: #f2d98a;
    }

    .dust-field {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .dust {
      position: absolute;
      left: calc(var(--x) * 1%);
      top: calc(var(--y) * 1%);
      width: var(--size);
      height: var(--size);
      border-radius: 999px;
      background: rgba(219, 166, 52, 0.8);
      box-shadow: 0 0 18px rgba(219, 166, 52, 0.72);
      opacity: 0.35;
      animation: dust-drift var(--duration) linear infinite;
      animation-delay: var(--delay);
    }

    @keyframes dust-drift {
      0% {
        transform: translate3d(0, 16px, 0);
        opacity: 0;
      }

      12% {
        opacity: 0.35;
      }

      64% {
        opacity: 0.5;
      }

      100% {
        transform: translate3d(var(--drift), -120vh, 0);
        opacity: 0;
      }
    }

    .site-shell {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }

    .topbar {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 0 32px;
      border-bottom: 1px solid rgba(147, 111, 30, 0.24);
      background: rgba(5, 4, 3, 0.72);
      backdrop-filter: blur(10px);
    }

    .brand {
      color: #eee6d8;
      font-size: 17px;
      font-weight: 700;
      font-variant: small-caps;
      text-decoration: none;
    }

    .status-pill {
      min-width: 118px;
      padding: 5px 12px;
      border: 1px solid rgba(147, 111, 30, 0.34);
      color: #a99a84;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      text-align: center;
      text-transform: uppercase;
    }

    .verify-main,
    .doc-main {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 74px 24px 64px;
    }

    .verify-frame,
    .doc-frame {
      position: relative;
      width: min(500px, 100%);
      border: 1px solid rgba(165, 124, 28, 0.64);
      border-radius: 2px;
      background: rgba(10, 8, 6, 0.78);
      box-shadow:
        0 28px 80px rgba(0, 0, 0, 0.48),
        0 0 70px rgba(30, 42, 92, 0.14);
    }

    .verify-frame {
      padding: 44px 38px 36px;
      text-align: center;
    }

    .corner {
      position: absolute;
      width: 22px;
      height: 22px;
      pointer-events: none;
    }

    .corner-top-left {
      top: -1px;
      left: -1px;
      border-top: 2px solid #a57c1c;
      border-left: 2px solid #a57c1c;
    }

    .corner-top-right {
      top: -1px;
      right: -1px;
      border-top: 2px solid #a57c1c;
      border-right: 2px solid #a57c1c;
    }

    .corner-bottom-left {
      bottom: -1px;
      left: -1px;
      border-bottom: 2px solid #a57c1c;
      border-left: 2px solid #a57c1c;
    }

    .corner-bottom-right {
      right: -1px;
      bottom: -1px;
      border-right: 2px solid #a57c1c;
      border-bottom: 2px solid #a57c1c;
    }

    .eyebrow {
      margin: 0 0 8px;
      color: #a77c16;
      font-size: 13px;
      font-variant: small-caps;
    }

    h1 {
      margin: 0;
      color: #f4eadb;
      font-size: 52px;
      line-height: 0.95;
      font-weight: 700;
      text-shadow: 0 0 18px rgba(255, 236, 199, 0.12);
    }

    .subtitle {
      margin: 12px 0 0;
      color: #8d8173;
      font-size: 15px;
      font-style: italic;
    }

    .ornament {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 14px;
      margin: 28px 0 30px;
      color: #a57c1c;
    }

    .ornament::before,
    .ornament::after {
      height: 1px;
      content: "";
      background: linear-gradient(90deg, rgba(165, 124, 28, 0), rgba(165, 124, 28, 0.82));
    }

    .ornament::after {
      background: linear-gradient(90deg, rgba(165, 124, 28, 0.82), rgba(165, 124, 28, 0));
    }

    .link-flow {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 18px;
      margin-bottom: 24px;
    }

    .account-mark {
      display: grid;
      gap: 8px;
      justify-items: center;
      color: #9d7b27;
      font-size: 11px;
      font-family: Arial, Helvetica, sans-serif;
      text-transform: uppercase;
    }

    .account-icon {
      width: 64px;
      height: 64px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(165, 124, 28, 0.44);
      border-radius: 50%;
      background:
        radial-gradient(circle at 34% 28%, rgba(255, 239, 194, 0.22), rgba(255, 239, 194, 0) 28px),
        linear-gradient(135deg, #2b304f, #15110c 72%);
      color: #efe3cc;
      font-size: 28px;
      font-weight: 700;
      box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.34);
    }

    .account-icon.roblox {
      background:
        radial-gradient(circle at 36% 30%, rgba(255, 239, 194, 0.25), rgba(255, 239, 194, 0) 28px),
        linear-gradient(135deg, #643025, #15110c 72%);
    }

    .link-sigil {
      color: #a57c1c;
      font-size: 24px;
    }

    .verify-copy {
      max-width: 360px;
      margin: 0 auto 26px;
      color: #b7aa99;
      font-size: 15px;
    }

    .verify-button,
    .modal-button {
      display: inline-flex;
      min-height: 48px;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      text-transform: uppercase;
      cursor: pointer;
    }

    .verify-button {
      width: 100%;
      max-width: 360px;
      padding: 0 18px;
      background: #4354ad;
      color: #fff;
      box-shadow: 0 14px 34px rgba(67, 84, 173, 0.22);
    }

    .verify-button:hover {
      color: #fff;
      background: #5264c7;
    }

    .button-mark {
      width: 15px;
      height: 15px;
      margin-right: 10px;
      border: 2px solid currentColor;
      transform: rotate(12deg);
    }

    .legal-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px 18px;
      margin-top: 16px;
      color: #6f665c;
      font-size: 13px;
      font-style: italic;
    }

    .site-footer {
      display: flex;
      justify-content: center;
      gap: 18px;
      padding: 18px 24px;
      color: #4f473e;
      font-size: 12px;
    }

    .consent-modal {
      position: fixed;
      inset: 0;
      z-index: 5;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
    }

    .consent-modal[hidden] {
      display: none;
    }

    .modal-panel {
      width: min(560px, 100%);
      border: 1px solid rgba(165, 124, 28, 0.66);
      border-radius: 2px;
      background: rgba(11, 9, 7, 0.95);
      padding: 46px 44px 34px;
      text-align: center;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.58);
    }

    .modal-icon {
      margin: 0 auto 16px;
      color: #9a936b;
      font-size: 34px;
    }

    .modal-panel h2 {
      margin: 0 0 12px;
      color: #f4eadb;
      font-size: 27px;
      line-height: 1.15;
    }

    .modal-panel p {
      margin: 0 auto 22px;
      max-width: 420px;
      color: #afa393;
      font-size: 15px;
    }

    .modal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 28px;
    }

    .modal-button {
      width: 100%;
      color: #efe3cc;
      background: transparent;
      border-color: rgba(165, 124, 28, 0.44);
    }

    .modal-button.primary {
      background: #9c3d2e;
      border-color: #b75543;
      color: #fff;
    }

    .doc-main {
      align-items: flex-start;
    }

    .doc-frame {
      width: min(720px, 100%);
      padding: 34px 38px 42px;
    }

    .doc-tabs {
      display: flex;
      gap: 18px;
      border-bottom: 1px solid rgba(165, 124, 28, 0.34);
      margin-bottom: 28px;
      padding-bottom: 12px;
    }

    .doc-tab {
      min-width: 158px;
      padding: 9px 14px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: #6f665c;
      font-size: 13px;
      font-variant: small-caps;
      text-align: center;
      text-decoration: none;
    }

    .doc-tab.active {
      border-color: rgba(255, 255, 255, 0.9);
      color: #d6a824;
    }

    .effective-date {
      margin: 0 0 24px;
      color: #dbc9b5;
      font-size: 15px;
    }

    .legal-section {
      margin-top: 22px;
    }

    .legal-section h2 {
      margin: 0 0 8px;
      color: #a77c16;
      font-size: 18px;
      font-variant: small-caps;
      line-height: 1.25;
    }

    .legal-section p,
    .legal-section li {
      color: #eadfce;
      font-size: 16px;
    }

    .legal-section p {
      margin: 0 0 10px;
    }

    .legal-section ul {
      margin: 8px 0 0;
      padding-left: 21px;
    }

    .legal-note {
      margin-top: 26px;
      padding: 16px 0 16px 18px;
      border-left: 1px solid rgba(165, 124, 28, 0.64);
      color: #a79b8b;
      font-size: 15px;
      font-style: italic;
    }

    @media (prefers-reduced-motion: reduce) {
      .dust {
        animation: none;
      }
    }

    @media (max-width: 640px) {
      .topbar {
        padding: 0 18px;
      }

      .verify-main,
      .doc-main {
        padding: 42px 16px 36px;
      }

      .verify-frame {
        padding: 36px 22px 30px;
      }

      h1 {
        font-size: 42px;
      }

      .link-flow {
        gap: 10px;
      }

      .account-icon {
        width: 56px;
        height: 56px;
        font-size: 24px;
      }

      .doc-frame {
        padding: 26px 20px 34px;
      }

      .doc-tabs {
        gap: 8px;
      }

      .doc-tab {
        min-width: 0;
        flex: 1;
        font-size: 12px;
      }

      .modal-panel {
        padding: 36px 22px 28px;
      }

      .modal-actions {
        grid-template-columns: 1fr;
      }

      .site-footer {
        flex-wrap: wrap;
      }
    }

    /* Thornvale menu style */
    html {
      background: #070706;
    }

    body {
      background:
        linear-gradient(90deg, rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0.74)),
        linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0) 22%),
        repeating-linear-gradient(108deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 96px),
        radial-gradient(circle at 72% 26%, rgba(255, 255, 255, 0.07), transparent 22rem),
        #090806;
      color: rgba(255, 255, 255, 0.92);
    }

    body::before {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0) 130px),
        radial-gradient(circle at 28% 60%, rgba(255, 255, 255, 0.045), transparent 28rem);
    }

    a {
      color: rgba(255, 255, 255, 0.88);
      text-decoration-color: rgba(255, 255, 255, 0.38);
    }

    a:hover {
      color: #fff;
      text-decoration-color: rgba(255, 255, 255, 0.78);
    }

    .dust {
      background: rgba(255, 255, 255, 0.72);
      box-shadow: 0 0 16px rgba(255, 255, 255, 0.36);
      opacity: 0.22;
    }

    .topbar {
      min-height: 52px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.11);
      background: rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(6px);
    }

    .brand {
      color: rgba(255, 255, 255, 0.9);
      font-size: 20px;
      font-style: italic;
      font-variant: normal;
      font-weight: 400;
    }

    .status-pill {
      border: 0;
      color: rgba(255, 255, 255, 0.52);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 13px;
      text-transform: none;
    }

    .verify-main,
    .doc-main,
    .result-main {
      align-items: flex-start;
      justify-content: flex-start;
      padding: clamp(28px, 7vw, 72px) clamp(26px, 8vw, 92px) 54px;
    }

    .verify-frame,
    .doc-frame,
    .result-panel,
    .linked-panel {
      width: min(860px, 100%);
      border: 0;
      border-radius: 0;
      background: linear-gradient(90deg, rgba(0, 0, 0, 0.26), rgba(0, 0, 0, 0.05));
      box-shadow: none;
      text-align: left;
    }

    .verify-frame,
    .result-panel,
    .linked-panel {
      padding: 0;
    }

    .corner,
    .ornament,
    .link-sigil,
    .button-mark {
      display: none;
    }

    .eyebrow,
    .effective-date {
      color: rgba(255, 255, 255, 0.74);
      font-size: 18px;
      font-variant: normal;
    }

    h1 {
      color: rgba(255, 255, 255, 0.96);
      font-size: clamp(38px, 7vw, 62px);
      font-style: italic;
      font-weight: 400;
      line-height: 1;
      text-shadow: 0 2px 18px rgba(0, 0, 0, 0.72);
    }

    .subtitle {
      margin-top: 8px;
      color: rgba(255, 255, 255, 0.66);
      font-size: 17px;
    }

    .link-flow {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      width: min(720px, 100%);
      margin: 34px 0 26px;
      border-top: 1px solid rgba(255, 255, 255, 0.22);
    }

    .account-mark {
      min-height: 64px;
      display: grid;
      grid-template-columns: 52px 1fr;
      gap: 16px;
      align-items: center;
      justify-items: stretch;
      border-bottom: 1px solid rgba(255, 255, 255, 0.17);
      color: rgba(255, 255, 255, 0.88);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18px;
      text-transform: none;
    }

    .account-icon,
    .account-icon.roblox {
      width: auto;
      height: auto;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      color: rgba(255, 255, 255, 0.5);
      font-size: 18px;
      font-weight: 400;
    }

    .account-text {
      display: grid;
      gap: 2px;
    }

    .account-detail {
      color: rgba(255, 255, 255, 0.52);
      font-size: 13px;
    }

    .verify-copy,
    .result-message {
      max-width: 620px;
      margin: 0 0 26px;
      color: rgba(255, 255, 255, 0.66);
      font-size: 16px;
    }

    .linked-summary {
      width: min(720px, 100%);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin: 34px 0 26px;
      padding: 0 0 22px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.16);
    }

    .linked-account {
      display: grid;
      grid-template-columns: 58px 1fr;
      align-items: center;
      gap: 16px;
      min-width: 0;
    }

    .linked-avatar {
      width: 58px;
      height: 58px;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.32);
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.72);
      font-size: 18px;
      font-style: italic;
    }

    .linked-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .linked-label {
      display: block;
      color: rgba(255, 255, 255, 0.42);
      font-size: 13px;
    }

    .linked-name {
      display: block;
      overflow-wrap: anywhere;
      color: rgba(255, 255, 255, 0.9);
      font-size: 19px;
    }

    .linked-details {
      width: min(720px, 100%);
      margin: 0 0 30px;
      border-top: 1px solid rgba(255, 255, 255, 0.14);
    }

    .linked-row {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 18px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.66);
      font-size: 15px;
    }

    .linked-row strong {
      color: rgba(255, 255, 255, 0.78);
      font-weight: 400;
    }

    .verify-button,
    .modal-button,
    .result-action {
      min-height: 44px;
      border: 1px solid rgba(255, 255, 255, 0.36);
      border-radius: 0;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.92);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 15px;
      font-weight: 400;
      text-transform: none;
    }

    .verify-button,
    .result-action {
      width: min(360px, 100%);
      max-width: none;
      justify-content: flex-start;
      padding: 0 18px;
      box-shadow: none;
    }

    .verify-button:hover,
    .modal-button:hover,
    .result-action:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }

    .legal-links {
      justify-content: flex-start;
      color: rgba(255, 255, 255, 0.44);
    }

    .site-footer {
      justify-content: flex-start;
      padding: 18px clamp(26px, 8vw, 92px);
      color: rgba(255, 255, 255, 0.32);
    }

    .consent-modal {
      background: rgba(0, 0, 0, 0.72);
    }

    .modal-panel {
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 0;
      background: rgba(7, 7, 6, 0.92);
      text-align: left;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.56);
    }

    .modal-icon {
      display: none;
    }

    .modal-panel h2,
    .legal-section h2,
    .result-panel h1 {
      color: rgba(255, 255, 255, 0.92);
      font-style: normal;
      font-variant: normal;
      font-weight: 400;
    }

    .modal-panel p,
    .legal-section p,
    .legal-section li {
      color: rgba(255, 255, 255, 0.68);
    }

    .modal-actions {
      width: min(390px, 100%);
    }

    .modal-button.primary {
      border-color: rgba(255, 255, 255, 0.5);
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
    }

    .doc-frame {
      padding: 0;
    }

    .doc-tabs {
      width: min(620px, 100%);
      gap: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.18);
    }

    .doc-tab {
      min-width: 150px;
      border: 0;
      border-bottom: 1px solid transparent;
      border-radius: 0;
      color: rgba(255, 255, 255, 0.42);
      font-variant: normal;
      text-align: left;
    }

    .doc-tab.active {
      border-color: rgba(255, 255, 255, 0.84);
      color: rgba(255, 255, 255, 0.9);
    }

    .legal-section {
      width: min(720px, 100%);
      margin-top: 24px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .legal-note {
      width: min(720px, 100%);
      border-left-color: rgba(255, 255, 255, 0.32);
      color: rgba(255, 255, 255, 0.5);
    }

    @media (max-width: 640px) {
      .verify-main,
      .doc-main,
      .result-main {
        padding: 32px 22px 42px;
      }

      .verify-frame {
        padding: 0;
      }

      .topbar {
        padding: 0 22px;
      }

      .link-flow {
        margin-top: 26px;
      }

      .account-mark {
        grid-template-columns: 38px 1fr;
      }

      .linked-summary {
        grid-template-columns: 1fr;
      }

      .linked-row {
        grid-template-columns: 1fr;
        gap: 2px;
      }

      .site-footer {
        padding: 18px 22px;
      }
    }
  </style>
</head>
<body>
  <div class="dust-field" aria-hidden="true">${renderDustMotes()}</div>
  <div class="site-shell">
    <header class="topbar">
      <a class="brand" href="/oauth/roblox/start">Thornvale</a>
      <span class="status-pill">${escapeHtml(statusLabel)}</span>
    </header>
    ${body}
    <footer class="site-footer">
      <span>&copy; 2026 Thornvale</span>
      <a href="/terms">Terms & Conditions</a>
      <a href="/privacy">Privacy Policy</a>
    </footer>
  </div>
  ${scripts}
</body>
</html>`);
}

function renderVerifyPage(res) {
  const body = `
    <main class="verify-main">
      <section class="verify-frame" aria-labelledby="verify-title">
        <span class="corner corner-top-left" aria-hidden="true"></span>
        <span class="corner corner-top-right" aria-hidden="true"></span>
        <span class="corner corner-bottom-left" aria-hidden="true"></span>
        <span class="corner corner-bottom-right" aria-hidden="true"></span>
        <h1 id="verify-title">Thornvale Verification</h1>
        <p class="subtitle">Connect Discord first, then Roblox.</p>
        <div class="ornament" aria-hidden="true">&#9670;</div>
        <div class="link-flow" aria-label="Account link flow">
          <div class="account-mark">
            <span class="account-icon">01</span>
            <span class="account-text">
              <span>Discord Account</span>
              <span class="account-detail">Authorize your Discord identity through Discord OAuth.</span>
            </span>
          </div>
          <span class="link-sigil" aria-hidden="true">&#9670;</span>
          <div class="account-mark">
            <span class="account-icon roblox">02</span>
            <span class="account-text">
              <span>Roblox Account</span>
              <span class="account-detail">Approve Roblox profile access to finish the account link.</span>
            </span>
          </div>
        </div>
        <p class="verify-copy">Thornvale uses this link to verify account ownership, apply Discord access when available, and support account-linked game systems.</p>
        <a class="verify-button" href="/oauth/discord/start" data-consent-open>
          <span class="button-mark" aria-hidden="true"></span>
          Connect Discord
        </a>
        <nav class="legal-links" aria-label="Legal links">
          <a href="/terms">Terms & Conditions</a>
          <a href="/privacy">Privacy Policy</a>
        </nav>
      </section>
    </main>
    <div class="consent-modal" data-consent-modal hidden>
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <div class="modal-icon" aria-hidden="true">&#9651;</div>
        <h2 id="consent-title">Before You Verify</h2>
        <p>Please make sure you have read our <a href="/terms">Terms & Conditions</a> before continuing.</p>
        <p>By choosing I Agree, you consent to Thornvale collecting and using Discord and Roblox account information for verification.</p>
        <div class="modal-actions">
          <button class="modal-button" type="button" data-consent-close>Cancel</button>
          <a class="modal-button primary" href="/oauth/discord/start">I Agree</a>
        </div>
      </section>
    </div>`;

  const scripts = `
  <script>
    const consentModal = document.querySelector("[data-consent-modal]");
    const consentOpen = document.querySelector("[data-consent-open]");
    const consentClose = document.querySelector("[data-consent-close]");

    function closeConsent() {
      consentModal.hidden = true;
    }

    consentOpen.addEventListener("click", (event) => {
      event.preventDefault();
      consentModal.hidden = false;
      consentClose.focus();
    });

    consentClose.addEventListener("click", closeConsent);
    consentModal.addEventListener("click", (event) => {
      if (event.target === consentModal) {
        closeConsent();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !consentModal.hidden) {
        closeConsent();
      }
    });
  </script>`;

  renderBasePage(res, "Thornvale Verification", body, { scripts });
}

function renderResultPage(res, page) {
  const actionHref = page.actionHref || "/oauth/roblox/start";
  const actionText = page.actionText || "Return to Verification";
  const title = escapeHtml(page.title);
  const message = escapeHtml(page.message);
  const statusLabel = /complete|linked|success/i.test(page.title) ? "Verified" : "Not Verified";
  const body = `
    <main class="result-main">
      <section class="result-panel" aria-labelledby="result-title">
        <p class="eyebrow">Verification</p>
        <h1 id="result-title">${title}</h1>
        <p class="result-message">${message}</p>
        <a class="result-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionText)}</a>
      </section>
    </main>`;

  renderBasePage(res, title, body, {
    statusCode: page.statusCode || 200,
    statusLabel,
  });
}

function formatLinkedDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getRobloxAvatarUrl(record) {
  const robloxUserId = record?.robloxUserId ? encodeURIComponent(record.robloxUserId) : "";
  return robloxUserId
    ? `https://www.roblox.com/headshot-thumbnail/image?userId=${robloxUserId}&width=150&height=150&format=png`
    : "";
}

function renderAvatar(label, url, fallback) {
  const safeLabel = escapeHtml(label);
  if (url) {
    return `<span class="linked-avatar"><img src="${escapeHtml(url)}" alt="${safeLabel} avatar"></span>`;
  }

  return `<span class="linked-avatar" aria-hidden="true">${escapeHtml(fallback)}</span>`;
}

function renderLinkedAccountPage(res, page) {
  const record = page.record || {};
  const discordIdentity = page.discordIdentity || {};
  const discordName = discordIdentity.displayName || discordIdentity.tag || record.discordId || "Discord";
  const robloxName = record.robloxDisplayName || record.robloxUsername || record.robloxUserId || "Roblox";
  const robloxUsername = record.robloxUsername || robloxName;
  const message = page.message || "Your Thornvale accounts are already linked.";
  const body = `
    <main class="result-main">
      <section class="linked-panel" aria-labelledby="linked-title">
        <p class="eyebrow">Verification Complete</p>
        <h1 id="linked-title">Welcome Back</h1>
        <p class="subtitle">fully linked</p>
        <div class="linked-summary" aria-label="Linked accounts">
          <div class="linked-account">
            ${renderAvatar(discordName, discordIdentity.avatarUrl, "D")}
            <span>
              <span class="linked-label">Discord</span>
              <span class="linked-name">${escapeHtml(discordName)}</span>
            </span>
          </div>
          <div class="linked-account">
            ${renderAvatar(robloxName, getRobloxAvatarUrl(record), "R")}
            <span>
              <span class="linked-label">Roblox</span>
              <span class="linked-name">${escapeHtml(robloxName)}</span>
            </span>
          </div>
        </div>
        <p class="result-message">${escapeHtml(message)}</p>
        <div class="linked-details">
          <div class="linked-row"><strong>Discord ID</strong><span>${escapeHtml(record.discordId || discordIdentity.id || "")}</span></div>
          <div class="linked-row"><strong>Roblox ID</strong><span>${escapeHtml(record.robloxUserId || "")}</span></div>
          <div class="linked-row"><strong>Roblox Username</strong><span>${escapeHtml(robloxUsername)}</span></div>
          <div class="linked-row"><strong>Linked</strong><span>${escapeHtml(formatLinkedDate(record.verifiedAt))}</span></div>
        </div>
        <a class="result-action" href="/oauth/roblox/start">Return</a>
      </section>
    </main>`;

  renderBasePage(res, "Welcome Back", body, {
    statusCode: page.statusCode || 200,
    statusLabel: "Verified",
  });
}

function renderLegalSections(sections) {
  return sections
    .map((section, index) => `
      <section class="legal-section">
        <h2>${index + 1}. ${section.heading}</h2>
        ${section.body}
      </section>`)
    .join("");
}

function renderLegalPage(res, page) {
  const sections = renderLegalSections(page.sections);
  const body = `
    <main class="doc-main">
      <article class="doc-frame">
        <span class="corner corner-top-left" aria-hidden="true"></span>
        <span class="corner corner-top-right" aria-hidden="true"></span>
        <span class="corner corner-bottom-left" aria-hidden="true"></span>
        <span class="corner corner-bottom-right" aria-hidden="true"></span>
        <nav class="doc-tabs" aria-label="Legal pages">
          <a class="doc-tab ${page.active === "privacy" ? "active" : ""}" href="/privacy">Privacy Policy</a>
          <a class="doc-tab ${page.active === "terms" ? "active" : ""}" href="/terms">Terms of Service</a>
        </nav>
        <p class="effective-date">Effective Date: ${LEGAL_EFFECTIVE_DATE}</p>
        ${sections}
        <p class="legal-note">${page.note}</p>
      </article>
    </main>`;

  renderBasePage(res, page.title, body);
}

app.get("/", (req, res) => {
  renderVerifyPage(res);
});

app.get("/oauth/roblox/start", (req, res) => {
  renderVerifyPage(res);
});

app.get("/oauth/discord/start", async (req, res) => {
  if (!isDiscordOAuthConfigured()) {
    return sendOAuthHtml(
      res,
      "Discord Setup Needed",
      "Discord OAuth is not configured yet. Add the Discord redirect URL and set the Discord OAuth client ID and secret before using this public account-linking flow.",
      503
    );
  }

  if (!isRobloxOAuthConfigured()) {
    return sendOAuthHtml(
      res,
      "Verification Unavailable",
      "Roblox OAuth is not configured yet. Please try again later.",
      503
    );
  }

  try {
    return res.redirect(await createDiscordAuthorizationUrl());
  } catch (err) {
    console.error("Discord OAuth start error:", err);
    return sendOAuthHtml(
      res,
      "Verification Unavailable",
      "Something went wrong while starting Discord verification. Please try again.",
      500
    );
  }
});

app.get("/oauth/discord/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query || {};
  if (error) {
    return sendOAuthHtml(
      res,
      "Verification Cancelled",
      String(errorDescription || error || "Discord authorization was cancelled."),
      400
    );
  }

  if (typeof code !== "string" || typeof state !== "string") {
    return sendOAuthHtml(res, "Verification Failed", "Missing Discord OAuth callback data.", 400);
  }

  const session = await verificationDb.consumeDiscordOAuthSession(state);
  if (!session) {
    return sendOAuthHtml(res, "Verification Expired", "That Discord verification link expired. Please start again.", 400);
  }

  try {
    const tokenPayload = await exchangeDiscordOAuthCode(code);
    const userInfo = await fetchDiscordUserInfo(tokenPayload.access_token);
    const discordIdentity = getDiscordIdentity(userInfo);
    if (!discordIdentity) {
      return sendOAuthHtml(res, "Verification Failed", "Discord did not return a usable user id.", 400);
    }

    const member = await fetchThornvaleMember(discordIdentity.id);
    const existingLink = await verificationDb.getVerificationByDiscordId(discordIdentity.id);
    if (existingLink) {
      await ensureVerifiedRole(member);

      return renderLinkedAccountPage(res, {
        discordIdentity,
        record: existingLink,
        message: "Your Discord and Roblox accounts are already linked for Thornvale.",
      });
    }

    const linkedIdentity = member
      ? discordIdentity
      : getPublicReviewDiscordIdentity(discordIdentity);

    return res.redirect(await createRobloxAuthorizationUrlForDiscord(linkedIdentity));
  } catch (err) {
    console.error("Discord OAuth verification error:", err);
    return sendOAuthHtml(res, "Verification Failed", "Something went wrong while verifying your Discord account. Please try again.", 500);
  }
});

app.get("/oauth/roblox/start/continue", async (req, res) => {
  if (!isRobloxOAuthConfigured()) {
    return sendOAuthHtml(
      res,
      "Verification Unavailable",
      "Roblox OAuth is not configured yet. Please try again later.",
      503
    );
  }

  try {
    return res.redirect(await createRobloxReviewAuthorizationUrl());
  } catch (err) {
    console.error("Roblox OAuth review start error:", err);
    return sendOAuthHtml(
      res,
      "Verification Unavailable",
      "Something went wrong while starting Roblox OAuth verification. Please try again.",
      500
    );
  }
});

app.get("/privacy", (req, res) => {
  renderLegalPage(res, {
    title: "Thornvale Privacy Policy",
    active: "privacy",
    note: "By verifying your account, you acknowledge and consent to this Privacy Policy.",
    sections: [
      {
        heading: "Overview",
        body: "<p>Thornvale Verification is a Discord and Roblox account-linking service used to confirm members, unlock verified access, and support account-linked game systems.</p>",
      },
      {
        heading: "Information We Collect",
        body: "<ul><li>Discord data: user ID, username, display name, and avatar when available.</li><li>Roblox data: user ID, username, display name, and OAuth verification result.</li><li>Verification data: linked account IDs, verification timestamps, role-sync state, and last in-game activity timestamps.</li></ul><p>We do not collect passwords or payment information.</p>",
      },
      {
        heading: "How We Use Your Data",
        body: "<p>We use linked account information to apply verified roles, support account recovery, manage role sync, assist moderation, and connect Roblox game systems with the Thornvale Discord community.</p>",
      },
      {
        heading: "Data Retention",
        body: "<p>We retain verification records while your account remains linked or while they are needed for Thornvale moderation, security, or game functionality. You may request unlinking through Thornvale staff.</p>",
      },
      {
        heading: "Data Security",
        body: "<p>Verification data is stored on secured systems and is accessible only to authorized Thornvale systems and staff members who need it for account verification, support, or moderation.</p>",
      },
      {
        heading: "Sharing and Disclosure",
        body: "<p>We do not sell your data. Account-linking data may be used internally by Thornvale staff and systems for verification, moderation, and game integration.</p>",
      },
      {
        heading: "Your Rights",
        body: "<p>You may request unlinking or deletion of your verification record by opening a support request with Thornvale staff. Some moderation records may be retained when needed for security or rule enforcement.</p>",
      },
      {
        heading: "Compliance",
        body: "<p>We operate this service to support Thornvale account verification and follow applicable United States privacy and platform requirements.</p>",
      },
    ],
  });
});

app.get("/terms", (req, res) => {
  renderLegalPage(res, {
    title: "Thornvale Terms of Service",
    active: "terms",
    note: "By linking your account, you agree to these Terms of Service.",
    sections: [
      {
        heading: "Acceptance",
        body: "<p>By using Thornvale Verification or linking your Discord and Roblox accounts, you agree to these Terms of Service.</p>",
      },
      {
        heading: "Service Description",
        body: "<p>Thornvale Verification links your Discord account with your Roblox account to enable verified access, role sync, account support, moderation tools, and related game functionality.</p>",
      },
      {
        heading: "User Responsibilities",
        body: "<ul><li>Follow Discord's Terms of Service and Roblox's Terms of Use.</li><li>Provide accurate account information when linking accounts.</li><li>Do not abuse, exploit, bypass, impersonate, or interfere with the verification system.</li></ul>",
      },
      {
        heading: "Suspension and Revocation",
        body: "<p>Thornvale staff may unlink accounts, suspend verification, revoke roles, or restrict access if needed for moderation, security, abuse prevention, or rule enforcement.</p>",
      },
      {
        heading: "No Warranty",
        body: "<p>This service is provided as-is without warranties of any kind. Thornvale may change, pause, or remove the verification system as its game and community systems evolve.</p>",
      },
      {
        heading: "Governing Law",
        body: "<p>These Terms are governed by the laws of the United States of America, without regard to conflict of law principles.</p>",
      },
      {
        heading: "Contact",
        body: "<p>For questions about these Terms, contact Thornvale staff through the Thornvale Discord server.</p>",
      },
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});




