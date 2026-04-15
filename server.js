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
const WALD_ROLE_ID = "1415902349192331381";
const ENVISIONED_ROLE_ID = "1415902349192331383";

// 🔹 Team → Role mapping
const roleMap = {
  "Crimson Blades": "1477828058949091481",
  "Vanguard": "1477828166025220178",
  "Fame": "1477827943278317660",
  "Chasers": "1477828132269457559"
};

const verificationCodes = new Map();
const unlinkedUsers = new Set();

async function resolveDiscordMember(guild, input) {
  const rawInput = input.trim();
  const mentionMatch = rawInput.match(/^<@!?(\d+)>$/);
  const discordId = mentionMatch?.[1] ?? (/^\d+$/.test(rawInput) ? rawInput : null);

  if (discordId) {
    try {
      return await guild.members.fetch(discordId);
    } catch {
      return null;
    }
  }

  const normalizedInput = rawInput.replace(/^@/, "").toLowerCase();
  const members = await guild.members.fetch();

  return members.find((guildMember) => {
    const { user, displayName } = guildMember;
    const tag = user.discriminator === "0"
      ? user.username
      : `${user.username}#${user.discriminator}`;

    return user.username.toLowerCase() === normalizedInput
      || user.tag.toLowerCase() === normalizedInput
      || tag.toLowerCase() === normalizedInput
      || user.globalName?.toLowerCase() === normalizedInput
      || displayName?.toLowerCase() === normalizedInput;
  }) ?? null;
}

async function updateGroupAcceptRoles(member) {
  if (member.roles.cache.has(WALD_ROLE_ID)) {
    await member.roles.remove(WALD_ROLE_ID);
  }

  if (!member.roles.cache.has(ENVISIONED_ROLE_ID)) {
    await member.roles.add(ENVISIONED_ROLE_ID);
  }
}

function sendInteractionResponse(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }

  return interaction.reply({
    content,
    ephemeral: true
  });
}


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
      .addStringOption(option =>
        option.setName("discorduser")
          .setDescription("Discord @username, mention, or user ID")
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
      await interaction.deferReply({ ephemeral: true });

      if (targetMember.roles.cache.has(VERIFIED_ROLE_ID)) {
        await targetMember.roles.remove(VERIFIED_ROLE_ID);
      }

      for (const roleId of Object.values(roleMap)) {
        if (targetMember.roles.cache.has(roleId)) {
          await targetMember.roles.remove(roleId);
        }
      }

      unlinkedUsers.add(targetUser.id);

      return sendInteractionResponse(interaction, `✅ Successfully unlinked ${targetUser.tag}`);

    } catch (err) {
      console.error("Unlink error:", err);
      return sendInteractionResponse(interaction, "❌ Failed to unlink user.");
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
    const discordUserInput = interaction.options.getString("discorduser");
    const targetMember = await resolveDiscordMember(guild, discordUserInput);

    if (!targetMember) {
      return interaction.reply({
        content: "Could not find that Discord user.",
        ephemeral: true
      });
    }

    try {
      await interaction.deferReply({ ephemeral: true });

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
        return sendInteractionResponse(interaction, `❌ Accept failed:\n${errorText}`);
      }

      try {
        await updateGroupAcceptRoles(targetMember);
      } catch (roleError) {
        console.error("Group accept role update error:", roleError);
        return sendInteractionResponse(interaction, `User accepted, but Discord roles could not be updated for ${targetMember.user.tag}.`);
      }

      return sendInteractionResponse(interaction, `User accepted. Envisioned was applied and Wald was removed for ${targetMember.user.tag}.`);

    } catch (err) {
      console.error("Accept error:", err);
      return sendInteractionResponse(interaction, "❌ Unexpected error occurred.");
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
      await interaction.deferReply({ ephemeral: true });

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
        return sendInteractionResponse(interaction, `❌ Rank change failed:\n${errorText}`);
      }

      return sendInteractionResponse(interaction, "✅ User rank updated successfully.");

    } catch (err) {
      console.error("Rank error:", err);
      return sendInteractionResponse(interaction, "❌ Unexpected error occurred.");
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

    // Remove existing team roles
    for (const roleId of Object.values(roleMap)) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }

    // Add correct role
    await member.roles.add(newRoleId);

    res.send("Role updated");

  } catch (err) {
    console.error("Role update error:", err);
    res.status(500).send("Error assigning role");
  }
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



