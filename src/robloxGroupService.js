class RobloxGroupError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "RobloxGroupError";
    this.code = code;
    this.status = status;
  }
}

function createRobloxGroupService({ groupId, cookie, fetchImpl = fetch }) {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedCookie = String(cookie || "").trim();

  return {
    isConfigured() {
      return /^\d+$/.test(normalizedGroupId) && normalizedCookie.length > 0;
    },

    async acceptJoinRequest(robloxUserId) {
      const userId = String(robloxUserId || "").trim();
      if (!/^\d+$/.test(userId)) {
        throw new RobloxGroupError("INVALID_ROBLOX_ID", "A numeric Roblox user ID is required.", 400);
      }
      if (!this.isConfigured()) {
        throw new RobloxGroupError(
          "ROBLOX_GROUP_NOT_CONFIGURED",
          "Roblox group automation is not configured.",
          503
        );
      }

      const cookieHeader = `.ROBLOSECURITY=${normalizedCookie}`;
      const csrfResponse = await fetchImpl("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: { Cookie: cookieHeader },
      });
      const csrfToken = csrfResponse.headers.get("x-csrf-token");
      if (!csrfToken) {
        throw new RobloxGroupError(
          "ROBLOX_CSRF_FAILED",
          "Roblox did not return a CSRF token. Check the configured group cookie.",
          502
        );
      }

      const response = await fetchImpl(
        `https://groups.roblox.com/v1/groups/${normalizedGroupId}/join-requests/users/${userId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
            "x-csrf-token": csrfToken,
          },
        }
      );
      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        const detail = responseText.trim().slice(0, 500);
        throw new RobloxGroupError(
          "ROBLOX_ACCEPT_FAILED",
          detail || `Roblox rejected the join request with HTTP ${response.status}.`,
          response.status || 502
        );
      }

      return { accepted: true, robloxUserId: userId };
    },
  };
}

module.exports = {
  RobloxGroupError,
  createRobloxGroupService,
};
