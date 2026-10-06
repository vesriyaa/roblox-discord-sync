function normalize(row) {
  if (!row) return null;
  return {
    id: row.id, guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id,
    title: row.title, description: row.description, startsAt: new Date(row.starts_at).toISOString(),
    status: row.status, locked: row.locked, revision: row.revision, count: Number(row.attendee_count || 0),
  };
}

const SELECT = `SELECT p.*, (SELECT COUNT(*) FROM event_panel_attendees a WHERE a.event_id=p.id) AS attendee_count FROM event_panels p`;
const TERMINAL = new Set(["ended", "cancelled"]);

function createEventPanelStore({ pool } = {}) {
  if (!pool && process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: String(process.env.DATABASE_SSL).toLowerCase() === "false" ? false : { rejectUnauthorized: false } });
  }
  async function transaction(fn) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await fn(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  return {
    async init() {
      if (!pool) throw new Error("Event panels require DATABASE_URL storage.");
      await pool.query(`CREATE TABLE IF NOT EXISTS event_panels (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
        title TEXT NOT NULL, description TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled', locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revision INTEGER NOT NULL DEFAULT 0,
        synced_revision INTEGER NOT NULL DEFAULT -1,
        CHECK(status IN ('scheduled','starting','grace','live','ended','cancelled')));
        CREATE TABLE IF NOT EXISTS event_panel_attendees (
        event_id TEXT NOT NULL REFERENCES event_panels(id), discord_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(event_id,discord_id));
        CREATE TABLE IF NOT EXISTS event_panel_audit (
        id BIGSERIAL PRIMARY KEY,event_id TEXT NOT NULL REFERENCES event_panels(id),
        actor_id TEXT NOT NULL,action TEXT NOT NULL,changes JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE INDEX IF NOT EXISTS event_panels_dirty ON event_panels(updated_at) WHERE synced_revision < revision;`);
    },
    async create(event) {
      return transaction(async (c) => {
        await c.query(`INSERT INTO event_panels(id,guild_id,channel_id,title,description,starts_at,created_by,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, [event.id,event.guildId,event.channelId,event.title,event.description,event.startsAt,event.actorId]);
        await c.query("INSERT INTO event_panel_audit(event_id,actor_id,action) VALUES($1,$2,'create')", [event.id,event.actorId]);
        return normalize((await c.query(`${SELECT} WHERE p.id=$1`, [event.id])).rows[0]);
      });
    },
    async get(reference, guildId) {
      return normalize((await pool.query(`${SELECT} WHERE (p.id=$1 OR p.message_id=$1) AND p.guild_id=$2`, [reference,guildId])).rows[0]);
    },
    async list(guildId) {
      return (await pool.query(`${SELECT} WHERE p.guild_id=$1 ORDER BY p.created_at DESC LIMIT 20`, [guildId])).rows.map(normalize);
    },
    async update(id, guildId, actorId, action, changes) {
      return transaction(async (c) => {
        const row = (await c.query("SELECT * FROM event_panels WHERE id=$1 AND guild_id=$2 FOR UPDATE", [id,guildId])).rows[0];
        if (!row) throw new Error("Event not found.");
        if (TERMINAL.has(row.status)) throw new Error("This event is closed. Create a new panel for another event.");
        if (action === "start" && row.status !== "scheduled") throw new Error("This event has already started.");
        if (["grace", "live"].includes(action) && row.status === "scheduled") throw new Error("Start the event first.");
        const next = { title: row.title, description: row.description, startsAt: row.starts_at, status: row.status, locked: row.locked, ...changes };
        await c.query(`UPDATE event_panels SET title=$2,description=$3,starts_at=$4,status=$5,locked=$6,
          updated_by=$7,updated_at=NOW(),revision=revision+1 WHERE id=$1`, [id,next.title,next.description,next.startsAt,next.status,next.locked,actorId]);
        await c.query("INSERT INTO event_panel_audit(event_id,actor_id,action,changes) VALUES($1,$2,$3,$4)", [id,actorId,action,changes]);
        return normalize((await c.query(`${SELECT} WHERE p.id=$1`, [id])).rows[0]);
      });
    },
    async attend(id, guildId, userId, attending) {
      return transaction(async (c) => {
        const row = (await c.query("SELECT status FROM event_panels WHERE id=$1 AND guild_id=$2 FOR UPDATE", [id,guildId])).rows[0];
        if (!row || row.status !== "scheduled") throw new Error("RSVPs are closed for this event.");
        const result = attending
          ? await c.query("INSERT INTO event_panel_attendees(event_id,discord_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [id,userId])
          : await c.query("DELETE FROM event_panel_attendees WHERE event_id=$1 AND discord_id=$2", [id,userId]);
        if (result.rowCount) await c.query("UPDATE event_panels SET revision=revision+1,updated_at=NOW() WHERE id=$1", [id]);
        return { changed: result.rowCount > 0, attending };
      });
    },
    async dirty() {
      return (await pool.query("SELECT id,guild_id FROM event_panels WHERE synced_revision<revision ORDER BY updated_at LIMIT 50")).rows;
    },
    async sync(id, publish) {
      // A session advisory lock serializes Discord edits across overlapping bot instances.
      const c = await pool.connect();
      let locked = false;
      try {
        locked = (await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`eventpanel:${id}`])).rows[0].locked;
        if (!locked) return null;
        const row = (await c.query(`${SELECT} WHERE p.id=$1`, [id])).rows[0];
        if (!row) return null;
        const event = normalize(row);
        if (row.synced_revision >= row.revision && row.message_id) return event;
        const messageId = await publish(event);
        await c.query("UPDATE event_panels SET message_id=$2,synced_revision=$3 WHERE id=$1", [id,messageId,row.revision]);
        return { ...event, messageId };
      } finally {
        if (locked) await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`eventpanel:${id}`]).catch(() => {});
        c.release();
      }
    },
  };
}

module.exports = { createEventPanelStore };
