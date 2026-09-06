# Private community check-ins

Start a round with `/questionnaire start duration:14d channel:#community`. Durations accept minutes or `s`, `m`, `h`, `d`, `w` combinations such as `2w3d`. There is no wave-style seven-day cap or applicant limit. Each server member may submit once per round, without Roblox verification. `/questionnaire status` shows the active round and `/questionnaire close` ends it early; either accepts a saved `id` for older rounds.

The public dashboard shows the privacy/deletion notice, closing date, submission count, and **Answer privately**. The questions appear only in the member's private introduction and form. Members choose **Answer only** or **Answer + request time off**. Wellbeing questions are optional. Time-off requests supply a duration such as `7d` or `2w`; the approved period starts when a reviewer approves it.

Omit `reviewchannel` to create a locked `questionnaire-review` channel. An existing review channel must be a separate text channel with an explicit @everyone View Channel denial. The bot does not rewrite an existing channel’s permissions. The review index contains opaque response references and **View privately** buttons; no answers, ratings, Discord identities, or time-off details are placed in channel history. Authorized reviewers open those details in an ephemeral bot response.

## Who can review

The initial reviewer is `1061349305115496449` (rysinoa), explicitly confirmed by the owner as trusted and 21+. This is inserted only once; revocations survive restarts. The bot does not independently verify anyone’s age.

Every private view and approval checks all of:

- The interaction and member belong to the configured server.
- A fresh permission-sheet fetch succeeds, and an enabled staff record matches the exact Discord ID.
- The account is explicitly approved in the questionnaire reviewer list.

Discord roles, Administrator permission, display-name matches, and stale permission-sheet data do not grant answer access. Even a server administrator who can bypass channel privacy only sees the opaque index without approval through the bot. Answers do not appear in ordinary channel messages or logs.

Use `/questionnaire reviewers` to view the approved list. A registered Owner can run `/questionnaire reviewer user:@staff approved:true confirmed21:true` after confirming that person is trusted and at least 21. Use `approved:false` to revoke. The bot updates that member’s explicit access to existing review channels; if it lacks permission, it reports the channel update failure while enforcing answer access immediately.

“Anonymous to the public” is not full anonymity: approved reviewers can see the submitting Discord account for follow-up and time-off handling. Discord, the hosting provider, and database operators process/store the information. The panel explains this before submission. Do not promise anonymity from the review team or uninterrupted monitoring.

## Time off

In the private response, **Approve + finish review** and **Decline + finish review** are available for pending time-off requests. Other submissions have **Finish review + delete answers**. These actions delete the entire questionnaire response row and answers from the live database in the same transaction as saving any time-off decision. Only one reviewer can complete it. Opening a response alone does not finish the review. The bot clears the current private answer view and removes the review-index button; cleanup retries after Discord failures. The bot DMs time-off decisions without quoting answers. If DMs are closed, there is no public fallback; the requester can use `/time-off` privately.

Only approved, unexpired time off exempts the user from `/inactive-check preview`, `near`, and `confirm`. The confirmation loop rechecks before queuing wipes or changing roles. If the questionnaire database is unavailable, inactivity actions fail closed. Pending/denied/expired requests are not exemptions. This does not block manual moderation, bulk unwaving, or game-specific systems outside this bot.

## Persistence and operations

`DATABASE_URL` is required; there is no volatile-memory fallback. Unreviewed responses remain available until staff finish reviewing them. Completed responses and their answers are deleted, including previously approved/declined time-off submissions migrated at startup. A separate minimal receipt retains session/Discord IDs, an opaque response reference and completion status to prevent duplicate submissions and preserve the aggregate count. Separate time-off records retain Discord ID, decision, return date and timestamps so inactivity protection and private status checks continue working. Neither contains questionnaire answers. Existing Discord copies or provider backups may persist; this is deletion from the live database, not a promise to erase all external copies.

A 30-second reconciliation worker closes expired rounds, updates counts, and retries missing review-index posts after restarts or Discord failures. Submission uniqueness and counters use a database transaction, and decisions use an atomic update. An old panel edit cannot mark a newer counter version synchronized. A failed index send does not lose a saved response.

`npm test` covers privacy, authorization, forms, submission failure paths, and synchronization. For real PostgreSQL checks, explicitly set `QUESTIONNAIRE_TEST_DATABASE_URL` and run `node scripts/test-questionnaire-postgres.js`. The test creates and drops only a random `questionnaire_qa_*` schema; it never uses live response tables or sends Discord messages.
