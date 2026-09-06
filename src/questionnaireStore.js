function normalize(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : value,
  ]));
}

function createQuestionnaireStore({ pool } = {}) {
  if (!pool && process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: String(process.env.DATABASE_SSL).toLowerCase() === "false" ? false : { rejectUnauthorized: false } });
  }
  const one = async (sql, args) => normalize((await pool.query(sql, args)).rows[0]);
  async function completeReview(id, guildId, reviewerId, decision = null) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = normalize((await c.query("SELECT * FROM questionnaire_responses WHERE id=$1 AND guild_id=$2 FOR UPDATE", [id,guildId])).rows[0]);
      if (!r || (decision && r.decision !== "pending")) { await c.query("ROLLBACK"); return null; }
      if (!decision && r.decision === "pending") { await c.query("ROLLBACK"); return { code:"PENDING" }; }
      let leave = null;
      if (decision) {
        leave = normalize((await c.query(`INSERT INTO questionnaire_time_off
          (id,guild_id,discord_id,decision,leave_until,reviewed_at,created_at)
          VALUES($1,$2,$3,$4,CASE WHEN $4='approved' THEN NOW()+$5::bigint*INTERVAL '1 millisecond' ELSE NULL END,NOW(),$6)
          RETURNING decision,leave_until`, [id,guildId,r.discordId,decision,r.leaveDurationMs,r.createdAt])).rows[0]);
      }
      await c.query(`INSERT INTO questionnaire_receipts(session_id,discord_id,response_id,completed_at,queue_message_id)
        VALUES($1,$2,$3,NOW(),$4) ON CONFLICT(session_id,discord_id) DO UPDATE SET completed_at=NOW()`, [r.sessionId,r.discordId,id,r.queueMessageId]);
      await c.query("DELETE FROM questionnaire_responses WHERE id=$1 AND guild_id=$2", [id,guildId]);
      await c.query("COMMIT");
      // Never return the deleted answers to a Discord reply or notification.
      return { id,discordId:r.discordId,decision:leave?.decision || "reviewed",leaveUntil:leave?.leaveUntil || null };
    } catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
    finally { c.release(); }
  }
  return {
    type: "postgres",
    async init() {
      if (!pool) throw new Error("Questionnaires require persistent DATABASE_URL storage.");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS questionnaire_reviewers (
          guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, approved_by TEXT NOT NULL,
          approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), active BOOLEAN NOT NULL DEFAULT TRUE,
          PRIMARY KEY(guild_id, discord_id)
        );
        CREATE TABLE IF NOT EXISTS questionnaire_sessions (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          review_channel_id TEXT NOT NULL, message_id TEXT, created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ends_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'open', submission_count INTEGER NOT NULL DEFAULT 0,
          needs_sync BOOLEAN NOT NULL DEFAULT TRUE, version INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS questionnaire_one_open_per_guild
          ON questionnaire_sessions(guild_id) WHERE status = 'open';
        CREATE TABLE IF NOT EXISTS questionnaire_responses (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES questionnaire_sessions(id),
          guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, answers JSONB NOT NULL,
          leave_duration_ms BIGINT, decision TEXT NOT NULL, leave_until TIMESTAMPTZ,
          reviewer_id TEXT, reviewed_at TIMESTAMPTZ, queue_message_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id, discord_id)
        );
        CREATE INDEX IF NOT EXISTS questionnaire_active_leave
          ON questionnaire_responses(guild_id, discord_id, leave_until) WHERE decision = 'approved';
        CREATE TABLE IF NOT EXISTS questionnaire_receipts (
          session_id TEXT NOT NULL REFERENCES questionnaire_sessions(id), discord_id TEXT NOT NULL,
          response_id TEXT NOT NULL UNIQUE, completed_at TIMESTAMPTZ, queue_message_id TEXT,
          PRIMARY KEY(session_id,discord_id)
        );
        CREATE TABLE IF NOT EXISTS questionnaire_time_off (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, discord_id TEXT NOT NULL,
          decision TEXT NOT NULL, leave_until TIMESTAMPTZ, reviewed_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS questionnaire_time_off_active
          ON questionnaire_time_off(guild_id,discord_id,leave_until) WHERE decision='approved';
        INSERT INTO questionnaire_receipts(session_id,discord_id,response_id,completed_at,queue_message_id)
          SELECT session_id,discord_id,id,CASE WHEN decision IN ('approved','denied') THEN reviewed_at ELSE NULL END,queue_message_id
          FROM questionnaire_responses ON CONFLICT(session_id,discord_id) DO UPDATE
          SET completed_at=COALESCE(questionnaire_receipts.completed_at,EXCLUDED.completed_at);
        INSERT INTO questionnaire_time_off(id,guild_id,discord_id,decision,leave_until,reviewed_at,created_at)
          SELECT id,guild_id,discord_id,decision,leave_until,reviewed_at,created_at FROM questionnaire_responses
          WHERE decision IN ('approved','denied') AND reviewed_at IS NOT NULL ON CONFLICT DO NOTHING;
        -- Previously decided time-off submissions have already been reviewed.
        DELETE FROM questionnaire_responses WHERE decision IN ('approved','denied') AND reviewed_at IS NOT NULL;
        -- Refresh existing dashboards, including closed rounds, after deployment.
        UPDATE questionnaire_sessions SET needs_sync=TRUE,version=version+1;
      `);
    },
    async seedReviewer(guildId, discordId) {
      await pool.query("INSERT INTO questionnaire_reviewers(guild_id,discord_id,approved_by) VALUES($1,$2,'initial-owner-confirmation') ON CONFLICT DO NOTHING", [guildId, discordId]);
    },
    async setReviewer(guildId, discordId, approvedBy, active) {
      await pool.query(`INSERT INTO questionnaire_reviewers(guild_id,discord_id,approved_by,active) VALUES($1,$2,$3,$4)
        ON CONFLICT(guild_id,discord_id) DO UPDATE SET active=$4,approved_by=$3,approved_at=NOW()`, [guildId, discordId, approvedBy, active]);
    },
    async listReviewers(guildId) {
      return (await pool.query("SELECT * FROM questionnaire_reviewers WHERE guild_id=$1 AND active=TRUE", [guildId])).rows.map(normalize);
    },
    async listReviewChannels(guildId) {
      return (await pool.query("SELECT DISTINCT review_channel_id FROM questionnaire_sessions WHERE guild_id=$1", [guildId])).rows.map((r) => r.review_channel_id);
    },
    async isReviewer(guildId, discordId) {
      return Boolean(await one("SELECT discord_id FROM questionnaire_reviewers WHERE guild_id=$1 AND discord_id=$2 AND active=TRUE", [guildId, discordId]));
    },
    async expireSessions() {
      await pool.query("UPDATE questionnaire_sessions SET status='closed',needs_sync=TRUE,version=version+1 WHERE status='open' AND ends_at<=NOW()");
    },
    async createSession(s) {
      await this.expireSessions();
      return one(`INSERT INTO questionnaire_sessions(id,guild_id,channel_id,review_channel_id,created_by,ends_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [s.id,s.guildId,s.channelId,s.reviewChannelId,s.createdBy,s.endsAt]);
    },
    async getSession(id) { return one("SELECT * FROM questionnaire_sessions WHERE id=$1", [id]); },
    async findOpenSession(guildId) {
      await this.expireSessions();
      return one("SELECT * FROM questionnaire_sessions WHERE guild_id=$1 AND status='open'", [guildId]);
    },
    async setMessage(id, messageId) {
      await pool.query("UPDATE questionnaire_sessions SET message_id=$2,needs_sync=TRUE WHERE id=$1", [id,messageId]);
    },
    async closeSession(id) {
      return one("UPDATE questionnaire_sessions SET status='closed',needs_sync=TRUE,version=version+1 WHERE id=$1 RETURNING *", [id]);
    },
    async listSyncSessions() {
      return (await pool.query("SELECT * FROM questionnaire_sessions WHERE needs_sync=TRUE")).rows.map(normalize);
    },
    async markSynced(id, version) {
      await pool.query("UPDATE questionnaire_sessions SET needs_sync=FALSE WHERE id=$1 AND version=$2", [id,version]);
    },
    async submit(r) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const session = normalize((await c.query("SELECT * FROM questionnaire_sessions WHERE id=$1 FOR UPDATE", [r.sessionId])).rows[0]);
        if (!session || session.guildId !== r.guildId || session.status !== "open" || Date.parse(session.endsAt) <= Date.now()) {
          await c.query("ROLLBACK"); return { ok: false, code: "CLOSED" };
        }
        const receipt = (await c.query(`INSERT INTO questionnaire_receipts(session_id,discord_id,response_id)
          VALUES($1,$2,$3) ON CONFLICT(session_id,discord_id) DO NOTHING RETURNING response_id`, [r.sessionId,r.discordId,r.id])).rows[0];
        if (!receipt) { await c.query("ROLLBACK"); return { ok:false,code:"DUPLICATE" }; }
        const response = normalize((await c.query(`INSERT INTO questionnaire_responses
          (id,session_id,guild_id,discord_id,answers,leave_duration_ms,decision) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(session_id,discord_id) DO NOTHING RETURNING *`,
        [r.id,r.sessionId,r.guildId,r.discordId,JSON.stringify(r.answers),r.leaveDurationMs,r.leaveDurationMs ? "pending" : "received"])).rows[0]);
        if (!response) { await c.query("ROLLBACK"); return { ok: false, code: "DUPLICATE" }; }
        await c.query("UPDATE questionnaire_sessions SET submission_count=submission_count+1,needs_sync=TRUE,version=version+1 WHERE id=$1", [r.sessionId]);
        await c.query("COMMIT");
        return { ok: true, response };
      } catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
      finally { c.release(); }
    },
    async getResponse(id, guildId) {
      return one("SELECT * FROM questionnaire_responses WHERE id=$1 AND guild_id=$2", [id,guildId]);
    },
    async listUndelivered() {
      // Do not even load answers into the channel delivery worker.
      return (await pool.query(`SELECT r.id,r.session_id,r.guild_id,s.review_channel_id
        FROM questionnaire_responses r JOIN questionnaire_sessions s ON s.id=r.session_id
        WHERE r.queue_message_id IS NULL ORDER BY r.created_at LIMIT 100`)).rows.map(normalize);
    },
    async markDelivered(id, messageId) {
      await pool.query(`WITH receipt AS (
        UPDATE questionnaire_receipts SET queue_message_id=$2 WHERE response_id=$1 RETURNING response_id
      ) UPDATE questionnaire_responses SET queue_message_id=$2 WHERE id IN (SELECT response_id FROM receipt)`, [id,messageId]);
    },
    async listCompletedQueue() {
      return (await pool.query(`SELECT r.response_id AS id,r.queue_message_id,s.guild_id,s.review_channel_id
        FROM questionnaire_receipts r JOIN questionnaire_sessions s ON s.id=r.session_id
        WHERE r.completed_at IS NOT NULL AND r.queue_message_id IS NOT NULL LIMIT 100`)).rows.map(normalize);
    },
    async markQueueCleaned(id) {
      await pool.query("UPDATE questionnaire_receipts SET queue_message_id=NULL WHERE response_id=$1 AND completed_at IS NOT NULL", [id]);
    },
    async decide(id, guildId, reviewerId, decision) {
      if (!["approved","denied"].includes(decision)) throw new Error("Invalid decision");
      return completeReview(id,guildId,reviewerId,decision);
    },
    finishReview: (id,guildId,reviewerId) => completeReview(id,guildId,reviewerId),
    async isOnLeave(guildId, discordId) {
      return Boolean(await one(`SELECT id FROM questionnaire_time_off WHERE guild_id=$1 AND discord_id=$2
        AND decision='approved' AND leave_until>NOW() LIMIT 1`, [guildId,discordId]));
    },
    async getOwnLeave(guildId, discordId) {
      return one(`SELECT decision,leave_until,reviewed_at FROM (
        SELECT decision,leave_until,reviewed_at,created_at FROM questionnaire_time_off WHERE guild_id=$1 AND discord_id=$2
        UNION ALL SELECT decision,leave_until,reviewed_at,created_at FROM questionnaire_responses
        WHERE guild_id=$1 AND discord_id=$2 AND leave_duration_ms IS NOT NULL
      ) requests ORDER BY created_at DESC LIMIT 1`, [guildId,discordId]);
    },
  };
}
module.exports = { createQuestionnaireStore, normalize };
