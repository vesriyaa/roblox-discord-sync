function uniqueRoleIds(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function toMemberArray(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return Array.from(collection.values());
  return Array.from(collection);
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function createBulkAccessService({
  verificationDb,
  verifiedRoleId,
  envisionedRoleId,
  unwavedRoleId,
  teamRoleIds = [],
  defaultUnwaveExemptRoleIds = [],
  isUnwaveExemptMember = async () => false,
  onVerificationRemoved = async () => {},
  robloxGroupService = null,
}) {
  if (!verificationDb) {
    throw new TypeError("verificationDb is required");
  }

  const unwaveRemovalIds = uniqueRoleIds([envisionedRoleId, ...teamRoleIds])
    .filter((roleId) => roleId !== String(unwavedRoleId || ""));
  const unverifyRemovalIds = uniqueRoleIds([verifiedRoleId, ...teamRoleIds]);
  const defaultExemptRoleIds = uniqueRoleIds(defaultUnwaveExemptRoleIds);

  async function updateMembers(guild, removalIds, {
    addRoleId = null,
    exemptRoleIds = [],
    checkStaffExemption = false,
    replaceAllRoles = false,
    removeFromRobloxGroup = false,
    onMemberUpdated = null,
  } = {}) {
    const fetched = await guild.members.fetch();
    const members = toMemberArray(fetched);
    const candidates = members.filter((member) => (
      !member.user?.bot
      && removalIds.some((roleId) => member.roles.cache.has(roleId))
    ));
    const exemptions = uniqueRoleIds(exemptRoleIds);
    const exemptionChecks = await Promise.all(candidates.map(async (member) => ({
      member,
      exempt: exemptions.some((roleId) => member.roles.cache.has(roleId))
        || (checkStaffExemption && await isUnwaveExemptMember(member)),
    })));
    const targets = exemptionChecks.filter((entry) => !entry.exempt).map((entry) => entry.member);
    const failures = [];
    const notificationFailures = [];
    let updated = 0;
    let notificationsDelivered = 0;
    let groupRemoved = 0;
    let groupAlreadyAbsent = 0;
    let groupUnlinked = 0;
    const groupFailures = [];

    await runWithConcurrency(targets, 5, async (member) => {
      try {
        if (replaceAllRoles && typeof member.roles.set === "function") {
          await member.roles.set(addRoleId ? [addRoleId] : []);
        } else {
          const presentRemovalIds = removalIds.filter((roleId) => member.roles.cache.has(roleId));
          if (presentRemovalIds.length > 0) {
            await member.roles.remove(presentRemovalIds);
          }
          if (addRoleId && !member.roles.cache.has(addRoleId)) {
            await member.roles.add(addRoleId);
          }
        }
        updated += 1;
        if (removeFromRobloxGroup) {
          try {
            const verification = typeof verificationDb.getVerificationByDiscordId === "function"
              ? await verificationDb.getVerificationByDiscordId(member.id)
              : null;
            if (!verification?.robloxUserId) {
              groupUnlinked += 1;
            } else if (typeof robloxGroupService?.removeMember !== "function") {
              groupFailures.push({
                discordId: String(member.id),
                robloxUserId: String(verification.robloxUserId),
                message: "Roblox group removal is not configured.",
              });
            } else {
              const groupResult = await robloxGroupService.removeMember(verification.robloxUserId);
              if (groupResult?.alreadyAbsent) groupAlreadyAbsent += 1;
              else groupRemoved += 1;
            }
          } catch (err) {
            groupFailures.push({
              discordId: String(member.id),
              message: String(err?.message || err).slice(0, 300),
            });
          }
        }
        if (typeof onMemberUpdated === "function") {
          try {
            const notification = await onMemberUpdated(member);
            if (notification) notificationsDelivered += 1;
            else notificationFailures.push({ discordId: String(member.id), message: "No private notice could be delivered." });
          } catch (err) {
            notificationFailures.push({
              discordId: String(member.id),
              message: String(err?.message || err).slice(0, 300),
            });
          }
        }
      } catch (err) {
        failures.push({
          discordId: String(member.id),
          message: String(err?.message || err).slice(0, 300),
        });
      }
    });

    return {
      targeted: targets.length,
      skippedExempt: candidates.length - targets.length,
      updated,
      failures,
      notificationsDelivered,
      notificationFailures,
      groupRemoved,
      groupAlreadyAbsent,
      groupUnlinked,
      groupFailures,
    };
  }

  return {
    async unwaveEveryone(guild, { exemptRoleIds = [], onMemberUpdated } = {}) {
      return updateMembers(guild, unwaveRemovalIds, {
        addRoleId: unwavedRoleId || null,
        exemptRoleIds: [...defaultExemptRoleIds, ...exemptRoleIds],
        checkStaffExemption: true,
        replaceAllRoles: true,
        removeFromRobloxGroup: true,
        onMemberUpdated,
      });
    },

    async unverifyEveryone(guild, { onMemberUpdated } = {}) {
      const roleResult = await updateMembers(guild, unverifyRemovalIds, { onMemberUpdated });
      const deletedLinks = await verificationDb.deleteAllVerifications();
      for (const record of deletedLinks) {
        await onVerificationRemoved(record);
      }
      return {
        ...roleResult,
        linksDeleted: deletedLinks.length,
      };
    },
  };
}

module.exports = {
  createBulkAccessService,
  runWithConcurrency,
};
