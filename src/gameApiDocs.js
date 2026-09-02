function createGameApiOpenApiSpec(publicBaseUrl) {
  const serverUrl = String(publicBaseUrl || "http://localhost:3000").replace(/\/$/, "");
  const verificationProperties = {
    verified: { type: "boolean" },
    discordId: { type: "string", nullable: true },
    robloxUserId: { type: "string", nullable: true },
    robloxUsername: { type: "string" },
    robloxDisplayName: { type: "string" },
    verifiedAt: { type: "string", format: "date-time", nullable: true },
    updatedAt: { type: "string", format: "date-time", nullable: true },
    lastGameSeenAt: { type: "string", format: "date-time", nullable: true },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "Thornvale Game API",
      version: "1.1.0",
      description: "Versioned, server-only API for Thornvale Roblox experiences. Keep the API key in ServerScriptService and send it as a Bearer token. Capability endpoints use a method field so new operations do not require new URLs.",
    },
    servers: [{ url: serverUrl }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Verification: { type: "object", required: ["verified"], properties: verificationProperties },
        Error: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: { type: "boolean", enum: [false] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
          },
        },
      },
    },
    paths: {
      "/api/v1/verifications/roblox/{robloxUserId}": {
        get: {
          tags: ["Verification"],
          summary: "Resolve a Roblox ID to its linked Discord account",
          parameters: [{ name: "robloxUserId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Verification state and linked IDs." },
            401: { description: "Invalid or missing API key." },
          },
        },
      },
      "/api/v1/verifications/discord/{discordId}": {
        get: {
          tags: ["Verification"],
          summary: "Resolve a Discord ID to its linked Roblox account",
          parameters: [{ name: "discordId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "Verification state and linked IDs." },
            401: { description: "Invalid or missing API key." },
          },
        },
      },
      "/api/v1/verifications/lookup": {
        post: {
          tags: ["Verification"],
          summary: "Look up a link using either account ID",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { discordId: { type: "string" }, robloxUserId: { type: "string" } },
                },
              },
            },
          },
          responses: {
            200: { description: "Verification state and linked IDs." },
            400: { description: "No account ID supplied." },
            401: { description: "Invalid or missing API key." },
          },
        },
      },
      "/api/v1/useraction": {
        post: {
          tags: ["Discord member actions"],
          summary: "Resolve a verified Roblox account and perform a Discord member action",
          description: "GetLink only reads the verification record. Other methods resolve the link, locate the member in the supplied/default guild, and perform the requested action. Unverified Roblox users return a successful skipped result.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["method"],
                  properties: {
                    method: { type: "string", enum: ["GetLink", "GetRoles", "SyncTeamRole", "AddRoles", "RemoveRoles", "Timeout", "Mute", "Deafen"] },
                    robloxUserId: { type: "string", description: "Preferred identity input." },
                    discordId: { type: "string", description: "Alternative identity input; it must already be linked." },
                    guildId: { type: "string", description: "Optional when the bot has a default guild configured." },
                    team: { type: "string", description: "Required for SyncTeamRole." },
                    roles: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Required for AddRoles and RemoveRoles." },
                    state: { description: "Boolean for Mute/Deafen; milliseconds for Timeout; 0 clears a timeout." },
                  },
                },
                examples: {
                  getRoles: { value: { method: "GetRoles", robloxUserId: "21609523" } },
                  syncTeam: { value: { method: "SyncTeamRole", robloxUserId: "21609523", team: "Vanguard" } },
                },
              },
            },
          },
          responses: {
            200: { description: "Action result, including skipped state for an unverified user." },
            400: { description: "Unknown method or invalid method fields." },
            401: { description: "Invalid or missing API key." },
            404: { description: "Verified Discord member is not in the guild." },
          },
        },
      },
      "/api/v1/webhook": {
        post: {
          tags: ["Discord messages"],
          summary: "Send a message or embed to a Discord channel",
          description: "Use a configured service name for game relays, or channelId/cid for a direct channel. The private Payload method remains available to legacy Thornvale relay adapters.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["method"],
                  properties: {
                    method: { type: "string", enum: ["Message", "Embed", "MultipleEmbeds"] },
                    service: { type: "string", enum: ["anticheat", "wipe", "death", "examservice"] },
                    channelId: { type: "string" },
                    message: { type: "string", description: "Required for Message." },
                    timestamp: { type: "integer", description: "Optional Unix seconds appended as a Discord relative timestamp." },
                    embedData: { description: "One embed object for Embed, or an array of 1-10 objects for MultipleEmbeds." },
                  },
                },
                examples: {
                  message: { value: { method: "Message", service: "anticheat", message: "Server check completed" } },
                  embed: { value: { method: "Embed", service: "death", embedData: { title: "Death", description: "Event details" } } },
                },
              },
            },
          },
          responses: {
            200: { description: "Discord message and channel IDs." },
            400: { description: "Unknown method or invalid payload." },
            401: { description: "Invalid or missing API key." },
            404: { description: "Unknown or unavailable channel." },
          },
        },
      },
      "/api/v1/activity": {
        post: {
          tags: ["Activity"],
          summary: "Record activity for a linked Roblox account",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["robloxUserId"],
                  properties: {
                    robloxUserId: { type: "string" },
                    robloxUsername: { type: "string" },
                    robloxDisplayName: { type: "string" },
                    eventType: { type: "string", enum: ["join", "leave", "seen"] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Activity accepted; linked IDs are returned when verified." },
            400: { description: "No Roblox ID supplied." },
            401: { description: "Invalid or missing API key." },
          },
        },
      },
    },
  };
}

function createGameApiDocsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thornvale Game API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#swagger-ui", deepLinking: true });</script>
</body>
</html>`;
}

module.exports = {
  createGameApiDocsHtml,
  createGameApiOpenApiSpec,
};
