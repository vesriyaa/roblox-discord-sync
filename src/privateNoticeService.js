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

  async function sendAccessNotice({ member, kind }) {
    const messages = {
      unwaved: "You have been unwaved from Thornvale. Your removable Discord roles were cleared, only the **Wald** access role was retained, and your Roblox group membership was removed if you were still in the group.",
      unverified: "You have been unverified from Thornvale. Your verification link and Verified/game roles were removed.",
      inactive: "You have been unwaved and unverified from Thornvale because no in-game activity was recorded before the configured cutoff. Your character data has also been queued for wipe.",
    };
    const content = messages[kind];
    if (!content) throw new TypeError(`Unknown access notice kind: ${kind}`);

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
};
