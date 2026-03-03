const express = require("express");
const { Client, GatewayIntentBits, SlashCommandBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.API_KEY;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const GROUP_ID = process.env.GROUP_ID;

// 🔹 ROLE IDS
const VERIFIED_ROLE_ID = "1477834795512893520";
const MOD_ROLE_ID = "1477872215801331763";

// 🔹 Team → Role mapping
const roleMap = {
  "Crimson Blades": "1477828058949091481",
  "Vanguard": "1477828166025220178",
  "Fame": "1477827943278317660",
  "Chasers": "1477828132269457559"
};

// In-memory stores
const verificationCodes = new Map();
const unlinkedUsers = new Set();

// ===============================
// BOT READY
// ===============================
client.once("ready", async () => {
  console.log("Bot is online");

  const guild = await client.guilds.fetch(GUILD_ID);

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Get a verification code for Roblox")
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Unlink a user's Roblox account")
      .addUserOption(option =>
        option.setName("user")
          .setDescription("User to unlink")
          .setRequired(true)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("getroles")
      .setDescription("Restore your team roles from Roblox")
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("groupaccept")
      .setDescription("Accept and rank a Roblox group member")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName("roleid")
          .setDescription("Roblox Group Role ID")
          .setRequired(true)
      )
  );
});

// ===============================
// SLASH COMMAND HANDLER
// ===============================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(interaction.user.id);

  // ===============================
  // VERIFY
  // ===============================
  if (interaction.commandName === "verify") {

    if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You are already verified. A moderator must unlink you first.",
        ephemeral: true
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes.set(code, interaction.user.id);

    return interaction.reply({
      content: `Your verification code is: **${code}**\nEnter this in-game.`,
      ephemeral: true
    });
  }

  // ===============================
  // UNLINK (MOD ONLY)
  // ===============================
  if (interaction.commandName === "unlink") {

    if (!member.roles.cache.has(MOD_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You do not have permission to use this command.",
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser("user");
    const targetMember = await guild.members.fetch(targetUser.id);

    try {

      if (targetMember.roles.cache.has(VERIFIED_ROLE_ID)) {
        await targetMember.roles.remove(VERIFIED_ROLE_ID);
      }

      for (const roleId of Object.values(roleMap)) {
        if (targetMember.roles.cache.has(roleId)) {
          await targetMember.roles.remove(roleId);
        }
      }

      unlinkedUsers.add(targetUser.id);

      return interaction.reply({
        content: `✅ Successfully unlinked ${targetUser.tag}`,
        ephemeral: true
      });

    } catch (err) {
      console.error("Unlink error:", err);
      return interaction.reply({
        content: "❌ Failed to unlink user.",
        ephemeral: true
      });
    }
  }

  // ===============================
  // GET ROLES
  // ===============================
  if (interaction.commandName === "getroles") {

    if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You must be verified first.",
        ephemeral: true
      });
    }

    return interaction.reply({
      content: "✅ Your roles will sync automatically when you rejoin Roblox.",
      ephemeral: true
    });
  }

  // ===============================
  // GROUP ACCEPT
  // ===============================
 if (interaction.commandName === "groupaccept") {

  if (!member.roles.cache.has(MOD_ROLE_ID)) {
    return interaction.reply({
      content: "❌ You do not have permission.",
      ephemeral: true
    });
  }

  const robloxId = interaction.options.getString("robloxid");
  const roleId = interaction.options.getInteger("roleid");

  try {

    // ✅ Correct Open Cloud endpoint
    const acceptResponse = await fetch(
      `https://apis.roblox.com/cloud/v2/groups/${GROUP_ID}/joinRequests/${robloxId}`,
      {
        method: "POST",
        headers: {
          "x-api-key": ROBLOX_API_KEY
        }
      }
    );

    if (!acceptResponse.ok) {
      const errorText = await acceptResponse.text();
      return interaction.reply({
        content: `❌ Accept failed:\n${errorText}`,
        ephemeral: true
      });
    }

    // Role update (this endpoint is correct)
    const roleResponse = await fetch(
      `https://apis.roblox.com/groups/v1/groups/${GROUP_ID}/users/${robloxId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ROBLOX_API_KEY
        },
        body: JSON.stringify({ roleId })
      }
    );

    if (!roleResponse.ok) {
      const errorText = await roleResponse.text();
      return interaction.reply({
        content: `❌ Role update failed:\n${errorText}`,
        ephemeral: true
      });
    }

    return interaction.reply({
      content: "✅ User accepted and ranked successfully.",
      ephemeral: true
    });

  } catch (err) {
    console.error("Group accept error:", err);
    return interaction.reply({
      content: "❌ Unexpected error occurred.",
      ephemeral: true
    });
  }
 }
});

// ===============================
// LOGIN
// ===============================
client.login(BOT_TOKEN);

// ===============================
// VERIFY ENDPOINT (Roblox → Bot)
// ===============================
app.post("/verify", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { code } = req.body;
  const discordId = verificationCodes.get(code);

  if (!discordId) {
    return res.status(400).send("Invalid code");
  }

  verificationCodes.delete(code);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
      return res.status(400).send("Already verified");
    }

    await member.roles.add(VERIFIED_ROLE_ID);

    try {
      await member.send("✅ You have successfully verified your Roblox account!");
    } catch {}

  } catch (err) {
    console.error("Verification error:", err);
  }

  res.json({ discordId });
});

// ===============================
// TEAM ROLE SYNC
// ===============================
app.post("/updateRole", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { discordId, team } = req.body;
  if (!discordId || !team) {
    return res.status(400).send("Missing data");
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);

    const newRoleId = roleMap[team];
    if (!newRoleId) {
      return res.status(400).send("Invalid team");
    }

    for (const roleId of Object.values(roleMap)) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }

    await member.roles.add(newRoleId);

    res.send("Role updated");

  } catch (err) {
    console.error("Role update error:", err);
    res.status(500).send("Error assigning role");
  }
});

// ===============================
// CHECK UNLINK
// ===============================
app.post("/checkUnlink", async (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { discordId } = req.body;
  if (!discordId) {
    return res.status(400).send("Missing discordId");
  }

  if (unlinkedUsers.has(discordId)) {
    unlinkedUsers.delete(discordId);
    return res.json({ unlinked: true });
  }

  res.json({ unlinked: false });
});

// ===============================
app.get("/", (req, res) => {
  res.send("Bot running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});



