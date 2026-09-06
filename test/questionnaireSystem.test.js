const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuestionnaireService, buildPanel, buildModal, buildQueuePayload, buildPrivateResponse } = require("../src/questionnaireService");
const { parseDuration, readAnswers, isRegisteredRecord, QUESTIONS } = require("../src/questionnairePolicy");
const { createSpreadsheetPermissionService } = require("../spreadsheetPermissions");
const { registerSlashCommands } = require("../src/registerSlashCommands");

const session = { id:"session",guildId:"guild",channelId:"public",reviewChannelId:"review",messageId:"panel",version:0,
  status:"open",submissionCount:3,endsAt:new Date(Date.now()+86400000).toISOString() };
const response = { id:"response",sessionId:"session",guildId:"guild",discordId:"private-author",answers:["7","PRIVATE_MENTAL","PRIVATE_REPORT","PRIVATE_SAFETY"],leaveDurationMs:86400000,decision:"pending" };
const registered = (id,role="Mod") => ({ configured:true,error:null,record:{enabled:true,discordIds:[id],role} });
function harness(overrides={}) {
  const calls = { reads:0,sends:[],decisions:0,submits:[] };
  const members = new Map([["reviewer",{user:{id:"reviewer"}}],["member",{user:{id:"member"}}]]);
  const channel = {guildId:"guild",messages:{fetch:async()=>({edit:async(p)=>calls.sends.push(p)})},send:async(p)=>{ calls.sends.push(p);return{id:"queue"}; }};
  const store = {init:async()=>{},seedReviewer:async()=>{},expireSessions:async()=>{},listSyncSessions:async()=>[],listUndelivered:async()=>[],
    isReviewer:async(_g,id)=>id==="reviewer",getSession:async()=>session,
    getResponse:async()=>{calls.reads++;return structuredClone(response);},
    submit:async(r)=>{calls.submits.push(r);return{ok:true,response:r};},
    decide:async()=>{calls.decisions++;return{...response,decision:"approved",leaveUntil:new Date(Date.now()+86400000).toISOString()};},
    isOnLeave:async()=>false, ...overrides.store};
  const service = createQuestionnaireService({client:{user:{id:"bot"},guilds:{fetch:async()=>({id:"guild",members:{fetch:async({user})=>members.get(user)}})},
    channels:{fetch:async()=>channel},users:{fetch:async()=>({send:async()=>{throw new Error("DM closed");}})}},store,guildId:"guild",
    getRegisteredAccess:overrides.getRegisteredAccess || (async(id)=>registered(id)),logger:{warn:()=>{}}});
  function interaction(id="reviewer",customId="questionnaire|view|response",guildId="guild") {
    const replies=[];
    return { user:{id},guildId,customId,replies,
      async deferReply(p){assert.equal(p.ephemeral,true);this.deferred=true;},
      async reply(p){assert.equal(p.ephemeral,true);this.replied=true;replies.push(p);},
      async editReply(p){assert.ok(this.deferred || this.replied);replies.push(p);},
      async showModal(m){replies.push(m.toJSON());} };
  }
  return {service,store,calls,interaction,members};
}

test("questionnaires allow durations beyond the wave cap without a participant limit",()=>{
  assert.equal(parseDuration("14d"),14*86400000);
  assert.equal(parseDuration("2w3d"),17*86400000);
  assert.equal(parseDuration("1h30m"),90*60000);
  for(const bad of ["", "0", "30s", "1hbad", "Infinity", "9999999999999999999999w"]) assert.equal(parseDuration(bad),null);
  const payload=JSON.stringify(buildPanel({...session,submissionCount:50001}));
  assert.ok(payload.includes("50001"));
  assert.ok(!payload.includes("Applications Left"));
});
test("no answers or author identity reach public panels or review channel history",()=>{
  for(const payload of [buildPanel(session),buildQueuePayload(response)]) {
    const json=JSON.stringify(payload);
    for(const secret of [response.discordId,...response.answers.slice(1)]) assert.ok(!json.includes(secret));
    assert.deepEqual(payload.allowedMentions,{parse:[]});
  }
  assert.ok(JSON.stringify(buildPrivateResponse(response)).includes("PRIVATE_MENTAL"));
});
test("all requested questions are present and modal answers are optional",()=>{
  const publicText=JSON.stringify(buildPanel(session));
  for(const question of QUESTIONS) assert.ok(publicText.includes(question));
  const modal=buildModal("session",false).toJSON();
  assert.equal(modal.components.length,4);
  assert.ok(modal.components.every((r)=>r.components[0].required===false));
  const leave=buildModal("session",true).toJSON();
  assert.equal(leave.components.length,5);
  assert.equal(leave.components[4].components[0].required,true);
  assert.throws(()=>readAnswers({getTextInputValue:()=>"11"},false),/1 to 10/);
  const fields={getTextInputValue:(key)=>key==="leave" ? "14d" : ""};
  assert.equal(readAnswers(fields,true).leaveDurationMs,14*86400000);
});
test("review access needs exact registered ID, not a matching display name or stale sheet",()=>{
  assert.equal(isRegisteredRecord(registered("reviewer"),"reviewer"),true);
  assert.equal(isRegisteredRecord({...registered("reviewer"),error:"offline"},"reviewer"),false);
  assert.equal(isRegisteredRecord(registered("other"),"reviewer"),false);
  assert.equal(isRegisteredRecord({configured:false,...registered("reviewer"),record:null},"reviewer"),false);
});
test("fresh registration fails closed after a permission-sheet outage or revocation",async()=>{
  let outage=false;
  let enabled=true;
  const permissions=createSpreadsheetPermissionService({url:"https://example.test/roster",fetchImpl:async()=>{
    if(outage) throw new Error("unavailable");
    return {ok:true,json:async()=>[{discordId:"12345",role:"Owner",enabled}]};
  }});
  assert.equal(isRegisteredRecord(await permissions.getRegisteredAccess("12345"),"12345"),true);
  outage=true;
  assert.equal(isRegisteredRecord(await permissions.getRegisteredAccess("12345"),"12345"),false);
  outage=false;enabled=false;
  assert.equal(isRegisteredRecord(await permissions.getRegisteredAccess("12345"),"12345"),false);
});
test("unapproved staff and cross-guild buttons cannot load or review a response",async(t)=>{
  const h=harness();await h.service.init();t.after(()=>h.service.stop());
  for(const i of [h.interaction("member"),h.interaction("reviewer",undefined,"other-guild"),h.interaction("member","questionnaire|approve|response")]) {
    await h.service.handleButton(i);
    assert.ok(!JSON.stringify(i.replies).includes("PRIVATE_"));
  }
  assert.equal(h.calls.reads,0);assert.equal(h.calls.decisions,0);
});
test("approved reviewer sees private answers; removed staff cannot use old buttons",async(t)=>{
  let active=true;
  const h=harness({getRegisteredAccess:async(id)=>active ? registered(id) : {configured:true,record:null}});
  await h.service.init();t.after(()=>h.service.stop());
  const view=h.interaction();await h.service.handleButton(view);
  assert.ok(JSON.stringify(view.replies).includes("PRIVATE_MENTAL"));
  active=false;
  const stale=h.interaction("reviewer","questionnaire|approve|response");await h.service.handleButton(stale);
  assert.equal(h.calls.decisions,0);assert.equal(h.calls.sends.length,0);
});
test("everyone can submit without Roblox verification and only private acknowledgement is returned",async(t)=>{
  const h=harness();await h.service.init();t.after(()=>h.service.stop());
  const i=h.interaction("member","questionnaire|submit|session|leave");
  i.fields={getTextInputValue:(key)=>({mood:"8",mental:"PRIVATE_MENTAL",harassment:"",community:"",leave:"2w"})[key]};
  await h.service.handleModal(i);
  assert.equal(h.calls.submits.length,1);
  assert.equal(h.calls.submits[0].discordId,"member");
  assert.equal(h.calls.submits[0].leaveDurationMs,14*86400000);
  assert.ok(!JSON.stringify(i.replies).includes("PRIVATE_MENTAL"));
});
test("closed and duplicate submissions receive private errors without answer echoes",async(t)=>{
  for(const code of ["CLOSED","DUPLICATE"]) {
    const h=harness({store:{submit:async()=>({ok:false,code})}});await h.service.init();t.after(()=>h.service.stop());
    const i=h.interaction("member","questionnaire|submit|session|answers");
    i.fields={getTextInputValue:(id)=>id==="mood" ? "5" : "PRIVATE_ANSWER"};
    await h.service.handleModal(i);assert.ok(!JSON.stringify(i.replies).includes("PRIVATE_ANSWER"));
    assert.match(i.replies[0].content,code==="CLOSED" ? /closed/ : /already submitted/);
  }
});
test("closed DMs never cause time-off decisions or private answers to be posted publicly",async(t)=>{
  const h=harness();await h.service.init();t.after(()=>h.service.stop());
  const i=h.interaction("reviewer","questionnaire|approve|response");await h.service.handleButton(i);
  assert.equal(h.calls.decisions,1);assert.equal(h.calls.sends.length,0);
  assert.match(i.replies[0].content,/DMs are closed/);
});
test("inactivity actions fail closed until time-off storage is ready",async()=>{
  const h=harness();assert.throws(()=>h.service.isOnLeave("guild","member"),/paused/);
});
test("restart synchronization closes panels and retries only opaque review indexes",async(t)=>{
  const delivered=[];
  const h=harness({store:{listSyncSessions:async()=>[{...session,status:"closed"}],
    markSynced:async()=>{},listUndelivered:async()=>[response],markDelivered:async(id)=>delivered.push(id)}});
  await h.service.init();t.after(()=>h.service.stop());
  assert.equal(h.calls.sends[0].components[0].components[0].data.disabled,true);
  assert.deepEqual(delivered,["response"]);
  assert.ok(!JSON.stringify(h.calls.sends).includes("PRIVATE_"));
});
test("questionnaire and private time-off commands register valid Discord payloads",async()=>{
  let commands;await registerSlashCommands({commands:{set:async(c)=>{commands=c.map((v)=>v.toJSON());}}});
  const q=commands.find((c)=>c.name==="questionnaire");assert.ok(q);
  assert.ok(q.options.find((s)=>s.name==="reviewer"));
  assert.ok(commands.find((c)=>c.name==="time-off"));
});
