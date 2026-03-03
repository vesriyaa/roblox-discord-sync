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
const GROUP_ID = process.env.GROUP_ID;

// 🔹 ROLE IDS
const VERIFIED_ROLE_ID = "1477834795512893520";
const MOD_ROLE_ID = "1477872215801331763";

// 🔹 DISCORD ROLE SWAP
const OLD_DISCORD_ROLE = "1415902349192331381";
const NEW_DISCORD_ROLE = "1415902349192331383";

// 🔹 Team → Role mapping
const roleMap = {
  "Crimson Blades": "1477828058949091481",
  "Vanguard": "1477828166025220178",
  "Fame": "1477827943278317660",
  "Chasers": "1477828132269457559"
};

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
      .setDescription("Accept a Roblox group join request")
      .addStringOption(option =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
  );

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("grouprank")
      .setDescription("Change a Roblox member's group rank")
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
  // UNLINK
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

    try {

      const csrfResponse = await fetch("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: {
          "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`
        }
      });

      const csrfToken = csrfResponse.headers.get("x-csrf-token");

      const acceptResponse = await fetch(
        `https://groups.roblox.com/v1/groups/${GROUP_ID}/join-requests/users/${robloxId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
            "x-csrf-token": csrfToken
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

      return interaction.reply({
        content: "✅ User accepted and Discord role updated.",
        ephemeral: true
      });

    } catch (err) {
      console.error("Accept error:", err);
      return interaction.reply({
        content: "❌ Unexpected error occurred.",
        ephemeral: true
      });
    }
  }

  // ===============================
  // GROUP RANK
  // ===============================
  if (interaction.commandName === "grouprank") {

    if (!member.roles.cache.has(MOD_ROLE_ID)) {
      return interaction.reply({
        content: "❌ You do not have permission.",
        ephemeral: true
      });
    }

    const robloxId = interaction.options.getString("robloxid");
    const roleId = interaction.options.getInteger("roleid");

    try {

      const csrfResponse = await fetch("https://auth.roblox.com/v2/logout", {
        method: "POST",
        headers: {
          "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`
        }
      });

      const csrfToken = csrfResponse.headers.get("x-csrf-token");

      const roleResponse = await fetch(
        `https://groups.roblox.com/v1/groups/${GROUP_ID}/users/${robloxId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Cookie": `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
            "x-csrf-token": csrfToken
          },
          body: JSON.stringify({ roleId })
        }
      );

      if (!roleResponse.ok) {
        const errorText = await roleResponse.text();
        return interaction.reply({
          content: `❌ Rank change failed:\n${errorText}`,
          ephemeral: true
        });
      }

      return interaction.reply({
        content: "✅ User rank updated successfully.",
        ephemeral: true
      });

    } catch (err) {
      console.error("Rank error:", err);
      return interaction.reply({
        content: "❌ Unexpected error occurred.",
        ephemeral: true
      });
    }
  }

});


// ===============================
// VERIFY ENDPOINT
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

    if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
      await member.roles.add(VERIFIED_ROLE_ID);
    }

    try {
      await member.send("✅ You have successfully verified your Roblox account!");
    } catch {}

  } catch (err) {
    console.error("Verification error:", err);
  }

  res.json({ discordId });
});

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
client.login(BOT_TOKEN);

app.get("/", (req, res) => {
  res.send("Bot running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});


