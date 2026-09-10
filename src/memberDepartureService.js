const { PALE } = require("./webhookColors");

function createMemberDepartureService({ client, guildId, channelId, verificationDb, waveStore,
  robloxGroupService, store, unwavedRoleId, wavedRoleIds = [], logger = console }) {
  let running = null;
  // Serialize event work with reconciliation so a retry cannot race a fresh removal.
  let queue = Promise.resolve();
  const serialized = work => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };

  async function fetchMember(guild, discordId) {
    try { return await guild.members.fetch({ user: discordId, force: true }); }
    catch (error) {
      if (Number(error.code) === 10007) return null; // Discord: Unknown Member only.
      throw error;
    }
  }

  function isUnwaved(member) {
    return member && !member.user?.bot && member.roles.cache.has(unwavedRoleId)
      && !wavedRoleIds.some(roleId => member.roles.cache.has(roleId));
  }

  async function logJob(job) {
    const channel = await client.channels.fetch(channelId);
    if (channel?.guildId !== guildId || typeof channel.send !== "function") throw new Error("Departure log channel is unavailable in the configured guild.");
    const title = job.reason === "left" ? "LEFT DISCORD" : "UNWAVED ACCESS CLEANUP";
    const payload = {
      allowedMentions: { parse: [] },
      embeds: [{ title: `[${job.username || job.discordId} ${title}]`.slice(0, 256),
        color: job.errorCode ? PALE.yellow : PALE.red,
        description: [`Discord: <@${job.discordId}> (${job.discordId})`,
          job.robloxUserId ? `Roblox: [${job.robloxUsername || job.robloxUserId}](https://www.roblox.com/users/${job.robloxUserId}/profile)` : "Roblox: no saved account link.",
          job.result || "Group removal pending.",
          job.catchUp ? "Detected during membership check; exact departure time is unknown." : "Server departure recorded.",
        ].join("\n"), timestamp: job.observedAt,
      }],
    };
    if (job.messageId) {
      try { await channel.messages.edit(job.messageId, payload); return; }
      catch (error) { if (Number(error.code) !== 10008) throw error; }
    }
    const message = await channel.send(payload);
    job.messageId = message.id;
    await store.save(job);
  }

  async function processJob(guild, job) {
    job.errorCode = null;
    try {
      if (!job.identityResolved) {
        const link = await verificationDb.getVerificationByDiscordId(job.discordId);
        Object.assign(job, { robloxUserId: link?.robloxUserId, robloxUsername: link?.robloxUsername, identityResolved: true });
        await store.save(job);
      }
      if (!job.actionDone) {
        const member = await fetchMember(guild, job.discordId);
        if ((job.reason === "left" && member) || (job.reason === "unwaved" && !isUnwaved(member))) {
          job.result = "Cleanup cancelled: member rejoined or their access changed before removal.";
        } else if (!job.robloxUserId) {
          job.result = "No linked Roblox account; group access could not be checked automatically.";
        } else {
          // Revoke old approvals before group removal so /verifygroup cannot restore access.
          await waveStore.revokeAcceptedApplications(job.discordId, job.robloxUserId);
          const result = await robloxGroupService.removeMember(job.robloxUserId);
          job.result = result.alreadyAbsent ? "Already absent from the Roblox group." : "Unwaved: removed from the Roblox group.";
          job.groupRemoved = Boolean(result.removed);
        }
        job.actionDone = true;
        await store.save(job);
      }
    } catch (error) {
      job.errorCode = String(error.code || "CLEANUP_FAILED");
      job.result = `Automatic cleanup pending (${job.errorCode}). The bot will retry.`;
      logger.error("[MemberDeparture] Cleanup pending", job.discordId, job.errorCode);
      await store.save(job);
    }
    try {
      await logJob(job);
      job.completed = Boolean(job.actionDone);
      await store.save(job);
    } catch (error) {
      logger.error("[MemberDeparture] Log delivery pending", job.discordId, String(error.code || "LOG_FAILED"));
    }
    return job;
  }

  async function reconcile() {
    const guild = await client.guilds.fetch(guildId);
    const summary = { checked: 0, departed: 0, unwaved: 0, removed: 0, alreadyAbsent: 0, failures: 0 };
    for (const job of await store.listPending(guildId)) {
      const result = await processJob(guild, job);
      if (result.errorCode) summary.failures++;
      if (result.groupRemoved) summary.removed++;
    }
    for (const link of await verificationDb.listVerifications()) {
      summary.checked++;
      try {
        const member = await fetchMember(guild, link.discordId);
        if (member && !isUnwaved(member)) continue;
        const reason = member ? "unwaved" : "left";
        summary[member ? "unwaved" : "departed"]++;
        const membership = await robloxGroupService.getMembership(link.robloxUserId);
        if (!membership.isMember) {
          summary.alreadyAbsent++;
          if (!member) await waveStore.revokeAcceptedApplications(link.discordId, link.robloxUserId);
          continue;
        }
        const job = await store.enqueue({ guildId, discordId: link.discordId, reason, catchUp: true,
          robloxUserId: link.robloxUserId, robloxUsername: link.robloxUsername, identityResolved: true,
          username: member?.user?.username || link.robloxUsername,
        });
        const result = await processJob(guild, job);
        if (result.groupRemoved) summary.removed++;
        if (result.errorCode) summary.failures++;
      } catch (error) {
        summary.failures++;
        logger.error("[MemberDeparture] Membership check failed", link.discordId, String(error.code || "CHECK_FAILED"));
      }
    }
    logger.log("[MemberDeparture] Reconciliation", JSON.stringify(summary));
    return summary;
  }

  return {
    init: () => store.init(),
    handleDeparture(member) {
      if (member.guild.id !== guildId) return Promise.resolve();
      return serialized(async () => {
        const job = await store.enqueue({ guildId, discordId: member.id, username: member.user?.username, reason: "left" });
        return processJob(member.guild, job);
      });
    },
    reconcile() {
      if (!running) running = serialized(reconcile).finally(() => { running = null; });
      return running;
    },
  };
}

module.exports = { createMemberDepartureService };
