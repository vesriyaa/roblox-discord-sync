function isAccessManagementChannel(channelId, configuredChannelId) {
  const requiredChannelId = String(configuredChannelId || "").trim();
  return !requiredChannelId || String(channelId || "") === requiredChannelId;
}

module.exports = {
  isAccessManagementChannel,
};
