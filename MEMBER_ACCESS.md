# Discord departures and Roblox group access

Departures from the configured `GUILD_ID` are logged to `MEMBER_LEAVE_CHANNEL_ID`, defaulting to `1547462516840464444`. The bot needs View Channel, Send Messages, and Embed Links there, plus the Discord Server Members intent. Partial members are supported, so the user need not already be cached.

For a linked departing member, the bot revokes their accepted wave applications and removes their Roblox group membership with the existing group service. An account already outside the group is a successful no-op. Unlinked departures are logged as requiring a manual group check. This does not wipe character data or remove the saved identity link.

Pending cleanup and log delivery are stored in PostgreSQL in `member_departure_jobs`. Failed removals are shown as pending in the channel; retries update the same message. Rejoined members are checked again before removal, and Discord errors other than Unknown Member never count as proof of departure.

On startup and every 15 minutes, reconciliation checks all saved verification links. It catches linked users who left while the bot was offline and members with Wald but none of the configured waved/team roles who still belong to the Roblox group. Current waved members and ungrouped applicants remain unchanged. Catch-up logs explicitly say that the exact departure time is unknown. Historical users without a saved identity link cannot be automatically reconciled.

All embed colors passing through either webhook relay API are softened into pale versions of the original hues. Existing Discord messages are unchanged. Direct webhooks that bypass this service are outside this color conversion.

`npm test` covers departures, absent/unlinked accounts, API errors, retries, rejoining, catch-up rules, revoked approvals, and color preservation. For a read-only live audit, run `node scripts/check-member-access.js` in an environment with access to the database and the bot's existing environment variables.
