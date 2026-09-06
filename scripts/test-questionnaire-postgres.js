// Integration test: uses only a newly created random schema, never live bot tables.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createQuestionnaireStore } = require("../src/questionnaireStore");
async function run() {
  assert.ok(process.env.QUESTIONNAIRE_TEST_DATABASE_URL,"Set QUESTIONNAIRE_TEST_DATABASE_URL explicitly to run this test.");
  const config={connectionString:process.env.QUESTIONNAIRE_TEST_DATABASE_URL,
    ssl:String(process.env.DATABASE_SSL).toLowerCase()==="false" ? false : {rejectUnauthorized:false}};
  const schema=`questionnaire_qa_${crypto.randomBytes(8).toString("hex")}`;
  assert.match(schema,/^questionnaire_qa_[a-f0-9]{16}$/);
  const admin=new Pool(config);
  let pool,created=false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);created=true;
    pool=new Pool({...config,options:`-c search_path=${schema},pg_catalog`});
    const store=createQuestionnaireStore({pool});await store.init();
    await store.seedReviewer("guild","reviewer");
    assert.equal(await store.isReviewer("guild","reviewer"),true);
    await store.setReviewer("guild","reviewer","owner",false);
    await store.seedReviewer("guild","reviewer");
    assert.equal(await store.isReviewer("guild","reviewer"),false,"Revocation must survive restart seeding");
    const makeSession=(id,guild="guild")=>store.createSession({id,guildId:guild,channelId:"public",reviewChannelId:"private",createdBy:"owner",endsAt:new Date(Date.now()+86400000).toISOString()});
    await makeSession("session");
    await assert.rejects(makeSession("another"));
    const submission=(id,user=id,extra={})=>({id,sessionId:"session",guildId:"guild",discordId:user,answers:["5","Fixture answer","",""],leaveDurationMs:null,...extra});
    const submitted=await Promise.all(Array.from({length:35},(_,i)=>store.submit(submission(`response${i}`))));
    assert.equal(submitted.filter((r)=>r.ok).length,35);
    const duplicates=await Promise.all(Array.from({length:12},(_,i)=>store.submit(submission(`duplicate${i}`,"same-member"))));
    assert.equal(duplicates.filter((r)=>r.ok).length,1);
    assert.equal((await store.getSession("session")).submissionCount,36);
    assert.equal((await store.submit(submission("wrong-guild","user",{guildId:"other"}))).ok,false);
    const restart=createQuestionnaireStore({pool});await restart.init();
    assert.equal((await restart.getSession("session")).submissionCount,36);
    assert.equal((await restart.getResponse("response0","other")),null);
    const queue=await restart.listUndelivered();
    assert.equal(queue.length,36);
    assert.ok(queue.every((r)=>!("answers" in r) && !("discordId" in r)));
    await restart.markDelivered("response0","queue-message");
    assert.equal((await restart.listUndelivered()).length,35);
    const stale=await store.getSession("session");
    await store.submit(submission("concurrent-counter"));
    await store.markSynced("session",stale.version);
    assert.equal((await store.getSession("session")).needsSync,true,"An older panel update cannot hide a newer count");
    await store.submit(submission("leave","leave-member",{leaveDurationMs:86400000}));
    assert.equal(await store.isOnLeave("guild","leave-member"),false);
    const decisions=await Promise.all([store.decide("leave","guild","r1","approved"),store.decide("leave","guild","r2","approved")]);
    assert.equal(decisions.filter(Boolean).length,1);
    assert.equal(await store.isOnLeave("guild","leave-member"),true);
    assert.equal(await store.isOnLeave("other","leave-member"),false);
    await pool.query("UPDATE questionnaire_responses SET leave_until=NOW()-INTERVAL '1 second' WHERE id='leave'");
    assert.equal(await store.isOnLeave("guild","leave-member"),false);
    await store.submit(submission("denied-leave","denied-member",{leaveDurationMs:86400000}));
    await store.decide("denied-leave","guild","r1","denied");
    assert.equal(await store.isOnLeave("guild","denied-member"),false);
    await store.closeSession("session");
    assert.equal((await store.submit(submission("late"))).ok,false);
    await makeSession("expired");
    await pool.query("UPDATE questionnaire_sessions SET ends_at=NOW()-INTERVAL '1 second' WHERE id='expired'");
    assert.equal((await store.submit(submission("expired-response","last",{sessionId:"expired"}))).ok,false);
    await store.expireSessions();
    assert.equal((await store.getSession("expired")).status,"closed");
    console.log("PostgreSQL integration passed: concurrent submissions, duplicate prevention, restart recovery, staff revocation, private queue, time-off decisions, expiry and count synchronization.");
  } finally {
    if(pool) await pool.end();
    if(created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
if(require.main===module) run().catch(()=>{console.error("Questionnaire PostgreSQL integration failed; no sensitive details logged.");process.exitCode=1;});
module.exports={run};
