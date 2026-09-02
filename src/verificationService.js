class VerificationServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "VerificationServiceError";
    this.status = status;
    this.code = code;
  }
}

function normalizeId(value) {
  return value == null ? "" : String(value).trim();
}

function serializeVerification(record) {
  if (!record) {
    return { verified: false };
  }

  return {
    verified: true,
    discordId: String(record.discordId),
    robloxUserId: String(record.robloxUserId),
    robloxUsername: record.robloxUsername || "",
    robloxDisplayName: record.robloxDisplayName || "",
    verifiedAt: record.verifiedAt || null,
    updatedAt: record.updatedAt || null,
    lastGameSeenAt: record.lastGameSeenAt || null,
    lastGameJoinedAt: record.lastGameJoinedAt || null,
    lastGameLeftAt: record.lastGameLeftAt || null,
  };
}

function createVerificationService({ verificationDb }) {
  if (!verificationDb) {
    throw new TypeError("verificationDb is required");
  }

  return {
    async lookup({ discordId, robloxUserId } = {}) {
      const normalizedDiscordId = normalizeId(discordId);
      const normalizedRobloxUserId = normalizeId(robloxUserId);
      if (!normalizedDiscordId && !normalizedRobloxUserId) {
        throw new VerificationServiceError(
          400,
          "VALIDATION_ERROR",
          "Provide discordId or robloxUserId."
        );
      }

      const record = normalizedDiscordId
        ? await verificationDb.getVerificationByDiscordId(normalizedDiscordId)
        : await verificationDb.getVerificationByRobloxUserId(normalizedRobloxUserId);

      return serializeVerification(record);
    },

    async recordActivity(input = {}) {
      const robloxUserId = normalizeId(input.robloxUserId);
      if (!robloxUserId) {
        throw new VerificationServiceError(
          400,
          "VALIDATION_ERROR",
          "Provide robloxUserId."
        );
      }

      const requestedEventType = normalizeId(input.eventType || input.event).toLowerCase();
      const eventType = new Set(["join", "leave", "seen"]).has(requestedEventType)
        ? requestedEventType
        : "seen";
      const record = await verificationDb.recordGameActivity({
        robloxUserId,
        eventType,
        robloxUsername: typeof input.robloxUsername === "string" ? input.robloxUsername : "",
        robloxDisplayName: typeof input.robloxDisplayName === "string" ? input.robloxDisplayName : "",
      });

      return {
        eventType,
        verification: serializeVerification(record),
      };
    },
  };
}

module.exports = {
  VerificationServiceError,
  createVerificationService,
  serializeVerification,
};
