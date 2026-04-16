const { GUILD_ID } = require("./config");

function formatOptionalString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : fallback;
}

function parsePositiveInteger(value) {
  const parsedValue = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function parseTimestamp(value) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? Math.floor(parsedValue) : null;
}

function buildDiscordMessageUrl(channelId, messageId) {
  if (!channelId || !messageId) {
    return null;
  }

  return `https://discord.com/channels/${GUILD_ID}/${channelId}/${messageId}`;
}

function parseChannelIdInput(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  if (/^\d+$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const mentionMatch = trimmedValue.match(/^<#(\d+)>$/);
  return mentionMatch?.[1] ?? null;
}

function parseEditableMessageReference(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  const urlMatch = trimmedValue.match(/^https?:\/\/(?:canary\.|ptb\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/);
  if (urlMatch) {
    const [, guildId, channelId, messageId] = urlMatch;
    return { guildId, channelId, messageId };
  }

  const shorthandMatch = trimmedValue.match(/^(\d+)\s*[:/]\s*(\d+)$/);
  if (shorthandMatch) {
    const [, channelId, messageId] = shorthandMatch;
    return { guildId: GUILD_ID, channelId, messageId };
  }

  return null;
}

module.exports = {
  buildDiscordMessageUrl,
  formatOptionalString,
  parseChannelIdInput,
  parseEditableMessageReference,
  parsePositiveInteger,
  parseTimestamp,
};
