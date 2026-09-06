const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, PermissionFlagsBits: P, OverwriteType } = require("discord.js");
const { QUESTIONS, PRIVACY_NOTICE, parseDuration, isRegisteredRecord, readAnswers } = require("./questionnairePolicy");
const PREFIX = "questionnaire|";
const button = (id, label, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(PREFIX + id).setLabel(label).setStyle(style);
const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);
const identifier = () => crypto.randomBytes(12).toString("hex");

function buildPanel(s) {
  const open = s.status === "open" && Date.parse(s.endsAt) > Date.now();
  return { allowedMentions: { parse: [] }, embeds: [new EmbedBuilder()
    .setTitle(open ? "Thornvale Community Check-in" : "Thornvale Community Check-in — Closed")
    .setColor(0x7ba6a0).setDescription(PRIVACY_NOTICE)
    .addFields(...QUESTIONS.map((question, i) => ({ name: `Question ${i + 1} — Optional`, value: question })),
      { name: "Submissions", value: String(s.submissionCount || 0), inline: true },
      { name: "Closes", value: `<t:${Math.floor(Date.parse(s.endsAt) / 1000)}:F>`, inline: true },
      { name: "Need time off?", value: "You can request a break when answering. Approved time off pauses inactivity removal until your approved return date. Everyone in the server can answer; one submission per person." })
    .setFooter({ text: `Questionnaire ${s.id}` })],
  components: [row(button(`begin|${s.id}`, open ? "Answer privately" : "Closed").setDisabled(!open))] };
}

function buildModal(sessionId, leave) {
  const inputs = [
    ["mood", "Optional: How are you doing? (1–10)", TextInputStyle.Short, 2],
    ["mental", "Optional: Mental health / support needed", TextInputStyle.Paragraph, 1000],
    ["harassment", "Optional: Harassment, bullying, or discomfort", TextInputStyle.Paragraph, 1000],
    ["community", "Optional: Safe and welcomed? Staff feedback", TextInputStyle.Paragraph, 1000],
  ];
  if (leave) inputs.push(["leave", "Requested time off (e.g. 7d or 2w)", TextInputStyle.Short, 32]);
  return new ModalBuilder().setCustomId(`${PREFIX}submit|${sessionId}|${leave ? "leave" : "answers"}`)
    .setTitle("Private community check-in").addComponents(...inputs.map(([id,label,style,max]) =>
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label)
        .setStyle(style).setMaxLength(max).setRequired(id === "leave")
        .setPlaceholder(id === "leave" ? "For example: 7d or 2w" : "Optional — you can leave this blank."))));
}

function buildQueuePayload(response) {
  // Channel history never contains answers, author IDs, ratings, or time-off details.
  return { content: `A private check-in is ready for review. Reference: ${response.id}`,
    allowedMentions: { parse: [] }, components: [row(button(`view|${response.id}`, "View privately"))] };
}

function buildPrivateResponse(r) {
  const fields = [
    { name: "Submitted by (private)", value: `<@${r.discordId}> · ${r.discordId}` },
    ...QUESTIONS.map((question, i) => ({ name: question, value: r.answers[i] || "Not shared" })),
    { name: "Time off", value: r.leaveDurationMs ? `Requested: ${Number(r.leaveDurationMs) / 86400000} days\nStatus: ${r.decision}` : "Not requested" },
  ];
  if (r.leaveUntil) fields.push({ name: "Approved until", value: `<t:${Math.floor(Date.parse(r.leaveUntil) / 1000)}:F>` });
  if (r.reviewerId) fields.push({ name: "Reviewed by", value: `<@${r.reviewerId}>` });
  return { allowedMentions: { parse: [] }, content: "Confidential staff view. Do not copy or share these answers outside the approved review team.",
    embeds: [new EmbedBuilder().setTitle("Private community check-in").setColor(0x7ba6a0).addFields(fields).setFooter({ text: r.id })],
    components: r.decision === "pending" ? [row(button(`approve|${r.id}`, "Approve time off", ButtonStyle.Success),
      button(`deny|${r.id}`, "Decline time off", ButtonStyle.Secondary))] : [] };
}

function createQuestionnaireService({ client, store, guildId, getRegisteredAccess, initialReviewerIds = [], logger = console }) {
  let ready = false;
  let reconciling = null;
  let timer;
  async function reply(i, payload) {
    const data = typeof payload === "string" ? { content: payload } : payload;
    const safe = { embeds: [], components: [], allowedMentions: { parse: [] }, ...data };
    return i.deferred || i.replied ? i.editReply(safe) : i.reply({ ...safe, ephemeral: true });
  }
  async function defer(i) { if (!i.deferred && !i.replied) await i.deferReply({ ephemeral: true }); }
  async function member(i) {
    if (i.guildId !== guildId || i.user?.bot) return null;
    const guild = await client.guilds.fetch(guildId);
    return guild.members.fetch({ user: i.user.id, force: true }).catch(() => null);
  }
  async function authorized(i, ownerOnly = false) {
    if (!await member(i)) return false;
    const access = await getRegisteredAccess(i.user.id);
    if (!isRegisteredRecord(access, i.user.id)) return false;
    if (ownerOnly) return (access.record.botRole || access.record.role) === "Owner";
    return store.isReviewer(guildId, i.user.id);
  }
  async function requireReviewer(i, ownerOnly = false) {
    if (await authorized(i, ownerOnly)) return true;
    await reply(i, ownerOnly ? "Only a currently registered Owner can change the approved 21+ reviewer list."
      : "Only registered staff explicitly approved as 21+ reviewers can access this action. No answers were disclosed.");
    return false;
  }
  async function availableSession(i, id) {
    if (!await member(i)) return null;
    const s = await store.getSession(id);
    return s?.guildId === guildId && s.status === "open" && Date.parse(s.endsAt) > Date.now() ? s : null;
  }
  async function reviewOverwrites(guild) {
    const reviewers = await store.listReviewers(guildId);
    const ids = [];
    for (const reviewer of reviewers) {
      const access = await getRegisteredAccess(reviewer.discordId);
      if (isRegisteredRecord(access, reviewer.discordId)) ids.push(reviewer.discordId);
    }
    return [
      { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.EmbedLinks] },
      ...ids.filter((id) => id !== client.user.id).map((id) => ({ id, type: OverwriteType.Member,
        allow: [P.ViewChannel,P.ReadMessageHistory], deny: [P.SendMessages,P.CreatePublicThreads,P.CreatePrivateThreads] })),
    ];
  }
  async function getReviewChannel(i, publicChannel) {
    const guild = await client.guilds.fetch(guildId);
    const supplied = i.options.getChannel("reviewchannel");
    if (supplied) {
      const channel = await guild.channels.fetch(supplied.id);
      if (!channel || channel.type !== ChannelType.GuildText || channel.id === publicChannel.id) throw new Error("Choose a separate private text review channel.");
      const everyone = channel.permissionOverwrites.cache.get(guildId);
      if (!everyone?.deny.has(P.ViewChannel)) throw new Error("The review channel must explicitly deny View Channel to @everyone. Omit reviewchannel to create a locked channel automatically.");
      // Replace only a newly created channel's permissions; never silently rewrite an existing channel.
      return channel;
    }
    return guild.channels.create({ name: "questionnaire-review", type: ChannelType.GuildText,
      topic: "Private check-in review index. Answers open privately only for registered, approved 21+ reviewers.",
      permissionOverwrites: await reviewOverwrites(guild), reason: "Private questionnaire review" });
  }
  async function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      await store.expireSessions();
      for (const s of await store.listSyncSessions()) {
        if (!s.messageId) continue;
        try {
          const channel = await client.channels.fetch(s.channelId);
          if (channel?.guildId !== guildId) continue;
          const message = await channel.messages.fetch(s.messageId);
          await message.edit(buildPanel(s));
          await store.markSynced(s.id,s.version);
        } catch { logger.warn("Questionnaire panel synchronization will retry."); }
      }
      for (const response of await store.listUndelivered()) {
        if (response.guildId !== guildId) continue;
        try {
          const channel = await client.channels.fetch(response.reviewChannelId);
          if (channel?.guildId !== guildId) continue;
          const message = await channel.send(buildQueuePayload(response));
          await store.markDelivered(response.id,message.id);
        } catch { logger.warn("Questionnaire review index delivery will retry."); }
      }
    })().finally(() => { reconciling = null; });
    return reconciling;
  }
  function scheduleSync() { void reconcile().catch(() => logger.warn("Questionnaire synchronization will retry.")); }
  async function command(i) {
    await defer(i);
    if (!ready) return reply(i,"The questionnaire system is unavailable. Staff should check its database connection.");
    if (i.commandName === "time-off") {
      if (!await member(i)) return reply(i,"Use this command in the Thornvale server.");
      const leave = await store.getOwnLeave(guildId,i.user.id);
      return reply(i, !leave ? "You have no time-off request. Request a break through an open community check-in."
        : leave.decision === "approved" ? `Your time off was approved until <t:${Math.floor(Date.parse(leave.leaveUntil)/1000)}:F>. ${Date.parse(leave.leaveUntil)>Date.now() ? "Inactivity removal is paused until then." : "That time-off period has ended."}`
          : `Your time-off request is ${leave.decision}.`);
    }
    const action = i.options.getSubcommand();
    if (action === "reviewer") {
      if (!await requireReviewer(i,true)) return;
      const target = i.options.getUser("user",true);
      const enable = i.options.getBoolean("approved",true);
      if (enable && i.options.getBoolean("confirmed21") !== true) return reply(i,"Confirm that this trusted staff member is 21+ before approving access.");
      if (enable && (target.bot || !isRegisteredRecord(await getRegisteredAccess(target.id),target.id))) return reply(i,"That account must have an active staff registration matching its Discord ID.");
      await store.setReviewer(guildId,target.id,i.user.id,enable);
      let channelUpdateFailed = false;
      for (const channelId of await store.listReviewChannels(guildId)) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.guildId !== guildId) continue;
          if (enable) await channel.permissionOverwrites.edit(target.id, { ViewChannel:true,ReadMessageHistory:true,SendMessages:false }, { type:OverwriteType.Member });
          else if (channel.permissionOverwrites.cache.has(target.id)) await channel.permissionOverwrites.delete(target.id);
        } catch { channelUpdateFailed = true; }
      }
      return reply(i,`Questionnaire review access ${enable ? "approved (confirmed 21+)" : "revoked"} for <@${target.id}>.${channelUpdateFailed ? " Some review-channel permissions need a manual update; answer access is already enforced by the bot." : ""}`);
    }
    if (!await requireReviewer(i)) return;
    if (action === "reviewers") {
      const reviewers = await store.listReviewers(guildId);
      return reply(i,`Approved 21+ reviewers (active staff registration is also required):\n${reviewers.map((r) => `<@${r.discordId}>`).join("\n") || "None"}`);
    }
    if (action === "start") {
      const duration = parseDuration(i.options.getString("duration",true));
      if (!duration) return reply(i,"Use a duration such as 30m, 2h, 14d, or 2w3d (at least one minute). There is no applicant limit or seven-day cap.");
      if (await store.findOpenSession(guildId)) return reply(i,"A questionnaire is already open. Close it before opening another.");
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(i.options.getChannel("channel")?.id || i.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) return reply(i,"Choose a server text channel for the public questionnaire.");
      const review = await getReviewChannel(i,channel);
      let session;
      try {
        session = await store.createSession({ id: identifier(),guildId,channelId:channel.id,reviewChannelId:review.id,
          createdBy:i.user.id,endsAt:new Date(Date.now()+duration).toISOString() });
        const message = await channel.send(buildPanel(session));
        await store.setMessage(session.id,message.id);
      } catch (error) {
        if (session) await store.closeSession(session.id);
        throw error;
      }
      scheduleSync();
      return reply(i,`Questionnaire opened in <#${channel.id}>. Private review index: <#${review.id}>. Everyone can submit once; no total submission limit.`);
    }
    const id = i.options.getString("id");
    let session = id ? await store.getSession(id) : await store.findOpenSession(guildId);
    if (!session || session.guildId !== guildId) return reply(i,"No matching questionnaire found.");
    if (action === "close") { session = await store.closeSession(session.id); scheduleSync(); }
    return reply(i,buildPanel(session));
  }
  async function handleButton(i) {
    if (!i.customId.startsWith(PREFIX)) return false;
    const [,action,id,mode] = i.customId.split("|");
    // Modal buttons cannot be deferred. Their session lookup is a single database query.
    if (!ready) { await reply(i,"Questionnaires are temporarily unavailable."); return true; }
    if (action === "form") {
      if (!await availableSession(i,id)) { await reply(i,"This questionnaire is closed or unavailable."); return true; }
      await i.showModal(buildModal(id,mode === "leave")); return true;
    }
    await defer(i);
    if (action === "begin") {
      if (!await availableSession(i,id)) { await reply(i,"This questionnaire is closed or unavailable."); return true; }
      await reply(i,{ content: `${PRIVACY_NOTICE}\n\n${QUESTIONS.map((q,n) => `${n+1}. ${q}`).join("\n\n")}`,
        components:[row(button(`form|${id}|answers`,"Answer only"),button(`form|${id}|leave`,"Answer + request time off",ButtonStyle.Secondary))] });
      return true;
    }
    if (!["view","approve","deny"].includes(action)) { await reply(i,"Unknown questionnaire action."); return true; }
    if (!await requireReviewer(i)) return true;
    let response = await store.getResponse(id,guildId);
    if (!response) { await reply(i,"This response is unavailable."); return true; }
    if (action !== "view") {
      response = await store.decide(id,guildId,i.user.id,action === "approve" ? "approved" : "denied");
      if (!response) { await reply(i,"This request was already reviewed, or did not request time off."); return true; }
      // Only the requester receives the decision. No public fallback if DMs are closed.
      try {
        const user = await client.users.fetch(response.discordId);
        await user.send({ content: response.decision === "approved"
          ? `Your Thornvale time-off request is approved until <t:${Math.floor(Date.parse(response.leaveUntil)/1000)}:F>. Inactivity removal is paused until then. You can check /time-off privately.`
          : "Your Thornvale time-off request was declined. You can contact an approved staff member privately or check /time-off.", allowedMentions:{parse:[]} });
      } catch { await reply(i,{...buildPrivateResponse(response),content:"Decision saved. Their DMs are closed; they can check /time-off privately."}); return true; }
    }
    await reply(i,buildPrivateResponse(response)); return true;
  }
  async function handleModal(i) {
    if (!i.customId.startsWith(`${PREFIX}submit|`)) return false;
    await defer(i);
    if (!ready) { await reply(i,"Questionnaires are temporarily unavailable; your answers were not saved."); return true; }
    const [,,id,mode] = i.customId.split("|");
    if (!await member(i)) { await reply(i,"Use this questionnaire in the Thornvale server."); return true; }
    let data;
    try { data = readAnswers(i.fields,mode === "leave"); }
    catch (error) { await reply(i,error.message); return true; }
    const result = await store.submit({id:identifier(),sessionId:id,guildId,discordId:i.user.id,...data});
    if (!result.ok) { await reply(i,result.code === "DUPLICATE" ? "You have already submitted this questionnaire." : "This questionnaire closed before your submission arrived. Your answers were not saved."); return true; }
    scheduleSync();
    await reply(i,`Thank you. Your private check-in has been saved.${data.leaveDurationMs ? " Your time-off request is pending staff approval; check /time-off for its status." : ""}`);
    return true;
  }
  async function guarded(handler,i) {
    try { return await handler(i); }
    catch {
      // Discord/SQL errors can contain request bodies. Never log raw errors here.
      logger.warn("Questionnaire operation failed; sensitive request details omitted.");
      await reply(i,"That questionnaire action could not be completed. Please try again; staff can check the bot’s connection.").catch(() => {});
      return true;
    }
  }
  return {
    async init() {
      await store.init();
      for (const id of initialReviewerIds) await store.seedReviewer(guildId,id);
      ready = true;
      await reconcile().catch(() => logger.warn("Questionnaire synchronization will retry."));
      timer = setInterval(scheduleSync,30000); timer.unref?.();
    },
    stop() { clearInterval(timer); },
    handleCommand: (i) => guarded(command,i),
    handleButton: (i) => guarded(handleButton,i),
    handleModal: (i) => guarded(handleModal,i),
    isOnLeave: (guild,discord) => {
      if (!ready) throw new Error("Inactivity actions paused: time-off protection is unavailable.");
      return store.isOnLeave(guild,discord);
    },
    reconcile,
  };
}
module.exports = { createQuestionnaireService, buildPanel, buildModal, buildQueuePayload, buildPrivateResponse };
