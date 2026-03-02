const express = require("express");
const { Client, GatewayIntentBits, SlashCommandBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.API_KEY;

const roleMap = {
  "Crimson Blades": "1477828058949091481",
  "Vanguard": "1477828166025220178",
  "Fame": "1477827943278317660",
  "Chasers": "1477828132269457559"
};

const verificationCodes = new Map(); 
// code -> discordId

client.once("ready", async () => {
  console.log("Bot is online");

  // Register slash command
  const guild = await client.guilds.fetch(GUILD_ID);

  await guild.commands.create(
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Get a verification code for Roblox")
  );
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    verificationCodes.set(code, interaction.user.id);

    await interaction.reply({
      content: `Your verification code is: **${code}**\nEnter this in Roblox.`,
      ephemeral: true
    });
  }
});

client.login(BOT_TOKEN);

app.post("/verify", (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { code } = req.body;

  const discordId = verificationCodes.get(code);

  if (!discordId) {
    return res.status(400).send("Invalid code");
  }

  verificationCodes.delete(code);

  res.json({ discordId });
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

    for (const roleId of Object.values(roleMap)) {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }

    await member.roles.add(newRoleId);

    res.send("Role updated");

  } catch (err) {
    console.error(err);
    res.status(500).send("Error assigning role");
  }
});

app.get("/", (req, res) => {
  res.send("Bot running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});
