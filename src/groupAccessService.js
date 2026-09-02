class GroupAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GroupAccessError";
    this.code = code;
  }
}

function createGroupAccessService({
  verificationService,
  waveStore,
  robloxGroupService,
  onAccessGranted = async () => {},
}) {
  if (!verificationService || !waveStore || !robloxGroupService) {
    throw new TypeError("verificationService, waveStore, and robloxGroupService are required");
  }

  return {
    getGroupUrl() {
      return robloxGroupService.getGroupUrl();
    },

    async completeApprovedAccess({ discordId, member }) {
      const verification = await verificationService.lookup({ discordId });
      if (!verification.verified) {
        throw new GroupAccessError(
          "NOT_VERIFIED",
          "Connect your Roblox account before completing group access."
        );
      }

      const application = await waveStore.findAcceptedApplication(
        discordId,
        verification.robloxUserId
      );
      if (!application) {
        throw new GroupAccessError(
          "APPLICATION_NOT_ACCEPTED",
          "An accepted Thornvale wave application is required."
        );
      }

      const membership = await robloxGroupService.getMembership(verification.robloxUserId);
      let acceptedJoinRequest = false;
      if (!membership.isMember) {
        await robloxGroupService.acceptJoinRequest(verification.robloxUserId);
        acceptedJoinRequest = true;
      }

      await onAccessGranted(member, verification);
      return {
        alreadyMember: membership.isMember,
        acceptedJoinRequest,
        application,
        verification,
      };
    },
  };
}

module.exports = {
  GroupAccessError,
  createGroupAccessService,
};
