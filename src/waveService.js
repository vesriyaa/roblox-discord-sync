const crypto = require("crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { buildDiscordMessageUrl } = require("./utils");

const WAVE_COLOR = 0x2fb8df;
const CLOSED_COLOR = 0xe74c3c;
const APPLY_PREFIX = "wave|apply|";
const SUBMIT_PREFIX = "wave|submit|";
const REVIEW_PREFIX = "wave|review|";
const MIN_WAVE_DURATION_MS = 60_000;
const MAX_WAVE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const DURATION_UNIT_MS = Object.freeze({
  s: 1000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
});

function createWaveId() {
  return `TV-WAVE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function parseWaveDuration(value) {
  const input = String(value ?? "").trim().toLowerCase();
  if (!input) return null;

  let durationMs = 0;
  if (/^\d+$/.test(input)) {
    durationMs = Number(input) * DURATION_UNIT_MS.m;
  } else {
    const compact = input.replace(/\s+/g, "");
    const componentPattern = /(\d+)([wdhms])/g;
    let cursor = 0;
    let match;
    while ((match = componentPattern.exec(compact)) !== null) {
      if (match.index !== cursor) return null;
      durationMs += Number(match[1]) * DURATION_UNIT_MS[match[2]];
      cursor = componentPattern.lastIndex;
    }
    if (cursor !== compact.length) return null;
  }

  if (!Number.isSafeInteger(durationMs)) return null;
  if (durationMs < MIN_WAVE_DURATION_MS || durationMs > MAX_WAVE_DURATION_MS) return null;
  return durationMs;
}

function parseRobloxIdentity(value) {
  const input = String(value || "").trim();
  const idMatch = input.match(/\b\d{1,20}\b/);
  if (!idMatch) {
    return null;
  }
  const withoutId = input
    .replace(idMatch[0], " ")
    .replace(/\b(?:roblox|username|userid|user|id|and)\b/gi, " ")
    .replace(/[():,|\-]+/g, " ");
  const usernameMatch = withoutId.match(/\b[A-Za-z0-9_]{3,20}\b/);
  if (!usernameMatch) {
    return null;
  }
  return { robloxUsername: usernameMatch[0], robloxUserId: idMatch[0] };
}

function isMatchingVerification(identity, verification) {
  return Boolean(
    identity
    && verification?.verified
    && identity.robloxUserId === String(verification.robloxUserId || "")
    && identity.robloxUsername.toLowerCase() === String(verification.robloxUsername || "").toLowerCase()
  );
}

function getCloseDescription(reason) {
  if (reason === "capacity") {
    return "This Thornvale wave closed automatically because the application limit was reached.";
  }
  if (reason === "manual") {
    return "This Thornvale application wave was closed by staff.";
  }
  if (reason === "setup_failed") {
    return "This Thornvale application wave could not be opened.";
  }
  return "This Thornvale application wave has automatically closed.";
}

function buildWavePayload(session) {
  const open = session.status === "open";
  const endsAtUnix = Math.floor(new Date(session.endsAt).getTime() / 1000);
  const applicationsLeft = Math.max(0, session.applicationLimit - session.applicationCount);
  const embed = new EmbedBuilder()
    .setTitle(open ? "Thornvale Wave Applications" : "Thornvale Wave Applications — CLOSED")
    .setDescription(open
      ? "Thornvale is accepting new applicants. Select the button below and complete the application to request entry. You must connect your Roblox account with `/verify` first."
      : getCloseDescription(session.closeReason))
    .setColor(open ? WAVE_COLOR : CLOSED_COLOR)
    .addFields(
      { name: "⏳ Ends", value: `<t:${endsAtUnix}:R>`, inline: true },
      { name: "📜 Applications Left", value: String(applicationsLeft), inline: true }
    )
    .setFooter({ text: `Thornvale Wave • ${session.id}` })
    .setTimestamp(new Date(session.createdAt));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPLY_PREFIX}${session.id}`)
      .setLabel(open ? "Apply to Thornvale" : "Applications Closed")
      .setStyle(open ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!open)
  );

  return { embeds: [embed], components: [row] };
}

function buildApplicationModal(session, verification) {
  const identity = new TextInputBuilder()
    .setCustomId("roblox_identity")
    .setLabel("Roblox Username AND User ID")
    .setStyle(TextInputStyle.Short)
    .setMinLength(5)
    .setMaxLength(100)
    .setRequired(true);
  if (verification?.robloxUsername && verification?.robloxUserId) {
    identity.setValue(`${verification.robloxUsername} (${verification.robloxUserId})`);
  }

  return new ModalBuilder()
    .setCustomId(`${SUBMIT_PREFIX}${session.id}`)
    .setTitle("Apply to Thornvale")
    .addComponents(
      new ActionRowBuilder().addComponents(identity),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("candidate_answer")
          .setLabel("What makes you a good candidate?")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(20)
          .setMaxLength(1000)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("discovery_answer")
          .setLabel("How did you find out about Thornvale?")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(3)
          .setMaxLength(500)
          .setRequired(true)
      )
    );
}

function buildApplicationReviewPayload(session, application) {
  const statusLabels = {
    pending: "Pending Staff Review",
    processing: "Review In Progress",
    accepted: "Accepted",
    denied: "Denied",
  };
  const statusColors = {
    pending: 0xf1c40f,
    processing: 0x3498db,
    accepted: 0x2ecc71,
    denied: 0xe74c3c,
  };
  const status = application.status || "pending";
  const actionable = status === "pending";
  const fields = [
    { name: "Applicant", value: `<@${application.discordId}> (${application.discordId})`, inline: false },
    { name: "Roblox", value: `${application.robloxUsername} (${application.robloxUserId})`, inline: false },
    { name: "What makes you a good candidate?", value: application.candidateAnswer.slice(0, 1024), inline: false },
    { name: "How did you find out about Thornvale?", value: application.discoveryAnswer.slice(0, 1024), inline: false },
    { name: "Review Status", value: statusLabels[status] || status, inline: false },
  ];
  if (application.statusMessage) {
    fields.push({ name: "Review Details", value: application.statusMessage.slice(0, 1024), inline: false });
  }
  if (application.reviewerDiscordId) {
    fields.push({ name: "Reviewed By", value: `<@${application.reviewerDiscordId}>`, inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Thornvale Wave Application — ${statusLabels[status] || status}`)
    .setColor(statusColors[status] || 0x95a5a6)
    .addFields(fields)
    .setFooter({ text: `Thornvale Wave • ${session.id} • Application ${application.id}` })
    .setTimestamp(new Date(application.updatedAt || application.createdAt || Date.now()));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REVIEW_PREFIX}accept|${application.id}`)
      .setLabel("Accept Application")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!actionable),
    new ButtonBuilder()
      .setCustomId(`${REVIEW_PREFIX}deny|${application.id}`)
      .setLabel("Deny Application")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!actionable)
  );

  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function createWaveService({
  client,
  store,
  verificationService,
  robloxGroupUrl = "",
  canReviewInteraction = async () => false,
  logger = console,
}) {
  if (!client || !store || !verificationService) {
    throw new TypeError("client, store, and verificationService are required");
  }

  const timers = new Map();

  async function editSessionMessage(session) {
    if (!session?.channelId || !session?.messageId) return;
    try {
      const channel = await client.channels.fetch(session.channelId);
      const message = await channel?.messages?.fetch(session.messageId);
      if (message) {
        await message.edit(buildWavePayload(session));
      }
    } catch (err) {
      logger.error(`Wave ${session.id} message update failed:`, err);
    }
  }

  function clearTimer(waveId) {
    const timer = timers.get(waveId);
    if (timer) clearTimeout(timer);
    timers.delete(waveId);
  }

  function scheduleClose(session) {
    clearTimer(session.id);
    if (session.status !== "open") return;
    const remaining = new Date(session.endsAt).getTime() - Date.now();
    const timer = setTimeout(async () => {
      try {
        const current = await store.getSession(session.id);
        if (!current || current.status !== "open") return;
        const closed = await store.closeSession(session.id, "time");
        await editSessionMessage(closed || current);
      } catch (err) {
        logger.error(`Wave ${session.id} automatic close failed:`, err);
      } finally {
        timers.delete(session.id);
      }
    }, Math.max(0, remaining));
    timer.unref?.();
    timers.set(session.id, timer);
  }

  async function reconcileSession(session) {
    if (!session) return null;
    if (session.status === "open" && new Date(session.endsAt).getTime() <= Date.now()) {
      const closed = await store.closeSession(session.id, "time");
      const result = closed || await store.getSession(session.id);
      await editSessionMessage(result);
      clearTimer(session.id);
      return result;
    }
    return session;
  }

  async function createApplicantThread(session, application) {
    try {
      const channel = await client.channels.fetch(session.channelId);
      if (channel?.type !== ChannelType.GuildText || typeof channel.threads?.create !== "function") {
        return null;
      }
      const thread = await channel.threads.create({
        name: `application-${application.robloxUsername}-${application.id.slice(-6)}`.slice(0, 100),
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Private Thornvale wave result for ${application.id}`,
      });
      await thread.members.add(application.discordId);
      const groupInstruction = robloxGroupUrl
        ? ` Before access can be completed, [request to join the Roblox group](${robloxGroupUrl}). If staff accept your application, run \`/verifygroup\` afterward.`
        : " Before access can be completed, request to join the Roblox group. If staff accept your application, run `/verifygroup` afterward.";
      await thread.send({
        content: `<@${application.discordId}> your Thornvale application was submitted and is waiting for staff review. Your result will be posted privately here.${groupInstruction}`,
        allowedMentions: { users: [application.discordId] },
      });
      return thread;
    } catch (err) {
      logger.error(`Wave ${session.id} private applicant thread failed:`, err);
      return null;
    }
  }

  async function notifyApplicant(application, content) {
    if (application.applicantThreadId) {
      try {
        const thread = await client.channels.fetch(application.applicantThreadId);
        if (thread?.archived && typeof thread.setArchived === "function") {
          await thread.setArchived(false, "Posting Thornvale application result");
        }
        if (thread && typeof thread.send === "function") {
          await thread.send({
            content: `<@${application.discordId}> ${content}`,
            allowedMentions: { users: [application.discordId] },
          });
          return "private thread";
        }
      } catch (err) {
        logger.error(`Application ${application.id} private result notification failed:`, err);
      }
    }

    try {
      const user = await client.users?.fetch?.(application.discordId);
      if (user && typeof user.send === "function") {
        await user.send({ content });
        return "DM";
      }
    } catch (err) {
      logger.error(`Application ${application.id} DM result notification failed:`, err);
    }
    return null;
  }

  async function sendReview(session, application) {
    const channel = await client.channels.fetch(session.reviewChannelId);
    if (!channel || typeof channel.send !== "function") return null;
    return channel.send(buildApplicationReviewPayload(session, application));
  }

  async function handleCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "start") {
      let existing = await store.findOpenSession(interaction.guildId);
      existing = await reconcileSession(existing);
      if (existing?.status === "open") {
        const existingUrl = existing.messageId
          ? buildDiscordMessageUrl(existing.channelId, existing.messageId)
          : "";
        return interaction.editReply(
          `A Thornvale wave is already open (${existing.id}).${existingUrl ? ` ${existingUrl}` : ""}`
        );
      }

      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const reviewChannel = interaction.options.getChannel("reviewchannel", true);
      if (!channel || typeof channel.send !== "function") {
        return interaction.editReply("The selected application channel cannot receive messages.");
      }
      if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply(
          "Choose a standard text channel so each applicant can receive their result in a private thread."
        );
      }
      if (!reviewChannel || typeof reviewChannel.send !== "function") {
        return interaction.editReply("The selected review channel cannot receive messages.");
      }

      const durationInput = interaction.options.getString("duration", true);
      const durationMs = parseWaveDuration(durationInput);
      if (durationMs === null) {
        return interaction.editReply(
          "Enter a duration from 1 minute to 7 days, such as `30m`, `1h`, `1d`, or `1h30m`. Plain numbers are treated as minutes."
        );
      }
      const applicationLimit = interaction.options.getInteger("limit", true);
      const session = await store.createSession({
        id: createWaveId(),
        guildId: interaction.guildId,
        channelId: channel.id,
        reviewChannelId: reviewChannel.id,
        createdByDiscordId: interaction.user.id,
        createdAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + durationMs).toISOString(),
        applicationLimit,
      });

      try {
        const message = await channel.send(buildWavePayload(session));
        const saved = await store.updateMessage(session.id, message.id);
        scheduleClose(saved);
        const messageUrl = buildDiscordMessageUrl(message.channelId, message.id);
        return interaction.editReply(`Thornvale wave ${session.id} opened.${messageUrl ? ` ${messageUrl}` : ""}`);
      } catch (err) {
        await store.closeSession(session.id, "setup_failed").catch(() => {});
        throw err;
      }
    }

    let session;
    const requestedId = interaction.options.getString("waveid")?.trim();
    session = requestedId
      ? await store.getSession(requestedId)
      : await store.findOpenSession(interaction.guildId);
    session = await reconcileSession(session);
    if (!session) {
      return interaction.editReply("No matching Thornvale wave was found.");
    }

    if (subcommand === "status") {
      const applicationsLeft = Math.max(0, session.applicationLimit - session.applicationCount);
      const messageUrl = session.messageId
        ? buildDiscordMessageUrl(session.channelId, session.messageId)
        : "";
      return interaction.editReply(
        `Wave ${session.id} is **${session.status}** with ${applicationsLeft} of ${session.applicationLimit} applications left.${messageUrl ? ` ${messageUrl}` : ""}`
      );
    }

    if (session.status !== "open") {
      return interaction.editReply(`Wave ${session.id} is already closed.`);
    }
    const closed = await store.closeSession(session.id, "manual");
    clearTimer(session.id);
    await editSessionMessage(closed);
    return interaction.editReply(`Thornvale wave ${session.id} closed.`);
  }

  async function updateReviewMessage(interaction, session, application) {
    if (!interaction.message || typeof interaction.message.edit !== "function") return;
    await interaction.message.edit(buildApplicationReviewPayload(session, application));
  }

  async function handleReviewButton(interaction) {
    const parts = interaction.customId.slice(REVIEW_PREFIX.length).split("|");
    const decision = parts[0];
    const applicationId = parts.slice(1).join("|");
    await interaction.deferReply({ ephemeral: true });

    if (!new Set(["accept", "deny"]).has(decision) || !applicationId) {
      await interaction.editReply("That Thornvale application action is invalid.");
      return true;
    }
    if (!await canReviewInteraction(interaction)) {
      await interaction.editReply("You do not have permission to review Thornvale applications.");
      return true;
    }

    const claimed = await store.claimApplication(applicationId, interaction.user.id);
    if (!claimed.ok) {
      const existingStatus = claimed.application?.status;
      const statusText = existingStatus
        ? `This application is already **${existingStatus}**.`
        : "This application could not be found.";
      await interaction.editReply(statusText);
      return true;
    }

    let application = claimed.application;
    const session = await store.getSession(application.waveId) || { id: application.waveId };

    if (decision === "deny") {
      application = await store.updateApplicationStatus(
        application.id,
        "denied",
        "Denied by Thornvale staff.",
        interaction.user.id
      );
      await updateReviewMessage(interaction, session, application).catch((err) => {
        logger.error(`Application ${application.id} review message update failed:`, err);
      });
      const deliveredBy = await notifyApplicant(
        application,
        "Your Thornvale application was denied by staff."
      );
      await interaction.editReply(
        `Application ${application.id} denied.${deliveredBy ? ` The applicant was notified by ${deliveredBy}.` : " The applicant could not be notified."}`
      );
      return true;
    }

    try {
      const verification = await verificationService.lookup({ discordId: application.discordId });
      if (!verification.verified || String(verification.robloxUserId) !== application.robloxUserId) {
        throw new Error("The applicant's Roblox verification no longer matches this application.");
      }

      application = await store.updateApplicationStatus(
        application.id,
        "accepted",
        "Accepted by Thornvale staff. Applicant must complete Roblox group access with /verifygroup.",
        interaction.user.id
      );
      await updateReviewMessage(interaction, session, application).catch((err) => {
        logger.error(`Application ${application.id} review message update failed:`, err);
      });
      const deliveredBy = await notifyApplicant(
        application,
        robloxGroupUrl
          ? `Your Thornvale application was accepted. [Request to join the Roblox group](${robloxGroupUrl}), then run \`/verifygroup\` to complete access.`
          : "Your Thornvale application was accepted. Request to join the Roblox group, then run `/verifygroup` to complete access."
      );
      await interaction.editReply(
        `Application ${application.id} accepted.${deliveredBy ? ` The applicant was notified by ${deliveredBy}.` : " The applicant could not be notified."}`
      );
    } catch (err) {
      const detail = String(err?.message || err).slice(0, 800);
      logger.error(`Application ${application.id} acceptance failed:`, err);
      application = await store.updateApplicationStatus(
        application.id,
        "pending",
        `Acceptance attempt failed: ${detail}`,
        null
      );
      await updateReviewMessage(interaction, session, application).catch(() => {});
      await interaction.editReply(
        `Could not accept application ${application.id}: ${detail}. It remains pending so staff can retry or deny it.`
      );
    }
    return true;
  }

  async function handleButton(interaction) {
    const customId = String(interaction.customId || "");
    if (customId.startsWith(REVIEW_PREFIX)) {
      return handleReviewButton(interaction);
    }
    if (!customId.startsWith(APPLY_PREFIX)) return false;
    const waveId = customId.slice(APPLY_PREFIX.length);
    let session = await store.getSession(waveId);
    session = await reconcileSession(session);
    if (!session || session.status !== "open") {
      await interaction.reply({ content: "This Thornvale application wave is closed.", ephemeral: true });
      return true;
    }

    const verification = await verificationService.lookup({ discordId: interaction.user.id });
    if (!verification.verified) {
      await interaction.reply({
        content: "Connect your Roblox account with `/verify` before applying to Thornvale.",
        ephemeral: true,
      });
      return true;
    }
    await interaction.showModal(buildApplicationModal(session, verification));
    return true;
  }

  async function handleModal(interaction) {
    if (!String(interaction.customId || "").startsWith(SUBMIT_PREFIX)) return false;
    await interaction.deferReply({ ephemeral: true });
    const waveId = interaction.customId.slice(SUBMIT_PREFIX.length);
    let session = await store.getSession(waveId);
    session = await reconcileSession(session);
    if (!session || session.status !== "open") {
      await interaction.editReply("This Thornvale application wave is closed.");
      return true;
    }

    const verification = await verificationService.lookup({ discordId: interaction.user.id });
    if (!verification.verified) {
      await interaction.editReply("Your Roblox verification is missing. Run `/verify`, then apply again.");
      return true;
    }

    const identity = parseRobloxIdentity(interaction.fields.getTextInputValue("roblox_identity"));
    if (!isMatchingVerification(identity, verification)) {
      await interaction.editReply(
        "The Roblox username and User ID must match the account connected through `/verify`."
      );
      return true;
    }

    const application = {
      id: `TV-APP-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      waveId,
      discordId: interaction.user.id,
      robloxUserId: verification.robloxUserId,
      robloxUsername: verification.robloxUsername,
      candidateAnswer: interaction.fields.getTextInputValue("candidate_answer").trim(),
      discoveryAnswer: interaction.fields.getTextInputValue("discovery_answer").trim(),
    };
    const reserved = await store.reserveApplication(application);
    if (!reserved.ok) {
      const messages = {
        ALREADY_APPLIED: "You have already submitted an application for this wave.",
        WAVE_FULL: "This Thornvale wave has reached its application limit.",
        WAVE_CLOSED: "This Thornvale application wave is closed.",
        WAVE_NOT_FOUND: "This Thornvale application wave no longer exists.",
      };
      if (reserved.session) await editSessionMessage(reserved.session);
      await interaction.editReply(messages[reserved.code] || "Your application could not be reserved.");
      return true;
    }

    session = reserved.session;
    await editSessionMessage(session);
    if (session.status !== "open") clearTimer(session.id);

    let pendingApplication = reserved.application;
    const applicantThread = await createApplicantThread(session, pendingApplication);
    if (applicantThread) {
      pendingApplication = await store.updateApplicationContext(pendingApplication.id, {
        applicantThreadId: applicantThread.id,
      });
    } else {
      const groupInstruction = robloxGroupUrl
        ? ` Request to join the Roblox group: ${robloxGroupUrl}. If staff accept your application, run \`/verifygroup\` afterward.`
        : " Request to join the Roblox group. If staff accept your application, run `/verifygroup` afterward.";
      await interaction.user.send({
        content: `Your Thornvale application was submitted and is waiting for staff review. Your result will be sent privately here.${groupInstruction}`,
      }).catch(() => {});
    }

    try {
      await sendReview(session, pendingApplication);
    } catch (err) {
      logger.error(`Wave ${session.id} review queue delivery failed:`, err);
      await store.updateApplicationStatus(
        pendingApplication.id,
        "pending",
        `Review queue delivery failed: ${String(err?.message || err).slice(0, 500)}`
      );
      await interaction.editReply(
        "Your application was saved, but the staff review message could not be posted. Please contact Thornvale staff with your application ID: "
        + `\`${pendingApplication.id}\`.`
      );
      return true;
    }

    const privateLocation = applicantThread ? ` You can follow its private status in <#${applicantThread.id}>.` : "";
    await interaction.editReply(
      `Your Thornvale application was submitted for staff review.${privateLocation}`
    );
    return true;
  }

  async function init() {
    await store.init();
    const sessions = await store.listOpenSessions();
    for (const session of sessions) {
      const current = await reconcileSession(session);
      if (current?.status === "open") scheduleClose(current);
    }
    logger.log(`Wave system ready (${store.type}); restored ${sessions.length} open session(s).`);
  }

  return {
    handleButton,
    handleCommand,
    handleModal,
    init,
  };
}

module.exports = {
  buildApplicationReviewPayload,
  buildWavePayload,
  createWaveService,
  isMatchingVerification,
  parseWaveDuration,
  parseRobloxIdentity,
};
