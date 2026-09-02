const { ChannelType } = require("discord.js");

function sanitizeThreadName(value) {
  return String(value || "member")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "member";
}

function createPrivateNoticeService({ client, logger = console }) {
  if (!client) {
    throw new TypeError("client is required");
  }

  async function sendDm(member, content) {
    let user = member?.user || null;
    if (!user && typeof client.users?.fetch === "function") {
      user = await client.users.fetch(member?.id).catch(() => null);
    }
    if (!user || typeof user.send !== "function") return null;
    try {
      await user.send({ content });
      return { deliveredBy: "DM", threadId: null };
    } catch (err) {
      logger.error(`Private notice DM failed for ${member?.id || "unknown"}:`, err);
      return null;
    }
  }

  async function createClosedPrivateThread({ channel, member, title, content }) {
    if (
      !channel
      || channel.type !== ChannelType.GuildText
      || typeof channel.threads?.create !== "function"
    ) {
      return null;
    }

    let thread = null;
    try {
      thread = await channel.threads.create({
        name: `${sanitizeThreadName(title)}-${sanitizeThreadName(member.user?.username || member.id)}`.slice(0, 100),
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Private Thornvale access notice for ${member.id}`,
      });
      await thread.members.add(member.id);
      await thread.send({
        content: `<@${member.id}> ${content}\n\n*This is a private Thornvale notice visible only to you and authorized staff.*`,
        allowedMentions: { users: [member.id] },
      });

      if (typeof thread.setLocked === "function") {
        await thread.setLocked(true, "Thornvale access notice delivered").catch((err) => {
          logger.warn(`Could not lock private notice thread ${thread.id}:`, err?.message || err);
        });
      }
      if (typeof thread.setArchived === "function") {
        await thread.setArchived(true, "Thornvale access notice delivered").catch((err) => {
          logger.warn(`Could not archive private notice thread ${thread.id}:`, err?.message || err);
        });
      }
      return { deliveredBy: "private thread", threadId: thread.id };
    } catch (err) {
      logger.error(`Private notice thread failed for ${member.id}:`, err);
      if (thread && typeof thread.setArchived === "function") {
        await thread.setArchived(true, "Private notice setup failed").catch(() => {});
      }
      return null;
    }
  }

  async function sendAccessNotice({ channel, member, kind }) {
    const messages = {
      unwaved: "You have been unwaved from Thornvale. Your removable Discord roles were cleared and only the **Wald** access role was retained.",
      unverified: "You have been unverified from Thornvale. Your verification link and Verified/game roles were removed.",
      inactive: "You have been unwaved and unverified from Thornvale because no in-game activity was recorded before the configured cutoff. Your character data has also been queued for wipe.",
    };
    const content = messages[kind];
    if (!content) throw new TypeError(`Unknown access notice kind: ${kind}`);

    const threadResult = await createClosedPrivateThread({
      channel,
      member,
      title: `thornvale-${kind}-notice`,
      content,
    });
    if (threadResult) return threadResult;
    return sendDm(member, content);
  }

  async function closeApplicationThread({ application, content }) {
    if (!application?.applicantThreadId) {
      return { closed: false, deliveredBy: null };
    }

    try {
      const thread = await client.channels.fetch(application.applicantThreadId);
      if (!thread) return { closed: false, deliveredBy: null };
      if (thread.archived && typeof thread.setArchived === "function") {
        await thread.setArchived(false, "Completing Thornvale group access");
      }
      if (typeof thread.send === "function") {
        await thread.send({
          content: `<@${application.discordId}> ${content}`,
          allowedMentions: { users: [application.discordId] },
        });
      }
      if (typeof thread.setLocked === "function") {
        await thread.setLocked(true, "Thornvale application completed");
      }
      if (typeof thread.setArchived === "function") {
        await thread.setArchived(true, "Thornvale application completed");
      }
      return { closed: true, deliveredBy: "private thread" };
    } catch (err) {
      logger.error(`Application ${application.id} thread closure failed:`, err);
      return { closed: false, deliveredBy: null };
    }
  }

  return {
    closeApplicationThread,
    sendAccessNotice,
  };
}

module.exports = {
  createPrivateNoticeService,
  sanitizeThreadName,
};
