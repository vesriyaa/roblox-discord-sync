const { randomUUID } = require("crypto");

function createMemberDepartureStore({ pool } = {}) {
  const memory = new Map();
  const db = pool || (process.env.DATABASE_URL ? new (require("pg").Pool)({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  }) : null);
  return {
    async init() {
      if (db) await db.query(`CREATE TABLE IF NOT EXISTS member_departure_jobs (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, discord_id TEXT NOT NULL,
        payload JSONB NOT NULL, completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    },
    async enqueue(payload) {
      // Coalesce retry/catch-up work while an earlier removal is outstanding.
      const pending = (await this.listPending(payload.guildId)).find(job => job.discordId === payload.discordId);
      if (pending) return pending;
      const job = { ...payload, id: randomUUID(), observedAt: new Date().toISOString() };
      await this.save(job);
      return job;
    },
    async save(job) {
      if (!db) { memory.set(job.id, structuredClone(job)); return; }
      await db.query(`INSERT INTO member_departure_jobs (id,guild_id,discord_id,payload,completed)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET payload=$4,completed=$5`,
      [job.id, job.guildId, job.discordId, JSON.stringify(job), Boolean(job.completed)]);
    },
    async listPending(guildId) {
      if (!db) return [...memory.values()].filter(job => job.guildId === guildId && !job.completed).map(job => structuredClone(job));
      const result = await db.query("SELECT payload FROM member_departure_jobs WHERE guild_id=$1 AND NOT completed ORDER BY created_at", [guildId]);
      return result.rows.map(row => row.payload);
    },
  };
}

module.exports = { createMemberDepartureStore };
