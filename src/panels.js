const {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const {
  EDITABLE_POST_BODY_FIELD_ID,
  EDITABLE_POST_MODAL_PREFIX,
  EDITABLE_POST_TITLE_FIELD_ID,
  GUILD_ID,
} = require("./config");
const {
  buildDiscordMessageUrl,
  formatOptionalString,
  parseChannelIdInput,
  parseEditableMessageReference,
} = require("./utils");

function parseEditablePostModalCustomId(customId) {
  const [prefix, mode, channelId, messageId] = String(customId || "").split("|");
  if (prefix !== EDITABLE_POST_MODAL_PREFIX || !mode || !channelId) {
    return null;
  }

  if (mode === "create") {
    return { mode, channelId, messageId: null };
  }

  if (mode === "edit" && messageId) {
    return { mode, channelId, messageId };
  }

  return null;
}

function clampModalValue(value, maxLength) {
  const normalizedValue = formatOptionalString(value);
  if (!normalizedValue) {
    return "";
  }

  return normalizedValue.length > maxLength
    ? normalizedValue.slice(0, maxLength)
    : normalizedValue;
}

function buildEditablePostEmbed(title, body) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(body);
}

function buildEditablePostModal(customId, initialValues = {}) {
  const titleInput = new TextInputBuilder()
    .setCustomId(EDITABLE_POST_TITLE_FIELD_ID)
    .setLabel("Title")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);

  const bodyInput = new TextInputBuilder()
    .setCustomId(EDITABLE_POST_BODY_FIELD_ID)
    .setLabel("Body")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  const initialTitle = clampModalValue(initialValues.title, 256);
  if (initialTitle) {
    titleInput.setValue(initialTitle);
  }

  const initialBody = clampModalValue(initialValues.body, 4000);
  if (initialBody) {
    bodyInput.setValue(initialBody);
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(initialValues.mode === "edit" ? "Edit Panel" : "Create Panel")
    .addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(bodyInput),
    );
}

async function fetchTargetChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("That channel is unavailable or cannot receive messages.");
  }

  if (channel.guildId && channel.guildId !== GUILD_ID) {
    throw new Error("That channel is not in the configured guild.");
  }

  return channel;
}

async function fetchEditableBotMessage(client, channelId, messageId) {
  const channel = await fetchTargetChannel(client, channelId);
  if (!channel.messages?.fetch) {
    throw new Error("That channel does not support message editing.");
  }

  const message = await channel.messages.fetch(messageId);
  if (!message) {
    throw new Error("That message could not be found.");
  }

  if (message.author?.id !== client.user?.id) {
    throw new Error("I can only edit messages that I posted.");
  }

  return { channel, message };
}

function getEditablePostInitialValues(message) {
  const primaryEmbed = Array.isArray(message?.embeds) ? message.embeds[0] : null;
  const title = formatOptionalString(primaryEmbed?.title);
  const body = formatOptionalString(primaryEmbed?.description);

  return {
    title,
    body,
  };
}

async function handleEditablePostModalSubmit({
  interaction,
  client,
  getInteractionMember,
  hasModPermissions,
}) {
  const parsedModal = parseEditablePostModalCustomId(interaction.customId);
  if (!parsedModal) {
    return false;
  }

  const { member } = await getInteractionMember(interaction);
  if (!hasModPermissions(member)) {
    await interaction.reply({
      content: "You do not have permission to use this action.",
      ephemeral: true,
    });
    return true;
  }

  const title = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_TITLE_FIELD_ID));
  const body = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_BODY_FIELD_ID));
  if (!title || !body) {
    await interaction.reply({
      content: "Title and body are both required.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const embed = buildEditablePostEmbed(title, body);

    if (parsedModal.mode === "create") {
      const channel = await fetchTargetChannel(client, parsedModal.channelId);
      const message = await channel.send({
        embeds: [embed],
      });

      const messageUrl = buildDiscordMessageUrl(message.channelId, message.id);
      await interaction.editReply(messageUrl
        ? `Posted panel: ${messageUrl}`
        : `Posted panel in <#${parsedModal.channelId}>.`);
      return true;
    }

    const { message } = await fetchEditableBotMessage(client, parsedModal.channelId, parsedModal.messageId);
    const updatedMessage = await message.edit({
      embeds: [embed],
    });

    const messageUrl = buildDiscordMessageUrl(updatedMessage.channelId, updatedMessage.id);
    await interaction.editReply(messageUrl
      ? `Updated panel: ${messageUrl}`
      : "Updated that panel.");
  } catch (err) {
    console.error("Editable panel modal error:", err);
    await interaction.editReply(`❌ ${err.message || "Failed to save that panel."}`);
  }

  return true;
}

async function handlePostPanelCommand({
  interaction,
  member,
  client,
  hasModPermissions,
}) {
  if (!hasModPermissions(member)) {
    return interaction.reply({
      content: "❌ You do not have permission.",
      ephemeral: true,
    });
  }

  const channelIdInput = interaction.options.getString("channelid");
  const channelId = parseChannelIdInput(channelIdInput);
  if (!channelId) {
    return interaction.reply({
      content: "❌ Enter a valid channel ID or channel mention.",
      ephemeral: true,
    });
  }

  try {
    await fetchTargetChannel(client, channelId);
    return interaction.showModal(
      buildEditablePostModal(
        `${EDITABLE_POST_MODAL_PREFIX}|create|${channelId}`,
        { mode: "create" }
      )
    );
  } catch (err) {
    console.error("Post panel command error:", err);
    return interaction.reply({
      content: `❌ ${err.message || "That channel could not be used."}`,
      ephemeral: true,
    });
  }
}

async function handleEditPanelCommand({
  interaction,
  member,
  client,
  hasModPermissions,
}) {
  if (!hasModPermissions(member)) {
    return interaction.reply({
      content: "❌ You do not have permission.",
      ephemeral: true,
    });
  }

  const messageInput = interaction.options.getString("message");
  const reference = parseEditableMessageReference(messageInput);
  if (!reference) {
    return interaction.reply({
      content: "❌ Use a Discord message link or channelId:messageId.",
      ephemeral: true,
    });
  }

  if (reference.guildId !== GUILD_ID) {
    return interaction.reply({
      content: "❌ That message is not from this server.",
      ephemeral: true,
    });
  }

  try {
    const { message } = await fetchEditableBotMessage(client, reference.channelId, reference.messageId);
    const initialValues = getEditablePostInitialValues(message);
    return interaction.showModal(
      buildEditablePostModal(
        `${EDITABLE_POST_MODAL_PREFIX}|edit|${reference.channelId}|${reference.messageId}`,
        {
          mode: "edit",
          title: initialValues.title,
          body: initialValues.body,
        }
      )
    );
  } catch (err) {
    console.error("Edit panel command error:", err);
    return interaction.reply({
      content: `❌ ${err.message || "That message could not be edited."}`,
      ephemeral: true,
    });
  }
}

module.exports = {
  handleEditPanelCommand,
  handleEditablePostModalSubmit,
  handlePostPanelCommand,
};
