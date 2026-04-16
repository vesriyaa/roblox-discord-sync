const verificationCodes = new Map();
const unlinkedUsers = new Set();
const adminActions = new Map();
const adminActionOrder = [];
const adminActionDedupe = new Map();
const adminActionWaiters = new Map();
const talentLookupRequests = new Map();
const talentLookupOrder = [];
const talentLookupWaiters = new Map();
const eventSessions = new Map();
const eventSessionOrder = [];

module.exports = {
  adminActionDedupe,
  adminActionOrder,
  adminActionWaiters,
  adminActions,
  eventSessionOrder,
  eventSessions,
  talentLookupOrder,
  talentLookupRequests,
  talentLookupWaiters,
  unlinkedUsers,
  verificationCodes,
};
