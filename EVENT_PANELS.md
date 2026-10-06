# Event panels

`/eventpanel` posts in channel `1494456631126396988`. Existing `/postpanel`, `/editpanel`, `/postevent`, and `/refreshevent` keep their existing behavior.

Staff need the same LoreTeam-or-higher hierarchy as panel commands, or an explicit `eventpanel` grant in the staff permission sheet. Members can RSVP without Roblox account verification.

## Create and edit

```text
/eventpanel create title:Ranger Trial time:in 2h description:Gather your patrol. Rewards for those who attend.
/eventpanel list
/eventpanel edit event:EVENT_ID title:Evening Ranger Trial description:Updated instructions.
```

The event ID appears in the panel footer and private command reply. The panel's Discord message ID also works. Each event has its own roster. Editing a panel preserves the same post and RSVPs.

Time accepts a Discord timestamp, Unix timestamp in seconds, `in 30m`, `in 2h`, `in 3d`, or an ISO date with timezone such as `2026-10-06T19:30-07:00`. Discord shows the announced time in each viewer's timezone. A planned event stays upcoming until staff start it; there is no automatic start or unsolicited ping.

## Run the event

```text
/eventpanel start event:EVENT_ID
/eventpanel grace event:EVENT_ID
/eventpanel live event:EVENT_ID
/eventpanel lock event:EVENT_ID
/eventpanel unlock event:EVENT_ID
/eventpanel end event:EVENT_ID
/eventpanel cancel event:EVENT_ID
```

Start replaces Attend with a green Join button and closes RSVPs. Green Join returns a private button to open `https://www.roblox.com/games/98469964369358/Thornvale-Sword-and-Shield`. Discord URL buttons cannot use green styling, so this is a two-click flow.

Lock/unlock marks the announced server-access status and disables/enables the panel's Join button. It does not operate Roblox's server lock and cannot revoke a game link somebody already received. Staff still control actual server access in-game. Grace and live change the phase while retaining the lock setting. End and cancel close the panel permanently; create another for a new event.

## Persistence and recovery

PostgreSQL stores event details, unique member RSVPs, and staff-change audit records. Attend is idempotent; Withdraw RSVP removes only the clicking member. Counts refresh after a short debounce. A shared row lock serializes RSVP changes with event starts, preventing late RSVP writes. A per-event advisory lock serializes public-message updates across bot instances. Dirty revisions retry after failed Discord updates and restarts. The original event ID/nonce and recent-message lookup recover uncertain initial sends. Commands report when the saved change is awaiting a public-panel refresh.

No live event is created during deployment or testing. Run `/eventpanel create` when ready to announce one.
