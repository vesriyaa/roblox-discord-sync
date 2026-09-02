const crypto = require("crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

function createWaveId() {
  return `TV-WAVE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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

function createWaveService({
  client,
  store,
  verificationService,
  robloxGroupService,
  onAcceptedMember,
  logger = console,
}) {
  if (!client || !store || !verificationService || !robloxGroupService) {
    throw new TypeError("client, store, verificationService, and robloxGroupService are required");
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

  async function sendReview(session, interaction, application, verification, outcome) {
    try {
      const channel = await client.channels.fetch(session.reviewChannelId);
      if (!channel || typeof channel.send !== "function") return;
      const accepted = outcome.status === "accepted";
      const embed = new EmbedBuilder()
        .setTitle(`Thornvale Wave Application — ${accepted ? "Accepted" : "Needs Attention"}`)
        .setColor(accepted ? 0x2ecc71 : 0xe67e22)
        .addFields(
          { name: "Applicant", value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
          { name: "Roblox", value: `${verification.robloxUsername} (${verification.robloxUserId})`, inline: false },
          { name: "What makes you a good candidate?", value: application.candidateAnswer.slice(0, 1024), inline: false },
          { name: "How did you find out about Thornvale?", value: application.discoveryAnswer.slice(0, 1024), inline: false },
          { name: "Automation Result", value: outcome.message.slice(0, 1024), inline: false }
        )
        .setFooter({ text: `Thornvale Wave • ${session.id} • Application ${application.id}` })
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      logger.error(`Wave ${session.id} review log failed:`, err);
    }
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
      if (!reviewChannel || typeof reviewChannel.send !== "function") {
        return interaction.editReply("The selected review channel cannot receive messages.");
      }

      const durationMinutes = interaction.options.getInteger("duration", true);
      const applicationLimit = interaction.options.getInteger("limit", true);
      const session = await store.createSession({
        id: createWaveId(),
        guildId: interaction.guildId,
        channelId: channel.id,
        reviewChannelId: reviewChannel.id,
        createdByDiscordId: interaction.user.id,
        createdAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
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

  async function handleButton(interaction) {
    if (!String(interaction.customId || "").startsWith(APPLY_PREFIX)) return false;
    const waveId = interaction.customId.slice(APPLY_PREFIX.length);
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

    let outcome;
    try {
      await robloxGroupService.acceptJoinRequest(verification.robloxUserId);
      let roleWarning = "";
      if (typeof onAcceptedMember === "function") {
        try {
          const guild = interaction.guild || await client.guilds.fetch(session.guildId);
          const member = await guild.members.fetch(interaction.user.id);
          await onAcceptedMember(member, verification);
        } catch (err) {
          logger.error(`Wave ${session.id} role update failed:`, err);
          roleWarning = " Roblox accepted the request, but staff should check the applicant's Discord roles.";
        }
      }
      outcome = {
        status: "accepted",
        message: `Roblox join request accepted.${roleWarning}`,
      };
    } catch (err) {
      logger.error(`Wave ${session.id} Roblox acceptance failed:`, err);
      outcome = {
        status: "failed",
        message: `Automatic Roblox acceptance failed: ${String(err?.message || err).slice(0, 800)}`,
      };
    }

    await store.updateApplicationStatus(application.id, outcome.status, outcome.message);
    await sendReview(session, interaction, application, verification, outcome);

    if (outcome.status === "accepted") {
      await interaction.user.send(
        "Your Thornvale wave application was accepted. Welcome to Thornvale!"
      ).catch(() => {});
      await interaction.editReply("Your application was accepted. Welcome to Thornvale!");
    } else {
      await interaction.editReply(
        "Your application was recorded, but automatic group acceptance needs staff attention. Staff have been notified."
      );
    }
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
  buildWavePayload,
  createWaveService,
  isMatchingVerification,
  parseRobloxIdentity,
};
