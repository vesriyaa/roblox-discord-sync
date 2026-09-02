const crypto = require("crypto");
const express = require("express");
const { VerificationServiceError } = require("./verificationService");

function getRequestApiKey(req) {
  const authorization = String(req.get("authorization") || "").trim();
  if (authorization) {
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    return (bearerMatch ? bearerMatch[1] : authorization).trim();
  }

  return String(req.get("x-api-key") || "").trim();
}

function keysMatch(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return providedBuffer.length === expectedBuffer.length
    && providedBuffer.length > 0
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAuthorizedRequest(req, apiKey) {
  return keysMatch(getRequestApiKey(req), apiKey);
}

function sendSuccess(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function sendError(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

function createGameApiRouter({
  apiKey,
  verificationService,
  userActionService,
  webhookService,
  onVerifiedJoin,
  logger = console,
}) {
  if (!verificationService) {
    throw new TypeError("verificationService is required");
  }

  const router = express.Router();

  router.use((req, res, next) => {
    if (!apiKey) {
      return sendError(res, 503, "API_NOT_CONFIGURED", "The game API is not configured.");
    }
    if (!isAuthorizedRequest(req, apiKey)) {
      return sendError(res, 401, "UNAUTHORIZED", "Invalid or missing API key.");
    }
    return next();
  });

  const handleLookup = async (req, res, lookup) => {
    try {
      return sendSuccess(res, await verificationService.lookup(lookup));
    } catch (err) {
      if (err instanceof VerificationServiceError) {
        return sendError(res, err.status, err.code, err.message);
      }
      logger.error("Game API verification lookup error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Verification lookup failed.");
    }
  };

  const handleOperation = async (req, res, service, operationName) => {
    if (!service || typeof service.execute !== "function") {
      return sendError(res, 503, "API_NOT_CONFIGURED", `${operationName} is not configured.`);
    }
    try {
      return sendSuccess(res, await service.execute(req.body));
    } catch (err) {
      if (Number.isInteger(err?.status) && typeof err?.code === "string") {
        return sendError(res, err.status, err.code, err.message);
      }
      logger.error(`Game API ${operationName} error:`, err);
      return sendError(res, 500, "INTERNAL_ERROR", `${operationName} failed.`);
    }
  };

  router.get("/verifications/roblox/:robloxUserId", (req, res) => (
    handleLookup(req, res, { robloxUserId: req.params.robloxUserId })
  ));

  router.get("/verifications/discord/:discordId", (req, res) => (
    handleLookup(req, res, { discordId: req.params.discordId })
  ));

  router.post("/verifications/lookup", (req, res) => handleLookup(req, res, req.body));

  router.post("/useraction", (req, res) => (
    handleOperation(req, res, userActionService, "user action")
  ));

  router.post("/webhook", (req, res) => (
    handleOperation(req, res, webhookService, "webhook delivery")
  ));

  router.post("/activity", async (req, res) => {
    try {
      const result = await verificationService.recordActivity(req.body);
      if (result.eventType === "join" && result.verification.verified && onVerifiedJoin) {
        try {
          await onVerifiedJoin(result.verification);
        } catch (err) {
          logger.error("Game API verified-role refresh error:", err);
        }
      }

      return sendSuccess(res, {
        recorded: true,
        ...result.verification,
      });
    } catch (err) {
      if (err instanceof VerificationServiceError) {
        return sendError(res, err.status, err.code, err.message);
      }
      logger.error("Game API activity error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Activity update failed.");
    }
  });

  return router;
}

module.exports = {
  createGameApiRouter,
  getRequestApiKey,
  isAuthorizedRequest,
  sendError,
  sendSuccess,
};
