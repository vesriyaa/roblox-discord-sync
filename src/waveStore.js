const hasDatabaseUrl = typeof process.env.DATABASE_URL === "string"
  && process.env.DATABASE_URL.trim() !== "";

let Pool = null;
if (hasDatabaseUrl) {
  ({ Pool } = require("pg"));
}

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeSession(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: row.message_id ? String(row.message_id) : null,
    reviewChannelId: String(row.review_channel_id),
    createdByDiscordId: String(row.created_by_discord_id),
    createdAt: toIso(row.created_at),
    endsAt: toIso(row.ends_at),
    applicationLimit: Number(row.application_limit),
    applicationCount: Number(row.application_count),
    status: row.status,
    closeReason: row.close_reason || null,
    closedAt: toIso(row.closed_at),
  };
}

function normalizeApplication(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    waveId: row.wave_id,
    discordId: String(row.discord_id),
    robloxUserId: String(row.roblox_user_id),
    robloxUsername: row.roblox_username,
    candidateAnswer: row.candidate_answer,
    discoveryAnswer: row.discovery_answer,
    applicantThreadId: row.applicant_thread_id ? String(row.applicant_thread_id) : null,
    status: row.status,
    statusMessage: row.status_message || null,
    reviewerDiscordId: row.reviewer_discord_id ? String(row.reviewer_discord_id) : null,
    reviewedAt: toIso(row.reviewed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function createMemoryStore() {
  const sessions = new Map();
  const applications = new Map();

  const cloneSession = (session) => session ? { ...session } : null;
  const cloneApplication = (application) => application ? { ...application } : null;

  function closeExpired(session) {
    if (session?.status === "open" && new Date(session.endsAt).getTime() <= Date.now()) {
      session.status = "closed";
      session.closeReason = "time";
      session.closedAt = new Date().toISOString();
    }
    return session;
  }

  return {
    type: "memory",
    async init() {
      console.warn("[WaveStore] DATABASE_URL is not configured; wave sessions will not survive a restart.");
    },
    async createSession(session) {
      const existing = Array.from(sessions.values()).find((entry) => (
        closeExpired(entry).guildId === session.guildId && entry.status === "open"
      ));
      if (existing) {
        const error = new Error("A wave is already open in this server.");
        error.code = "WAVE_ALREADY_OPEN";
        throw error;
      }
      const record = {
        ...session,
        messageId: null,
        applicationCount: 0,
        status: "open",
        closeReason: null,
        closedAt: null,
      };
      sessions.set(record.id, record);
      return cloneSession(record);
    },
    async updateMessage(id, messageId) {
      const session = sessions.get(id);
      if (!session) return null;
      session.messageId = String(messageId);
      return cloneSession(session);
    },
    async getSession(id) {
      return cloneSession(closeExpired(sessions.get(id)));
    },
    async findOpenSession(guildId) {
      const session = Array.from(sessions.values()).find((entry) => (
        closeExpired(entry).guildId === String(guildId) && entry.status === "open"
      ));
      return cloneSession(session);
    },
    async listOpenSessions() {
      return Array.from(sessions.values())
        .map(closeExpired)
        .filter((session) => session.status === "open")
        .map(cloneSession);
    },
    async closeSession(id, reason = "manual") {
      const session = sessions.get(id);
      if (!session) return null;
      if (session.status === "open") {
        session.status = "closed";
        session.closeReason = reason;
        session.closedAt = new Date().toISOString();
      }
      return cloneSession(session);
    },
    async reserveApplication(application) {
      const session = closeExpired(sessions.get(application.waveId));
      if (!session) return { ok: false, code: "WAVE_NOT_FOUND" };
      if (session.status !== "open") return { ok: false, code: "WAVE_CLOSED", session: cloneSession(session) };
      const duplicate = Array.from(applications.values()).find((entry) => (
        entry.waveId === application.waveId
        && (entry.discordId === application.discordId || entry.robloxUserId === application.robloxUserId)
      ));
      if (duplicate) return { ok: false, code: "ALREADY_APPLIED", session: cloneSession(session) };
      if (session.applicationCount >= session.applicationLimit) {
        await this.closeSession(session.id, "capacity");
        return { ok: false, code: "WAVE_FULL", session: cloneSession(session) };
      }

      const record = {
        ...application,
        applicantThreadId: null,
        status: "pending",
        statusMessage: null,
        reviewerDiscordId: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      applications.set(record.id, record);
      session.applicationCount += 1;
      if (session.applicationCount >= session.applicationLimit) {
        session.status = "closed";
        session.closeReason = "capacity";
        session.closedAt = new Date().toISOString();
      }
      return { ok: true, session: cloneSession(session), application: cloneApplication(record) };
    },
    async getApplication(id) {
      return cloneApplication(applications.get(id));
    },
    async findAcceptedApplication(discordId, robloxUserId) {
      const matches = Array.from(applications.values())
        .filter((application) => (
          application.status === "accepted"
          && application.discordId === String(discordId)
          && application.robloxUserId === String(robloxUserId)
        ))
        .sort((left, right) => new Date(right.reviewedAt || right.updatedAt) - new Date(left.reviewedAt || left.updatedAt));
      return cloneApplication(matches[0]);
    },
    async updateApplicationContext(id, { applicantThreadId } = {}) {
      const application = applications.get(id);
      if (!application) return null;
      if (applicantThreadId !== undefined) {
        application.applicantThreadId = applicantThreadId ? String(applicantThreadId) : null;
      }
      application.updatedAt = new Date().toISOString();
      return cloneApplication(application);
    },
    async claimApplication(id, reviewerDiscordId) {
      const application = applications.get(id);
      if (!application) return { ok: false, code: "APPLICATION_NOT_FOUND" };
      const staleClaim = application.status === "processing"
        && (Date.now() - new Date(application.updatedAt).getTime()) >= 5 * 60_000;
      if (application.status !== "pending" && !staleClaim) {
        return { ok: false, code: "ALREADY_REVIEWED", application: cloneApplication(application) };
      }
      application.status = "processing";
      application.statusMessage = null;
      application.reviewerDiscordId = String(reviewerDiscordId);
      application.reviewedAt = null;
      application.updatedAt = new Date().toISOString();
      return { ok: true, application: cloneApplication(application) };
    },
    async updateApplicationStatus(id, status, statusMessage, reviewerDiscordId = null) {
      const application = applications.get(id);
      if (!application) return null;
      application.status = status;
      application.statusMessage = statusMessage || null;
      application.reviewerDiscordId = reviewerDiscordId ? String(reviewerDiscordId) : null;
      application.reviewedAt = new Set(["accepted", "denied"]).has(status)
        ? new Date().toISOString()
        : null;
      application.updatedAt = new Date().toISOString();
      return cloneApplication(application);
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

  return {
    type: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wave_sessions (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          review_channel_id TEXT NOT NULL,
          created_by_discord_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ends_at TIMESTAMPTZ NOT NULL,
          application_limit INTEGER NOT NULL CHECK (application_limit > 0),
          application_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          close_reason TEXT,
          closed_at TIMESTAMPTZ
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wave_applications (
          id TEXT PRIMARY KEY,
          wave_id TEXT NOT NULL REFERENCES wave_sessions(id) ON DELETE CASCADE,
          discord_id TEXT NOT NULL,
          roblox_user_id TEXT NOT NULL,
          roblox_username TEXT NOT NULL,
          candidate_answer TEXT NOT NULL,
          discovery_answer TEXT NOT NULL,
          applicant_thread_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          status_message TEXT,
          reviewer_discord_id TEXT,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (wave_id, discord_id),
          UNIQUE (wave_id, roblox_user_id)
        )
      `);
      await pool.query("ALTER TABLE wave_applications ADD COLUMN IF NOT EXISTS applicant_thread_id TEXT");
      await pool.query("ALTER TABLE wave_applications ADD COLUMN IF NOT EXISTS reviewer_discord_id TEXT");
      await pool.query("ALTER TABLE wave_applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
      await pool.query("UPDATE wave_sessions SET status = 'closed', close_reason = 'time', closed_at = NOW() WHERE status = 'open' AND ends_at <= NOW()");
      await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS wave_sessions_one_open_per_guild ON wave_sessions (guild_id) WHERE status = 'open'");
    },
    async createSession(session) {
      try {
        const result = await pool.query(
          `INSERT INTO wave_sessions (
             id, guild_id, channel_id, review_channel_id, created_by_discord_id,
             ends_at, application_limit
           )
           SELECT $1, $2, $3, $4, $5, $6, $7
           WHERE NOT EXISTS (
             SELECT 1 FROM wave_sessions WHERE guild_id = $2 AND status = 'open'
           )
           RETURNING *`,
          [
            session.id,
            session.guildId,
            session.channelId,
            session.reviewChannelId,
            session.createdByDiscordId,
            session.endsAt,
            session.applicationLimit,
          ]
        );
        if (!result.rows[0]) {
          const error = new Error("A wave is already open in this server.");
          error.code = "WAVE_ALREADY_OPEN";
          throw error;
        }
        return normalizeSession(result.rows[0]);
      } catch (err) {
        if (err.code === "23505") {
          err.code = "WAVE_ALREADY_OPEN";
        }
        throw err;
      }
    },
    async updateMessage(id, messageId) {
      const result = await pool.query(
        "UPDATE wave_sessions SET message_id = $2 WHERE id = $1 RETURNING *",
        [id, String(messageId)]
      );
      return normalizeSession(result.rows[0]);
    },
    async getSession(id) {
      const result = await pool.query("SELECT * FROM wave_sessions WHERE id = $1", [id]);
      return normalizeSession(result.rows[0]);
    },
    async findOpenSession(guildId) {
      const result = await pool.query(
        "SELECT * FROM wave_sessions WHERE guild_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
        [String(guildId)]
      );
      return normalizeSession(result.rows[0]);
    },
    async listOpenSessions() {
      const result = await pool.query("SELECT * FROM wave_sessions WHERE status = 'open'");
      return result.rows.map(normalizeSession);
    },
    async closeSession(id, reason = "manual") {
      const result = await pool.query(
        `UPDATE wave_sessions
         SET status = 'closed', close_reason = $2, closed_at = COALESCE(closed_at, NOW())
         WHERE id = $1 AND status = 'open'
         RETURNING *`,
        [id, reason]
      );
      if (result.rows[0]) {
        return normalizeSession(result.rows[0]);
      }
      return this.getSession(id);
    },
    async reserveApplication(application) {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const sessionResult = await connection.query(
          "SELECT * FROM wave_sessions WHERE id = $1 FOR UPDATE",
          [application.waveId]
        );
        let session = normalizeSession(sessionResult.rows[0]);
        if (!session) {
          await connection.query("ROLLBACK");
          return { ok: false, code: "WAVE_NOT_FOUND" };
        }
        if (session.status !== "open") {
          await connection.query("ROLLBACK");
          return { ok: false, code: "WAVE_CLOSED", session };
        }
        if (new Date(session.endsAt).getTime() <= Date.now()) {
          const closed = await connection.query(
            "UPDATE wave_sessions SET status = 'closed', close_reason = 'time', closed_at = NOW() WHERE id = $1 RETURNING *",
            [session.id]
          );
          await connection.query("COMMIT");
          return { ok: false, code: "WAVE_CLOSED", session: normalizeSession(closed.rows[0]) };
        }
        if (session.applicationCount >= session.applicationLimit) {
          const closed = await connection.query(
            "UPDATE wave_sessions SET status = 'closed', close_reason = 'capacity', closed_at = NOW() WHERE id = $1 RETURNING *",
            [session.id]
          );
          await connection.query("COMMIT");
          return { ok: false, code: "WAVE_FULL", session: normalizeSession(closed.rows[0]) };
        }

        const duplicate = await connection.query(
          "SELECT 1 FROM wave_applications WHERE wave_id = $1 AND (discord_id = $2 OR roblox_user_id = $3) LIMIT 1",
          [application.waveId, application.discordId, application.robloxUserId]
        );
        if (duplicate.rows[0]) {
          await connection.query("ROLLBACK");
          return { ok: false, code: "ALREADY_APPLIED", session };
        }

        const applicationResult = await connection.query(
          `INSERT INTO wave_applications (
             id, wave_id, discord_id, roblox_user_id, roblox_username,
             candidate_answer, discovery_answer, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING *`,
          [
            application.id,
            application.waveId,
            application.discordId,
            application.robloxUserId,
            application.robloxUsername,
            application.candidateAnswer,
            application.discoveryAnswer,
          ]
        );
        const nextCount = session.applicationCount + 1;
        const reachedCapacity = nextCount >= session.applicationLimit;
        const updatedSession = await connection.query(
          `UPDATE wave_sessions
           SET application_count = $2,
               status = CASE WHEN $3 THEN 'closed' ELSE status END,
               close_reason = CASE WHEN $3 THEN 'capacity' ELSE close_reason END,
               closed_at = CASE WHEN $3 THEN NOW() ELSE closed_at END
           WHERE id = $1
           RETURNING *`,
          [session.id, nextCount, reachedCapacity]
        );
        await connection.query("COMMIT");
        return {
          ok: true,
          session: normalizeSession(updatedSession.rows[0]),
          application: normalizeApplication(applicationResult.rows[0]),
        };
      } catch (err) {
        await connection.query("ROLLBACK").catch(() => {});
        if (err.code === "23505") {
          return { ok: false, code: "ALREADY_APPLIED" };
        }
        throw err;
      } finally {
        connection.release();
      }
    },
    async getApplication(id) {
      const result = await pool.query("SELECT * FROM wave_applications WHERE id = $1", [id]);
      return normalizeApplication(result.rows[0]);
    },
    async findAcceptedApplication(discordId, robloxUserId) {
      const result = await pool.query(
        `SELECT * FROM wave_applications
         WHERE discord_id = $1 AND roblox_user_id = $2 AND status = 'accepted'
         ORDER BY reviewed_at DESC NULLS LAST, updated_at DESC
         LIMIT 1`,
        [String(discordId), String(robloxUserId)]
      );
      return normalizeApplication(result.rows[0]);
    },
    async updateApplicationContext(id, { applicantThreadId } = {}) {
      const result = await pool.query(
        `UPDATE wave_applications
         SET applicant_thread_id = COALESCE($2, applicant_thread_id), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, applicantThreadId ? String(applicantThreadId) : null]
      );
      return normalizeApplication(result.rows[0]);
    },
    async claimApplication(id, reviewerDiscordId) {
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      const result = await pool.query(
        `UPDATE wave_applications
         SET status = 'processing', status_message = NULL,
             reviewer_discord_id = $2, reviewed_at = NULL, updated_at = NOW()
         WHERE id = $1
           AND (status = 'pending' OR (status = 'processing' AND updated_at <= $3))
         RETURNING *`,
        [id, String(reviewerDiscordId), staleBefore]
      );
      if (result.rows[0]) {
        return { ok: true, application: normalizeApplication(result.rows[0]) };
      }
      const application = await this.getApplication(id);
      return {
        ok: false,
        code: application ? "ALREADY_REVIEWED" : "APPLICATION_NOT_FOUND",
        application,
      };
    },
    async updateApplicationStatus(id, status, statusMessage, reviewerDiscordId = null) {
      const result = await pool.query(
        `UPDATE wave_applications
         SET status = $2, status_message = $3,
             reviewer_discord_id = $4,
             reviewed_at = CASE WHEN $2 IN ('accepted', 'denied') THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, status, statusMessage || null, reviewerDiscordId ? String(reviewerDiscordId) : null]
      );
      return normalizeApplication(result.rows[0]);
    },
  };
}

function createWaveStore() {
  return hasDatabaseUrl ? createPostgresStore() : createMemoryStore();
}

module.exports = {
  createMemoryStore,
  createWaveStore,
  normalizeApplication,
  normalizeSession,
};
