const { SlashCommandBuilder } = require("discord.js");

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Get a verification code for Roblox"),

    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Unlink a user's Roblox account")
      .addUserOption((option) =>
        option.setName("user")
          .setDescription("User to unlink")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("getroles")
      .setDescription("Restore your team roles from Roblox"),

    new SlashCommandBuilder()
      .setName("groupaccept")
      .setDescription("Accept a Roblox group join request")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("discorduser")
          .setDescription("Discord @username, mention, or user ID")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("wipe")
      .setDescription("Wipe a Roblox player's data")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("reason")
          .setDescription("Optional wipe reason")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("unwipe")
      .setDescription("Clear a Roblox player's pending wipe flag")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("restore")
      .setDescription("Restore a Roblox player's data from a wipe snapshot")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("snapshot")
          .setDescription("Snapshot ID or latest")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("talents")
      .setDescription("Look up a Roblox player's saved talents")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox username or user ID")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("postpanel")
      .setDescription("Open a panel composer for a target channel")
      .addStringOption((option) =>
        option.setName("channelid")
          .setDescription("Discord channel ID or channel mention")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("editpanel")
      .setDescription("Edit a previously posted panel")
      .addStringOption((option) =>
        option.setName("message")
          .setDescription("Discord message link or channelId:messageId")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("postevent")
      .setDescription("Post an event summary to the event logs channel")
      .addStringOption((option) =>
        option.setName("eventid")
          .setDescription("Event ID from Studio")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("refreshevent")
      .setDescription("Refresh a previously posted event summary")
      .addStringOption((option) =>
        option.setName("eventid")
          .setDescription("Event ID from Studio")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("grouprank")
      .setDescription("Change a Roblox member's group rank")
      .addStringOption((option) =>
        option.setName("robloxid")
          .setDescription("Roblox User ID")
          .setRequired(true)
      )
      .addIntegerOption((option) =>
        option.setName("roleid")
          .setDescription("Roblox Group Role ID")
          .setRequired(true)
      ),
  ];
}

async function registerSlashCommands(guild) {
  for (const command of buildSlashCommands()) {
    await guild.commands.create(command);
  }
}

module.exports = {
  registerSlashCommands,
};
