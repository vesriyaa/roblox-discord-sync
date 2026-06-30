const hasDatabaseUrl = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim() !== "";

let Pool = null;
if (hasDatabaseUrl) {
  ({ Pool } = require("pg"));
}

const SESSION_TTL_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLink(row) {
  if (!row) {
    return null;
  }

  return {
    discordId: String(row.discord_id),
    robloxUserId: String(row.roblox_user_id),
    robloxUsername: row.roblox_username || "",
    robloxDisplayName: row.roblox_display_name || "",
    verifiedAt: toIso(row.verified_at),
    updatedAt: toIso(row.updated_at),
    lastGameSeenAt: toIso(row.last_game_seen_at),
    lastGameJoinedAt: toIso(row.last_game_joined_at),
    lastGameLeftAt: toIso(row.last_game_left_at),
  };
}

function normalizeSession(row) {
  if (!row) {
    return null;
  }

  return {
    state: row.state,
    discordId: String(row.discord_id),
    discordTag: row.discord_tag || "",
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

function createMemoryStore() {
  const linksByDiscord = new Map();
  const linksByRoblox = new Map();
  const sessions = new Map();

  function pruneSessions() {
    const now = Date.now();
    for (const [state, session] of sessions) {
      if (session.expiresAtMs <= now) {
        sessions.delete(state);
      }
    }
  }

  return {
    type: "memory",
    async init() {
      console.warn("[VerificationDB] DATABASE_URL is not configured; using in-memory verification storage.");
    },
    async createOAuthSession(session) {
      pruneSessions();
      const createdAt = Date.now();
      sessions.set(session.state, {
        ...session,
        createdAtMs: createdAt,
        expiresAtMs: createdAt + SESSION_TTL_MS,
      });
    },
    async consumeOAuthSession(state) {
      pruneSessions();
      const session = sessions.get(state);
      if (!session) {
        return null;
      }
      sessions.delete(state);
      return {
        state: session.state,
        discordId: session.discordId,
        discordTag: session.discordTag,
        nonce: session.nonce,
        codeVerifier: session.codeVerifier,
        createdAt: toIso(session.createdAtMs),
        expiresAt: toIso(session.expiresAtMs),
      };
    },
    async getVerificationByDiscordId(discordId) {
      return linksByDiscord.get(String(discordId)) || null;
    },
    async getVerificationByRobloxUserId(robloxUserId) {
      return linksByRoblox.get(String(robloxUserId)) || null;
    },
    async upsertVerification(link) {
      const discordId = String(link.discordId);
      const robloxUserId = String(link.robloxUserId);
      const existingRoblox = linksByRoblox.get(robloxUserId);
      if (existingRoblox && existingRoblox.discordId !== discordId) {
        const error = new Error("Roblox account is already linked to another Discord account.");
        error.code = "ROBLOX_ALREADY_LINKED";
        throw error;
      }

      const previous = linksByDiscord.get(discordId);
      if (previous && previous.robloxUserId !== robloxUserId) {
        linksByRoblox.delete(previous.robloxUserId);
      }

      const record = {
        discordId,
        robloxUserId,
        robloxUsername: link.robloxUsername || "",
        robloxDisplayName: link.robloxDisplayName || "",
        verifiedAt: previous?.verifiedAt || nowIso(),
        updatedAt: nowIso(),
        lastGameSeenAt: previous?.lastGameSeenAt || nowIso(),
        lastGameJoinedAt: previous?.lastGameJoinedAt || null,
        lastGameLeftAt: previous?.lastGameLeftAt || null,
      };
      linksByDiscord.set(discordId, record);
      linksByRoblox.set(robloxUserId, record);
      return record;
    },
    async recordGameActivity(activity) {
      const robloxUserId = String(activity?.robloxUserId || "");
      const existing = linksByRoblox.get(robloxUserId);
      if (!existing) {
        return null;
      }

      const timestamp = nowIso();
      existing.updatedAt = timestamp;
      existing.lastGameSeenAt = timestamp;
      if (activity.eventType === "join") {
        existing.lastGameJoinedAt = timestamp;
      } else if (activity.eventType === "leave") {
        existing.lastGameLeftAt = timestamp;
      }
      if (activity.robloxUsername) {
        existing.robloxUsername = activity.robloxUsername;
      }
      if (activity.robloxDisplayName) {
        existing.robloxDisplayName = activity.robloxDisplayName;
      }
      return existing;
    },
    async listInactiveCandidates(cutoffIso, limit) {
      return Array.from(linksByDiscord.values())
        .filter((record) => record.lastGameSeenAt && new Date(record.lastGameSeenAt) <= new Date(cutoffIso))
        .sort((left, right) => new Date(left.lastGameSeenAt) - new Date(right.lastGameSeenAt))
        .slice(0, limit);
    },
    async listNearlyInactiveCandidates(nearCutoffIso, inactiveCutoffIso, limit) {
      const nearCutoff = new Date(nearCutoffIso);
      const inactiveCutoff = new Date(inactiveCutoffIso);
      return Array.from(linksByDiscord.values())
        .filter((record) => {
          if (!record.lastGameSeenAt) {
            return false;
          }
          const lastSeen = new Date(record.lastGameSeenAt);
          return lastSeen > inactiveCutoff && lastSeen <= nearCutoff;
        })
        .sort((left, right) => new Date(left.lastGameSeenAt) - new Date(right.lastGameSeenAt))
        .slice(0, limit);
    },
    async deleteVerificationByDiscordId(discordId) {
      const key = String(discordId);
      const existing = linksByDiscord.get(key);
      linksByDiscord.delete(key);
      if (existing) {
        linksByRoblox.delete(existing.robloxUserId);
      }
      return existing || null;
    },
  };
}

function createPostgresStore() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_SSL || "").toLowerCase() === "false"
      ? false
      : { rejectUnauthorized: false },
  });

  async function query(text, params) {
    return pool.query(text, params);
  }

  return {
    type: "postgres",
    async init() {
      await query(`
        CREATE TABLE IF NOT EXISTS roblox_discord_links (
          discord_id TEXT PRIMARY KEY,
          roblox_user_id TEXT NOT NULL UNIQUE,
          roblox_username TEXT,
          roblox_display_name TEXT,
          verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query("ALTER TABLE roblox_discord_links ADD COLUMN IF NOT EXISTS last_game_seen_at TIMESTAMPTZ");
      await query("ALTER TABLE roblox_discord_links ADD COLUMN IF NOT EXISTS last_game_joined_at TIMESTAMPTZ");
      await query("ALTER TABLE roblox_discord_links ADD COLUMN IF NOT EXISTS last_game_left_at TIMESTAMPTZ");
      await query("UPDATE roblox_discord_links SET last_game_seen_at = NOW() WHERE last_game_seen_at IS NULL");

      await query(`
        CREATE TABLE IF NOT EXISTS roblox_oauth_sessions (
          state TEXT PRIMARY KEY,
          discord_id TEXT NOT NULL,
          discord_tag TEXT,
          nonce TEXT NOT NULL,
          code_verifier TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
    },
    async createOAuthSession(session) {
      await query("DELETE FROM roblox_oauth_sessions WHERE expires_at <= NOW()");
      await query(
        `
          INSERT INTO roblox_oauth_sessions (
            state,
            discord_id,
            discord_tag,
            nonce,
            code_verifier,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 millisecond'))
        `,
        [
          session.state,
          String(session.discordId),
          session.discordTag || "",
          session.nonce,
          session.codeVerifier,
          SESSION_TTL_MS,
        ]
      );
    },
    async consumeOAuthSession(state) {
      const result = await query(
        `
          DELETE FROM roblox_oauth_sessions
          WHERE state = $1 AND expires_at > NOW()
          RETURNING *
        `,
        [state]
      );
      return normalizeSession(result.rows[0]);
    },
    async getVerificationByDiscordId(discordId) {
      const result = await query(
        "SELECT * FROM roblox_discord_links WHERE discord_id = $1",
        [String(discordId)]
      );
      return normalizeLink(result.rows[0]);
    },
    async getVerificationByRobloxUserId(robloxUserId) {
      const result = await query(
        "SELECT * FROM roblox_discord_links WHERE roblox_user_id = $1",
        [String(robloxUserId)]
      );
      return normalizeLink(result.rows[0]);
    },
    async upsertVerification(link) {
      const discordId = String(link.discordId);
      const robloxUserId = String(link.robloxUserId);
      const existingRoblox = await this.getVerificationByRobloxUserId(robloxUserId);
      if (existingRoblox && existingRoblox.discordId !== discordId) {
        const error = new Error("Roblox account is already linked to another Discord account.");
        error.code = "ROBLOX_ALREADY_LINKED";
        throw error;
      }

      const result = await query(
        `
          INSERT INTO roblox_discord_links (
            discord_id,
            roblox_user_id,
            roblox_username,
            roblox_display_name,
            last_game_seen_at
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (discord_id)
          DO UPDATE SET
            roblox_user_id = EXCLUDED.roblox_user_id,
            roblox_username = EXCLUDED.roblox_username,
            roblox_display_name = EXCLUDED.roblox_display_name,
            last_game_seen_at = COALESCE(roblox_discord_links.last_game_seen_at, NOW()),
            updated_at = NOW()
          RETURNING *
        `,
        [
          discordId,
          robloxUserId,
          link.robloxUsername || "",
          link.robloxDisplayName || "",
        ]
      );
      return normalizeLink(result.rows[0]);
    },
    async recordGameActivity(activity) {
      const eventType = String(activity?.eventType || "").toLowerCase();
      const result = await query(
        `
          UPDATE roblox_discord_links
          SET
            roblox_username = COALESCE(NULLIF($2, ''), roblox_username),
            roblox_display_name = COALESCE(NULLIF($3, ''), roblox_display_name),
            last_game_seen_at = NOW(),
            last_game_joined_at = CASE WHEN $4 = 'join' THEN NOW() ELSE last_game_joined_at END,
            last_game_left_at = CASE WHEN $4 = 'leave' THEN NOW() ELSE last_game_left_at END,
            updated_at = NOW()
          WHERE roblox_user_id = $1
          RETURNING *
        `,
        [
          String(activity?.robloxUserId || ""),
          activity?.robloxUsername || "",
          activity?.robloxDisplayName || "",
          eventType,
        ]
      );
      return normalizeLink(result.rows[0]);
    },
    async listInactiveCandidates(cutoffIso, limit) {
      const result = await query(
        `
          SELECT *
          FROM roblox_discord_links
          WHERE last_game_seen_at <= $1
          ORDER BY last_game_seen_at ASC
          LIMIT $2
        `,
        [cutoffIso, limit]
      );
      return result.rows.map(normalizeLink);
    },
    async listNearlyInactiveCandidates(nearCutoffIso, inactiveCutoffIso, limit) {
      const result = await query(
        `
          SELECT *
          FROM roblox_discord_links
          WHERE last_game_seen_at > $2
            AND last_game_seen_at <= $1
          ORDER BY last_game_seen_at ASC
          LIMIT $3
        `,
        [nearCutoffIso, inactiveCutoffIso, limit]
      );
      return result.rows.map(normalizeLink);
    },
    async deleteVerificationByDiscordId(discordId) {
      const result = await query(
        "DELETE FROM roblox_discord_links WHERE discord_id = $1 RETURNING *",
        [String(discordId)]
      );
      return normalizeLink(result.rows[0]);
    },
  };
}

function createVerificationDatabase() {
  return hasDatabaseUrl ? createPostgresStore() : createMemoryStore();
}

module.exports = {
  createVerificationDatabase,
};
