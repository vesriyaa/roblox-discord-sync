const QUESTIONS = Object.freeze([
  "How have you been doing recently on a scale of 1–10?",
  "How has your mental health been lately? Is there anything you’ve been struggling with or would like support with?",
  "Have you experienced or witnessed any harassment, bullying, or behavior that made you uncomfortable?",
  "Do you feel safe and welcomed within the community? Is there anything the staff team could improve or help you with?",
]);
const PRIVACY_NOTICE = "Share only what you’re comfortable sharing; every wellbeing question is optional. If you’d rather talk privately, you’re welcome to message an approved staff member you trust. Your submission is anonymous to the public, not to the review team: your Discord identity and answers are available through this bot only to registered, trusted staff explicitly approved as 21+. Answers are not posted in public or staff-channel messages. Discord and the bot’s hosting/database systems process and store this information. This questionnaire is not monitored continuously.";

function parseDuration(value, now = Date.now()) {
  const input = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  let duration = 0;
  if (/^\d+$/.test(input)) duration = Number(input) * units.m;
  else {
    const pattern = /(\d+)([smhdw])/g;
    let cursor = 0;
    for (const match of input.matchAll(pattern)) {
      if (match.index !== cursor) return null;
      duration += Number(match[1]) * units[match[2]];
      cursor = match.index + match[0].length;
    }
    if (!input || cursor !== input.length) return null;
  }
  return Number.isSafeInteger(duration) && duration >= 60000
    && Number.isFinite(new Date(now + duration).getTime()) ? duration : null;
}

function isRegisteredRecord(access, discordId) {
  const record = access?.record;
  return Boolean(access?.configured && !access.error && record?.enabled
    && record.discordIds?.includes(String(discordId))
    && ["Mod", "LoreTeam", "Admin", "Owner"].includes(record.botRole || record.role));
}

function readAnswers(fields, requestsLeave) {
  const answers = ["mood", "mental", "harassment", "community"].map((id) => fields.getTextInputValue(id).trim());
  if (answers.some((answer) => answer.length > 1000)) throw new Error("Please keep each answer within 1,000 characters.");
  if (answers[0] && !/^(?:[1-9]|10)$/.test(answers[0])) throw new Error("Enter a whole number from 1 to 10, or leave the rating blank.");
  const leaveDurationMs = requestsLeave ? parseDuration(fields.getTextInputValue("leave")) : null;
  if (requestsLeave && !leaveDurationMs) throw new Error("Enter a time-off duration such as 7d, 2w, or 1w3d (at least one minute).");
  if (!requestsLeave && answers.every((answer) => !answer)) throw new Error("Please answer at least one question, or select the time-off request option.");
  return { answers, leaveDurationMs };
}

module.exports = { QUESTIONS, PRIVACY_NOTICE, parseDuration, isRegisteredRecord, readAnswers };
