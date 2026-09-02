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
  const cookieHeader = `.ROBLOSECURITY=${normalizedCookie}`;
  let csrfToken = "";
  let csrfRequest = null;

  function validateUserId(robloxUserId) {
    const userId = String(robloxUserId || "").trim();
    if (!/^\d+$/.test(userId)) {
      throw new RobloxGroupError("INVALID_ROBLOX_ID", "A numeric Roblox user ID is required.", 400);
    }
    return userId;
  }

  function isConfigured() {
    return /^\d+$/.test(normalizedGroupId) && normalizedCookie.length > 0;
  }

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    if (!csrfRequest) {
      csrfRequest = fetchImpl("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: { Cookie: cookieHeader },
      }).then((response) => {
        const token = response.headers?.get?.("x-csrf-token");
        if (!token) {
          throw new RobloxGroupError(
            "ROBLOX_CSRF_FAILED",
            "Roblox did not return a CSRF token. Check the configured group cookie.",
            502
          );
        }
        csrfToken = token;
        return token;
      }).finally(() => {
        csrfRequest = null;
      });
    }
    return csrfRequest;
  }

  async function authenticatedRequest(url, method) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const token = await getCsrfToken();
      const response = await fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "x-csrf-token": token,
        },
      });
      const replacementToken = response.headers?.get?.("x-csrf-token");
      if (replacementToken) csrfToken = replacementToken;
      if (response.status === 403 && replacementToken && attempt < 4) continue;
      if (response.status === 429 && attempt < 4) {
        const retryAfterSeconds = Math.max(1, Number(response.headers?.get?.("retry-after")) || attempt);
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterSeconds, 30) * 1000));
        continue;
      }
      return response;
    }
    throw new RobloxGroupError("ROBLOX_REQUEST_FAILED", "Roblox request retries were exhausted.", 502);
  }

  async function getMembership(robloxUserId) {
    const userId = validateUserId(robloxUserId);
    if (!/^\d+$/.test(normalizedGroupId)) {
      throw new RobloxGroupError("ROBLOX_GROUP_NOT_CONFIGURED", "The Roblox group ID is not configured.", 503);
    }

    const response = await fetchImpl(
      `https://groups.roblox.com/v2/users/${userId}/groups/roles`,
      { method: "GET" }
    );
    if (!response.ok) {
      throw new RobloxGroupError(
        "ROBLOX_MEMBERSHIP_CHECK_FAILED",
        `Roblox membership lookup failed with HTTP ${response.status}.`,
        response.status || 502
      );
    }
    const payload = await response.json();
    const membership = Array.isArray(payload?.data)
      ? payload.data.find((entry) => String(entry?.group?.id || "") === normalizedGroupId)
      : null;
    return {
      isMember: Boolean(membership),
      groupId: normalizedGroupId,
      robloxUserId: userId,
      role: membership?.role || null,
    };
  }

  return {
    isConfigured() {
      return isConfigured();
    },

    getGroupUrl() {
      return /^\d+$/.test(normalizedGroupId)
        ? `https://www.roblox.com/communities/${normalizedGroupId}`
        : "https://www.roblox.com/communities";
    },

    async getMembership(robloxUserId) {
      return getMembership(robloxUserId);
    },

    async acceptJoinRequest(robloxUserId) {
      const userId = validateUserId(robloxUserId);
      if (!isConfigured()) {
        throw new RobloxGroupError(
          "ROBLOX_GROUP_NOT_CONFIGURED",
          "Roblox group automation is not configured.",
          503
        );
      }

      const response = await authenticatedRequest(
        `https://groups.roblox.com/v1/groups/${normalizedGroupId}/join-requests/users/${userId}`,
        "POST"
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

    async removeMember(robloxUserId) {
      const userId = validateUserId(robloxUserId);
      const membership = await getMembership(userId);
      if (!membership.isMember) {
        return { removed: false, alreadyAbsent: true, robloxUserId: userId };
      }
      if (!isConfigured()) {
        throw new RobloxGroupError(
          "ROBLOX_GROUP_NOT_CONFIGURED",
          "Roblox group automation is not configured.",
          503
        );
      }

      const response = await authenticatedRequest(
        `https://groups.roblox.com/v1/groups/${normalizedGroupId}/users/${userId}`,
        "DELETE"
      );
      if (response.ok) {
        return { removed: true, alreadyAbsent: false, robloxUserId: userId };
      }
      if (response.status === 404) {
        return { removed: false, alreadyAbsent: true, robloxUserId: userId };
      }

      const responseText = await response.text().catch(() => "");
      const detail = responseText.trim().slice(0, 500);
      throw new RobloxGroupError(
        "ROBLOX_REMOVE_MEMBER_FAILED",
        detail || `Roblox rejected the member removal with HTTP ${response.status}.`,
        response.status || 502
      );
    },
  };
}

module.exports = {
  RobloxGroupError,
  createRobloxGroupService,
};
