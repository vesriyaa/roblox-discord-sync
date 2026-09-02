const { ChannelType, SlashCommandBuilder } = require("discord.js");

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Verify your Discord account with Roblox OAuth"),

    new SlashCommandBuilder()
      .setName("verification-system")
      .setDescription("Post the Roblox verification panel")
      .addStringOption((option) =>
        option.setName("channelid")
          .setDescription("Optional channel ID or mention")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Unlink a user's Roblox account")
      .addUserOption((option) =>
        option.setName("user")
          .setDescription("User to unlink")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("dm")
      .setDescription("Send a direct message from the Thornvale bot")
      .addUserOption((option) =>
        option.setName("user")
          .setDescription("Discord user to message")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("message")
          .setDescription("Message to send")
          .setMaxLength(1900)
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("getroles")
      .setDescription("Restore your team roles from Roblox"),

    new SlashCommandBuilder()
      .setName("inactive-check")
      .setDescription("Preview or confirm in-game inactivity unwaves")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("preview")
          .setDescription("Preview verified users past the inactivity cutoff")
          .addIntegerOption((option) =>
            option.setName("days")
              .setDescription("Inactive after this many days")
              .setRequired(false)
          )
          .addIntegerOption((option) =>
            option.setName("limit")
              .setDescription("Maximum users to list")
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("near")
          .setDescription("List verified users close to the inactivity cutoff")
          .addIntegerOption((option) =>
            option.setName("days")
              .setDescription("Inactive after this many days")
              .setRequired(false)
          )
          .addIntegerOption((option) =>
            option.setName("within")
              .setDescription("Show users becoming inactive within this many days")
              .setRequired(false)
          )
          .addIntegerOption((option) =>
            option.setName("limit")
              .setDescription("Maximum users to list")
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("confirm")
          .setDescription("Unwave inactive users, remove roles, unlink, and queue wipes")
          .addIntegerOption((option) =>
            option.setName("days")
              .setDescription("Inactive after this many days")
              .setRequired(false)
          )
          .addIntegerOption((option) =>
            option.setName("limit")
              .setDescription("Maximum users to process")
              .setRequired(false)
          )
      ),

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
      .setName("wave")
      .setDescription("Manage Thornvale application waves")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("start")
          .setDescription("Open a timed Thornvale application wave")
          .addStringOption((option) =>
            option.setName("duration")
              .setDescription("Duration: 30m, 1h, 1d, 1h30m, or plain minutes (max 7d)")
              .setMaxLength(32)
              .setRequired(true)
          )
          .addIntegerOption((option) =>
            option.setName("limit")
              .setDescription("Maximum applications accepted by this wave")
              .setMinValue(1)
              .setMaxValue(500)
              .setRequired(true)
          )
          .addChannelOption((option) =>
            option.setName("reviewchannel")
              .setDescription("Private channel where completed applications are logged")
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
          .addChannelOption((option) =>
            option.setName("channel")
              .setDescription("Channel for the public wave panel (defaults to this channel)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("status")
          .setDescription("Show the active or selected wave status")
          .addStringOption((option) =>
            option.setName("waveid")
              .setDescription("Optional Thornvale wave ID")
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("close")
          .setDescription("Close the active or selected wave")
          .addStringOption((option) =>
            option.setName("waveid")
              .setDescription("Optional Thornvale wave ID")
              .setRequired(false)
          )
      ),

    new SlashCommandBuilder()
      .setName("shutdown")
      .setDescription("Shut down all active Thornvale places")
      .addStringOption((option) =>
        option.setName("reason")
          .setDescription("Optional shutdown reason")
          .setRequired(false)
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
  await guild.commands.set(buildSlashCommands());
}

module.exports = {
  registerSlashCommands,
};
