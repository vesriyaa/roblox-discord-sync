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

const EDITABLE_POST_CONTENT_FIELD_ID = "content";
const EDITABLE_POST_COLOR_FIELD_ID = "color";
const EDITABLE_POST_FOOTER_FIELD_ID = "footer";

const NAMED_EMBED_COLORS = {
  black: 0x000000,
  blue: 0x3498db,
  blurple: 0x5865f2,
  gold: 0xf1c40f,
  gray: 0x95a5a6,
  green: 0x2ecc71,
  grey: 0x95a5a6,
  orange: 0xe67e22,
  pink: 0xff69b4,
  purple: 0x9b59b6,
  red: 0xe74c3c,
  teal: 0x1abc9c,
  white: 0xffffff,
  yellow: 0xf1c40f,
};

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

function parseEmbedColor(input) {
  const normalizedInput = formatOptionalString(input).toLowerCase();
  if (!normalizedInput) {
    return null;
  }

  if (normalizedInput in NAMED_EMBED_COLORS) {
    return NAMED_EMBED_COLORS[normalizedInput];
  }

  const sanitizedInput = normalizedInput.replace(/^#/, "").replace(/^0x/, "");
  if (/^[0-9a-f]{6}$/i.test(sanitizedInput)) {
    return Number.parseInt(sanitizedInput, 16);
  }

  return null;
}

function formatEmbedColorValue(colorValue) {
  const numericValue = Number.isFinite(colorValue)
    ? colorValue
    : Number.isFinite(colorValue?.data?.color)
      ? colorValue.data.color
      : Number.isFinite(colorValue?.color)
        ? colorValue.color
        : null;

  if (!Number.isFinite(numericValue)) {
    return "";
  }

  return `#${numericValue.toString(16).padStart(6, "0").toUpperCase()}`;
}

function buildEditablePostEmbed(title, body, options = {}) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(body);

  if (Number.isFinite(options.color)) {
    embed.setColor(options.color);
  }

  const footerText = formatOptionalString(options.footer);
  if (footerText) {
    embed.setFooter({ text: footerText });
  }

  return embed;
}

function buildEditablePostModal(customId, initialValues = {}) {
  const contentInput = new TextInputBuilder()
    .setCustomId(EDITABLE_POST_CONTENT_FIELD_ID)
    .setLabel("Message Content")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(2000);

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

  const colorInput = new TextInputBuilder()
    .setCustomId(EDITABLE_POST_COLOR_FIELD_ID)
    .setLabel("Color (#hex or name)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32);

  const footerInput = new TextInputBuilder()
    .setCustomId(EDITABLE_POST_FOOTER_FIELD_ID)
    .setLabel("Footer")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(2048);

  const initialContent = clampModalValue(initialValues.content, 2000);
  if (initialContent) {
    contentInput.setValue(initialContent);
  }

  const initialTitle = clampModalValue(initialValues.title, 256);
  if (initialTitle) {
    titleInput.setValue(initialTitle);
  }

  const initialBody = clampModalValue(initialValues.body, 4000);
  if (initialBody) {
    bodyInput.setValue(initialBody);
  }

  const initialColor = clampModalValue(initialValues.color, 32);
  if (initialColor) {
    colorInput.setValue(initialColor);
  }

  const initialFooter = clampModalValue(initialValues.footer, 2048);
  if (initialFooter) {
    footerInput.setValue(initialFooter);
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(initialValues.mode === "edit" ? "Edit Panel" : "Create Panel")
    .addComponents(
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(bodyInput),
      new ActionRowBuilder().addComponents(colorInput),
      new ActionRowBuilder().addComponents(footerInput),
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
  const content = formatOptionalString(message?.content);
  const title = formatOptionalString(primaryEmbed?.title);
  const body = formatOptionalString(primaryEmbed?.description);
  const color = formatEmbedColorValue(primaryEmbed);
  const footer = formatOptionalString(primaryEmbed?.footer?.text);

  return {
    content,
    title,
    body,
    color,
    footer,
  };
}

async function handleEditablePostModalSubmit({
  interaction,
  client,
  getInteractionMember,
  hasCommandPermission,
}) {
  const parsedModal = parseEditablePostModalCustomId(interaction.customId);
  if (!parsedModal) {
    return false;
  }

  const { member } = await getInteractionMember(interaction);
  const commandName = parsedModal.mode === "create" ? "postpanel" : "editpanel";
  if (!await hasCommandPermission(member, commandName)) {
    await interaction.reply({
      content: "You do not have permission to use this action.",
      ephemeral: true,
    });
    return true;
  }

  const content = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_CONTENT_FIELD_ID));
  const title = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_TITLE_FIELD_ID));
  const body = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_BODY_FIELD_ID));
  const colorInput = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_COLOR_FIELD_ID));
  const footer = formatOptionalString(interaction.fields.getTextInputValue(EDITABLE_POST_FOOTER_FIELD_ID));
  if (!title || !body) {
    await interaction.reply({
      content: "Title and body are both required.",
      ephemeral: true,
    });
    return true;
  }

  const embedColor = parseEmbedColor(colorInput);
  if (colorInput && !Number.isFinite(embedColor)) {
    await interaction.reply({
      content: "Color must be a hex value like #C0392B or a simple name like red, gold, blue, or purple.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const embed = buildEditablePostEmbed(title, body, {
      color: embedColor,
      footer,
    });
    const createPayload = { embeds: [embed] };
    if (content) {
      createPayload.content = content;
    }

    const editPayload = {
      content: content || "",
      embeds: [embed],
    };

    if (parsedModal.mode === "create") {
      const channel = await fetchTargetChannel(client, parsedModal.channelId);
      const message = await channel.send(createPayload);

      const messageUrl = buildDiscordMessageUrl(message.channelId, message.id);
      await interaction.editReply(messageUrl
        ? `Posted panel: ${messageUrl}`
        : `Posted panel in <#${parsedModal.channelId}>.`);
      return true;
    }

    const { message } = await fetchEditableBotMessage(client, parsedModal.channelId, parsedModal.messageId);
    const updatedMessage = await message.edit(editPayload);

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
  ensureCommandPermission,
}) {
  if (!await ensureCommandPermission(interaction, member, "postpanel")) {
    return;
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
  ensureCommandPermission,
}) {
  if (!await ensureCommandPermission(interaction, member, "editpanel")) {
    return;
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
          content: initialValues.content,
          title: initialValues.title,
          body: initialValues.body,
          color: initialValues.color,
          footer: initialValues.footer,
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
