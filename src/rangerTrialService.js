const express = require("express");
const { isAuthorizedRequest } = require("./gameApi");

const CHANNEL_ID = "1415902351985872909";
const uuid = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v);
const snowflake = (v) => /^\d{1,20}$/.test(String(v));

function normalizeRoster(body) {
  if (!uuid(body.id) || !snowflake(body.owner) || !Array.isArray(body.candidates)
      || body.candidates.length < 1 || body.candidates.length > 30) throw new Error("Invalid trial roster.");
  const seen = new Set();
  const candidates = body.candidates.map((row) => {
    const userId = String(row.userId);
    if (!snowflake(userId) || seen.has(userId) || !uuid(row.characterId)
        || !/^\d{1,4}$/.test(String(row.slot))
        || !["Pending", "Pass", "Retest", "Fail"].includes(row.result)) throw new Error("Invalid trial candidate.");
    seen.add(userId);
    return { userId, name: String(row.name || userId).slice(0, 32), slot: String(row.slot), characterId: row.characterId, result: row.result };
  });
  return { id: body.id, owner: String(body.owner), ownerName: String(body.ownerName || body.owner).slice(0, 32), candidates };
}

function createRangerTrialService({ client, apiKey, guildId, canReview, pool } = {}) {
  let ready = false;
  if (!pool && process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: String(process.env.DATABASE_SSL).toLowerCase() === "false" ? false : { rejectUnauthorized: false } });
  }
  const router = express.Router();
  router.use((req, res, next) => {
    if (!isAuthorizedRequest(req, apiKey)) return res.status(401).json({ success: false, error: { message: "Unauthorized" } });
    if (!ready) return res.status(503).json({ success: false, error: { message: "Trial review storage unavailable" } });
    return next();
  });
  const route = (fn) => async (req, res) => {
    try { return res.json({ success: true, data: await fn(req.body || {}) }); }
    catch (err) {
      console.error("[RangerTrials] API operation failed", err.code || err.message);
      return res.status(400).json({ success: false, error: { message: "Trial operation failed; check the roster and retry." } });
    }
  };
  async function postRoster(id) {
    const row = (await pool.query("SELECT * FROM ranger_trial_reviews WHERE id=$1", [id])).rows[0];
    if (!row || row.message_id) return;
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || String(channel.guildId) !== String(guildId) || typeof channel.send !== "function") throw new Error("Trial channel unavailable");
    const roster = row.roster;
    const message = await channel.send({ allowedMentions: { parse: [] }, embeds: [{
      title: "RANGER TRIAL — REVIEW",
      color: 0x79866d,
      description: `Examiner: ${roster.ownerName}\nTrial: \`${id}\`\n\n`
        + roster.candidates.map((p) => `${p.name} · ${p.userId} · slot ${p.slot} — **${p.result}**`).join("\n")
        + "\n\nUse `/ranger-pass` with this trial ID and candidate's Roblox user ID. Pending or Retest candidates can be passed after the trial ends. Offline rewards wait for that character to return.",
    }] });
    await pool.query("UPDATE ranger_trial_reviews SET message_id=$2 WHERE id=$1 AND message_id IS NULL", [id, message.id]);
  }
  router.post("/archive", route(async (body) => {
    const roster = normalizeRoster(body);
    await pool.query("INSERT INTO ranger_trial_reviews(id,roster) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [roster.id, roster]);
    // The immutable first roster controls approvals. Repeated end attempts cannot rewrite it.
    await postRoster(roster.id).catch((err) => console.error("[RangerTrials] Posting deferred", err.code || err.message));
    return { archived: true };
  }));
  router.post("/pending", route(async (body) => {
    if (!Array.isArray(body.users) || body.users.length > 200 || !body.users.every(snowflake)) throw new Error("Invalid users");
    return (await pool.query(`SELECT trial_id AS id,user_id AS "userId",slot,character_id AS "characterId"
      FROM ranger_trial_grants WHERE user_id=ANY($1::text[]) AND applied_at IS NULL ORDER BY created_at LIMIT 200`, [body.users.map(String)])).rows;
  }));
  router.post("/ack", route(async (body) => {
    if (!uuid(body.id) || !snowflake(body.userId) || !uuid(body.characterId)) throw new Error("Invalid receipt");
    await pool.query(`UPDATE ranger_trial_grants SET applied_at=COALESCE(applied_at,NOW())
      WHERE trial_id=$1 AND user_id=$2 AND character_id=$3`, [body.id, String(body.userId), body.characterId]);
    return { received: true };
  }));
  return {
    router,
    async init() {
      if (!pool) throw new Error("DATABASE_URL is required for trial reviews");
      await pool.query(`CREATE TABLE IF NOT EXISTS ranger_trial_reviews (
        id TEXT PRIMARY KEY, roster JSONB NOT NULL, message_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS ranger_trial_grants (
        trial_id TEXT NOT NULL REFERENCES ranger_trial_reviews(id), user_id TEXT NOT NULL, slot TEXT NOT NULL,
        character_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_at TIMESTAMPTZ, PRIMARY KEY(trial_id,user_id));
        CREATE INDEX IF NOT EXISTS ranger_trial_pending ON ranger_trial_grants(user_id) WHERE applied_at IS NULL;`);
      ready = true;
      const retry = async () => {
        const rows = (await pool.query("SELECT id FROM ranger_trial_reviews WHERE message_id IS NULL ORDER BY created_at LIMIT 10")).rows;
        for (const row of rows) await postRoster(row.id);
      };
      void retry().catch(() => {});
      const timer = setInterval(() => void retry().catch(() => {}), 60000);
      timer.unref();
    },
    async handleCommand(interaction) {
      if (interaction.channelId !== CHANNEL_ID || String(interaction.guildId) !== String(guildId)) {
        return interaction.reply({ content: "Use this command in the Ranger trial review channel.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      if (!await canReview(interaction)) return interaction.editReply("You do not have Ranger trial review permission.");
      if (!ready) return interaction.editReply("Trial storage is unavailable. No reward was issued; retry later.");
      const id = interaction.options.getString("trial", true);
      const userId = interaction.options.getString("userid", true);
      if (!uuid(id) || !snowflake(userId)) return interaction.editReply("Use the trial ID and Roblox user ID from the roster.");
      const row = (await pool.query("SELECT roster FROM ranger_trial_reviews WHERE id=$1", [id])).rows[0];
      const candidate = row?.roster?.candidates.find((p) => p.userId === userId);
      if (!candidate) return interaction.editReply("That player is not on this completed trial's roster.");
      if (!["Pending", "Retest"].includes(candidate.result)) return interaction.editReply(`The recorded result is ${candidate.result}; it cannot be passed through this command.`);
      const grant = await pool.query(`INSERT INTO ranger_trial_grants(trial_id,user_id,slot,character_id,reviewer_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING user_id`, [id,userId,candidate.slot,candidate.characterId,interaction.user.id]);
      if (!grant.rowCount) return interaction.editReply("This candidate's pass is already recorded. No duplicate reward was queued.");
      await interaction.editReply(`Pass recorded for ${candidate.name}. Fame membership and Steam equipment will be saved when their trial character is loaded in an updated game server.`);
      await interaction.channel.send({ content: `Ranger trial \`${id}\`: **${candidate.name} (${userId}) passed** · approved by <@${interaction.user.id}>.`, allowedMentions: { parse: [] } });
    },
  };
}

module.exports = { CHANNEL_ID, normalizeRoster, createRangerTrialService };
