const { GameApiError } = require("./gameApiError");

const METHOD_ALIASES = new Map([
  ["message", "Message"],
  ["embed", "Embed"],
  ["multipleembeds", "MultipleEmbeds"],
  ["payload", "Payload"],
  ["relay", "Payload"],
]);

function normalizeMethod(value) {
  return METHOD_ALIASES.get(String(value || "").replace(/[^a-z]/gi, "").toLowerCase()) || "";
}

function createWebhookService({
  client,
  resolveRelayChannelId,
  buildRelayPayload,
  buildRelayComponents = () => [],
}) {
  if (!client || typeof resolveRelayChannelId !== "function" || typeof buildRelayPayload !== "function") {
    throw new TypeError("client, resolveRelayChannelId, and buildRelayPayload are required");
  }

  async function execute(input = {}) {
    const method = normalizeMethod(input.method);
    if (!method) {
      throw new GameApiError(400, "UNKNOWN_METHOD", "Use Message, Embed, or MultipleEmbeds.");
    }
    if (typeof client.isReady === "function" && !client.isReady()) {
      throw new GameApiError(503, "BOT_NOT_READY", "The Discord bot is not ready.");
    }

    const service = String(input.service || "").trim().toLowerCase();
    const channelId = String(
      input.channelId ?? input.cid ?? (service ? resolveRelayChannelId(service) : "") ?? ""
    ).trim();
    if (!channelId) {
      throw new GameApiError(404, "CHANNEL_NOT_FOUND", "Provide a valid service or Discord channel ID.");
    }

    let source;
    if (method === "Message") {
      const message = String(input.message ?? input.content ?? "").trim();
      if (!message) {
        throw new GameApiError(400, "VALIDATION_ERROR", "Message requires message or content.");
      }
      const timestamp = Number(input.timestamp);
      source = {
        content: Number.isFinite(timestamp) && timestamp > 0
          ? `${message} <t:${Math.floor(timestamp)}:R>`
          : message,
        allowedMentions: input.allowedMentions,
      };
    } else if (method === "Embed") {
      if (!input.embedData || Array.isArray(input.embedData) || typeof input.embedData !== "object") {
        throw new GameApiError(400, "VALIDATION_ERROR", "Embed requires one embedData object.");
      }
      source = { embeds: [input.embedData], content: input.content, allowedMentions: input.allowedMentions };
    } else if (method === "MultipleEmbeds") {
      if (!Array.isArray(input.embedData) || input.embedData.length === 0 || input.embedData.length > 10) {
        throw new GameApiError(400, "VALIDATION_ERROR", "MultipleEmbeds requires 1 through 10 embedData objects.");
      }
      source = { embeds: input.embedData, content: input.content, allowedMentions: input.allowedMentions };
    } else {
      source = input.payload && typeof input.payload === "object" ? input.payload : input;
    }

    const messagePayload = buildRelayPayload(source);
    const components = buildRelayComponents(service, source);
    if (components.length > 0) {
      messagePayload.components = components;
    }
    if (!messagePayload.content && (!Array.isArray(messagePayload.embeds) || messagePayload.embeds.length === 0)) {
      throw new GameApiError(400, "VALIDATION_ERROR", "The webhook payload has no message content or embeds.");
    }

    let message;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== "function") {
        throw new GameApiError(404, "CHANNEL_NOT_FOUND", "The Discord channel is unavailable.");
      }
      message = await channel.send(messagePayload);
    } catch (err) {
      if (err instanceof GameApiError) {
        throw err;
      }
      throw new GameApiError(502, "DISCORD_SEND_FAILED", "Discord rejected the webhook message.");
    }

    return {
      method,
      service: service || null,
      channelId: message.channelId || channelId,
      messageId: message.id,
    };
  }

  return { execute };
}

module.exports = {
  createWebhookService,
  normalizeMethod,
};
