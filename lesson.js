"use strict";

/* ============================================================
   오늘의 오디오 수업 — daily audio lesson
   Builds a spoken lesson out of today's interpreter log: Gemini
   writes the content, a TTS engine speaks it, the app assembles
   one audio track and keeps the on-screen script in sync.

   Loads after app.js and reuses its globals: settings, el, $,
   jget, jset, esc, callPlain, todaysEntries, todayKey, studyDate,
   spanishOf, koreanOf, openDlg, closeDlg, setStatus, showError,
   openSettings, busy, recording.
   ============================================================ */

const LESSON_KEY = "interp.lesson";
const LESSON_DEFAULTS = {
  engine: "device", ttsKey: "",
  /* One Spanish voice and one Korean voice, chosen once and then remembered,
     so every lesson — phone, PC or exported file — is read by the same two. */
  voiceEs: "", voiceEsCode: "", voiceKo: "", voiceKoCode: "",
  sexEs: "female", sexKo: "female",
  devVoiceEs: "", devVoiceKo: "",
  chars: { ym: "", n: 0 },
  /* lesson length in minutes, 10 or 20; a saved setting without it reads as 10 */
  minutes: 10
};
let lset = Object.assign({}, LESSON_DEFAULTS, jget(LESSON_KEY, {}));
function lpersist(){ jset(LESSON_KEY, lset); }
const lessonMinutes = () => (Number(lset.minutes) === 20 ? 20 : 10);

const TTS_URL = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const TTS_VOICES_URL = "https://texttospeech.googleapis.com/v1/voices";
/* One rate for the whole track, asked for explicitly: the two voices may have
   different natural rates and mixing them would shift the pitch of one. */
const TTS_SR = 24000;
const MP3_KBPS = 64;
const TTS_CONCURRENCY = 3;
const KEEP_LESSONS = 7;

/* An mp3 round trip is not sample-exact. LAME prepends 576 samples of encoder
   delay and the decoder adds its own filterbank lag, so what <audio> reports
   as currentTime runs ahead of the timeline we built: measured at 46.04 ms for
   this 24 kHz mono stream (1105 samples / 24000). The highlight therefore
   looks up currentTime - MP3_DELAY_MS, and every seek adds it back, so tapping
   a row still lands on that row rather than the one above it. */
const MP3_DELAY_MS = 46;
/* silence at the head of an mp3 lesson, for a Bluetooth link waking up */
const LEAD_PAD_SEC = 0.4;

const SCRIPT_TIMEOUT_MS = 150000;   // writing the script is one long reasoning call
/* Claude streams the same script; it is slower per token than Flash, so it gets
   its own, longer deadline. 64k of the model's 128k output cap: twice Gemini's
   32k, because Claude's thinking is counted inside the same cap. */
const CLAUDE_SCRIPT_TIMEOUT_MS = 360000;
const CLAUDE_SCRIPT_MAX_TOKENS = 64000;
const CLAUDE_ASK_TIMEOUT_MS = 60000;
const CLAUDE_ASK_MAX_TOKENS = 8000;

const SLOW_RATE = 0.72;        // the one deliberately slow read of a whole sentence
const SPEED_STEPS = [0.8, 1, 1.2];

/* Pauses, in seconds, after each spoken segment. */
const P = {
  intro: 1.5,
  lead: 0.6,
  wordEs: 2.0, wordKo: 0.8, wordKoLast: 1.2,
  sentLead: 0.5, sentSlow: 1.2, sentMean: 1.0,
  note: 0.5, chunkEs: 1.5, chunkKo: 0.6,
  en: 0.6,                     // the one-line English comparison
  frameEs: 1.6, frameKo: 0.8,  // a frame, an example, one person of a frame
  tableLead: 0.4,
  full: 4.0,
  reviewEs: 0.6, reviewKo: 0.8,
  outro: 0.4,
  quizThink: 3.0,              // 0교시: the Korean meaning, then time to say it yourself
  quizFollow: 2.0,             // after the Spanish answer, time to repeat it
  guess: 2.0,                  // «맞혀 보세요»: the gap before the answer
  oneEs: 0.9, oneMean: 0.5,    // 4교시, one word of a sentence
  why: 0.6,
  section: 1.0                 // added on top, at a section boundary
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanStr = (v) => (typeof v === "string" ? v.trim() : "");

/* ---------------- Korean ordinals ---------------- */

const ORD_ONES = ["", "첫", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const ORD_TENS = ["", "열", "스물", "서른", "마흔", "쉰"];

function ordKo(n){
  n = Math.round(n);
  if (n < 1 || n > 59) return n + "번";
  const t = Math.floor(n / 10), o = n % 10;
  if (!t) return ORD_ONES[o] + " 번째";
  let s = ORD_TENS[t];
  if (o) s += (o === 1 ? "한" : o === 2 ? "두" : ORD_ONES[o]);
  return s + " 번째";
}

/* ---------------- lesson content from the AI ----------------
   One call writes the material of a 10- or 20-minute, five-part audio lesson
   (lset.minutes); the app builds the timeline (parts, repetitions, silences to
   answer in, sound cues) in code — see lessonBuild. The prompt differs only in
   the minutes, the part clock and how much story and challenge to write. */

function lessonPrompt(minutes){
  const A = lessonLength(minutes).ai;
  return [
  "You are a Spanish instructional designer with ten years of experience building lively, immersive",
  "audio lessons. You write the MATERIAL of one " + A.min + "-minute audio lesson. The learner is a Korean who",
  "runs a Korean restaurant in Mexico, a complete beginner, who listens in the car and on the phone",
  "and is expected to ANSWER OUT LOUD. The app builds the timeline in code — the five parts, the",
  "repetitions, the silences to answer in, the sound cues. You choose and write what goes in.",
  "",
  "Input: one JSON object:",
  "  today        — everything they interpreted today: es (Spanish), ko (Korean), an optional",
  "                 tip, and the study chunks they already saw. It may be EMPTY.",
  "  new_words    — up to ten queued words for the beginner, in course order (may be empty).",
  "  grammar_step — today's grammar topic: title, core (what to teach), how (how to explain it).",
  "  pronoun_hits — today's Spanish lines where the app spotted lo/la/le/se/me/te (may be empty).",
  "  recent       — what lessons of the last few days already taught: idioms, frames, words",
  "                 (expressions), sentences, pronoun lines (may be empty).",
  "",
  "THE FIVE PARTS (the app times them; you fill them):",
  "  1 warm-up, " + A.clock[0] + " min: a 3-second speed quiz on the last lesson (the app makes it from that",
  "    lesson), then today's situation thrown at the learner (situation.setup).",
  "  2 cheat code 1, " + A.clock[1] + " min: today's grammar_step as ONE plain 'cheat code' (cheat.hook), then the",
  "    target expressions drilled three times in rhythm, each with a short example.",
  "  3 cheat code 2, " + A.clock[2] + " min: a short role-play — something goes wrong and the learner talks their",
  "    way out of it — built from the targets, the frames and the idiom.",
  "  4 one-second challenge, " + A.clock[3] + " min: a Korean situation, the learner answers in Spanish at once.",
  "  5 cool-down, " + A.clock[4] + " min: one take-away sentence and a small real-life mission.",
  "",
  "CHOOSE AND FOCUS. A list of twenty words read out loses a listener in the car. Pick FEW things",
  "and use each of them many times inside one storyline.",
  "- The storyline: ONE situation taken from today's actual conversations (what was going on, who",
  "  was talking, what went wrong or was asked for). The restaurant kitchen when it fits — it",
  "  usually does — otherwise today's real context. If today is empty, use the restaurant kitchen.",
  "- It is a role-play the learner imagines ('오늘 여러분은 … 입니다'). Never state facts about the",
  "  learner's real life, staff, customers or money that are not in today's data.",
  "",
  "AVOID REPEATS — use recent: never pick an idiom listed in recent.idioms; prefer targets and frames",
  "not in recent.words / recent.frames; do not reuse a recent.pronoun line. A part of today's talk",
  "that was taught recently can still be the setting — teach something new inside it.",
  "",
  "Return ONE JSON object and nothing else. No markdown, no code fence, no commentary.",
  "",
  "{",
  '  "situation": {"setup":""},',
  '  "targets":   [{"es":"","ko":"","base":"","base_ko":"","how":"","example":{"es":"","ko":""},"gesture":""}],',
  '  "cheat":     {"hook":"","explain":[""],"examples":[{"es":"","ko":""}]},',
  '  "frames":    [{"es":"","ko":"","note":""}],',
  '  "story":     {"title":"","setup":"","lines":[{"who":"","es":"","ko":"","learner":false,"gesture":""}]},',
  '  "idiom":     {"es":"","ko":"","literal":"","why":"","example":{"es":"","ko":""}},',
  '  "new_words_used": [{"es":"","form":"","ko":""}],',
  '  "challenge": [{"ko":"","es":""}],',
  '  "pronoun":   {"quiz":[{"ko":"","es":""}]},',
  '  "takeaway":  {"es":"","ko":""},',
  '  "mission": "",',
  '  "outro": ""',
  "}",
  "",
  "situation.setup — 1 or 2 short Korean sentences that drop the learner into the scene, with",
  "  energy: 오늘 여러분은 멕시코 식당 주방의 신입 요리사입니다! 사장님 지시도 받고, 손님 불만도 막아야 해요.",
  "",
  "targets — 3 to 5 short expressions, the heart of the lesson, at most 5 words each, said the way",
  "  a Mexican says them (¡Ábrelo! / ¡Ciérralo! / ¡Dámelo! / Es que no puedo.). Show today's",
  "  grammar_step in them where it fits; take them from today's talk where you can.",
  "  ko: the plain Korean meaning (그거 열어!).",
  "  base / base_ko: OPTIONAL, the plain dictionary word it is built from and its meaning",
  "    (abrir / 열다). Empty when there is none.",
  "  how: ONE short Korean line a child could follow on how base became es — the 'trick'",
  "    (abre 끝에 ‘그거’ lo 를 붙이면 ábrelo). No grammar terms.",
  "  example: ONE very easy sentence of at most 7 words using it, from the storyline, with Korean.",
  "  gesture: OPTIONAL, a tiny hand gesture to do while saying it, in Korean (문 여는 손짓). It is",
  "    shown on screen only, never read aloud.",
  "",
  "cheat — today's grammar_step, following its core and how.",
  "  hook: the cheat code in ONE short Korean line (말 끝에 ‘그거’ lo 만 붙이면 명령!).",
  "  explain: 1 or 2 short Korean sentences a child could follow. Show, do not name.",
  "  examples: 1 or 2 tiny correct Mexican Spanish sentences of at most 5 words, with Korean.",
  "",
  "frames — 1 or 2 bones of speaking used INSIDE the story: Por eso (그래서), Es que (그게 실은,",
  "  핑계 댈 때), Voy a (나 ~할 거야), Creo que, Tengo que … es: only the fixed words, no placeholder.",
  "  ko: the meaning with ~ where the rest goes. note: OPTIONAL one Korean line on when it is used.",
  "  A frame that no story line uses is thrown away by the app.",
  "",
  "story — the role-play, " + A.lines + " lines in two short scenes: something goes wrong (a complaint, a",
  "  mistake, a missing thing), then the learner's role talks their way out and fixes it.",
  "  title: a short Korean title. setup: one Korean line.",
  "  lines[].who: the speaker in Korean, short (손님, 사장님, 요리사, 직원). lines[].es: at most 12",
  "  words, natural Mexican Spanish; the learner's lines use the targets and the frames many times.",
  "  lines[].ko: its Korean. lines[].learner: true for the lines the learner says (their role),",
  "  " + A.learner + " of them. lines[].gesture: OPTIONAL, shown on screen only.",
  "",
  "idiom — ONE set expression genuinely in daily use in Mexico that fits the story (estar en su salsa",
  "  = 물 만난 물고기, cambiar de idea = 생각을 바꾸다), ideally one heard today. Only one you are",
  "  certain of; else null. Never one listed in recent.idioms. literal: the words one by one in",
  "  Korean. why: ONE short Korean line on why it means that. example: at most 7 words, with Korean.",
  "",
  "new_words_used — from the input new_words ONLY, the ones the story or the targets really use,",
  "  0 to 4, earlier ones first. es: copied EXACTLY from new_words. form: the exact form as it",
  "  appears in your story or targets (mide for medir). ko: plain Korean meaning. Do not force a",
  "  word in; unused ones simply wait for another day.",
  "",
  "challenge — " + A.challenge + " one-second prompts: ko is a short Korean situation or order (창문 닫아! / 그거",
  "  나 줘! / 그게 실은 못 해…), es the Spanish answer of at most 6 words (¡Ciérralo! / ¡Dámelo! /",
  "  Es que no puedo.). Mostly the targets and frames in new situations.",
  "",
  "pronoun — the little words lo, la, le, se, me, te: 2 or 3 more quiz lines in the same style",
  "  (그에게 그것을 줘 → Dáselo). Prefer real lines from pronoun_hits when they fit.",
  "",
  "takeaway — the ONE sentence to take home, at most 8 words, from the story.",
  "mission — ONE short, playful Korean line: a real moment today when to say it, even silently",
  "  (오늘 냉장고 문 닫을 때 속으로 ‘¡Ciérralo!’ 외치기!). Under 70 characters.",
  "outro — ONE short Korean closing line, under 50 characters.",
  "",
  "SPANISH: correct, natural Mexican Spanish. Mexico first: when a word has a second meaning a",
  "  beginner in Mexico will meet, say so in ko, short (camión 트럭, 버스). caliente is for food and",
  "  things only: a hot person says tengo calor. Food words (huevo, leche, chile, plátano, pepino)",
  "  are used only in their food meaning — never in a double-meaning phrase. Written accents and ¡ ¿",
  "  are kept (Ábrelo, Dámelo).",
  "",
  "KOREAN, CHILD-SIMPLE — every Korean line is plain, short and meant to be heard out loud:",
  "- Never use grammar terms: 과거분사, 현재분사, 접속법, 직설법, 재귀동사, 명령형, 부정사,",
  "  동사원형, 시제, 활용, 인칭, 목적격, 대명사, 전치사, 관사, 과거형, 미래형,",
  "  목적어, 주어, 동사, 명사, 형용사, 점과거, 불완료과거, 현재완료, 가정법.",
  "  Say what it DOES instead: 시킬 때 / 이미 끝난 일 / 앞으로 할 일 / 끝에 붙는 ‘그거’ lo.",
  "  If a term is truly unavoidable, put it once in brackets after the plain words.",
  "- 합쇼체 or friendly 해요체, no markdown, no brackets.",
  "",
  "HARD RULES",
  "- Never introduce a name, number, price, time or place that is not in today's data.",
  "- Never state as fact anything about the learner, the staff or the customers that the data does",
  "  not say. The story is a role-play, and is presented as one.",
  "- Skip greetings, yes/no and anything with no learning in it as targets."
  ].join("\n");
}

/* Pull the JSON out of a reply that may carry a fence or stray prose. */
function lessonExtractJson(text){
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("JSON 을 찾지 못했습니다.");
  return JSON.parse(s.slice(a, b + 1));
}

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
function cleanPair(v){
  const o = asObj(v);
  const es = cleanStr(o && o.es), ko = cleanStr(o && o.ko);
  return es && ko ? { es: es, ko: ko } : null;
}

/* The frame itself is what gets spoken, so placeholders go: "voy a + 동사" and
   "creo que …" are said as "voy a" and "creo que". Korean left inside means
   the model ignored the format, and the item is not trusted. */
function cleanFrameEs(v){
  const s = cleanStr(v).replace(/\s*\+.*$/, "").replace(/…|\.{2,}|~/g, "").replace(/\s+/g, " ").trim();
  return /[가-힣]/.test(s) ? "" : s;
}

/* ---- grammar words a beginner should never hear ----
   The prompt already forbids them; this is the check on what came back. A
   term inside brackets is allowed once in the whole lesson (과거분사 at ⑦);
   a second bracketed one is taken out, and a line that still uses one in the
   open is dropped rather than read out. */
const GRAMMAR_BAN = [
  "과거분사", "현재분사", "분사", "접속법", "직설법", "재귀동사", "재귀", "명령형", "명령법",
  "부정사", "동사원형", "시제", "인칭", "목적격", "목적어", "대명사", "전치사", "관사",
  "과거형", "미래형", "점과거", "단순과거", "불완료", "반과거", "현재완료", "완료형",
  "가정법", "조건법", "동명사", "형용사", "부사", "명사", "동사"
];
const BAN_RE = new RegExp(GRAMMAR_BAN.join("|"));
function banScrub(s, state){
  let t = cleanStr(s);
  if (!t || !BAN_RE.test(t)) return t;
  t = t.replace(/\s*\(([^()]*)\)/g, (all, inner) => {
    if (!BAN_RE.test(inner)) return all;
    if (state && !state.used){ state.used = true; return all; }
    return "";
  }).trim();
  const open = t.replace(/\([^()]*\)/g, "");
  return BAN_RE.test(open) ? "" : t;
}

/* the first n sentences of s, within cap characters — or nothing */
function firstSentences(s, n, cap){
  /* no look-behind here: an older iPhone Safari refuses the whole file over one */
  const parts = (cleanStr(s).match(/[^.!?]+[.!?]*/g) || []).map((p) => p.trim()).filter(Boolean);
  let out = "";
  for (const p of parts.slice(0, n)){
    if (out && (out + " " + p).length > cap) break;
    out = out ? out + " " + p : p;
  }
  return out.length > cap ? "" : out;
}
/* bounds for the short Korean lines and examples the AI writes */
const LITERAL_CHARS = 60, IDIOM_WHY_CHARS = 120, EXAMPLE_WORDS = 7;
/* a Korean line of bounded length, banned words scrubbed */
function koLine(v, ban, cap){
  const s = banScrub(v, ban);
  return s && s.length <= cap && /[가-힣]/.test(s) ? s : "";
}
const wordCount = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
/* a number in an example that the source never had is a made-up fact */
const digitsOf = (s) => (String(s || "").match(/\d+/g) || []);
function noNewNumbers(es, src){
  const have = new Set(digitsOf(src));
  return digitsOf(es).every((d) => have.has(d));
}
/* spoken: arrows, quote marks and ~ are for the eye */
function sayWhy(s){
  return String(s || "").replace(/\s*[→↔]\s*/g, ", ").replace(/[«»‘’“”]/g, "")
    .replace(/\s*~\s*/g, " ").replace(/\s+/g, " ").trim();
}

/* The reply was cut off: keep everything up to the last value that closed,
   and close what was still open. Only used once a retry has failed too. */
function lessonSalvageJson(text){
  const s0 = String(text || "");
  const a = s0.indexOf("{");
  if (a < 0) throw new Error("JSON 을 찾지 못했습니다.");
  const s = s0.slice(a);
  const stack = [];
  let inStr = false, escp = false, cut = -1, cutStack = null;
  for (let i = 0; i < s.length; i++){
    const ch = s[i];
    if (inStr){
      if (escp) escp = false; else if (ch === "\\") escp = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]"){
      stack.pop();
      if (!stack.length) return JSON.parse(s.slice(0, i + 1));
      cut = i + 1; cutStack = stack.slice();
    }
  }
  if (cut < 0) throw new Error("JSON 을 찾지 못했습니다.");
  return JSON.parse(s.slice(0, cut) + cutStack.reverse().join(""));
}

/* Drop anything missing a side, so a half-written item can never become a
   silent segment or a blank line later on. Every part is optional except the
   targets or the story: a reply cut short loses that part, never the lesson.
   `sourceEs`, when given, is the Spanish actually said today; numbers in the
   story and examples are checked against it. `cur`, when given, is the day's
   curriculum plan (curriculumPlan): only its queued new words may be claimed
   as used, and only when the story really says them. */
const TARGETS_MAX = 5, STORY_MAX = 14, CHALLENGE_MAX = 12, FRAMES_STORY_MAX = 2, NEW_USED_MAX = 4;
const TARGET_WORDS = 6, LINE_WORDS = 14, CHALLENGE_WORDS = 8;
const hasKo = (s) => /[가-힣]/.test(String(s || ""));
/* `es` said as whole words inside `line`, accents, case and punctuation aside */
function phraseIn(es, line){
  const k = reviewKey(es);
  return k !== "" && (" " + reviewKey(line) + " ").indexOf(" " + k + " ") >= 0;
}
/* a Spanish line of at most `words` words, Korean meaning beside it, no made-up number */
function cleanLine(x, words, src){
  const p = cleanPair(x);
  if (!p || hasKo(p.es) || !hasKo(p.ko) || wordCount(p.es) > words || !noNewNumbers(p.es, src)) return null;
  return p;
}
function cleanLines(list, words, src, max){
  const out = [], seen = new Set();
  for (const x of (Array.isArray(list) ? list : [])){
    const p = cleanLine(x, words, src);
    if (!p || seen.has(foldEs(p.es))) continue;
    seen.add(foldEs(p.es));
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

function lessonNormalise(raw, sourceEs, cur){
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("대본 형식이 올바르지 않습니다.");
  const srcAll = Array.isArray(sourceEs) ? sourceEs.join(" ") : "";
  const ban = { used: false };
  const gest = (v) => koLine(v, ban, 60);

  const targets = [], tseen = new Set();
  for (const x of (Array.isArray(raw.targets) ? raw.targets : [])){
    const p = cleanLine(x, TARGET_WORDS, srcAll);
    if (!p || tseen.has(foldEs(p.es))) continue;
    tseen.add(foldEs(p.es));
    const base = cleanStr(x.base);
    targets.push({
      es: p.es, ko: banScrub(p.ko, ban) || p.ko,
      base: base && !hasKo(base) && wordCount(base) <= 3 ? base : "",
      baseKo: koLine(x.base_ko, ban, 24),
      how: koLine(x.how, ban, 100),
      ex: cleanLine(x.example, EXAMPLE_WORDS, srcAll),
      gesture: gest(x.gesture)
    });
    if (targets.length >= TARGETS_MAX) break;
  }

  const st = asObj(raw.story) || {};
  const lines = [];
  for (const x of (Array.isArray(st.lines) ? st.lines : [])){
    const p = cleanLine(x, LINE_WORDS, srcAll);
    const who = cleanStr(x && x.who);
    if (!p || !who || who.length > 8 || !hasKo(who)) continue;
    lines.push({ who: who, es: p.es, ko: p.ko, learner: x.learner === true, gesture: gest(x.gesture) });
    if (lines.length >= STORY_MAX) break;
  }
  if (!targets.length && !lines.length) throw new Error("대본에 표현이 없습니다.");
  const spoken = lines.map((l) => l.es).concat(targets.map((t) => t.es));

  /* a frame is taught inside the story or not at all */
  const frames = [], fseen = new Set();
  for (const x of (Array.isArray(raw.frames) ? raw.frames : [])){
    const o = asObj(x);
    const es = cleanFrameEs(o && o.es), ko = cleanStr(o && o.ko);
    if (!es || !hasKo(ko) || fseen.has(foldEs(es)) || !spoken.some((l) => phraseIn(es, l))) continue;
    fseen.add(foldEs(es));
    frames.push({ es: es, ko: ko, note: koLine(o.note, ban, 70) });
    if (frames.length >= FRAMES_STORY_MAX) break;
  }

  const io = asObj(raw.idiom);
  const idiom = io && cleanStr(io.es) && !hasKo(io.es) && hasKo(io.ko) ? {
    es: cleanStr(io.es), ko: cleanStr(io.ko),
    literal: koLine(io.literal, ban, LITERAL_CHARS),
    why: firstSentences(koLine(io.why, ban, IDIOM_WHY_CHARS), 1, IDIOM_WHY_CHARS),
    ex: cleanLine(io.example, EXAMPLE_WORDS, srcAll)
  } : null;

  /* claimed new words: only queued ones, only in the form the story really says */
  const queued = new Map((cur && Array.isArray(cur.newWords) ? cur.newWords : []).map((w) => [foldEs(w), w]));
  const newUsed = [], nseen = new Set();
  for (const x of (Array.isArray(raw.new_words_used) ? raw.new_words_used : [])){
    const o = asObj(x);
    const w = queued.get(foldEs(o && o.es)), form = cleanStr(o && o.form).replace(/^[¡¿]+|[.,!?]+$/g, "");
    const ko = koLine(o && o.ko, ban, 30);
    if (!w || !form || !ko || nseen.has(w)) continue;
    const at = lines.findIndex((l) => phraseIn(form, l.es));
    const inTarget = targets.findIndex((t) => phraseIn(form, t.es));
    if (at < 0 && inTarget < 0) continue;
    nseen.add(w);
    newUsed.push({ es: w, form: form, ko: ko, line: at, target: inTarget });
    if (newUsed.length >= NEW_USED_MAX) break;
  }

  const ch = asObj(raw.cheat) || {};
  const cheat = {
    hook: koLine(ch.hook, ban, 70),
    explain: (Array.isArray(ch.explain) ? ch.explain : [ch.explain])
      .map((s) => koLine(s, ban, 130)).filter(Boolean).slice(0, 2),
    examples: cleanLines(ch.examples, EXAMPLE_WORDS, srcAll, 2)
  };

  const pron = asObj(raw.pronoun);
  const firstLearner = lines.find((l) => l.learner);
  const take = cleanLine(raw.takeaway, 9, srcAll) || (firstLearner ? { es: firstLearner.es, ko: firstLearner.ko }
    : targets[0] ? { es: targets[0].es, ko: targets[0].ko } : null);

  return {
    fmt: LESSON_FMT,
    situation: koLine(asObj(raw.situation) && raw.situation.setup, ban, 170),
    targets: targets,
    cheat: cheat,
    frames: frames,
    story: { title: koLine(st.title, ban, 30), setup: koLine(st.setup, ban, 140), lines: lines },
    idiom: idiom,
    newUsed: newUsed,
    challenge: cleanLines(raw.challenge, CHALLENGE_WORDS, srcAll, CHALLENGE_MAX),
    pronoun: { points: [], quiz: pron ? cleanLines(pron.quiz, CHALLENGE_WORDS, srcAll, 3) : [] },
    takeaway: take,
    mission: koLine(raw.mission, ban, 90),
    outro: koLine(raw.outro, ban, 80) || "오늘 수업 끝. 수고하셨어요!"
  };
}

/* One script call: `prompt` is the system text, `body` the JSON input and
   `normalise` turns the parsed reply into checked content (it throws when the
   reply is unusable). The teacher lesson (teachPrompt / teachBody /
   teachNormalise) is the only caller now. */
async function lessonWriteScript(prompt, body, normalise){
  /* the reply is several thousand tokens (a dialogue for each item): the cap
     is set far above it, so a cut-off reply means something went wrong
     rather than that the lesson simply grew */
  const cfg = { temperature: 0.4, thinking_level: "medium", max_output_tokens: 32768 };
  /* with a Claude key the script is written by Claude first (same prompt, same
     body); a failed or unparseable Claude reply is redone by Gemini, and the
     retry below then goes straight to Gemini */
  const route = {};

  const replies = [];
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++){
    const nudge = attempt === 0 ? "" :
      "\n\nYour previous reply could not be parsed. Return ONLY the JSON object, starting " +
      "with { and ending with }. No fence, no text before it and none after it.";
    const sys = prompt + nudge;
    const claudeTurn = !!settings.claudeKey && !(route.claudeFailed && settings.apiKey);
    const limitMs = SCRIPT_TIMEOUT_MS + (claudeTurn ? CLAUDE_SCRIPT_TIMEOUT_MS : 0);
    try {
      /* callPlain has no deadline of its own, and this call holds the app's
         `busy` flag: without a cap, one stalled request would leave the
         microphone and the typing box disabled until a reload. A Claude turn
         carries its own deadline and leaves Gemini its full one after it. */
      const reply = await Promise.race([
        viaClaude(sys, body, () => callPlain(sys, body, cfg), {
          route: route,
          maxTokens: CLAUDE_SCRIPT_MAX_TOKENS,
          effort: "medium",
          timeoutMs: CLAUDE_SCRIPT_TIMEOUT_MS,
          validate: (t) => {
            const j = lessonExtractJson(t);
            if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("대본 형식이 올바르지 않습니다.");
          },
          onFallback: (note) => { try { lessonBusySub(note + " 대본을 쓰는 중…"); } catch (e) {} }
        }),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error("대본 요청이 " + (limitMs / 1000) + "초 안에 끝나지 않았습니다.")),
          limitMs))
      ]);
      replies.push(String(reply || ""));
      return normalise(lessonExtractJson(reply));
    } catch (e) {
      if (/API \d{3}/.test((e && e.message) || "")) throw e;   // key, quota, model: do not retry
      if (e && e.claude) throw e;   // Claude failed with no Gemini key to hand it to: a second wait would fail the same way
      lastErr = e;
    }
  }
  /* both replies were cut off or malformed: keep what the longer one finished
     — a part that was cut is simply missing, the rest of the lesson stands */
  const longest = replies.sort((a, b) => b.length - a.length)[0];
  if (longest){
    try { return normalise(lessonSalvageJson(longest)); }
    catch (e) {}
  }
  throw new Error("대본을 만들지 못했습니다.\n" + ((lastErr && lastErr.message) || ""));
}

/* ---------------- segments and display rows ---------------- */

/* A frame's meaning is written with ~ where the swapped part goes. On screen
   that reads well; aloud a voice may say "물결" or nothing at all, so the
   spoken line says 뭐뭐 instead. */
function sayKo(s){
  return String(s || "").replace(/\s*~\s*/g, " 뭐뭐 ").replace(/\s+/g, " ").trim();
}

/* ---------------- the course: new words, grammar, lo·le·se ----------------

   Three parts that do not depend on what was said today, so a lesson can be
   made on a day with no conversation at all. WHAT is taught and in which order
   is code — the word list in words-es.js and GRAMMAR_STEPS below; Gemini only
   writes meanings, examples and explanations, in the same single call.
   Progress lives in localStorage, apart from the lesson records, and moves
   only once a lesson has been saved (curriculumCommit): a failed or cancelled
   run costs no words, and 다시 만들기 on the same day reuses the same ones. */

const NEW_WORDS_KEY = "interp.newWords";   // { learned: { "<es>": { d: "<study day>", ko } } }
const GRAMMAR_KEY = "interp.grammar";      // { n: steps taught, last: { date, k } }
const NEW_PER_DAY = 10;
const NEW_REVIEW_LAST = 4, NEW_REVIEW_WEEK = 2;

function wordList(){
  return typeof NEW_WORDS_ES !== "undefined" && Array.isArray(NEW_WORDS_ES) ? NEW_WORDS_ES : [];
}
/* accents and case aside — only ever used to compare, never stored */
function foldEs(s){
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase().trim();
}
function esTokens(lines){
  const out = new Set();
  for (const l of (Array.isArray(lines) ? lines : [])){
    for (const t of foldEs(l).split(/[^a-z]+/)) if (t) out.add(t);
  }
  return out;
}
const dayNum = (iso) => Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1,
                                            Number(iso.slice(8, 10))) / 86400000);
function isoAddDays(iso, n){
  return new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10);
}

function newWordsLearned(){
  const s = asObj(jget(NEW_WORDS_KEY, null));
  const src = asObj(s && s.learned) || {};
  const out = {};
  for (const k of Object.keys(src)){
    const e = asObj(src[k]);
    if (e && typeof e.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.d)) out[k] = { d: e.d, ko: cleanStr(e.ko) };
  }
  return out;
}
function newWordsCount(){
  const learned = newWordsLearned();
  return wordList().filter((w) => learned[w]).length;
}

/* The ten words for study day `iso`. Words already given to this day come
   first (a 다시 만들기), then the next unlearned ones that were not in today's
   own conversation. When the whole list is done, the longest-ago ones come
   back — never one from the last week. */
function newWordsPick(iso, sourceEs){
  const list = wordList(), learned = newWordsLearned();
  const toks = esTokens(sourceEs);
  const inTalk = (w) => toks.has(foldEs(w)) || (/se$/.test(w) && toks.has(foldEs(w.slice(0, -2))));
  const out = [], seen = new Set();
  const take = (w) => { out.push(w); seen.add(w); };
  for (const w of list) if (out.length < NEW_PER_DAY && learned[w] && learned[w].d === iso) take(w);
  for (const w of list){
    if (out.length >= NEW_PER_DAY) break;
    if (!seen.has(w) && !learned[w] && !inTalk(w)) take(w);
  }
  const oldOnes = [];
  if (out.length < NEW_PER_DAY){
    const cut = isoAddDays(iso, -7);
    const old = list.filter((w) => !seen.has(w) && learned[w] && learned[w].d < cut && !inTalk(w))
      .sort((a, b) => learned[a].d.localeCompare(learned[b].d));
    for (const w of old){
      if (out.length >= NEW_PER_DAY) break;
      take(w); oldOnes.push(w);
    }
  }
  const before = list.filter((w) => learned[w] && learned[w].d !== iso).length;
  return { words: out, again: oldOnes.length > 0, oldWords: oldOnes, learnedBefore: before };
}

/* For 0교시: some of the last day's new words, and one or two from about a
   week ago — a small spaced repeat. The pick turns with the day so the same
   four are not asked every time. */
function newWordsReview(iso){
  const learned = newWordsLearned(), byDay = new Map();
  for (const w of wordList()){
    const e = learned[w];
    if (!e || !e.ko || !(e.d < iso)) continue;
    if (!byDay.has(e.d)) byDay.set(e.d, []);
    byDay.get(e.d).push({ es: w, ko: e.ko, d: e.d });
  }
  const days = Array.from(byDay.keys()).sort();
  if (!days.length) return [];
  const n = dayNum(iso);
  const turn = (arr, k) => {
    if (arr.length <= k) return arr.slice();
    const s = n % arr.length;
    return arr.slice(s).concat(arr.slice(0, s)).slice(0, k);
  };
  const last = days[days.length - 1];
  const out = turn(byDay.get(last), NEW_REVIEW_LAST).map((x) => Object.assign(x, { when: "last" }));
  let best = null, gap = 99;
  for (const d of days){
    const age = n - dayNum(d);
    if (d === last || age < 5 || age > 14) continue;
    if (Math.abs(age - 7) < gap){ best = d; gap = Math.abs(age - 7); }
  }
  if (best) for (const x of turn(byDay.get(best), NEW_REVIEW_WEEK)) out.push(Object.assign(x, { when: "week" }));
  return out;
}

/* ---- what was already taught, and when ----
   A week of the same kitchen sounds alike: measured on seven mock days, 70% of
   the lesson's time went to things taught in the last week (2026-10-31). So
   every item a lesson teaches IN FULL is written here once the lesson is saved,
   keyed by part and plain Spanish. Inside KNOWN_DAYS it is «아는 것»: said once,
   no repeats, no long note, and it is left out of 마무리. A short mention does
   not reset the clock, so an item comes back in full after KNOWN_DAYS.
   t: v 대화 단어 · i 숙어 · s 문장 · w 문장 속 낱말 · f 뼈대 · p lo·le·se */
const TAUGHT_KEY = "interp.taught";        // { items: { "<t>:<key>": { d, p, n, es } } }
const KNOWN_DAYS = 5;
const TAUGHT_KEEP = 600;
/* how much of it goes into the script request, per part (the request grows) */
const RECENT_CAP = { i: 12, f: 12, v: 20, s: 6, p: 8 };
const RECENT_FIELD = { i: "idioms", f: "frames", v: "words", s: "sentences", p: "pronoun" };

const taughtId = (t, es) => t + ":" + reviewKey(String(es || "").replace(/\s*…$/, ""));

function taughtAll(){
  const s = asObj(jget(TAUGHT_KEY, null));
  const src = asObj(s && s.items) || {};
  const out = {};
  const day = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  for (const k of Object.keys(src)){
    const e = asObj(src[k]);
    if (e && day(e.d)) out[k] = { d: e.d, p: day(e.p) ? e.p : "", n: Number(e.n) > 0 ? Number(e.n) : 1,
                                  es: cleanStr(e.es).slice(0, 80) };
  }
  return out;
}
/* the last day BEFORE `iso` it was taught in full: a 다시 만들기 on the same day
   must see the same «known» set as the first make did */
function taughtBefore(e, iso){
  if (e.d < iso) return e.d;
  return e.p && e.p < iso ? e.p : "";
}
/* `days` is the window: KNOWN_DAYS for the story lessons, TEACH_DAYS (two
   weeks) for the teacher lesson, which never picks a recent item again */
function taughtRecent(iso, days){
  const cut = isoAddDays(iso, -(days || KNOWN_DAYS)), all = taughtAll(), out = {};
  for (const k of Object.keys(all)){
    const d = taughtBefore(all[k], iso);
    if (d && d >= cut) out[k] = { d: d, n: all[k].n, es: all[k].es };
  }
  return out;
}
/* the same, as short lists for the script request — newest first, capped */
function taughtRecentList(recent){
  const out = {};
  for (const t of Object.keys(RECENT_FIELD)) out[RECENT_FIELD[t]] = [];
  const keys = Object.keys(recent || {}).sort((a, b) => recent[b].d.localeCompare(recent[a].d) || a.localeCompare(b));
  for (const k of keys){
    const t = k.split(":")[0], f = RECENT_FIELD[t];
    if (!f || !recent[k].es || out[f].length >= RECENT_CAP[t]) continue;
    out[f].push(recent[k].es);
  }
  return out;
}
function taughtCommit(iso, list){
  const all = taughtAll(), next = {};
  for (const k of Object.keys(all)) next[k] = all[k];
  for (const x of (Array.isArray(list) ? list : [])){
    if (!x || !x.t || !cleanStr(x.es)) continue;
    const k = taughtId(x.t, x.es);
    if (k.length < 3) continue;
    const e = next[k];
    if (!e) next[k] = { d: iso, p: "", n: 1, es: cleanStr(x.es).slice(0, 80) };
    else if (e.d !== iso && e.d < iso) next[k] = { d: iso, p: e.d, n: e.n + 1, es: e.es || cleanStr(x.es).slice(0, 80) };
  }
  const keep = Object.keys(next).sort((a, b) => next[b].d.localeCompare(next[a].d)).slice(0, TAUGHT_KEEP);
  const items = {};
  for (const k of keep) items[k] = next[k];
  jset(TAUGHT_KEY, { items: items });
}

/* ---- the grammar course: one step a day, in this order ----
   core goes to Gemini as what to teach, how as the way to say it, and rule/ex
   are the code's own fallback and the «지난 문법 다시 보기» lines. None of the
   Korean here may use a grammar term (GRAMMAR_BAN); step 7 alone allows
   (과거분사) once, in brackets. */
const GRAMMAR_STEPS = [
  { title: "lo · la · los · las — 그것을, 그를",
    core: "lo/la/los/las stand for the thing or person the action lands on (it, him, her, them), so the noun is not repeated. They go right BEFORE the verb (lo pongo), or glued to the END of a command or of the dictionary form (ponlo, voy a ponerlo). lo/los for words like el arroz, la/las for words like la salsa.",
    how: "‘무엇을’에 해당하는 말을 짧게 바꿔 부르는 말이라고 설명. el arroz 를 다시 말하지 않고 lo 로 바꾸는 모습을 보여 줄 것. o 로 끝나는 말은 대개 lo, a 로 끝나는 말은 대개 la, 여럿이면 los·las.",
    rule: "‘그것을, 그를’은 lo·la, 여럿이면 los·las. pongo, hago 같은 ‘하는 말’ 바로 앞에 와요.",
    ex: [{ es: "¿El arroz? Lo pongo en el refri.", ko: "밥? 그거 냉장고에 넣을게." },
         { es: "La salsa la hago yo.", ko: "소스는 내가 만들어." }] },
  { title: "le · les — 그에게",
    core: "le = to him / to her / to you (usted); les = to them / to you all. It marks the person who RECEIVES (give, tell, ask, serve, explain to someone). Before the verb (le doy), glued to the end of commands (dale). Very common: le digo, le doy, le pregunto, les sirvo. Even when the person is named, le stays — that is how Mexicans say it: le doy el plato al cliente.",
    how: "‘누구에게’ 주거나 말하는지를 가리키는 말. 받는 사람이 하나면 le, 여럿이면 les. lo(무엇을)와 헷갈리지 않게 ‘무엇을 vs 누구에게’ 로 나란히 보여 줄 것.",
    rule: "‘그 사람에게’는 le, 여러 사람에게는 les.",
    ex: [{ es: "Le doy el plato.", ko: "그에게 접시를 줘요." },
         { es: "Les explico la receta.", ko: "그 사람들에게 요리법을 설명해요." }] },
  { title: "se 의 세 얼굴",
    core: "Three uses of se. (1) le/les turns into se right before lo/la/los/las: nobody says 'le lo doy', it is 'se lo doy' (I give it to him/her); les + lo turns into se lo too. In Mexico you will often hear 'se los dije' for 'I told it to you all' — mention it as something to recognise, not as the rule. (2) se for doing something to oneself: se lava las manos (he washes his own hands) — with me/te for I/you: me lavo, te lavas. (3) se for 'people in general / it is done': aquí se vende pan, ¿cómo se dice esto?",
    how: "세 가지를 하나씩 짧게. ① le 와 lo 가 나란히 오면 le 가 se 로 바뀐다 — se lo doy = 그에게 그것을 줘. ② 자기 몸에 하는 일 — se lava las manos. ③ 사람들이 보통 그렇게 한다 — aquí se vende pan 여기서 빵을 팔아요. 각각 예문을 붙일 것.",
    rule: "le 와 lo 가 만나면 se lo. 자기 몸에 하는 일은 나 me, 너 te, 그·당신 se: me lavo, se lava. ‘사람들이 보통 ~해’에도 se.",
    ex: [{ es: "Se lo doy mañana.", ko: "그에게 그거 내일 줄게요." },
         { es: "¿Cómo se dice esto en español?", ko: "이거 스페인어로 어떻게 말해요?" }] },
  { title: "me · te · nos — 나를, 나에게",
    core: "me = me / to me, te = you / to you (tú), nos = us / to us. The same little word covers both 'me' and 'to me'. Same place as lo and le: before the verb (me ayudas), glued to the end of commands (ayúdame, dime).",
    how: "나·너·우리 쪽 작은 말. ‘나를’과 ‘나에게’가 같은 me 하나라는 것을 예문 두 개로 보여 줄 것. 부탁할 때 끝에 붙는 모습(ayúdame)도.",
    rule: "나를·나에게는 me, 너를·너에게는 te, 우리를·우리에게는 nos.",
    ex: [{ es: "¿Me ayudas?", ko: "나 좀 도와줄래?" },
         { es: "Te llamo en la tarde.", ko: "오후에 너한테 전화할게." }] },
  { title: "이미 끝난 일 ① 늘 같은 끝 모양",
    core: "Finished past of regular verbs. -ar: -é, -aste, -ó, -amos, -aron (limpié, limpiaste, limpió, limpiamos, limpiaron). -er/-ir: -í, -iste, -ió, -imos, -ieron (comí, comiste, comió, comimos, comieron). The written accent matters: hablo (I speak) vs habló (he spoke). Signal words: ayer, anoche, la semana pasada. Give a 나/너/그(당신)/우리/그들·너희 table (in Mexico the -aron form is also 'you all').",
    how: "어제·지난주처럼 이미 끝난 일을 말할 때 끝이 바뀐다. -ar 로 끝나는 말과 -er·-ir 로 끝나는 말 두 무리로 나눠 표로. hablo 와 habló 처럼 글자 위 작은 빗금(´) 하나로 뜻이 바뀌는 것도 짚을 것.",
    rule: "이미 끝난 일은 -ar 말이면 -é, -aste, -ó, -er·-ir 말이면 -í, -iste, -ió 로 끝나요.",
    ex: [{ es: "Ayer limpié la cocina.", ko: "어제 나는 주방을 청소했어." },
         { es: "¿Ya comiste?", ko: "너 밥 먹었어?" }] },
  { title: "이미 끝난 일 ② 통째로 외우는 말",
    core: "Common irregular finished-past forms to learn as whole words: fui (I went / I was — ir and ser share it), hice / hizo (did, made), tuve (had), puse (put), dije (said), traje (brought), vine (came), pude (could), estuve (was, somewhere), di (gave), vi (saw). These have no written accent.",
    how: "자주 쓰는 말은 모양이 제멋대로라 통째로 외운다. fui 하나가 ‘갔어’도 되고 ‘~였어’도 된다는 것. 주방에서 자주 쓰는 hice, puse, traje 를 예문으로.",
    rule: "자주 쓰는 말은 모양이 제멋대로라 통째로 외워요: fui, hice, tuve, puse, dije.",
    ex: [{ es: "Ya hice la salsa.", ko: "소스 벌써 만들었어." },
         { es: "Fui al mercado temprano.", ko: "일찍 시장에 갔어." }] },
  { title: "‘~해 본 적 있어’ — he + -ado · -ido",
    core: "he, has, ha, hemos, han + a form ending in -ado (-ar verbs) or -ido (-er/-ir verbs): he comido, ¿has probado...?, nunca he ido. Teach it for EXPERIENCE (have you ever...). In Mexico a plain finished action is usually said with the finished past (ya comí); he + -ado is most natural for experience: ¿Has probado el mole? Nunca he visto la nieve. Irregular ones: hecho, puesto, dicho, visto, abierto, escrito, roto, vuelto.",
    how: "‘~해 본 적 있어’에 쓴다. he·has·ha 뒤에 끝이 -ado, -ido 로 바뀐 말이 붙는다. 방금 한 일은 멕시코에서는 ya comí 처럼 말한다는 것을 꼭 짚을 것. 이 -ado·-ido 모양을 책에서 부르는 이름은 괄호로 딱 한 번만 (과거분사) 라고 적어도 된다. 멕시코에서는 그냥 끝난 일에는 ya comí 를 더 많이 쓴다는 것도.",
    rule: "he, has, ha 뒤에 -ado·-ido 를 붙이면 ‘~해 본 적 있어’가 돼요. 방금 한 일은 ya comí 처럼 말해요.",
    ex: [{ es: "¿Has probado el mole?", ko: "몰레 먹어 봤어?" },
         { es: "Nunca he visto la nieve.", ko: "나는 눈을 본 적이 없어." }] },
  { title: "-ado · -ido 로 ‘~된 상태’ 말하기",
    core: "The same -ado/-ido word used as a describing word with estar: la puerta está cerrada, el pollo está cocido, la tienda está abierta, estoy cansado. Its ending matches the thing: cerrado / cerrada / cerrados / cerradas.",
    how: "‘문이 닫혀 있어’처럼 이미 그렇게 된 상태. está 다음에 -ado·-ido. 물건이 a 로 끝나는 말이면 -ada, 여럿이면 -s 가 붙는 것을 짝지어 보여 줄 것.",
    rule: "está + -ado·-ido 는 ‘~된 상태야’. la 쪽 말이면 -ada, 여럿이면 -s 를 붙여요.",
    ex: [{ es: "La puerta está cerrada.", ko: "문이 닫혀 있어." },
         { es: "El pollo ya está cocido.", ko: "닭고기는 벌써 익었어." }] },
  { title: "예전에 늘 하던 일 — -aba · -ía",
    core: "Used-to / background past. -ar: -aba, -abas, -aba, -ábamos, -aban (trabajaba). -er/-ir: -ía, -ías, -ía, -íamos, -ían (comía, vivía). Used for what happened regularly back then (antes trabajaba en un hotel), for the background of a story (llovía, era tarde), and for age and clock time in the past (tenía diez años, eran las tres). Only three are irregular: ir → iba, ser → era, ver → veía.",
    how: "‘예전에는 늘 ~했었어’, ‘그때 ~하고 있었어’. 사진이 아니라 계속 돌아가던 영상 같은 것. antes, siempre, cuando era niño 같은 말과 함께. iba, era 는 따로 외운다.",
    rule: "예전에 늘 하던 일이나 그때의 배경은 -aba, -ía 로 끝나요. iba, era 는 따로 외워요.",
    ex: [{ es: "Antes trabajaba en un hotel.", ko: "예전에 나는 호텔에서 일했었어." },
         { es: "Cuando era niño, comía mucho.", ko: "어렸을 때 나는 많이 먹었어." }] },
  { title: "끝난 일 vs 예전에 하던 일 — 고르기",
    core: "Finished past (-é, -ó, fui, hice) = one event that is over, with a clear end, like a photo (also with a counted number of times or a closed length of time: fui tres veces, trabajé ahí dos años): ayer comí tacos, llegó a las tres. -aba/-ía = what was going on in the background or happened again and again, like a video playing: comía cuando llegó; antes comía tacos cada día. Classic pair in one sentence: Cocinaba cuando llegó el jefe (I was cooking — background; the boss arrived — one event).",
    how: "사진(끝이 분명한 일 — 세 번 했든 두 해 동안 했든 끝났으면 사진) vs 영상(그때 계속되던 일, 늘 하던 일) 비유로. 한 문장 안에 둘이 같이 나오는 예(Cocinaba cuando llegó el jefe)를 꼭 넣을 것. ayer·una vez 는 끝난 일 쪽, siempre·antes·cada día 는 하던 일 쪽 신호.",
    rule: "끝이 분명한 일은 몇 번이든 얼마 동안이든 -é·-ó, 그때의 배경이나 늘 하던 일은 -aba·-ía.",
    ex: [{ es: "Cocinaba cuando llegó el jefe.", ko: "요리하고 있었는데 사장님이 왔어." },
         { es: "Antes iba al mercado, pero ayer fui a la tienda.", ko: "예전엔 시장에 다녔는데, 어제는 가게에 갔어." }] },
  { title: "‘~해!’ 시키기와 작은 말 붙이기",
    core: "Asking a friend (tú) to do something: the same form as 'he/she does': habla, come, limpia, lava. Short ones to learn: pon, haz, di, ven, sal, ten, ve. The little words glue to the END: ponlo, lávalo, dámelo, pásamela; once glued a written accent often appears to keep the stress (dame → dámelo). For usted it is ponga, haga, dígame (mention lightly).",
    how: "친구에게 ‘~해!’ 할 때 모양. lo·me·se 같은 작은 말은 끝에 꼭 붙인다: ponlo(그거 놔), dámelo(그거 나한테 줘). 붙이고 나면 글자 위에 작은 빗금(´)이 생기는 것도 한 줄로.",
    rule: "시킬 때는 lo·me·se 같은 작은 말을 끝에 붙여요: ponlo, dámelo.",
    ex: [{ es: "Pásame la sal, por favor.", ko: "소금 좀 건네줘." },
         { es: "Lávalo bien.", ko: "그거 잘 씻어." }] },
  { title: "‘~하지 마’",
    core: "Telling a friend NOT to do something changes the ending: no + (-ar verb → -es, -er/-ir verb → -as): no hables, no toques, no comas, no abras. Learn: no hagas, no pongas, no digas, no vayas, no salgas. The little words go back IN FRONT of the verb, not glued: tócalo → no lo toques, dámelo → no me lo des.",
    how: "‘하지 마’ 는 no 다음에 끝이 바뀐다: -ar 말은 -es, -er·-ir 말은 -as. 시킬 때 끝에 붙던 lo 가 다시 앞으로 온다는 것을 tócalo / no lo toques 짝으로.",
    rule: "‘하지 마’는 no 다음에 끝을 바꿔요(-ar 말은 -es, -er·-ir 말은 -as). 작은 말은 다시 앞으로: no lo toques.",
    ex: [{ es: "No lo toques, está caliente.", ko: "그거 만지지 마, 뜨거워." },
         { es: "No hagas ruido.", ko: "시끄럽게 하지 마." }] },
  { title: "gustar 처럼 거꾸로 말하는 말",
    core: "me gusta el café = coffee pleases me. The thing liked decides gusta / gustan: me gusta el taco, me gustan los tacos. me/te/le/nos/les in front shows WHO likes it. The same pattern: encantar (me encanta), doler (me duele la cabeza), faltar (nos falta sal), importar, molestar, quedar (te queda bien).",
    how: "한국어 ‘나는 ~가 좋아’와 비슷하게 좋아하는 대상이 주인공. 대상이 여럿이면 gustan. me duele, me falta 같은 같은 꼴의 말을 주방 예문으로.",
    rule: "‘나는 ~가 좋아’는 me gusta. 좋아하는 게 여럿이면 gustan.",
    ex: [{ es: "Me gusta la comida coreana.", ko: "나는 한국 음식이 좋아." },
         { es: "Me duelen los pies.", ko: "나 발이 아파." }] },
  { title: "ser 와 estar — 둘 다 ‘이다’",
    core: "ser = what something IS: who or what, where from, job, what it is made of, the time (soy coreano, es mi jefe, es de pollo, son las tres). estar = how or where something is right now: state, feeling, place (estoy cansado, la sopa está caliente, el jefe está en la oficina). Same word, different meaning: es aburrido (a boring person) vs está aburrido (bored right now).",
    how: "원래 그런 것은 ser, 지금 그런 상태나 있는 곳은 estar. 같은 말이 ser/estar 에 따라 뜻이 바뀌는 짝(es aburrido / está aburrido)을 꼭 보여 줄 것.",
    rule: "원래 그런 것은 ser, 지금 그런 상태나 있는 곳은 estar.",
    ex: [{ es: "Soy de Corea y estoy en México.", ko: "나는 한국 사람이고 지금 멕시코에 있어." },
         { es: "La sopa es de pollo y está muy caliente.", ko: "수프는 닭고기 수프인데 아주 뜨거워." }] },
  { title: "por 와 para",
    core: "para = the goal, who it is for, where it is headed, a deadline: para ti, para la mesa dos, para mañana, para limpiar. por = the reason, a thank-you, passing through, the price, the way: gracias por..., por teléfono, lo compré por cien pesos, paso por la tienda.",
    how: "para 는 화살표 끝(목적·받을 사람·마감), por 는 이유와 지나가는 길·값·수단. 자주 쓰는 굳은 말(por favor, gracias por, para mañana)부터.",
    rule: "목적·받을 사람·마감은 para, 이유·지나는 길·값·수단은 por.",
    ex: [{ es: "Este plato es para la mesa dos.", ko: "이 접시는 2번 테이블 거야." },
         { es: "Gracias por la ayuda.", ko: "도와줘서 고마워." }] },
  { title: "el 쪽 말 · la 쪽 말, 하나 · 여럿 맞추기",
    core: "Every noun is either an el word or a la word: most -o words take el/un, most -a words take la/una (exceptions to learn: el día, el problema, la mano). Describing words match it: el plato limpio, la mesa limpia, los platos limpios, las mesas limpias. Plural: add -s after a vowel, -es after a consonant (pan → panes, limón → limones).",
    how: "o 로 끝나면 대개 el, a 로 끝나면 대개 la. 꾸미는 말도 끝을 맞추고 여럿이면 -s. el día, la mano 같은 예외 두세 개만.",
    rule: "o 로 끝나면 대개 el, a 로 끝나면 대개 la. 꾸미는 말도 끝을 맞추고, 여럿이면 -s.",
    ex: [{ es: "Los platos están limpios.", ko: "접시들이 깨끗해." },
         { es: "La mesa está sucia.", ko: "테이블이 더러워." }] },
  { title: "hay 와 está — ‘있다’ 두 가지",
    core: "hay = there is / there are, for whether something exists at all (any number, never changes): hay pan, hay tres ollas, no hay gas. está / están = where a known, specific thing is: el pan está en la mesa, las ollas están abajo. In the past: había. hay que + verb = one has to.",
    how: "‘~ 있어?’처럼 있는지 없는지는 hay, 이미 아는 그것이 어디 있는지는 está. 같은 물건으로 두 문장을 짝지어 보여 줄 것.",
    rule: "있는지 없는지는 hay, 이미 아는 그것이 어디 있는지는 está.",
    ex: [{ es: "¿Hay leche?", ko: "우유 있어?" },
         { es: "La leche está en el refri.", ko: "우유는 냉장고에 있어." }] },
  { title: "묻는 말 — qué · dónde · cuándo · cómo · cuánto",
    core: "Question words carry a written accent: qué (what), quién (who), dónde (where), cuándo (when), cómo (how), cuánto / cuántos (how much / how many: ¿cuánto cuesta?, ¿cuántos platos?), cuál (which), por qué (why) — and the answer 'because' is porque, one word, no accent. In Mexico ¿mande? asks politely for something to be repeated.",
    how: "묻는 말은 글자 위에 작은 빗금이 붙는다. ‘왜’는 por qué 두 단어, 대답 ‘왜냐하면’은 porque 한 단어. 주방에서 자주 묻는 말로 예문. ¿mande? 도 한 줄.",
    rule: "묻는 말은 글자 위에 작은 빗금이 붙어요. ‘왜’는 por qué, 대답 ‘왜냐하면’은 porque.",
    ex: [{ es: "¿Dónde está el cuchillo?", ko: "칼 어디 있어?" },
         { es: "¿Cuánto cuesta?", ko: "얼마예요?" }] },
  { title: "해야 해 — tengo que · hay que · debes",
    core: "tener que + dictionary form = I/you have to (personal, the most common): tengo que, tienes que, tiene que, tenemos que. hay que + dictionary form = it has to be done, no one in particular. deber + dictionary form = should (advice, duty): debes descansar.",
    how: "내가 해야 하면 tengo que, 누구든 해야 하면 hay que, ‘~해야지’는 debes. 나·너·그·우리 표는 tener que 로.",
    rule: "내가 해야 하면 tengo que, 누구든 해야 하면 hay que, ‘~해야지’는 debes.",
    ex: [{ es: "Tengo que lavar los platos.", ko: "나 설거지해야 해." },
         { es: "Hay que cerrar la puerta.", ko: "문을 닫아야 해." }] },
  { title: "앞으로 할 일 — voy a ~ 와 -é",
    core: "The everyday future in Mexico: ir a + the dictionary form (voy a cocinar, vas a ver). The one-word future adds -é, -ás, -á, -emos, -án to the whole dictionary form (cocinaré, comerás); it sounds firmer, and is also used to guess (¿Dónde estará?). Irregular: haré, tendré, pondré, diré, saldré, vendré, podré.",
    how: "앞으로 할 일은 voy a + 사전에 나오는 모양이 가장 흔하다. 한 단어로 끝에 -é 를 붙이는 방법도 있지만 더 딱딱하고 짐작할 때도 쓴다. 두 방법을 나란히.",
    rule: "앞으로 할 일은 voy a + 사전에 나오는 모양이 가장 흔해요. 한 단어로는 끝에 -é, -ás, -á.",
    ex: [{ es: "Mañana voy a llegar temprano.", ko: "내일 일찍 올게." },
         { es: "Te llamaré en la noche.", ko: "밤에 너한테 전화할게." }] },
  { title: "지금 하는 중 — estoy + -ando · -iendo",
    core: "estar + a form ending in -ando (-ar verbs) or -iendo (-er/-ir verbs): estoy cocinando, está lavando, estamos comiendo; leyendo, durmiendo. Only for what is happening right now. The little words may go in front or be glued at the end: lo estoy lavando = estoy lavándolo.",
    how: "‘지금 ~하고 있는 중’. estoy 다음에 -ando, -iendo. 주방에서 지금 하는 일로 예문. 작은 말은 앞에 와도 되고 끝에 붙어도 된다.",
    rule: "지금 하고 있는 중이면 estoy + -ando·-iendo.",
    ex: [{ es: "Estoy picando la cebolla.", ko: "나 지금 양파 썰고 있어." },
         { es: "¿Qué estás haciendo?", ko: "너 지금 뭐 하고 있어?" }] },
  { title: "‘~하면’ — si …",
    core: "si + the ordinary present, then the present, a future or a request: si llueve, no voy; si tienes tiempo, ayúdame; si llega el jefe, avísame. Only real, possible situations here (no 'if I were'). Never the one-word future after si: si llega, not si llegará.",
    how: "‘~하면’은 si 다음에 지금 모양을 그대로. 뒤에는 부탁이나 할 일을 붙인다. 주방에서 바로 쓸 예문.",
    rule: "‘~하면’은 si 다음에 지금 모양을 그대로 써요.",
    ex: [{ es: "Si tienes hambre, come algo.", ko: "배고프면 뭐 좀 먹어." },
         { es: "Si llega el cliente, me avisas.", ko: "손님 오면 나한테 알려 줘." }] },
  { title: "비교하기 — más … que · tan … como",
    core: "más + describing word + que = more ... than; menos ... que = less ... than; tan ... como = as ... as. Special ones: mejor (better), peor (worse), mayor (older), menor (younger). el más grande = the biggest. Before a number it is más de: más de diez.",
    how: "더 ~하면 más … que, 덜 ~하면 menos … que, 똑같이 ~하면 tan … como. mejor, peor 는 따로. 주방 물건 비교로.",
    rule: "더 ~하면 más … que, 덜 ~하면 menos … que, 똑같이 ~하면 tan … como.",
    ex: [{ es: "Este cuchillo es más grande que ese.", ko: "이 칼이 그것보다 더 커." },
         { es: "La sopa está tan caliente como el café.", ko: "수프가 커피만큼 뜨거워." }] },
  { title: "어쩌다 그렇게 됐어 — se me cayó",
    core: "Things that happened without meaning to: se + me/te/le + the event: se me cayó el vaso (the glass fell 'on me' = I dropped it by accident), se me olvidó, se me rompió, se nos acabó el gas, se le quemó el arroz. The thing decides the ending: se me cayeron los platos.",
    how: "‘내가 일부러 한 게 아니라 그렇게 돼 버렸어’라는 느낌. se + me(나한테) + 일어난 일. 떨어뜨리기·깜빡하기·태우기 같은 주방 실수로. se 의 세 얼굴과 이어 줄 것.",
    rule: "일부러 한 게 아니면 se me + 일어난 일: se me cayó, se me olvidó.",
    ex: [{ es: "Se me cayó el vaso.", ko: "실수로 컵을 떨어뜨렸어." },
         { es: "Se me olvidó la llave.", ko: "열쇠를 깜빡했어." }] },
  { title: "바라는 마음 — quiero que + 살짝 바뀐 끝",
    core: "When someone wants, asks or hopes that ANOTHER person does something, the verb after que changes its ending: -ar verbs take -e (quiero que limpies), -er/-ir verbs take -a (quiero que comas). Same with necesito que, espero que, ojalá que, para que. These are the same endings seen in 'no hables, no comas', and the same short ones: hagas, pongas, vayas, tengas (no lo hagas → quiero que lo hagas). When the SAME person wants to do it, no que and no change: quiero comer, never quiero que como.",
    how: "‘네가 ~해 줬으면 좋겠어’처럼 다른 사람에게 바랄 때 que 뒤 끝이 살짝 바뀐다. ‘하지 마’에서 본 그 끝과 같다는 것을 이어 줄 것. 문법 이름은 쓰지 말 것.",
    rule: "다른 사람이 ~하길 바랄 땐 que 뒤 끝이 바뀌어요: -ar 말은 -e, -er·-ir 말은 -a.",
    ex: [{ es: "Quiero que me ayudes.", ko: "네가 나를 도와줬으면 좋겠어." },
         { es: "Necesito que llegues temprano.", ko: "네가 일찍 와 줘야 해." }] }
];

/* ①..⑳ then ㉑..㉟ — the course is shorter than that */
function circNum(n){
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCharCode(0x3251 + n - 21);
  return String(n);
}

function grammarState(){
  const s = asObj(jget(GRAMMAR_KEY, null)) || {};
  const last = asObj(s.last);
  return {
    n: Number.isInteger(s.n) && s.n >= 0 ? s.n : 0,
    last: last && typeof last.date === "string" && Number.isInteger(last.k) && last.k >= 0 ? last : null
  };
}
/* k counts every step ever taught; idx is where that is in the course and
   round how many times round it has gone (1 or more = 복습 회차) */
function grammarPick(iso){
  const st = grammarState(), T = GRAMMAR_STEPS.length;
  const k = st.last && st.last.date === iso ? st.last.k : st.n;
  const recap = [k - 1, k - 2].filter((x) => x >= 0).map((x) => x % T);
  return { k: k, idx: k % T, round: Math.floor(k / T), total: T, recap: recap };
}

/* ---- lo·le·se: today's lines that may carry one ----
   Only a hint for Gemini, which decides what really is one (la before a
   noun means "the"). Stand-alone le/les/se/me/te/nos/lo, and a word with one
   glued to its end: dámelo, mételo, ponlo, hacerlo, dándole. */
const PRON_SOLO = new Set(["lo", "le", "les", "se", "me", "te", "nos"]);
const PRON_TAIL = /^(?:[a-zñü]*[áéíóú][a-zñü]*(?:me|te|se|nos|lo|la|los|las|le|les)|[a-zñ]+(?:ar|er|ir|ír|ando|iendo)(?:me|se|nos|lo|la|los|las|le|les)|(?:pon|haz|di|ten|ven|sal|ve)(?:me|te|se|nos|lo|la|los|las|le|les)(?:lo|la|los|las)?)$/;
function pronounHits(lines){
  const known = new Set(wordList());
  const out = [];
  for (const l of (Array.isArray(lines) ? lines : [])){
    const s = cleanStr(l);
    if (!s) continue;
    const toks = s.toLowerCase().split(/[^a-záéíóúñü]+/).filter(Boolean);
    if (toks.some((t) => PRON_SOLO.has(t) || (t.length > 4 && !known.has(t) && PRON_TAIL.test(t)))){
      if (out.indexOf(s) < 0) out.push(s);
    }
    if (out.length >= 6) break;
  }
  return out;
}

/* the drill's own material, for a day when today's talk has none */
const PRON_BASE = [
  { es: "Dáselo.", ko: "그에게 그것을 줘.", who: "그에게", what: "그것을" },
  { es: "Lo pongo aquí.", ko: "그거 여기 놓을게.", who: "", what: "그것을" },
  { es: "Le doy la cuenta.", ko: "그에게 계산서를 줘요.", who: "그에게", what: "계산서를" },
  { es: "Te lo traigo.", ko: "너한테 그거 가져다줄게.", who: "너에게", what: "그것을" },
  { es: "Se lo dije.", ko: "그에게 그걸 말했어.", who: "그에게", what: "그것을" },
  { es: "Pásamela.", ko: "그거 나한테 건네줘.", who: "나에게", what: "그것을" },
  { es: "No lo toques.", ko: "그거 만지지 마.", who: "", what: "그것을" },
  { es: "Se lava las manos.", ko: "그는 자기 손을 씻어.", who: "자기 자신에게", what: "손을" },
  { es: "¿Me lo explicas otra vez?", ko: "나한테 그거 다시 설명해 줄래?", who: "나에게", what: "그것을" },
  { es: "Ya se la di.", ko: "그에게 그거 벌써 줬어.", who: "그에게", what: "그것을" },
  { es: "Dímelo.", ko: "나한테 그거 말해 줘.", who: "나에게", what: "그것을" },
  { es: "Les sirvo la sopa.", ko: "그분들께 수프를 드려요.", who: "그 사람들에게", what: "수프를" }
];
const PRON_POINTS = 2, PRON_QUIZ = 3;

/* What the drill teaches today: Gemini's points and quiz where it wrote
   them, the base set filling whatever is missing. Never empty. */
function pronounPlan(p, iso, recent){
  const L = PRON_BASE.length;
  const start = ((dayNum(iso) * 5) % L + L) % L;          // a different few each day
  /* a line drilled in the last few days gives way to one not heard lately —
     the same «y mételo al refri» every morning teaches nothing new */
  const fresh = (x) => !(recent && recent[taughtId("p", x.es)]);
  const points = p && p.points ? p.points.filter(fresh).slice(0, 3) : [];
  const quiz = p && p.quiz ? p.quiz.filter(fresh).slice(0, PRON_QUIZ) : [];
  const used = new Set(points.concat(quiz).map((x) => foldEs(x.es)));
  const spare = [];
  for (let i = 0; i < L; i++){
    const b = PRON_BASE[(start + i) % L];
    if (!used.has(foldEs(b.es)) && fresh(b)) spare.push(b);
  }
  /* everything was drilled lately: the base set still fills, in its turn */
  if (spare.length < PRON_POINTS + PRON_QUIZ){
    for (let i = 0; i < L; i++){
      const b = PRON_BASE[(start + i) % L];
      if (!used.has(foldEs(b.es)) && spare.indexOf(b) < 0) spare.push(b);
    }
  }
  if (!points.length) for (const b of spare.splice(0, PRON_POINTS)) points.push(Object.assign({ today: false }, b));
  while (quiz.length < PRON_QUIZ && spare.length){
    const b = spare.shift();
    quiz.push({ es: b.es, ko: b.ko });
  }
  return { points: points, quiz: quiz };
}

/* Everything the day's course needs, read before the script is written. */
function curriculumPlan(sourceEs, iso){
  const pick = newWordsPick(iso, sourceEs);
  const recent = taughtRecent(iso);
  return {
    iso: iso,
    newWords: pick.words, wordsAgain: pick.again, oldWords: pick.oldWords,
    learnedBefore: pick.learnedBefore,
    wordReview: newWordsReview(iso),
    grammar: grammarPick(iso),
    pronounHits: pronounHits(sourceEs),
    recent: recent,
    recentList: taughtRecentList(recent)
  };
}

/* Called only after the lesson record has been saved. The words actually
   taught become learned on that study day; the grammar step moves on once a
   day — a 다시 만들기 on the same day finds it already moved and keeps it. */
function curriculumCommit(lesson){
  const c = lesson && asObj(lesson.curriculum);
  if (!c || typeof c.iso !== "string") return;
  const learned = newWordsLearned();
  for (const w of (Array.isArray(c.newWords) ? c.newWords : [])){
    if (w && w.es) learned[w.es] = { d: c.iso, ko: cleanStr(w.ko) };
  }
  jset(NEW_WORDS_KEY, { learned: learned });
  if (c.grammar && Number.isInteger(c.grammar.k)){
    const g = grammarState();
    if (!(g.last && g.last.date === c.iso)) jset(GRAMMAR_KEY, { n: c.grammar.k + 1, last: { date: c.iso, k: c.grammar.k } });
  }
  if (Array.isArray(c.taught)) taughtCommit(c.iso, c.taught);
}

/* ---------------- 0교시 — yesterday's review ----------------

   Built by code from the previous saved lesson — no extra Gemini call. It reads
   that lesson's display rows, whose sectionId/kind/es/ko have been the same
   since the first version, so a lesson from before 4교시 existed simply has no
   frames to offer. Words are never reviewed here: sentences, expressions and
   frames are. What the user asked about yesterday comes first. */
const YDAY_SENTS = 2, YDAY_EXPR_MIN = 3, YDAY_EXPR_MAX = 6;
const YDAY_MAX_MS = 270000;         // about four and a half minutes, everything in
const YDAY_PRI = { expr: 1, frame: 1, idiom: 2, sent: 3 };

/* lower case, Spanish accents and punctuation gone; Hangul is put back together */
function reviewKey(s){
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .toLowerCase().replace(/[…~¿?¡!.,;:"'«»()\[\]\-]/g, " ").replace(/\s+/g, " ").trim();
}

/* the reviewable items of a saved lesson, in the order they were taught */
function reviewItemsFrom(rec){
  const rows = rec && rec.lesson && Array.isArray(rec.lesson.rows) ? rec.lesson.rows : [];
  const out = [], seen = new Set();
  const add = (it) => {
    const k = reviewKey(it.es);
    if (!k || !it.ko || seen.has(k)) return;
    seen.add(k);
    out.push(Object.assign(it, { key: k, order: out.length }));
  };
  const isFrameHead = (r) => r && r.sectionId === "frames" && r.kind === "pair" &&
    (r.badge === "×2" || r.badge === "어제 복습");
  for (let i = 0; i < rows.length; i++){
    const r = asObj(rows[i]);
    if (!r) continue;
    const es = cleanStr(r.es), ko = cleanStr(r.ko);
    if (!es || !ko) continue;
    /* a story20 lesson marks the head row of each item it taught */
    if (r.rv){
      if (YDAY_PRI[r.rv]) add({ type: r.rv, es: es.replace(/\s*…$/, ""), show: es, ko: ko, ex: null });
      continue;
    }
    if (isFrameHead(r)){
      /* one example to go with it: a swapped one first, else the real one */
      let swap = null, real = null;
      for (let j = i + 1; j < rows.length && asObj(rows[j]) && rows[j].sectionId === "frames" &&
                          !isFrameHead(rows[j]); j++){
        const x = rows[j], xe = cleanStr(x.es), xk = cleanStr(x.ko);
        if (x.kind !== "pair" || !xe || !xk) continue;
        if (!swap && x.badge === "바꿔 끼우기") swap = { es: xe, ko: xk };
        if (!real && x.badge === "오늘 문장") real = { es: xe, ko: xk };
      }
      add({ type: "frame", es: es.replace(/\s*…$/, ""), show: es, ko: ko, ex: swap || real });
    } else if (r.sectionId === "idioms" && r.kind === "pair"){
      add({ type: "idiom", es: es, show: es, ko: ko, ex: null });
    } else if (r.sectionId === "sents" && r.kind === "full"){
      add({ type: "sent", es: es, show: es, ko: ko, ex: null });
    }
  }
  return out;
}

/* what was asked about that lesson: the questions, and the Spanish in the answers */
function reviewAsked(qa){
  const es = [], ko = [];
  for (const t of (Array.isArray(qa) ? qa : [])){
    if (!asObj(t)) continue;
    const q = reviewKey(t.q);
    if (q){ es.push(" " + q + " "); ko.push(q); }
    for (const p of (Array.isArray(t.parts) ? t.parts : [])){
      if (p && p.lang === "es"){ const k = reviewKey(p.text); if (k) es.push(" " + k + " "); }
    }
  }
  return { es: es, ko: ko };
}
function reviewHit(it, asked){
  const k = it.key, kk = reviewKey(it.ko);
  return asked.es.some((a) => (k.length >= 3 && a.indexOf(" " + k + " ") >= 0) ||
                              (a.trim().length >= 6 && (" " + k + " ").indexOf(a) >= 0)) ||
         (kk.length >= 3 && asked.ko.some((a) => a.indexOf(kk) >= 0));
}

/* what one item says aloud: meaning, a gap to answer in, the answer, a gap to repeat */
function reviewSegs(it){
  const out = [
    { speaker: "ko", text: sayKo(it.ko), pause: P.quizThink },
    { speaker: "es", text: it.es, pause: it.type === "sent" ? P.full : P.quizFollow }
  ];
  if (it.ex){
    out.push({ speaker: "es", text: it.ex.es, pause: P.frameEs, ex: true });
    out.push({ speaker: "ko", text: it.ex.ko, pause: P.frameKo, ex: true });
  }
  return out;
}
const reviewMs = (list) => list.reduce((n, s) => n + estimateMs(s) + s.pause * 1000, 0);

const REVIEW_HOW = "한국어 뜻을 듣고, 3초 안에 스페인어로 떠올려 말해 보세요. 그다음 정답을 듣고 따라 하세요.";
const REVIEW_END = "좋아요. 이제 오늘 수업이에요.";

/* The plan for 0교시, or null. `iso` is today's study day; `prev` the saved
   record to review — anything malformed in it is skipped, never thrown. */
function reviewPlan(prev, iso){
  if (!asObj(prev) || !prev.date || !(String(prev.date) < iso)) return null;
  const all = reviewItemsFrom(prev);
  if (!all.length) return null;
  const asked = reviewAsked(prev.qa);
  for (const it of all) it.hit = reviewHit(it, asked);
  const rank = (it) => (it.hit ? 0 : YDAY_PRI[it.type]);
  const sorted = all.slice().sort((a, b) => rank(a) - rank(b) || a.order - b.order);

  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) - 1, 12);
  const yesterday = studyDate(d) === String(prev.date);
  const label = (prev.lesson && cleanStr(prev.lesson.dateLabel)) ||
    (Number(String(prev.date).slice(5, 7)) + "월 " + Number(String(prev.date).slice(8, 10)) + "일");
  const lead = (yesterday ? "먼저 어제 배운 표현을 복습할게요. " : "먼저 지난 " + label + " 수업을 복습할게요. ") + REVIEW_HOW;

  const fixedMs = reviewMs([{ speaker: "ko", text: lead, pause: P.lead },
                            { speaker: "ko", text: REVIEW_END, pause: P.section }]);
  const take = [];
  let ms = fixedMs, nS = 0, nE = 0;
  const fits = (it) => ms + reviewMs(reviewSegs(it)) <= YDAY_MAX_MS;
  for (const it of sorted){
    const sent = it.type === "sent";
    if (sent ? nS >= YDAY_SENTS : nE >= YDAY_EXPR_MAX) continue;
    if (!fits(it)) continue;
    take.push(it);
    ms += reviewMs(reviewSegs(it));
    if (sent) nS++; else nE++;
  }
  /* at least one sentence when there was one, if the expressions can spare a place */
  const firstSent = sorted.find((it) => it.type === "sent");
  if (!nS && firstSent && nE > YDAY_EXPR_MIN){
    for (let i = take.length - 1; i >= 0; i--){
      if (take[i].hit) continue;
      const out = take[i];
      const was = ms;
      ms += reviewMs(reviewSegs(firstSent)) - reviewMs(reviewSegs(out));
      if (ms <= YDAY_MAX_MS){ take.splice(i, 1); take.push(firstSent); nS++; nE--; }
      else ms = was;
      break;
    }
  }
  if (!take.length) return null;
  return { date: String(prev.date), label: label, yesterday: yesterday, lead: lead,
           items: take, estMs: ms };
}

/* ---------------- the 10- or 20-minute lesson: five parts, built in code ----------------

   The AI writes the material (lessonNormalise); everything about time is
   decided here: what is said in which part, how often, and the silences the
   learner answers in. Each part is built at a few levels of fullness and the
   combination whose estimated length lands nearest the target (10:00 or
   20:00, lset.minutes) and nearest each part's own slot is kept. The levels
   only add repetition rounds (a second quiz round, slow reads, replays,
   meaning-first rounds, more challenge rounds); the core — the targets ×3,
   the story lines with call and response, one challenge round, the take-away
   and the mission — is in every level, so a short lesson loses rounds, not
   material. A lesson made this way carries fmt LESSON_FMT (the name is from
   when 20 minutes was the only length) and `minutes`; lessonTimeline then
   writes the real start and end of each part into its title. Old saved
   lessons have no fmt and are left exactly as they were. */

const LESSON_FMT = "story20";
const PARTS = {
  warm:      { id: "warm",      title: "① 도입 · 워밍업" },
  cheat:     { id: "cheat",     title: "② 치트키 1" },
  story:     { id: "story",     title: "③ 치트키 2 · 위기 탈출 상황극" },
  challenge: { id: "challenge", title: "④ 1초 반응 챌린지" },
  cool:      { id: "cool",      title: "⑤ 쿨다운 · 오늘의 미션" }
};
/* Per length: the target, each part's slot (ms), and what the AI is asked to
   write. At 10 minutes the warm-up and cool-down keep more of their share (the
   quiz and the take-away are short already); the story and the challenge get
   less material instead of being cut afterwards. */
const LESSON_LENGTHS = {
  10: { targetMs: 10 * 60000,
        slot: { warm: 100000, cheat: 160000, story: 160000, challenge: 100000, cool: 80000 },
        ai: { min: 10, clock: ["0-2", "2-4", "4-7", "7-9", "9-10"],
              lines: "6 to 8", learner: "3 or 4", challenge: "5 or 6" } },
  20: { targetMs: 20 * 60000,
        slot: { warm: 180000, cheat: 300000, story: 360000, challenge: 240000, cool: 120000 },
        ai: { min: 20, clock: ["0-3", "3-8", "8-14", "14-18", "18-20"],
              lines: "10 to 14", learner: "5 to 7", challenge: "10 to 12" } }
};
const lessonLength = (minutes) => LESSON_LENGTHS[Number(minutes) === 20 ? 20 : 10];

/* Pauses, in seconds. The answer gaps are the point of the lesson: the
   learner speaks into them. */
const Q = {
  lead: 0.8, say: 0.6, role: 0.25, line: 0.8, lineKo: 1.0,
  think3: 3.0,                 // the warm-up speed quiz: three seconds to answer
  think2: 2.0,                 // «거꾸로»: the meaning, then a beat longer than the challenge
  think1: 1.0,                 // the one-second challenge
  afterAns: 1.6,               // after an answer, time to say it once more
  repMin: 2.4, repMax: 3.0, repPad: 1.0,   // repeat-after-me: the line's length plus a breath
  chain: 2.0,                  // the rhythm chain, a steady beat between targets
  section: 1.2                 // added on top, between parts
};
/* the gap after a model line the learner repeats: as long as the line, plus a breath, 2-3 s */
function repGap(es){
  const sec = estimateMs({ speaker: "es", text: String(es || ""), rate: 1 }) / 1000 + Q.repPad;
  return Math.round(Math.min(Q.repMax, Math.max(Q.repMin, sec)) * 10) / 10;
}

/* Generated sound cues, written into the mp3 in front of a segment: a chime
   where a part starts, a tick right before a quiz answer. Length is the whole
   slot, tone plus the short silence after it. Device voice plays none. */
const CUE_MS = { chime: 650, tick: 200 };
const CUE_TONES = { chime: [{ f: 880, ms: 170, decay: 9 }, { f: 1318.5, ms: 260, decay: 9 }],
                    tick: [{ f: 1760, ms: 55, decay: 60 }] };
const CUE_GAIN = 7000;
function cuePcm(kind, sr){
  const notes = CUE_TONES[kind];
  const out = new Int16Array(notes ? Math.round(sr * CUE_MS[kind] / 1000) : 0);
  let at = 0;
  for (const n of (notes || [])){
    const len = Math.round(sr * n.ms / 1000);
    for (let k = 0; k < len && at + k < out.length; k++){
      const t = k / sr;
      const env = Math.min(1, k / (sr * 0.005)) * Math.exp(-t * n.decay);
      out[at + k] = Math.round(CUE_GAIN * env * Math.sin(2 * Math.PI * n.f * t));
    }
    at += len;
  }
  return out;
}

const CR_REPEAT = "🗣 따라 하세요", CR_SAY = "🗣 말해 보세요", CR_FAST = "🗣 1초 안에 말해 보세요";
const pickSay = (pool, n) => pool[((n % pool.length) + pool.length) % pool.length];
const plainKo = (s) => String(s || "").replace(/\s*~\s*/g, " ").replace(/\s+/g, " ").trim();

/* One part: its own rows and segments with local ids, joined at the end. */
function lessonPart(part){
  const rows = [], segs = [];
  let g = 0;
  return {
    part: part, rows: rows, segs: segs, taught: [], newUsed: [], learnedKo: {},
    row(kind, fields){ g++; rows.push(Object.assign({ gid: g, kind: kind }, fields)); return g; },
    seg(gid, speaker, text, pause, extra){
      text = cleanStr(text);
      if (!text) return;
      segs.push(Object.assign({ speaker: speaker, text: text, rate: 1, pauseAfter: pause, gid: gid }, extra || {}));
    },
    ms(){ return segs.reduce((n, s) => n + estimateMs(s) + (CUE_MS[s.cue] || 0) + s.pauseAfter * 1000, 0); },
    teach(t, es){ if (cleanStr(es)) this.taught.push({ t: t, es: cleanStr(es).replace(/\s*…$/, "") }); }
  };
}
/* a narrated line, shown and said */
function pSay(p, ko, pause, extra, shown){
  const g = p.row("say", { ko: shown || ko });
  p.seg(g, "ko", ko, pause == null ? Q.lead : pause, extra);
  return g;
}
/* repeat after me, `n` times at a steady pace, then the meaning */
function pRepeat(p, x, n, fields, cue){
  const g = p.row("pair", Object.assign({ es: x.es, ko: x.ko, cr: CR_REPEAT }, fields || {}));
  const gap = repGap(x.es);
  if (cue) p.seg(g, "ko", cue, Q.say);
  for (let k = 0; k < n; k++) p.seg(g, "es", x.es, gap);
  p.seg(g, "ko", plainKo(x.ko), Q.lead);
  return g;
}
/* a quiz line: the Korean, a gap to answer in, a tick, the Spanish, a gap to say it again.
   On screen the Spanish stays covered until it plays (see lessonTimeline). */
function pQuiz(p, x, think, fields){
  const g = p.row("pair", Object.assign({ es: x.es, ko: x.ko, quiz: true }, fields || {}));
  p.seg(g, "ko", plainKo(x.ko), think);
  p.seg(g, "es", x.es, Q.afterAns, { cue: "tick" });
  return g;
}

/* ① intro, the speed quiz on the last lesson, today's situation */
function buildWarm(ctx, level){
  const p = lessonPart(PARTS.warm), c = ctx.content;
  const nT = c.targets.length;
  const intro = ctx.dateLabel + " 스페인어 수업입니다. 오늘은 " + ctx.minutes + "분 동안 듣기만 하지 말고, 입으로 직접 말하는 수업이에요. " +
    "조용해지는 틈이 나오면, 그 틈에 꼭 소리 내어 말해 보세요.";
  pSay(p, intro, Q.lead, { cue: "chime" });

  /* the tail is measured first, so the quiz gets whatever is left of the slot */
  const tail = lessonPart(PARTS.warm);
  const setup = c.situation || "오늘 여러분은 멕시코 식당 주방의 신입 요리사입니다! 오늘 하루를 말로 버텨 볼게요.";
  pSay(tail, setup, Q.lead);
  if (nT){
    pSay(tail, "오늘 손에 쥘 무기는 딱 " + nT + "개예요. 먼저 소리만 들어 보세요.", Q.say);
    for (const t of c.targets){
      const g = tail.row("pair", { es: t.es, ko: t.ko, badge: "오늘의 무기" });
      tail.seg(g, "es", t.es, Q.say);
      tail.seg(g, "ko", plainKo(t.ko), Q.line);
    }
  }
  ctx.reviewN = 0;
  if (!ctx.quiz.length) return [p, tail];
  const q = lessonPart(PARTS.warm);
  const who = ctx.plan ? (ctx.plan.yesterday ? "어제 배운 표현이에요." : "지난 " + ctx.plan.label + " 수업 표현이에요.")
                       : "지난번에 배운 단어예요.";
  pSay(q, "몸풀기로 3초 스피드 퀴즈! " + who + " 한국어를 들으면 3초 안에 스페인어로 말하세요. 그다음에 정답이 나와요.", Q.lead);
  const room = ctx.len.slot.warm - p.ms() - tail.ms() - 4000;
  const took = [];
  for (const it of ctx.quiz){
    const trial = lessonPart(PARTS.warm);
    pQuiz(trial, it, Q.think3, {});
    if (took.length >= 2 && q.ms() + trial.ms() > room) break;
    pQuiz(q, it, Q.think3, { badge: it.badge, cr: CR_SAY });
    took.push(it);
  }
  /* level 1: the same ones again, faster — the ping-pong */
  if (level >= 1 && took.length >= 3){
    pSay(q, "한 번 더, 이번엔 2초!", Q.say);
    for (const it of took.slice().reverse().slice(0, 6)) pQuiz(q, it, Q.think2, { badge: "2초", cr: CR_SAY });
  }
  pSay(q, pickSay(["좋아요, 입이 좀 풀렸죠?", "좋아요, 몸 풀렸죠?", "잘하셨어요. 이제 오늘 이야기로 갑니다."], ctx.dn), Q.say);
  ctx.reviewN = took.length;
  return [p, q, tail];
}

/* ② today's grammar step as one cheat code, then the targets in rhythm: a
   slow model, three at a steady beat, an example; the little words lo·le·se;
   then, by level, the targets backwards (meaning first) and in a chain */
function buildCheat(ctx, level){
  const c = ctx.content, step = ctx.step;
  const title = PARTS.cheat.title + (step ? " · " + step.title.split(" — ")[0] : "");
  const p = lessonPart(Object.assign({}, PARTS.cheat, { title: title }));
  const hook = c.cheat.hook || (step ? step.rule : "오늘의 표현을 입에 붙여 볼게요.");
  pSay(p, "치트키 1! " + plainKo(hook), Q.lead, { cue: "chime" }, "🔑 치트키: " + hook);
  for (const line of c.cheat.explain) pSay(p, plainKo(line), Q.say);

  c.targets.forEach((t, i) => {
    const known = ctx.knownT("v", t.es);
    const head = ordKo(i + 1) + "." + (t.base && t.baseKo ? "" : " " + plainKo(t.ko));
    const g = p.row("lead", { ko: ordKo(i + 1) + (t.base ? " · " + t.base + (t.baseKo ? " (" + t.baseKo + ")" : "") : " · " + t.ko) });
    p.seg(g, "ko", head, Q.say);
    if (t.base && t.baseKo){
      p.seg(g, "es", t.base, Q.say);
      p.seg(g, "ko", plainKo(t.baseKo) + ".", Q.say);
    }
    if (t.how && !known){
      const gh = p.row("note", { ko: t.how });
      p.seg(gh, "ko", sayWhy(t.how), Q.say);
    }
    if (level >= 1 && !known){
      const gs = p.row("slow", { es: t.es, badge: "천천히" });
      p.seg(gs, "ko", "천천히 한 번.", Q.role);
      p.seg(gs, "es", t.es, repGap(t.es), { rate: SLOW_RATE });
    }
    pRepeat(p, t, known ? 1 : 3, { badge: known ? "최근 배운 것" : "×3 리듬", gesture: t.gesture || undefined, rv: "expr" },
            i === 0 ? "세 번, 같은 박자로 따라 하세요." : "따라 하세요.");
    if (!known) p.teach("v", t.es);
    /* a queued new word that only a target uses (not the story) is taught here */
    for (const w of c.newUsed){
      if (w.line >= 0 || w.target !== i) continue;
      const gw = p.row("pair", { es: w.es, ko: w.ko, badge: "🆕 새 단어", cr: CR_REPEAT });
      p.seg(gw, "ko", "새 단어예요. " + plainKo(w.ko) + ".", Q.say);
      p.seg(gw, "es", w.es, repGap(w.es));
      p.newUsed.push(w);
    }
    if (level >= 1 && t.ex) pRepeat(p, t.ex, 1, { badge: "예문" }, "");
  });

  /* the grammar step's own examples: the AI's, else the course's */
  const exs = c.cheat.examples.length ? c.cheat.examples : (step ? step.ex.slice(0, 1) : []);
  if (exs.length){
    pSay(p, "치트키가 들어간 문장 하나 더 들어 볼게요.", Q.say);
    for (const x of exs) pRepeat(p, x, 1, { badge: "예문" }, "");
  }

  /* lo·le·se, two lines: who gets it, what is given */
  if (ctx.pronPts.length){
    pSay(p, "작은 말 lo, le, se 도 두 개만 볼게요. 누구에게, 무엇을, 만 들어 보세요.", Q.say);
    for (const x of ctx.pronPts){
      pRepeat(p, x, 1, { badge: "lo·le·se" }, "");
      const ask = [x.who ? "누구에게? " + x.who : "", x.what ? "무엇을? " + x.what : ""].filter(Boolean);
      if (ask.length){
        const gn = p.row("note", { ko: ask.join(" · ") });
        p.seg(gn, "ko", ask.join(". ") + ".", Q.say);
      }
      p.teach("p", x.es);
    }
  }
  if (level >= 2 && c.targets.length){
    pSay(p, "이번엔 거꾸로! 한국어를 들으면 먼저 스페인어로 말해 보세요.", Q.lead);
    for (const t of c.targets) pQuiz(p, t, Q.think2, { badge: "거꾸로", cr: CR_SAY });
  }
  /* level 4: each target's example, meaning first — the target inside a sentence */
  if (level >= 4 && c.targets.some((t) => t.ex)){
    pSay(p, "이번엔 문장으로! 한국어를 들으면 오늘 무기를 넣어서 말해 보세요.", Q.lead);
    for (const t of c.targets) if (t.ex) pQuiz(p, t.ex, Q.think3, { badge: "문장으로", cr: CR_SAY });
  }
  if (level >= 3 && c.targets.length > 1){
    pSay(p, "마지막으로 연달아, 리듬 타면서 두 번!", Q.say);
    for (let round = 0; round < 2; round++){
      const g = p.row("pair", { es: c.targets.map((t) => t.es).join(" · "), ko: "연달아 " + (round + 1) + "번째", cr: CR_REPEAT });
      for (const t of c.targets) p.seg(g, "es", t.es, Q.chain);
    }
  }
  return [p];
}

/* ③ the role-play: the frames first, then the scene with the learner's lines
   repeated; by level, the scene once more in Spanish only, then with the
   learner speaking first on their own lines, then on every line */
function buildStory(ctx, level){
  const c = ctx.content, lines = c.story.lines;
  const p = lessonPart(PARTS.story);
  const setup = c.story.setup || (c.story.title ? c.story.title + "." : "");
  pSay(p, "치트키 2, 위기 탈출 상황극! " + setup, Q.lead, { cue: "chime" },
       "🎬 " + (c.story.title ? c.story.title + " — " : "") + (c.story.setup || "위기 탈출 상황극"));

  c.frames.forEach((f) => {
    const known = ctx.knownT("f", f.es);
    const lead = "오늘의 뼈대, " + plainKo(f.ko) + "." + (f.note ? " " + f.note : "");
    const g = p.row("pair", { es: f.es + " …", ko: f.ko, badge: known ? "아는 뼈대" : "뼈대", cr: CR_REPEAT, rv: "frame" });
    p.seg(g, "ko", sayKo(lead), Q.say);
    const gap = repGap(f.es);
    p.seg(g, "es", f.es, gap);
    if (!known){ p.seg(g, "es", f.es, gap); p.teach("f", f.es); }
  });

  const learnerRole = (lines.find((l) => l.learner) || {}).who || "";
  if (lines.length){
    pSay(p, learnerRole ? "자, 상황 시작! 여러분은 " + learnerRole + "예요. " + learnerRole + " 대사는 따라 하세요."
                        : "자, 상황 시작!", Q.lead);
  }
  const spot = new Map();
  for (const w of c.newUsed) if (w.line >= 0 && !spot.has(w.line)) spot.set(w.line, w);
  let who = "";
  lines.forEach((l, i) => {
    const g = p.row("pair", { es: l.es, ko: l.ko, role: l.who, cr: l.learner ? CR_REPEAT : undefined,
                              gesture: l.gesture || undefined });
    if (l.who !== who){ p.seg(g, "ko", l.who + ".", Q.role); who = l.who; }
    if (l.learner){
      p.seg(g, "es", l.es, repGap(l.es));
      p.seg(g, "ko", l.ko, Q.lineKo);
    } else {
      p.seg(g, "es", l.es, Q.line);
      p.seg(g, "ko", l.ko, Q.lineKo);
    }
    /* a queued new word the line used: the word itself, then the shape it had in the line */
    const w = spot.get(i);
    if (w){
      const other = foldEs(w.form) !== foldEs(w.es);
      const gw = p.row("pair", { es: w.es, ko: w.ko + (other ? " · 대사 속: " + w.form : ""), badge: "🆕 새 단어", cr: CR_REPEAT });
      p.seg(gw, "ko", "새 단어예요. " + plainKo(w.ko) + ".", Q.say);
      p.seg(gw, "es", w.es, repGap(w.es));
      if (other){
        p.seg(gw, "ko", "방금 대사에서는 이렇게 나왔어요.", Q.role);
        p.seg(gw, "es", w.form, repGap(w.form));
      }
      p.newUsed.push(w);
    }
  });

  const x = c.idiom;
  if (x && !ctx.knownT("i", x.es)){
    const g = p.row("pair", { es: x.es, ko: x.ko, badge: "보너스 숙어", cr: CR_REPEAT, rv: "idiom" });
    p.seg(g, "ko", "보너스 숙어! " + plainKo(x.ko) + ".", Q.say);
    const gap = repGap(x.es);
    p.seg(g, "es", x.es, gap);
    p.seg(g, "es", x.es, gap);
    if (x.literal){
      const gl = p.row("note", { ko: "글자 그대로: " + x.literal });
      p.seg(gl, "ko", "글자 그대로는 " + sayWhy(x.literal).replace(/[.。]\s*$/, "") + ".", Q.say);
    }
    if (x.why){
      const gw = p.row("note", { ko: x.why });
      p.seg(gw, "ko", sayWhy(x.why), Q.say);
    }
    if (x.ex) pRepeat(p, x.ex, 1, { badge: "예문" }, "");
    p.teach("i", x.es);
  }

  if (level >= 1 && lines.length){
    pSay(p, "이제 처음부터 끝까지, 스페인어로만 쭉 들어 볼게요.", Q.lead);
    for (const l of lines){
      const g = p.row("pair", { es: l.es, ko: l.ko, role: l.who, badge: "다시 듣기" });
      p.seg(g, "es", l.es, Q.line);
    }
  }
  if (level >= 2 && learnerRole){
    pSay(p, "이번엔 진짜 실전! " + learnerRole + " 차례에는 한국어 뜻만 나와요. 정답이 나오기 전에 먼저 말해 보세요.", Q.lead);
    for (const l of lines){
      if (l.learner) pQuiz(p, l, Q.think3, { role: l.who, badge: "실전", cr: CR_SAY });
      else {
        const g = p.row("pair", { es: l.es, ko: l.ko, role: l.who });
        p.seg(g, "es", l.es, Q.line);
      }
    }
  }
  if (level >= 3 && lines.length){
    pSay(p, "마지막 도전! 이번엔 모든 대사를 여러분이 먼저 말해요.", Q.lead);
    for (const l of lines) pQuiz(p, l, Q.think3, { role: l.who, badge: "전부 내가", cr: CR_SAY });
  }
  /* level 4: the learner's own lines once more, now with one second */
  if (level >= 4 && learnerRole){
    pSay(p, "끝으로 " + learnerRole + " 대사만, 이번엔 1초 안에!", Q.say);
    for (const l of lines) if (l.learner) pQuiz(p, l, Q.think1, { role: l.who, badge: "1초", cr: CR_FAST });
  }
  return [p];
}

/* ④ Korean in, Spanish out, within a second. Rounds go round the same items
   in a different order. lo·le·se has its place here. */
const ROUND_SAY = ["", "한 번 더! 이번엔 순서를 섞어서 갑니다.", "또 한 바퀴, 더 빠르게!", "한 바퀴 더, 순서가 또 바뀌어요!",
                   "진짜 마지막 바퀴, 최고 속도로!"];
function buildChallenge(ctx, rounds){
  const c = ctx.content;
  const p = lessonPart(PARTS.challenge);
  const items = c.challenge.map((x) => ({ es: x.es, ko: x.ko, badge: "챌린지" }))
    .concat(ctx.pron.map((x) => ({ es: x.es, ko: x.ko, badge: "lo·le·se" })));
  if (!items.length) return [p];
  pSay(p, "1초 반응 챌린지! 한국어 상황을 들으면, 1초 안에 스페인어로 말하세요. 그다음에 정답이 나와요.",
       Q.lead, { cue: "chime" });
  const half = Math.ceil(items.length / 2);
  for (let r = 0; r < rounds; r++){
    if (r) pSay(p, r === rounds - 1 && r > 1 ? ROUND_SAY[ROUND_SAY.length - 1] : ROUND_SAY[Math.min(r, ROUND_SAY.length - 2)], Q.say);
    const order = r % 4 === 0 ? items : r % 4 === 1 ? items.slice().reverse()
      : r % 4 === 2 ? items.filter((_, k) => k % 2 === 0).concat(items.filter((_, k) => k % 2 === 1))
      : items.slice(half).concat(items.slice(0, half));
    for (const x of order) pQuiz(p, x, Q.think1, { badge: x.badge, cr: CR_FAST });
  }
  for (const x of ctx.pron) p.teach("p", x.es);
  return [p];
}

/* the take-away sentence built up from its end: «uno nuevo», «cambiarlo por
   uno nuevo», then all of it — each piece repeated. Short ones are not cut. */
function backChain(es){
  const words = String(es || "").replace(/[¡!¿?.,;:]/g, "").split(/\s+/).filter(Boolean);
  const out = [];
  for (let k = 2; k < words.length - 1; k += 2) out.push(words.slice(words.length - k).join(" "));
  return out;
}

/* ⑤ the one sentence to take home, the targets once more as a last check, at
   level 1 the learner's own story lines once more, the mission */
function buildCool(ctx, level){
  const c = ctx.content;
  const p = lessonPart(PARTS.cool);
  const t = c.takeaway;
  if (t){
    pSay(p, "쿨다운. 오늘 건져 갈 한 문장이에요.", Q.lead, { cue: "chime" });
    const gs = p.row("slow", { es: t.es, badge: "느리게" });
    p.seg(gs, "es", t.es, Q.line, { rate: SLOW_RATE });
    const gm = p.row("say", { ko: t.ko });
    p.seg(gm, "ko", t.ko, Q.say);
    const parts = backChain(t.es);
    if (parts.length){
      pSay(p, "뒤에서부터 조금씩 붙여 볼게요.", Q.say);
      for (const piece of parts){
        const g = p.row("pair", { es: piece, ko: "", badge: "뒤에서부터", cr: CR_REPEAT });
        p.seg(g, "es", piece, repGap(piece));
      }
    }
    pRepeat(p, t, 3, { badge: "×3", rv: "sent" }, "이제 통째로, 세 번 따라 하세요.");
    p.teach("s", t.es);
  } else pSay(p, "쿨다운.", Q.lead, { cue: "chime" });
  if (c.targets.length){
    pSay(p, "오늘의 무기, 마지막 점검! 한국어를 들으면 말해 보세요.", Q.say);
    for (const x of c.targets) pQuiz(p, x, Q.think2, { badge: "마지막 점검", cr: CR_SAY });
  }
  const mine = c.story.lines.filter((l) => l.learner);
  if (level >= 1 && mine.length){
    pSay(p, "오늘 상황극에서 여러분이 한 말, 마지막으로 한 번씩 따라 하세요.", Q.say);
    for (const l of mine) pRepeat(p, l, 1, { role: l.who, badge: "내 대사" }, "");
  }
  const mission = c.mission || (t ? "오늘 하루, 기회가 오면 속으로라도 ‘" + t.es + "’ 한 번 말해 보기!" : "");
  if (mission){
    /* the Spanish inside the mission is read by the Spanish voice */
    const g = p.row("say", { ko: "🎯 미션: " + mission });
    const parts = ("오늘의 미션! " + sayWhy(mission)).split(/([¡¿]?[A-Za-zÁÉÍÓÚÑÜáéíóúñü][A-Za-zÁÉÍÓÚÑÜáéíóúñü ,']*[A-Za-zÁÉÍÓÚÑÜáéíóúñü][.!?]*)/);
    const said = parts.map((x, k) => ({ x: x, es: k % 2 === 1 })).filter((o) => cleanStr(o.x) && !/^[\s.,!?]+$/.test(o.x));
    /* a beat after the Spanish to echo it, and after the last piece */
    said.forEach((o, k) => p.seg(g, o.es ? "es" : "ko", o.x, o.es || k === said.length - 1 ? 1.0 : Q.role));
  }
  pSay(p, c.outro, Q.lead);
  return [p];
}

/* Parts → one flat segment list and the display rows, ids made global. A row
   that ended up with no segment is dropped: the timeline needs every row to
   start somewhere. */
function partsJoin(parts){
  const segs = [], rows = [];
  let base = 0, sid = 0;
  for (const p of parts){
    const used = new Set(p.segs.map((s) => s.gid));
    let top = 0;
    for (const r of p.rows){
      top = Math.max(top, r.gid);
      if (!used.has(r.gid)) continue;
      const o = Object.assign({}, r, { gid: "g" + (base + r.gid), sectionId: p.part.id, sectionTitle: p.part.title });
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      rows.push(o);
    }
    for (const s of p.segs){
      sid++;
      segs.push(Object.assign({}, s, { id: "s" + sid, gid: "g" + (base + s.gid),
                                       sectionId: p.part.id, sectionTitle: p.part.title }));
    }
    base += top;
  }
  for (let i = 0; i < segs.length - 1; i++){
    if (segs[i].sectionId !== segs[i + 1].sectionId) segs[i].pauseAfter += Q.section;
  }
  return { segs: segs, rows: rows };
}
const partsMs = (list) => list.reduce((n, p) => n + p.ms(), 0);

/* `prev`, when given, is the saved lesson before this one: the warm-up quizzes
   it. `cur` is the day's course plan (curriculumPlan). `minutes` is 10 or 20;
   left out, it is the lesson setting. */
function lessonBuild(content, when, prev, cur, minutes){
  const min = Number(minutes == null ? lessonMinutes() : minutes) === 20 ? 20 : 10;
  const len = lessonLength(min);
  const iso = studyDate(when);
  const dateLabel = Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일";
  const recent = cur && asObj(cur.recent) ? cur.recent : null;
  const G = cur && cur.grammar ? cur.grammar : null;
  const plan = reviewPlan(prev, iso);
  const wordQuiz = cur && Array.isArray(cur.wordReview) ? cur.wordReview : [];
  const BADGE = { frame: "어제 뼈대", idiom: "어제 숙어", sent: "어제 문장", expr: "어제 표현" };
  const quiz = (plan ? plan.items.map((it) => ({ es: it.es, ko: it.ko, badge: BADGE[it.type] || "어제 표현" })) : [])
    .concat(wordQuiz.map((w) => ({ es: w.es, ko: w.ko, badge: w.when === "week" ? "지난주 단어" : "지난번 새 단어" })));
  const pp = pronounPlan(content.pronoun, iso, recent);
  const ctx = {
    content: content, iso: iso, dateLabel: dateLabel, dn: dayNum(iso), plan: plan, quiz: quiz,
    minutes: min, len: len,
    step: G ? GRAMMAR_STEPS[G.idx] : null,
    knownT: (t, es) => !!(recent && recent[taughtId(t, es)]),
    pron: pp.quiz.slice(0, PRON_QUIZ),
    pronPts: pp.points.slice(0, 2)
  };

  /* the fixed parts once; the three elastic ones at every level, and the
     combination nearest the target — with a lighter pull towards each part's slot */
  const cools = [0, 1].map((l) => buildCool(ctx, l));
  const warms = [0, 1].map((l) => buildWarm(ctx, l));
  const cheats = [0, 1, 2, 3, 4].map((l) => buildCheat(ctx, l));
  const stories = [0, 1, 2, 3, 4].map((l) => buildStory(ctx, l));
  const chals = [1, 2, 3, 4, 5].map((n) => buildChallenge(ctx, n));
  const ms = new Map();
  for (const list of [].concat(cools, warms, cheats, stories, chals)) ms.set(list, partsMs(list));
  const off = (list, id) => Math.abs(ms.get(list) - len.slot[id]);
  let best = null;
  for (const w of warms) for (const a of cheats) for (const b of stories) for (const d of chals) for (const e of cools){
    const total = ms.get(w) + ms.get(a) + ms.get(b) + ms.get(d) + ms.get(e);
    const cost = Math.abs(total - len.targetMs) +
      0.3 * (off(w, "warm") + off(a, "cheat") + off(b, "story") + off(d, "challenge") + off(e, "cool"));
    if (!best || cost < best.cost) best = { cost: cost, parts: [].concat(w, a, b, d, e), estMs: total };
  }
  const joined = partsJoin(best.parts);

  const taught = [], newUsed = [];
  for (const p of best.parts){ taught.push(...p.taught); newUsed.push(...p.newUsed); }
  /* targets that only exist inside a known item were not claimed as new words */
  const oldOnes = cur && Array.isArray(cur.oldWords) ? cur.oldWords : [];
  const learnedNow = cur ? cur.learnedBefore + newUsed.filter((w) => oldOnes.indexOf(w.es) < 0).length : 0;
  const course = cur ? {
    iso: iso,
    newWords: newUsed.map((w) => ({ es: w.es, ko: w.ko })),
    grammar: G ? { k: G.k, idx: G.idx } : null,
    taught: taught
  } : null;

  const titles = {};
  for (const p of best.parts) titles[p.part.id] = p.part.title;
  return Object.assign({
    fmt: LESSON_FMT, minutes: min, date: iso, dateLabel: dateLabel, parts: titles,
    counts: Object.assign({ words: 0, idioms: taught.filter((x) => x.t === "i").length,
                            sentences: content.takeaway ? 1 : 0, frames: content.frames.length,
                            targets: content.targets.length, story: content.story.lines.length,
                            challenge: content.challenge.length + ctx.pron.length },
                          quiz.length ? { review: ctx.reviewN } : {},
                          cur ? { newWords: newUsed.length, learned: learnedNow } : {},
                          G ? { grammarAt: G.idx + 1, grammarOf: GRAMMAR_STEPS.length } : {}),
    reviewOf: plan ? plan.date : "",
    segments: joined.segs, rows: joined.rows
  }, course ? { curriculum: course } : {});
}

/* «03:05~08:12 · ② 치트키 1»: the real span of each part of a story20 lesson,
   from the timeline just computed — estimated in device mode, exact in mp3. */
function clockMmSs(ms){
  const t = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}
function lessonPartTimes(lesson){
  const span = {};
  for (const s of lesson.segments){
    const x = span[s.sectionId] || (span[s.sectionId] = { a: s.start, b: s.end });
    x.a = Math.min(x.a, s.start);
    x.b = Math.max(x.b, s.end);
  }
  const titles = asObj(lesson.parts) || {};
  const label = (id) => span[id] && titles[id]
    ? clockMmSs(span[id].a) + "~" + clockMmSs(span[id].b) + " · " + titles[id] : null;
  for (const r of lesson.rows){ const t = label(r.sectionId); if (t) r.sectionTitle = t; }
  for (const s of lesson.segments){ const t = label(s.sectionId); if (t) s.sectionTitle = t; }
}

/* the footer and the exported file's subtitle */
function lessonCountsText(c){
  c = c || {};
  if (c.targets != null){
    return "표현 " + c.targets + (c.idioms ? " · 숙어 " + c.idioms : "") + (c.frames ? " · 뼈대 " + c.frames : "") +
      " · 상황극 " + (c.story || 0) + "줄 · 챌린지 " + (c.challenge || 0);
  }
  return "단어 " + c.words + " · 숙어 " + c.idioms + " · 문장 " + c.sentences + (c.frames ? " · 뼈대 " + c.frames : "");
}

/* Start and end of every segment, and the boundary of every display row.
   Rows run boundary to boundary so the highlight never lands in a gap.

   Everything here stays floating point on purpose. Rounding each segment to a
   whole millisecond used to push the error down the track — half a millisecond
   a segment, and a nine minute lesson has several hundred of them, so the last
   rows sat about 150 ms off. Only the clock on screen rounds.

   `sr` is passed in cloud mode. The pause between lines is written to the file
   as a whole number of samples, so when we know the sample rate the timeline
   counts it exactly the way the encoder did. */
function lessonTimeline(lesson, sr){
  const segs = lesson.segments;
  /* an mp3 lesson starts with LEAD_PAD_SEC of silence; device mode has none */
  let t = sr && lesson.padMs > 0 ? lesson.padMs : 0;
  for (const s of segs){
    s.start = t;
    t += (s.audioMs || 0);
    s.end = t;
    t += sr ? Math.round(sr * s.pauseAfter) / sr * 1000 : s.pauseAfter * 1000;
  }
  /* the track stops at the last word, not after its trailing pause */
  const total = segs.length ? segs[segs.length - 1].end : 0;

  const first = {};
  for (const s of segs) if (!(s.gid in first)) first[s.gid] = s.start;
  for (const r of lesson.rows) r.start = first[r.gid] != null ? first[r.gid] : 0;
  /* a 0교시 quiz line uncovers its Spanish when the Spanish starts playing */
  const firstEs = {};
  for (const s of segs) if (s.speaker === "es" && !(s.gid in firstEs)) firstEs[s.gid] = s.start;
  for (const r of lesson.rows) if (r.quiz) r.reveal = firstEs[r.gid] != null ? firstEs[r.gid] : r.start;
  for (let i = 0; i < lesson.rows.length; i++){
    lesson.rows[i].until = (i + 1 < lesson.rows.length) ? lesson.rows[i + 1].start : total;
  }
  lesson.totalMs = total;
  if (lesson.fmt === LESSON_FMT || lesson.fmt === TEACH_FMT) lessonPartTimes(lesson);
  return lesson;
}

function rowAt(rows, ms){
  let lo = 0, hi = rows.length - 1, best = 0;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    if (rows[mid].start <= ms){ best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/* Rough spoken length. Only used to draw a progress bar in device mode,
   where the real durations are not known until each line is spoken. */
function estimateMs(seg){
  const perChar = seg.speaker === "es" ? 68 : 96;
  return Math.max(500, Math.round(seg.text.length * perChar / (seg.rate || 1)));
}
function lessonEstimate(lesson){
  for (const s of lesson.segments) s.audioMs = estimateMs(s);
  return lessonTimeline(lesson);
}

/* ================================================================
   The teacher lesson (fmt "teach1", 2026-11-11)

   A warm Korean teacher and a Mexican speaker take turns. The AI writes the
   dialogue of every item; this code places the native speaker's normal and
   slow model reads, the pauses to repeat in and the tick before a recap
   answer, then fits the whole to 10 or 20 minutes.

   Two voices, never mixed: a "ko" turn is read by the Korean voice and may
   not hold a single Latin letter; every Spanish piece is its own "es" turn.
   Section names are shown on screen, never spoken, and spoken text carries
   no symbols, emoji, list numbers or digits.

   Content comes from the user's own log: today first, older days not yet
   taught when today is thin, the words-es.js queue last (marked on screen).
   Nothing taught in the last TEACH_DAYS days is picked again. The grammar
   course is not used here and its stored state is left as it is.

   The story builder above (lessonBuild and its parts) is no longer called;
   lessons saved in that format still open, play and export from their rows.
   ================================================================ */

const TEACH_FMT = "teach1";
const TEACH_DAYS = 14;
const THIN_LINES = 6;                // fewer usable lines today than this: older days top it up
const TEACH_LINES_TODAY = 60, TEACH_LINES_OLD = 24, TEACH_LIST_WORDS = 8, TEACH_AVOID_MAX = 40;
const TEACH_SIZES = {
  10: { words: 4, idioms: 1, sents: 2, recap: 3, targetMs: 600000, loMs: 570000, hiMs: 645000 },
  20: { words: 6, idioms: 2, sents: 4, recap: 3, targetMs: 1200000, loMs: 1140000, hiMs: 1260000 }
};
const teachSize = (minutes) => TEACH_SIZES[Number(minutes) === 20 ? 20 : 10];
const TEACH_TITLES = { open: "여는 말", recap: "복습", words: "단어", idiom: "숙어", sent: "오늘 쓴 문장", close: "마무리" };
const TEACH_POINTS = 2;              // at most two explained changes per sentence
const USE_WORDS = 12;
/* small connecting words that get their own explanation when a sentence has one */
const CONNECTORS = ["por", "para", "a", "al", "de", "del", "en", "con", "sin", "que", "porque", "pero", "y", "o",
                    "si", "cuando", "como", "hasta", "desde"];
/* pauses, seconds */
const TP = { line: 0.6, model: 0.8, slow: 1.0, es: 0.9, think: 2.0, answer: 1.5, item: 1.2,
             repMin: 2.4, repMax: 5.5, repPad: 1.2, repCap: 7.0 };
/* only a light stretch of the pauses: a short reply makes a shorter lesson, never a padded one */
const TEACH_SCALES = [0.9, 1, 1.15];

const LATIN_CH = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
const GIMMICK_RE = /무기|치트키|챌린지|쿨다운|미션|퀘스트|필살기|레벨업/;
/* the Korean voice spelling Spanish sounds («아르로 끝나는 말», «'에'로 바뀌어요»): confusing
   by ear — the rule is shown by the Spanish voice instead (hablar, habla. comer, come.) */
const SPELL_RE = /(?:아르|에르|이르)['‘’«»"“”]?(?:로|나)|['‘’«»"“”](?:아|에|이|오|우|이에)['‘’«»"“”]/;
/* a complete spoken Korean sentence ends like this (해요체, 합쇼체, a question) */
const KO_END = /[요다죠까네]$/;
/* emoji, arrows, circled numbers, dingbats, flags (surrogate pairs) — no \p{} here:
   an older iPhone Safari refuses the whole file over a regex it cannot parse */
const SAY_EMOJI = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[←-⇿⌀-⏿①-⓿■-➿⬀-⯿㉐-㋿️‍⃣]/g;

/* ---- numbers said as words ---- */
const KO_DIG = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const KO_NATIVE = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"];
function numKo4(n){
  let out = "", r = n;
  for (const u of [[1000, "천"], [100, "백"], [10, "십"]]){
    const q = Math.floor(r / u[0]);
    if (q){ out += (q > 1 ? KO_DIG[q] : "") + u[1]; r -= q * u[0]; }
  }
  return out + (r ? KO_DIG[r] : "");
}
/* up to 99,999,999: 만 groups (15000 → 만오천) */
function numKoInt(n){
  if (n === 0) return "영";
  const man = Math.floor(n / 10000), rest = n % 10000;
  return (man ? (man > 1 ? numKo4(man) : "") + "만" : "") + (rest ? numKo4(rest) : "");
}
function numKo(m){
  const parts = String(m).split(/[.,]/);
  const n = Number(parts[0]);
  const head = Number.isInteger(n) && n >= 0 && n < 100000000 ? numKoInt(n)
    : parts[0].split("").map((d) => KO_DIG[Number(d)] || "").join(" ");
  return parts[1] ? head + " 점 " + parts[1].split("").map((d) => KO_DIG[Number(d)] || "").join(" ") : head;
}
const ES_UNITS = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce",
  "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós",
  "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const ES_HUNDREDS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos",
  "ochocientos", "novecientos"];
const ES_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
function numEs(m){
  const parts = String(m).split(/[.,]/);
  const n = Number(parts[0]);
  /* up to 999,999: prices in pesos (150 → ciento cincuenta, 1500 → mil quinientos) */
  const word = (k) => {
    if (k < 30) return ES_UNITS[k];
    if (k < 100) return ES_TENS[Math.floor(k / 10)] + (k % 10 ? " y " + ES_UNITS[k % 10] : "");
    if (k === 100) return "cien";
    if (k < 1000){
      const h = Math.floor(k / 100), r = k % 100;
      return ES_HUNDREDS[h] + (r ? " " + word(r) : "");
    }
    if (k < 1000000){
      const th = Math.floor(k / 1000), r = k % 1000;
      return (th === 1 ? "mil" : word(th).replace(/veintiuno$/, "veintiún").replace(/uno$/, "un") + " mil") + (r ? " " + word(r) : "");
    }
    return String(k).split("").map((d) => ES_UNITS[Number(d)]).join(" ");
  };
  const head = Number.isInteger(n) && n >= 0 ? word(n) : "";
  return parts[1] ? head + " punto " + parts[1].split("").map((d) => ES_UNITS[Number(d)]).join(" ") : head;
}

/* What a voice actually reads: no emoji, no list number or bullet at the
   start, digits as words, quotes and brackets gone, separators as a comma,
   and nothing outside the letters of its own language and . , ? ! (plus ¡ ¿
   for Spanish). Latin letters are kept on the Korean side only so that the
   caller can still see them and refuse the turn. */
function speakClean(s, es){
  let t = String(s || "").replace(SAY_EMOJI, " ");
  t = t.replace(/^\s*(?:\(?\d{1,2}\s*[.)]|[-*•·]|#+)\s*/, "");
  /* thousands separators (15,000 / 1,500) are not decimals */
  t = t.replace(/(\d)[,.](?=\d{3}(?!\d))/g, "$1");
  if (es) t = t.replace(/\d+(?:[.,]\d+)?/g, (m) => " " + numEs(m) + " ");
  else {
    /* counted things take the native numbers (두 개, 한 번); the rest Sino-Korean (십일월) */
    t = t.replace(/(\d+)\s*(개|명|번|시간|시|살|잔|그릇|마리|병|장|가지|군데|달|사람)/g, (all, d, u) => {
      const n = Number(d);
      return n >= 1 && n <= 10 ? KO_NATIVE[n] + " " + u : all;
    });
    t = t.replace(/\d+(?:[.,]\d+)?/g, (m) => numKo(m));
    /* Quotes stay: a Korean voice reads them as a short pause, and «'열어!'가»
       without them turns into «열어가». Every kind becomes ' (held as \u0001
       through the stripping below). A full stop inside a quote that a particle
       follows goes («줄게.»예요 → '줄게'예요). */
    t = t.replace(/[«»“”"‘’'`]+/g, "\u0001")
         /* only before a CLOSING quote (an odd number of quotes before it) */
         .replace(/([^\s\u0001])[.?!]+(?=\u0001[가-힣])/g,
                  (m, ch, off, str) => ((str.slice(0, off).match(/\u0001/g) || []).length % 2 ? ch : m));
    /* a leftover ~ placeholder becomes a natural word, never a symbol */
    t = t.replace(/~\s*([가-힣]+)/g, (all, w) => tildeKo(w));
  }
  t = t.replace(/~/g, " ").replace(/[«»“”"‘’'`()[\]{}<>*#_=+\\^@&%$|]/g, " ")
       .replace(/\s*[·•—–:;/→↔…]+\s*/g, ", ");
  t = t.replace(es ? /[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ¡¿.,?! ]/g : /[^가-힣A-Za-zÁÉÍÓÚÜÑáéíóúüñ.,?! \u0001]/g, " ");
  t = t.replace(/\s+/g, " ").replace(/\s+([.,?!])/g, "$1").replace(/([.,?!])[.,]+/g, "$1")
       .replace(/^[\s.,?!]+/, "").replace(/[\s,]+$/, "").replace(/[¡¿]+$/, "").trim();
  return es ? t : koQuotes(t);
}
/* the quotes of a spoken Korean line: no stray or unpaired ones, the full
   stop outside the closing one («줘.'» → «줘'.») */
function koQuotes(t){
  let s = t.replace(/\u0001+/g, "\u0001").replace(/(^|\s)\u0001(?=\s|$)/g, "$1");
  if ((s.match(/\u0001/g) || []).length % 2) s = s.replace(/\u0001/g, "");
  /* pair by pair: an empty pair goes, a full stop before a closing quote moves outside it */
  s = s.replace(/\u0001([^\u0001]*)\u0001/g, (m, x) => {
    if (!x.trim()) return "";
    const end = x.match(/[.?!]+$/);
    return end ? "\u0001" + x.slice(0, -end[0].length) + "\u0001" + end[0] : m;
  });
  return s.replace(/\u0001/g, "'").replace(/([.,?!])[.,]+/g, "$1").replace(/\s+/g, " ")
          .replace(/^[\s.,?!]+/, "").trim();
}
/* «~로 맞바꿔서» → «무엇으로 맞바꿔서», «~할 거야» → «무엇을 할 거야» */
function tildeKo(w){
  /* `w` is the whole Hangul run glued to the ~: a particle only when it is all of it */
  if (/^(에게|한테|께|에게서|한테서)$/.test(w)) return "누구" + w;
  if (/^(할|하는|한|했던|해야|하려고)$/.test(w)) return "무엇을 " + w;
  if (/^(으로|로|으로서|로서|를|을|가|이|는|은|와|과|랑|이랑|하고|의|에|에서|까지|부터|처럼|만|도|보다|때문에)$/.test(w))
    return "무엇" + w.replace(/^로/, "으로").replace(/^를/, "을").replace(/^가$/, "이").replace(/^는/, "은")
      .replace(/^와/, "과").replace(/^랑/, "이랑").replace(/^때문에/, " 때문에");
  return "무엇 " + w;
}

/* stretches of Latin letters with no Hangul between them */
function latinSpans(s){
  const out = [];
  let a = -1, b = -1;
  for (let i = 0; i < s.length; i++){
    const ch = s[i];
    if (LATIN_CH.test(ch)){ if (a < 0) a = i; b = i; }
    else if (/[가-힣]/.test(ch) && a >= 0){ out.push([a, b + 1]); a = -1; }
  }
  if (a >= 0) out.push([a, b + 1]);
  return out;
}

/* A turn is { who, shown, say, pause }: `shown` for the screen, `say` for the voice. */
function esTurn(text, pause, diag){
  const t = cleanStr(text).replace(/[«»“”"]/g, "").trim();
  if (!t || hasKo(t) || !LATIN_CH.test(t)){ if (diag) diag.dropped++; return []; }
  const say = speakClean(t, true);
  return say && LATIN_CH.test(say) ? [{ who: "es", shown: t, say: say, pause: pause || "" }] : [];
}
/* the leftovers of a split at its edges; a closing quote stays when it closes a pair */
const trimShown = (s) => {
  const t = String(s || "").replace(/^[\s»”’,.:;·—–-]+/, "").replace(/[\s«“‘:,·—–-]+$/, "").trim();
  return (t.match(/['"]/g) || []).length % 2 ? t.replace(/^['"]+|['"]+$/g, "").trim() : t;
};
function koOnly(shown, pause){
  let say = speakClean(shown, false);
  if (!hasKo(say) || LATIN_CH.test(say)) return null;
  if (!/[.?!]$/.test(say)) say += ".";
  return { who: "ko", shown: trimShown(shown), say: say, pause: pause || "" };
}
/* A Korean turn, checked. Returns the turn(s), or null when it has to be
   refused: a gimmick word, a grammar term out in the open, or Spanish in the
   middle of the sentence. Spanish at the very start or end is moved into its
   own "es" turn, as long as the Korean left over is a whole sentence. */
function koTurn(text, pause, diag){
  const t0 = cleanStr(text);
  if (!t0) return [];
  const refuse = () => { if (diag) diag.rejected++; return null; };
  if (GIMMICK_RE.test(t0) || SPELL_RE.test(t0) || BAN_RE.test(t0.replace(/\([^()]*\)/g, ""))) return refuse();
  const t = t0.replace(/\(([^()]*)\)/g, (all, inner) => (BAN_RE.test(inner) ? "" : all)).trim();
  if (!hasKo(t)){ if (diag) diag.split++; return esTurn(t, pause, diag); }
  const spans = latinSpans(t);
  if (!spans.length){ const k = koOnly(t, pause); return k ? [k] : refuse(); }
  if (spans.length !== 1) return refuse();
  let a = spans[0][0], b = spans[0][1];
  while (a > 0 && /[¡¿]/.test(t[a - 1])) a--;
  while (b < t.length && /[.!?]/.test(t[b])) b++;
  const before = t.slice(0, a), after = t.slice(b), es = t.slice(a, b);
  const atEnd = !hasKo(after), atStart = !hasKo(before);
  if (!atEnd && !atStart) return refuse();
  /* «Abre»는 … / «Da»예요: Hangul glued to the Spanish is its particle, and would be left dangling */
  if (atStart && /^[»”’"')\]]*[가-힣]/.test(after)) return refuse();
  const k = koOnly(atEnd ? before : after, "");
  const e = esTurn(es, "", null);
  if (!k || !e.length || !KO_END.test(k.say.replace(/[.?!]+$/, ""))) return refuse();
  if (diag) diag.split++;
  const pair = atEnd ? [k, e[0]] : [e[0], k];
  pair[1].pause = pause || "";
  return pair;
}
/* a list of turns; a refused Korean turn becomes a placeholder that the
   builder fills with a safe line of its own */
function teachTurns(list, diag){
  const out = [];
  for (const x of (Array.isArray(list) ? list : [])){
    const o = asObj(x);
    if (!o) continue;
    const pause = o.pause === "repeat" ? "repeat" : "";
    const got = o.who === "es" ? esTurn(o.text, pause, diag) : o.who === "ko" ? koTurn(o.text, pause, diag) : [];
    if (got === null) out.push({ who: "ko", shown: "", say: "", pause: pause, safe: true });
    else for (const g of got) out.push(g);
  }
  return out;
}
/* one Korean cue line, or null */
function cueTurn(s, diag){
  const got = koTurn(s, "", diag);
  return got && got.length === 1 && got[0].who === "ko" ? got[0] : null;
}
const realKo = (turns) => turns.some((t) => t.who === "ko" && !t.safe);

function teachUse(o, diag){
  const x = asObj(o);
  if (!x) return null;
  const es = cleanStr(x.es).replace(/[«»“”"]/g, "").trim(), ko = cleanStr(x.ko);
  if (!es || hasKo(es) || !LATIN_CH.test(es) || wordCount(es) > USE_WORDS || !hasKo(ko) || LATIN_CH.test(ko)) return null;
  const say = speakClean(es, true);
  return say ? { es: es, ko: ko, say: say, lead: teachTurns(x.lead, diag) } : null;
}
/* the reasons for one sentence: at most TEACH_POINTS, each with a real Korean line */
function teachPoints(list, diag){
  const out = [];
  let valid = 0;
  for (const x of (Array.isArray(list) ? list : [])){
    const o = asObj(x);
    if (!o) continue;
    const turns = teachTurns(o.turns, diag);
    if (!realKo(turns)) continue;
    valid++;
    if (out.length < TEACH_POINTS) out.push({ about: cleanStr(o.about), turns: turns });
  }
  if (valid > TEACH_POINTS) diag.pointsCut++;
  return out;
}
/* the connecting words of `es` that none of its points talks about */
function connectorsLeft(es, points){
  const toks = foldEs(es).split(/[^a-zñ]+/).filter(Boolean);
  const said = new Set();
  for (const p of points){
    for (const t of foldEs(p.about).split(/[^a-zñ]+/)) if (t) said.add(t);
    for (const t of p.turns) if (t.who === "es") for (const w of foldEs(t.say).split(/[^a-zñ]+/)) if (w) said.add(w);
  }
  return Array.from(new Set(toks.filter((t) => CONNECTORS.indexOf(t) >= 0 && !said.has(t))));
}

/* ---- what may be taught today ---- */
function teachPlan(todayRows, allLog, iso, minutes){
  const size = teachSize(minutes);
  const recent = taughtRecent(iso, TEACH_DAYS);
  const all = taughtAll();
  const cut = isoAddDays(iso, -TEACH_DAYS);
  const learned = newWordsLearned();
  /* list words from the last two weeks; a 다시 만들기 today sees what the first make saw */
  const listRecent = Object.keys(learned).filter((w) => learned[w].d >= cut && learned[w].d < iso);
  const lineOf = (e, day) => {
    const es = cleanStr(spanishOf(e)), ko = cleanStr(koreanOf(e));
    /* the Korean side may be read aloud (a sentence's meaning): Hangul, no Latin */
    return es && hasKo(ko) && !LATIN_CH.test(ko) && LATIN_CH.test(es) && !hasKo(es) ? { es: es, ko: ko, day: day } : null;
  };
  const seen = new Set(), lines = [];
  const add = (l) => {
    const k = reviewKey(l.es);
    if (!k || seen.has(k)) return false;
    seen.add(k); lines.push(l);
    return true;
  };
  for (const e of (Array.isArray(todayRows) ? todayRows : [])){
    if (lines.length >= TEACH_LINES_TODAY) break;
    const l = lineOf(e, iso);
    if (l && !recent[taughtId("s", l.es)]) add(l);
  }
  const todayN = lines.length;
  if (todayN < THIN_LINES){
    /* older days, newest first, lines never taught as a sentence */
    const everS = (es) => { const e = all[taughtId("s", es)]; return !!(e && taughtBefore(e, iso)); };
    const older = (Array.isArray(allLog) ? allLog : [])
      .filter((e) => e && e.at)
      .map((e) => ({ e: e, d: studyDate(e.at) }))
      .filter((x) => x.d && x.d < iso)
      .sort((a, b) => b.d.localeCompare(a.d) || String(a.e.at).localeCompare(String(b.e.at)));
    let n = 0;
    for (const x of older){
      if (n >= TEACH_LINES_OLD) break;
      const l = lineOf(x.e, x.d);
      if (l && !everS(l.es) && add(l)) n++;
    }
  }
  const pick = newWordsPick(iso, lines.map((l) => l.es));
  const wordList = pick.words.filter((w) => listRecent.indexOf(w) < 0 && !recent[taughtId("v", w)])
    .slice(0, TEACH_LIST_WORDS);
  const avoid = { words: listRecent.slice(), idioms: [], sentences: [] };
  const keys = Object.keys(recent).sort((a, b) => recent[b].d.localeCompare(recent[a].d));
  for (const k of keys){
    const t = k.split(":")[0], es = recent[k].es;
    if (!es) continue;
    const f = t === "v" ? "words" : t === "i" ? "idioms" : t === "s" ? "sentences" : "";
    if (f && avoid[f].length < TEACH_AVOID_MAX) avoid[f].push(es);
  }
  return { iso: iso, minutes: Number(minutes) === 20 ? 20 : 10, size: size, lines: lines, todayN: todayN,
           thin: todayN < THIN_LINES, wordList: wordList, recent: recent, avoid: avoid,
           listRecent: listRecent };
}

/* the request body: the lines to choose from, the fallback words, what to avoid, how many */
function teachBody(plan){
  return JSON.stringify({
    lines: plan.lines.map((l) => ({ es: l.es, ko: l.ko, day: l.day === plan.iso ? "today" : l.day })),
    word_list: plan.wordList,
    avoid: plan.avoid,
    want: { words: plan.size.words + 1, idioms: plan.size.idioms + 1, sentences: plan.size.sents + 1 }
  });
}

function teachPrompt(){
  return [
  "You write one spoken Spanish lesson as a dialogue between two voices: a warm, experienced Korean tutor",
  "(the \"ko\" voice) and a Mexican native speaker (the \"es\" voice). The learner is a Korean who runs a Korean",
  "restaurant in Mexico, a complete beginner, listening alone in the car. The app reads every turn aloud",
  "with two different text-to-speech voices, and adds the native speaker's normal and slow model reads, the",
  "pauses to repeat in and all timing. You write what is said.",
  "",
  "INPUT — one JSON object:",
  "  lines     — what the learner actually said or heard: es, ko, day (\"today\" or a date). Today's lines",
  "              come first; older days are there only because today was thin.",
  "  word_list — fallback beginner words, in course order (may be empty).",
  "  avoid     — words, idioms and sentences taught in the last 14 days. Never pick any of them.",
  "  want      — how many words, idioms and sentences to write. Each count has ONE spare in it, so the",
  "              app can drop one that clashes.",
  "",
  "WHAT TO PICK",
  "- words: single useful words (verbs, nouns, adjectives) that appear in lines. es is the plain dictionary",
  "  form (abrir, not ábrelo; olla, not ollas); heard is the exact line it came from. Only if lines cannot",
  "  give enough, take from word_list and set source \"list\". Never greetings, names, numbers, yes or no.",
  "- idioms: a set expression from lines if there is one (source \"log\"); otherwise a common Mexican one",
  "  that fits one of the lines (source \"common\"). Only expressions you are certain are in daily use.",
  "- sentences: lines copied exactly (es and ko as given), short and useful, at most ten words.",
  "- Prefer today's lines. Never anything listed in avoid.",
  "",
  "THE TWO VOICES — the most important rule",
  "- A \"ko\" turn is read by a Korean voice. It must NEVER contain a Latin letter: no Spanish word, no",
  "  letter, no ending like -ar. Every Spanish piece is its own \"es\" turn.",
  "- Finish the Korean sentence first; the Spanish turn comes after it. Never put Spanish inside a",
  "  Korean sentence.",
  "  Wrong: {\"who\":\"ko\",\"text\":\"da 끝에 나에게 me, 그거 lo 를 붙여요.\"}",
  "  Right: {\"who\":\"ko\",\"text\":\"먼저 «줘»예요.\"}, {\"who\":\"es\",\"text\":\"Da.\"}, {\"who\":\"ko\",\"text\":\"다음은 «나한테»예요.\"}, {\"who\":\"es\",\"text\":\"Me.\"}",
  "- Never spell Spanish sounds or endings in Hangul (no «아르로 끝나는 말», no «'에'로 바뀌어요»). Show a",
  "  sound by letting the es voice say whole words, then sum it up in Korean without letters:",
  "  {\"who\":\"ko\",\"text\":\"끝소리가 어떻게 바뀌는지 들어 보세요.\"}, {\"who\":\"es\",\"text\":\"Hablar, habla. Comer, come. Abrir, abre.\"},",
  "  {\"who\":\"ko\",\"text\":\"원래 모양의 끝을 떼고 짧은 끝소리 하나만 남기면, 친구한테 시키는 말이 돼요.\"}",
  "- An \"es\" turn holds Spanish only, never Hangul.",
  "- No digits, symbols, list numbers, emoji or section names in any turn. Numbers are written as words.",
  "- When the teacher names a word or a meaning, put it in single quotes ('열다', '냉장고 좀 열어 줘');",
  "  the voice reads the quotes as a short pause.",
  "- Never write ~ or a placeholder in a ko turn. Write a natural phrase instead: 무엇으로 맞바꿔서,",
  "  '할 거야'라는 말, 누구를 위해.",
  "",
  "HOW THE TEACHER TALKS",
  "- Like a warm, experienced Korean tutor talking to one adult: natural spoken 해요체, complete sentences,",
  "  natural connectors (자, 이번엔, 아까 그, 기억나시죠?, 그래서, 그런데).",
  "- Vary the phrasing. Never use the same cue line twice in a row (따라 해 보세요 / 소리 내서 한번 해",
  "  보세요 / 입으로 한번 말해 볼까요?).",
  "- No gimmick words (무기, 치트키, 챌린지, 쿨다운, 미션, 퀘스트). No fragments such as «첫 번째.» or «손님.».",
  "- Kid-simple. No grammar terms (동사, 명사, 형용사, 전치사, 대명사, 명령형, 시제, 인칭, 접속법 …): say what",
  "  the word DOES instead.",
  "- Never state facts about the learner, the staff, customers, prices or times that the lines do not say.",
  "",
  "SAY WHY, BRIEFLY — when a word changes shape, give the reason in one or two short lines, not only that",
  "it changed:",
  "- Telling a friend to do something (abrir → abre): «친구한테 시키는 모양은 '그 사람이 ~한다'는 모양과",
  "  똑같아요. 그래서 '그가 연다'가 그대로 '열어!'가 돼요.» Then the rule once, by sound (see above):",
  "  hablar, habla. comer, come. abrir, abre.",
  "- The short irregular ones (pon, ten, ven, di, haz, sal, sé, ve): «자주 쓰는 짧은 말 몇 개는 따로 외우는",
  "  모양이에요.»",
  "- Who does it (como, comes, come): the ending already tells who, so Spanish often leaves out 나 or 너.",
  "- Matching (frío, fría, fríos): a describing word follows the thing it describes; let the es voice",
  "  say both (El caldo está frío. La sopa está fría.) rather than naming the letters.",
  "- Little attached words (lo, la, le, me, se): they mean 그거, 나한테 and so on; on an order they stick to the",
  "  end, otherwise they come in front.",
  "- ser and estar: ser for what something is, estar for how or where it is right now.",
  "- Small connecting words (por, para, a, de, en, con, que, porque, pero, y, o, si, cuando …): say what kind",
  "  of word it is in plain Korean («앞에 붙어서 뒤의 말과 한 덩어리가 되는 말이에요. 한국어 조사가 앞으로 온",
  "  거라고 보면 돼요.» or «문장과 문장을 잇는 말이에요.»), what it does in THIS sentence, and one tiny contrast",
  "  where useful, above all por and para (por: 무엇으로 맞바꿔서, 무엇 때문에, 어디를 거쳐 / para: 누구를",
  "  위해, 언제까지, 어느 쪽으로).",
  "  The Spanish word itself is always its own es turn.",
  "- At most TWO explained points per sentence (why has at most two entries). Pick the most useful ones;",
  "  small words count.",
  "",
  "OUTPUT — ONE JSON object and nothing else: no fence, no commentary. A turn is {\"who\":\"ko\"|\"es\",\"text\":\"\"}.",
  "{",
  " \"opening\": \"\",",
  " \"words\": [{\"es\":\"\",\"ko\":\"\",\"source\":\"log|list\",\"heard\":\"\",\"intro\":[],\"repeat_cue\":\"\",",
  "            \"use\":{\"lead\":[],\"es\":\"\",\"ko\":\"\"},\"why\":[{\"about\":\"\",\"turns\":[]}],\"whole_cue\":\"\",",
  "            \"use2\":{\"lead\":[],\"es\":\"\",\"ko\":\"\",\"why\":[{\"about\":\"\",\"turns\":[]}]}}],",
  " \"idioms\": [{\"es\":\"\",\"ko\":\"\",\"source\":\"log|common\",\"heard\":\"\",\"literal\":[],\"meaning\":[],\"repeat_cue\":\"\",",
  "             \"use\":{\"lead\":[],\"es\":\"\",\"ko\":\"\"},\"why\":[{\"about\":\"\",\"turns\":[]}],\"whole_cue\":\"\",",
  "             \"use2\":{\"lead\":[],\"es\":\"\",\"ko\":\"\",\"why\":[]}}],",
  " \"sentences\": [{\"es\":\"\",\"ko\":\"\",\"intro\":[],\"why\":[{\"about\":\"\",\"turns\":[]}],",
  "                \"variation\":{\"word\":\"\",\"lead\":[],\"es\":\"\",\"ko\":\"\"},\"repeat_cue\":\"\"}],",
  " \"takeaway\": {\"es\":\"\",\"ko\":\"\",\"lead\":[]},",
  " \"goodbye\": \"\"",
  "}",
  "",
  "WHAT EACH PART IS FOR (the app adds the native speaker's reads and the pauses):",
  "- opening: ONE Korean line about today's theme. The app says the date before it.",
  "- words[].intro: the meaning, as a complete sentence («먼저 «열다»예요.»). The app then plays the word,",
  "  normal and slow, then repeat_cue and a pause.",
  "- words[].use: a simple usage sentence (at most eight words) with the word. lead gives its Korean",
  "  meaning in a sentence («문장으로 해 볼게요. «냉장고 좀 열어 줘.»»); the app plays use.es after the lead.",
  "- words[].why: the reasons, as alternating ko and es turns; about is the Spanish bit explained. If",
  "  use.es has the word in a changed shape, the first point explains why. A small connecting word in",
  "  use.es gets a point too, within the limit of two.",
  "- words[].whole_cue: the cue before the learner says the whole sentence; the app then plays it again.",
  "- words[].use2: a second usage sentence that changes ONE thing in the first (who, the thing, a small",
  "  word, already done …). lead says in Korean what changes and the new meaning; why has ONE point with",
  "  the reason for that change. The app plays it and leaves a pause to repeat.",
  "- idioms[]: literal is the words one by one in Korean; meaning is what it really means and when to say",
  "  it. Then use, why and whole_cue as for words; use2 is a second example in another situation (why",
  "  may be empty).",
  "- sentences[].intro: say it is something the learner said (오늘 하신 말, or 며칠 전에 하신 말 for an older",
  "  day) and give the Korean meaning; the app plays it normal and slow. why as above. variation changes",
  "  ONE word to another of today's words (variation.word is that word's es): lead in Korean («'바꾸다'",
  "  자리에 '열다'만 넣어 볼게요.»), es and ko the changed sentence. repeat_cue comes before the pause after it.",
  "- takeaway: one of today's sentences or usage sentences to take home; lead introduces it.",
  "- goodbye: one short, warm Korean goodbye.",
  "",
  "LENGTH — the lesson is listened to for its full length, so the teacher really talks:",
  "- each word: about a minute and a quarter. intro in two turns (the meaning, then when they would say",
  "  it at work); why with two points of three to five turns each; use2 with its one reason.",
  "- each idiom: about a minute and a half. literal two turns, meaning two turns, why two points, use2.",
  "- Real content fills the time; the app adds no drilling to make up a short reply.",
  "- each sentence: about a minute and a half. intro two turns (that they said it, and the meaning); why",
  "  two points of three to five turns; variation lead two turns (what is swapped, and the new meaning).",
  "- Korean turns of one or two sentences each (about 20 to 80 characters). Spanish turns short.",
  "",
  "SPANISH: correct, natural Mexican Spanish; keep accents and ¡ ¿. caliente is for food and things only;",
  "food words only in their food meaning.",
  "",
  "EXAMPLE of one word (follow its voice rule, its turns and its tone):",
  "{\"es\":\"abrir\",\"ko\":\"열다\",\"source\":\"log\",\"heard\":\"Ábrelo, por favor.\",",
  " \"intro\":[{\"who\":\"ko\",\"text\":\"먼저 '열다'예요.\"}], \"repeat_cue\":\"따라 해 보세요.\",",
  " \"use\":{\"lead\":[{\"who\":\"ko\",\"text\":\"문장으로 해 볼게요. '냉장고 좀 열어 줘.'\"}],\"es\":\"Abre el refri, por favor.\",\"ko\":\"냉장고 좀 열어 줘.\"},",
  " \"why\":[{\"about\":\"abre\",\"turns\":[{\"who\":\"ko\",\"text\":\"원래 모양은 이거였죠.\"},{\"who\":\"es\",\"text\":\"Abrir.\"},",
  "   {\"who\":\"ko\",\"text\":\"친구한테 시키는 모양은 '그 사람이 연다'는 모양과 똑같아요. 그래서 '그가 연다'가 그대로 '열어!'가 돼요.\"},",
  "   {\"who\":\"es\",\"text\":\"Abre.\"},{\"who\":\"ko\",\"text\":\"끝소리가 어떻게 바뀌는지 들어 보세요.\"},",
  "   {\"who\":\"es\",\"text\":\"Hablar, habla. Comer, come. Abrir, abre.\"}]}],",
  " \"whole_cue\":\"이제 문장 전체를 따라 해 보세요.\",",
  " \"use2\":{\"lead\":[{\"who\":\"ko\",\"text\":\"이번엔 '냉장고' 대신 '그거'로 바꿔 볼게요. '그거 열어 줘.'\"}],\"es\":\"Ábrelo, por favor.\",\"ko\":\"그거 열어 줘.\",",
  "   \"why\":[{\"about\":\"ábrelo\",\"turns\":[{\"who\":\"ko\",\"text\":\"'그거'는 시키는 말 끝에 바로 붙어요.\"},{\"who\":\"es\",\"text\":\"Ábrelo.\"}]}]}}"
  ].join("\n");
}

/* the plan line that holds `es`, if any */
function teachLineFor(es, plan){
  if (!cleanStr(es)) return null;
  return plan.lines.find((l) => phraseIn(es, l.es)) || null;
}
/* an idiom said in a line in another person or tense: its content words after the verb are there */
function idiomLine(es, plan){
  const exact = teachLineFor(es, plan);
  if (exact) return exact;
  const toks = foldEs(es).split(/[^a-zñ]+/).filter(Boolean).slice(1).filter((t) => t.length >= 4);
  if (!toks.length) return null;
  return plan.lines.find((l) => { const have = new Set(foldEs(l.es).split(/[^a-zñ]+/)); return toks.every((t) => have.has(t)); }) || null;
}
const plainEs = (s) => cleanStr(s).replace(/[«»“”"]/g, "").replace(/^[¡¿]+|[.,!?]+$/g, "").trim();
const esOk = (es) => !!es && !hasKo(es) && LATIN_CH.test(es);

/* The reply, checked and cleaned. Throws only when nothing usable is left. */
function teachNormalise(raw, plan){
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("대본 형식이 올바르지 않습니다.");
  const diag = { rejected: 0, split: 0, dropped: 0, whyDropped: 0, varDropped: 0, recent: 0, notInLog: 0,
                 pointsCut: 0, use2Dropped: 0, connectorsLeft: [] };
  const recent = (t, es) => !!plan.recent[taughtId(t, es)];
  const listSet = new Set(plan.wordList.map(foldEs));
  const listRecent = new Set((plan.listRecent || []).map(foldEs));
  const S = plan.size;
  const koOk = (s) => hasKo(s) && !LATIN_CH.test(s);
  const withUse = (o, es, needReason) => {
    let use = teachUse(o.use, diag);
    const why = use ? teachPoints(o.why, diag) : [];
    if (use && !phraseIn(es, use.es) && !why.length){ use = null; diag.whyDropped++; }
    if (use){ const left = connectorsLeft(use.es, why); if (left.length && why.length < TEACH_POINTS) diag.connectorsLeft.push(use.es + ": " + left.join(",")); }
    /* the second sentence: for a word it changes one thing and must say why
       (one point); for an idiom it is a second example, its reason optional */
    const u2o = asObj(o.use2);
    let use2 = use && u2o ? teachUse(u2o, diag) : null;
    const why2 = use2 ? teachPoints(u2o.why, diag).slice(0, 1) : [];
    if (use2 && (reviewKey(use2.es) === reviewKey(use.es) || (needReason && !why2.length) ||
                 (!phraseIn(es, use2.es) && !why2.length && !idiomLike(es, use2.es)))){ use2 = null; diag.use2Dropped++; }
    return { use: use, why: use ? why : [], wholeCue: cueTurn(o.whole_cue, diag), use2: use2, why2: use2 ? why2 : [] };
  };
  /* an idiom said in another person or tense: its content words after the verb are all there */
  const idiomLike = (es, line) => {
    const toks = foldEs(es).split(/[^a-zñ]+/).filter(Boolean).slice(1).filter((t) => t.length >= 4);
    const have = new Set(foldEs(line).split(/[^a-zñ]+/));
    return toks.length > 0 && toks.every((t) => have.has(t));
  };

  const words = [], wseen = new Set();
  for (const x of (Array.isArray(raw.words) ? raw.words : [])){
    const o = asObj(x);
    if (!o) continue;
    const es = plainEs(o.es), ko = cleanStr(o.ko);
    if (!esOk(es) || wordCount(es) > 3 || !koOk(ko) || wseen.has(foldEs(es))) continue;
    if (recent("v", es) || listRecent.has(foldEs(es))){ diag.recent++; continue; }
    const fromList = o.source === "list";
    const line = fromList ? null : (teachLineFor(o.heard, plan) || teachLineFor(es, plan));
    if (fromList ? !listSet.has(foldEs(es)) : !line){ diag.notInLog++; continue; }
    wseen.add(foldEs(es));
    words.push(Object.assign({ es: es, ko: ko, source: fromList ? "list" : "log", day: line ? line.day : "",
      intro: teachTurns(o.intro, diag), repeatCue: cueTurn(o.repeat_cue, diag) }, withUse(o, es, true)));
  }
  const logW = words.filter((w) => w.source === "log");
  const pickedWords = logW.slice(0, S.words).concat(words.filter((w) => w.source === "list").slice(0, Math.max(0, S.words - logW.length)));

  const idioms = [], iseen = new Set();
  for (const x of (Array.isArray(raw.idioms) ? raw.idioms : [])){
    const o = asObj(x);
    if (!o) continue;
    const es = plainEs(o.es), ko = cleanStr(o.ko);
    if (!esOk(es) || wordCount(es) > 6 || !koOk(ko) || iseen.has(foldEs(es))) continue;
    if (recent("i", es)){ diag.recent++; continue; }
    const line = idiomLine(o.heard, plan) || idiomLine(es, plan);
    iseen.add(foldEs(es));
    idioms.push(Object.assign({ es: es, ko: ko, source: line ? "log" : "common", day: line ? line.day : "",
      literal: teachTurns(o.literal, diag), meaning: teachTurns(o.meaning, diag),
      repeatCue: cueTurn(o.repeat_cue, diag) }, withUse(o, es, false)));
    if (idioms.length >= S.idioms) break;
  }

  const sents = [], sseen = new Set();
  for (const x of (Array.isArray(raw.sentences) ? raw.sentences : [])){
    const o = asObj(x);
    if (!o) continue;
    const es = cleanStr(o.es).replace(/[«»“”"]/g, "").trim();
    const k = reviewKey(es);
    const line = plan.lines.find((l) => reviewKey(l.es) === k) ||
      (wordCount(es) >= 3 ? plan.lines.find((l) => (" " + reviewKey(l.es) + " ").indexOf(" " + k + " ") >= 0) : null);
    if (!esOk(es) || !line || sseen.has(k)){ if (esOk(es) && !line) diag.notInLog++; continue; }
    if (recent("s", es) || recent("s", line.es)){ diag.recent++; continue; }
    const ko = koOk(cleanStr(o.ko)) ? cleanStr(o.ko) : line.ko;
    const why = teachPoints(o.why, diag);
    const left = connectorsLeft(es, why);
    if (left.length && why.length < TEACH_POINTS) diag.connectorsLeft.push(es + ": " + left.join(","));
    const v = asObj(o.variation);
    const vEs = v ? cleanStr(v.es).replace(/[«»“”"]/g, "").trim() : "";
    const variation = v && esOk(vEs) && koOk(cleanStr(v.ko)) && wordCount(vEs) <= USE_WORDS && reviewKey(vEs) !== k
      ? { word: plainEs(v.word), es: vEs, ko: cleanStr(v.ko), say: speakClean(vEs, true), lead: teachTurns(v.lead, diag) } : null;
    sseen.add(k);
    sents.push({ es: es, ko: ko, say: speakClean(es, true), day: line.day, intro: teachTurns(o.intro, diag),
                 why: why, variation: variation, repeatCue: cueTurn(o.repeat_cue, diag) });
    if (sents.length >= S.sents) break;
  }
  /* a variation has to use one of today's words */
  const wordSet = new Set(pickedWords.map((w) => foldEs(w.es)));
  for (const s of sents){
    if (s.variation && !wordSet.has(foldEs(s.variation.word))){ s.variation = null; diag.varDropped++; }
  }
  if (!pickedWords.length && !sents.length) throw new Error("대본에 단어도 문장도 없습니다.");

  /* the take-away is one of today's sentences, or a usage sentence */
  const candidates = sents.map((s) => ({ es: s.es, ko: s.ko }))
    .concat(pickedWords.concat(idioms).filter((w) => w.use).map((w) => ({ es: w.use.es, ko: w.use.ko })))
    .concat(pickedWords.concat(idioms).filter((w) => w.use2).map((w) => ({ es: w.use2.es, ko: w.use2.ko })));
  const tk = asObj(raw.takeaway);
  const hit = tk ? candidates.find((c) => reviewKey(c.es) === reviewKey(tk.es)) : null;
  const takeBase = hit || candidates[0] || null;
  const takeaway = takeBase ? { es: takeBase.es, ko: takeBase.ko, say: speakClean(takeBase.es, true),
                                lead: hit ? teachTurns(tk.lead, diag) : [] } : null;

  const op = koTurn(raw.opening, "", diag);
  return {
    fmt: TEACH_FMT,
    opening: op && op.length === 1 && op[0].who === "ko" ? op[0] : null,
    words: pickedWords, idioms: idioms, sents: sents, takeaway: takeaway,
    goodbye: cueTurn(raw.goodbye, diag), diag: diag
  };
}

/* ---- the code's own lines: varied, never the same twice in a row ---- */
const hasBatchim = (s) => {
  const c = String(s || "").replace(/[^가-힣]+$/, "");
  const ch = c.charCodeAt(c.length - 1);
  return ch >= 0xAC00 && ch <= 0xD7A3 && (ch - 0xAC00) % 28 !== 0;
};
const ida = (s) => (hasBatchim(s) ? "이에요" : "예요");
/* a Korean meaning to be quoted inside a code line: said cleanly, its own quotes and end mark gone */
const koPlain = (s) => speakClean(s, false).replace(/'/g, "").replace(/[.?!]+$/, "").trim();
const TEACH_POOL = {
  open: [(d) => d + " 수업이에요.", (d) => "안녕하세요. " + d + " 수업 시작할게요.", (d) => d + " 수업, 같이 시작해 봐요."],
  theme: ["오늘은 실제로 쓰신 말로 공부해 볼게요.", "오늘도 직접 하신 말들 중에서 골라 왔어요.", "오늘은 대화에서 나온 말로 같이 연습해 봐요."],
  recapLead: ["먼저 지난번에 배운 거 몇 가지만 떠올려 볼게요. 제가 한국어로 물으면, 정답이 나오기 전에 먼저 말해 보세요.",
              "시작하기 전에 지난번 거 잠깐 떠올려 봐요. 제가 물어보면 먼저 스페인어로 말해 보세요."],
  recapAsk: [(k) => "'" + k + "', 스페인어로 뭐였죠?", (k) => "기억나시죠? '" + k + "', 어떻게 말했죠?", (k) => "'" + k + "', 이건 뭐라고 했죠?"],
  recapEnd: ["좋아요. 이제 오늘 거 볼게요.", "잘하셨어요. 그럼 오늘 공부 시작해요."],
  wordIntro: [(k) => "먼저 '" + k + "'" + ida(k) + ".", (k) => "다음은 '" + k + "'" + ida(k) + ".", (k) => "이번엔 '" + k + "'" + ida(k) + "."],
  useLead: [(k) => "문장으로 해 볼게요. '" + k + "'.", (k) => "이렇게 써요. '" + k + "'."],
  use2Lead: ["이번엔 한 군데만 바꿔 볼게요."],
  idiomIntro: [(k) => "이번엔 숙어 하나 볼게요. 뜻은 '" + k + "'" + ida(k) + "."],
  exLead: [(k) => "다른 예도 들어 볼게요. '" + k + "'."],
  sentIntro: [(k) => "이번엔 실제로 하신 말이에요. '" + k + "'.", (k) => "다음도 하신 말이에요. '" + k + "'."],
  varLead: ["한 군데만 바꿔 볼게요."],
  repeat: ["따라 해 보세요.", "소리 내서 한번 해 보세요.", "입으로 한번 따라 해 볼까요?", "이번엔 직접 말해 보세요."],
  whole: ["이제 문장 전체를 따라 해 보세요.", "처음부터 끝까지 이어서 말해 보세요.", "문장 통째로 한번 해 볼게요."],
  again: ["한 번 더 들어 볼게요.", "다시 한번 들어 보세요.", "한 번만 더 갈게요."],
  safe: ["이 부분은 소리로 잘 들어 보세요.", "잘 들어 보세요.", "이 소리를 귀에 담아 두세요."],
  take: ["오늘 하나만 가져가신다면 이 문장이에요.", "오늘 꼭 기억할 문장 하나만 다시 들어 볼게요."],
  bye: ["오늘도 수고 많으셨어요. 내일 또 만나요.", "오늘 수업은 여기까지예요. 운전 조심하세요."]
};
function teachPicker(seed){
  let n = Math.abs(seed | 0), last = "";
  return (pool, arg) => {
    for (let k = 0; k < pool.length; k++){
      const x = pool[(n + k) % pool.length];
      const s = typeof x === "function" ? x(arg) : x;
      if (s !== last || k === pool.length - 1){ n = n + k + 1; last = s; return s; }
    }
    return "";
  };
}

/* ---- the recap: three items of the last saved lesson, any format ---- */
function teachRecap(prev, iso, n){
  if (!asObj(prev) || !prev.date || !(String(prev.date) < iso)) return null;
  const asked = reviewAsked(prev.qa);
  const all = reviewItemsFrom(prev).map((it) => {
    const koSay = koPlain(it.ko), esSay = speakClean(it.es, true);
    return koSay && !LATIN_CH.test(koSay) && esSay ? Object.assign(it, { koSay: koSay, esSay: esSay, hit: reviewHit(it, asked) }) : null;
  }).filter(Boolean);
  if (!all.length) return null;
  const take = [], used = new Set();
  const put = (it) => { if (it && !used.has(it) && take.length < n){ used.add(it); take.push(it); } };
  for (const it of all) if (it.hit) put(it);
  for (const t of ["sent", "expr", "idiom", "frame"]) put(all.find((it) => it.type === t && !used.has(it)));
  for (const it of all) put(it);
  take.sort((a, b) => a.order - b.order);
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) - 1, 12);
  return { date: String(prev.date), yesterday: studyDate(d) === String(prev.date), items: take };
}

const isoLabel = (iso) => Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일";

/* One fitting of the lesson: `level` adds repetition rounds, `scale` stretches
   the pauses to repeat in. Returns the parts in order. */
function teachParts(c, ctx, level, scale){
  const pick = teachPicker(ctx.dn);
  const st = { lastKo: "", lastCue: "" };
  const gap = (es) => {
    const sec = estimateMs({ speaker: "es", text: String(es || ""), rate: 1 }) / 1000 + TP.repPad;
    /* never shorter than TP.repMin, whatever the scale: the learner needs that long to say it */
    return Math.round(Math.max(TP.repMin, Math.min(TP.repCap, Math.min(TP.repMax, Math.max(TP.repMin, sec)) * scale)) * 10) / 10;
  };
  const part = (id, title) => lessonPart({ id: id, title: title || TEACH_TITLES[id] });
  /* a Korean line written by code: shown with digits, said in words */
  const sayLine = (p, shown, pause, fields) => {
    let say = speakClean(shown, false);
    /* a pool line wrapped around an empty meaning («먼저 ''예요») says nothing useful */
    if (/''/.test(shown)){ shown = pick(TEACH_POOL.safe); say = speakClean(shown, false); }
    /* a meaning interpolated from the log may hold a Latin word: never to the Korean voice */
    if (LATIN_CH.test(say)){ shown = pick(TEACH_POOL.safe); say = speakClean(shown, false); }
    if (!say) return;
    const g = p.row("say", Object.assign({ ko: shown, who: "ko" }, fields || {}));
    p.seg(g, "ko", /[.?!]$/.test(say) ? say : say + ".", pause == null ? TP.line : pause, { by: "code" });
    st.lastKo = say;
  };
  let lastEs = "";
  const turn = (p, t, fields) => {
    if (t.who === "es"){
      const g = p.row("pair", Object.assign({ es: t.shown, who: "es" }, fields || {}));
      p.seg(g, "es", t.say, t.pause === "repeat" ? gap(t.say) : TP.es);
      lastEs = t.say;
      return;
    }
    if (t.safe){ sayLine(p, pick(TEACH_POOL.safe), TP.line); return; }
    if (t.say === st.lastKo) return;          // the same line twice in a row says nothing new
    const g = p.row("say", Object.assign({ ko: t.shown, who: "ko" }, fields || {}));
    p.seg(g, "ko", t.say, t.pause === "repeat" ? gap(lastEs) : TP.line);
    st.lastKo = t.say;
  };
  const turns = (p, list) => { for (const t of list) turn(p, t); };
  /* a cue before a pause to repeat in: the AI's line unless it repeats the last cue */
  const cue = (p, t, pool, es) => {
    const say = t && t.say !== st.lastCue ? t.say : "";
    let shown = say ? t.shown : pick(pool);
    for (let k = 0; !say && k < pool.length && speakClean(shown, false) === st.lastCue; k++) shown = pick(pool);
    const s = say || speakClean(shown, false);
    const g = p.row("say", { ko: shown, who: "ko", cr: CR_REPEAT });
    p.seg(g, "ko", /[.?!]$/.test(s) ? s : s + ".", gap(es), say ? undefined : { by: "code" });
    st.lastCue = s; st.lastKo = s;
  };
  /* the native speaker's model: normal, then slow */
  const model = (p, es, say, ko, fields, slow) => {
    const g = p.row("pair", Object.assign({ es: es, ko: ko, who: "es" }, fields || {}));
    p.seg(g, "es", say, slow ? TP.model : TP.es);
    if (slow) p.seg(g, "es", say, TP.slow, { rate: SLOW_RATE });
    lastEs = say;
  };
  const badgeOf = (x) => (x.source === "list" ? "단어 목록에서" : x.day && x.day !== ctx.iso ? isoLabel(x.day) + " 대화" : undefined);
  /* a usage sentence: lead, the sentence normal and slow, why, then the learner says it whole */
  const useBlock = (p, x) => {
    const u = x.use;
    if (realKo(u.lead)) turns(p, u.lead);
    else sayLine(p, pick(TEACH_POOL.useLead, koPlain(u.ko)));
    model(p, u.es, u.say, u.ko, {}, true);
    for (const pt of x.why) turns(p, pt.turns);
    cue(p, x.wholeCue, TEACH_POOL.whole, u.say);
    model(p, u.es, u.say, u.ko, { badge: "다시" }, false);
  };
  /* the second sentence: one thing changed, with its reason (a word), or a second example (an idiom) */
  const use2Block = (p, x, leadPool) => {
    const u = x.use2;
    if (!u) return;
    if (realKo(u.lead)) turns(p, u.lead);
    else sayLine(p, pick(leadPool, koPlain(u.ko)));
    model(p, u.es, u.say, u.ko, { badge: "하나 더" }, false);
    for (const pt of x.why2) turns(p, pt.turns);
    cue(p, null, TEACH_POOL.repeat, u.say);
  };
  /* the one code-added round an item may get (level 1): its main sentence once more */
  const againBlock = (p, es, say, ko) => {
    if (level < 1 || !say) return;
    sayLine(p, pick(TEACH_POOL.again));
    model(p, es, say, ko, {}, false);
    cue(p, null, TEACH_POOL.repeat, say);
  };

  const parts = [];
  /* 1. opening: the date, then today's theme */
  const op = part("open");
  sayLine(op, pick(TEACH_POOL.open, ctx.dateLabel));
  if (c.opening) turn(op, c.opening);
  else sayLine(op, pick(TEACH_POOL.theme));
  parts.push(op);

  /* 2. the recap: the question, two seconds, a tick, the answer */
  if (ctx.recap && ctx.recap.items.length){
    const rp = part("recap", ctx.recap.yesterday ? "어제 복습" : "지난 수업 복습");
    sayLine(rp, pick(TEACH_POOL.recapLead));
    for (const it of ctx.recap.items){
      const g = rp.row("pair", { es: it.show || it.es, ko: it.ko, quiz: true, who: "es", badge: "복습" });
      const q = pick(TEACH_POOL.recapAsk, it.koSay);
      rp.seg(g, "ko", speakClean(q, false).replace(/([^.?!])$/, "$1?"), TP.think, { by: "code" });
      rp.seg(g, "es", it.esSay, TP.answer, { cue: "tick", by: "prev" });
    }
    sayLine(rp, pick(TEACH_POOL.recapEnd));
    parts.push(rp);
  }

  /* 3. words: meaning, model normal and slow, repeat, a usage sentence with its reasons */
  if (c.words.length){
    const wp = part("words");
    c.words.forEach((w) => {
      if (realKo(w.intro)) turns(wp, w.intro);
      else sayLine(wp, pick(TEACH_POOL.wordIntro, koPlain(w.ko)));
      model(wp, w.es, speakClean(w.es, true), w.ko, { badge: badgeOf(w), rv: "expr" }, true);
      cue(wp, w.repeatCue, TEACH_POOL.repeat, speakClean(w.es, true));
      if (w.use){ useBlock(wp, w); use2Block(wp, w, TEACH_POOL.use2Lead); againBlock(wp, w.use.es, w.use.say, w.use.ko); }
      wp.teach("v", w.es);
      if (w.source === "list") wp.newUsed.push({ es: w.es, ko: w.ko });
    });
    parts.push(wp);
  }

  /* 4. idioms: literal, real meaning, model, repeat, a usage sentence */
  if (c.idioms.length){
    const ip = part("idiom");
    c.idioms.forEach((x) => {
      turns(ip, x.literal);
      if (realKo(x.meaning)) turns(ip, x.meaning);
      else sayLine(ip, pick(TEACH_POOL.idiomIntro, koPlain(x.ko)));
      model(ip, x.es, speakClean(x.es, true), x.ko, { badge: badgeOf(x), rv: "idiom" }, true);
      cue(ip, x.repeatCue, TEACH_POOL.repeat, speakClean(x.es, true));
      if (x.use){ useBlock(ip, x); use2Block(ip, x, TEACH_POOL.exLead); againBlock(ip, x.use.es, x.use.say, x.use.ko); }
      ip.teach("i", x.es);
    });
    parts.push(ip);
  }

  /* 5. the user's own sentences: normal and slow, the reasons, a one-word variation */
  if (c.sents.length){
    const sp = part("sent");
    const words = new Set(c.words.map((w) => foldEs(w.es)));
    c.sents.forEach((s) => {
      if (realKo(s.intro)) turns(sp, s.intro);
      else sayLine(sp, pick(TEACH_POOL.sentIntro, koPlain(s.ko)));
      model(sp, s.es, s.say, s.ko, { badge: badgeOf(s), rv: "sent" }, true);
      for (const pt of s.why) turns(sp, pt.turns);
      const v = s.variation && words.has(foldEs(s.variation.word)) ? s.variation : null;
      if (v){
        if (realKo(v.lead)) turns(sp, v.lead);
        else sayLine(sp, pick(TEACH_POOL.varLead));
        model(sp, v.es, v.say, v.ko, { badge: "바꿔 말하기" }, false);
        cue(sp, s.repeatCue, TEACH_POOL.repeat, v.say);
      } else {
        cue(sp, s.repeatCue, TEACH_POOL.whole, s.say);
        model(sp, s.es, s.say, s.ko, { badge: "다시" }, false);
      }
      if (v) againBlock(sp, s.es, s.say, s.ko);
      sp.teach("s", s.es);
    });
    parts.push(sp);
  }

  /* 6. closing: the one sentence to take away, said by the native speaker, then goodbye */
  const cp = part("close");
  const tk = c.takeaway;
  if (tk){
    if (realKo(tk.lead)) turns(cp, tk.lead);
    else sayLine(cp, pick(TEACH_POOL.take));
    model(cp, tk.es, tk.say, tk.ko, {}, true);
    cue(cp, null, TEACH_POOL.repeat, tk.say);
  }
  if (c.goodbye) turn(cp, c.goodbye);
  else sayLine(cp, pick(TEACH_POOL.bye));
  parts.push(cp);
  return parts;
}

/* drop `k` items, last word first, so an over-long reply still fits */
function teachTrim(c, k){
  const o = Object.assign({}, c, { words: c.words.slice(), idioms: c.idioms.slice(), sents: c.sents.slice() });
  const order = ["words", "sents", "words", "idioms", "sents", "words"];
  for (let i = 0; i < k && i < order.length; i++) if (o[order[i]].length > 1) o[order[i]].pop();
  return o;
}

/* The lesson record. `prev` is the saved lesson before this one (the recap);
   `plan` is teachPlan's. The fitting keeps every item when it can: it tries
   the repetition levels and pause scales first, and drops an item only when
   even the shortest fitting is over the range. */
function teachBuild(content, when, prev, plan, minutes){
  const min = Number(minutes == null ? lessonMinutes() : minutes) === 20 ? 20 : 10;
  const size = teachSize(min);
  const iso = studyDate(when);
  const ctx = { iso: iso, dn: dayNum(iso), dateLabel: isoLabel(iso), recap: teachRecap(prev, iso, size.recap) };
  let best = null;
  for (let drop = 0; drop <= 4; drop++){
    if (best && best.inRange) break;
    const cc = drop ? teachTrim(content, drop) : content;
    for (const level of [0, 1]){
      for (const scale of TEACH_SCALES){
        const parts = teachParts(cc, ctx, level, scale);
        const ms = partsMs(parts) + (parts.length - 1) * Q.section * 1000;
        const inRange = ms >= size.loMs && ms <= size.hiMs;
        /* in range beats out of range; then nearest the target, with fewer extras and drops */
        const cost = Math.abs(ms - size.targetMs) + level * 4000 + Math.abs(scale - 1) * 15000 + drop * 30000;
        if (!best || (inRange && !best.inRange) || (inRange === best.inRange && cost < best.cost))
          best = { cost: cost, parts: parts, estMs: ms, inRange: inRange, level: level, scale: scale, drop: drop };
      }
    }
  }
  const joined = partsJoin(best.parts);
  const taught = [], newUsed = [];
  for (const p of best.parts){ taught.push(...p.taught); newUsed.push(...p.newUsed); }
  const titles = {};
  for (const p of best.parts) titles[p.part.id] = p.part.title;
  const n = (t) => taught.filter((x) => x.t === t).length;
  const learnedBefore = newWordsCount();
  return {
    fmt: TEACH_FMT, minutes: min, date: iso, dateLabel: ctx.dateLabel, parts: titles,
    counts: Object.assign({ words: n("v"), idioms: n("i"), sentences: n("s") },
                          ctx.recap ? { review: ctx.recap.items.length } : {},
                          newUsed.length ? { newWords: newUsed.length, learned: learnedBefore + newUsed.length } : {}),
    reviewOf: ctx.recap ? ctx.recap.date : "",
    fit: { level: best.level, scale: best.scale, drop: best.drop, estMs: Math.round(best.estMs) },
    diag: content.diag || {},
    segments: joined.segs, rows: joined.rows,
    /* only what was actually spoken counts as taught; the grammar step is not touched */
    curriculum: { iso: iso, newWords: newUsed, grammar: null, taught: taught }
  };
}

/* ---------------- PCM ---------------- */

function b64ToBytes(b64){
  const bin = atob(String(b64 || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* LINEAR16 comes back wrapped in a RIFF header (documented). Read the real
   rate out of the header rather than trusting what we asked for, and still
   cope if a raw PCM body ever turns up. */
function pcmFromBytes(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length > 44 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46){
    let off = 12, sr = 0;
    while (off + 8 <= u8.length){
      const id = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
      const size = dv.getUint32(off + 4, true);
      if (id === "fmt ") sr = dv.getUint32(off + 12, true);
      else if (id === "data"){
        const len = Math.min(size, u8.length - (off + 8));
        const n = len >> 1, pcm = new Int16Array(n), base = off + 8;
        for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(base + i * 2, true);
        return { pcm: pcm, sr: sr || TTS_SR };
      }
      off += 8 + size + (size & 1);
    }
  }
  const n = u8.length >> 1, pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, true);
  return { pcm: pcm, sr: TTS_SR };
}

/* Insurance against two voices answering at different rates: one track can
   only have one rate, and a mismatch would shift the pitch of half the lesson. */
function resample(pcm, from, to){
  if (!from || from === to) return pcm;
  const n = Math.max(1, Math.round(pcm.length * to / from));
  const out = new Int16Array(n);
  const step = pcm.length / n;
  for (let i = 0; i < n; i++) out[i] = pcm[Math.min(pcm.length - 1, Math.floor(i * step))];
  return out;
}

/* ---------------- Cloud TTS ---------------- */

/* Which locales to ask for, best first. Chirp 3: HD has no es-MX at all, and
   its es-US is Latin American — much closer to Mexico than es-ES — so es-US
   now leads instead of es-MX. */
const LANG_TRY = { es: ["es-US", "es-MX", "es-419", "es-ES"], ko: ["ko-KR"] };

/* Voice families, most natural first. Chirp 3: HD is Google's current top tier
   and is the whole point of this change — the old ranking started at Neural2
   and skipped Chirp entirely, which is why the lesson sounded synthetic.
   Studio has no Spanish or Korean voice and Journey/News/Casual are English
   only, so those are skipped rather than ranked. */
const VOICE_RANK = [/Chirp3-HD/i, /Chirp-HD/i, /Neural2/i, /Wavenet/i, /Standard/i];
const VOICE_SKIP = /journey|news|casual|polyglot|studio/i;

/* The default is ONE named voice per language. Chirp 3: HD carries the same
   voice set in every locale it supports and names them <locale>-Chirp3-HD-<voice>
   (docs: cloud.google.com/text-to-speech/docs/chirp3-hd). Nothing here is
   trusted blindly: a name is only used if voices.list says the key's project
   really has it, and otherwise VOICE_RANK picks the closest thing that exists. */
const VOICE_PICKS = {
  es: { female: ["es-US-Chirp3-HD-Aoede", "es-US-Neural2-A", "es-US-Wavenet-A"],
        male:   ["es-US-Chirp3-HD-Charon", "es-US-Neural2-B", "es-US-Wavenet-B"] },
  ko: { female: ["ko-KR-Chirp3-HD-Leda", "ko-KR-Neural2-A", "ko-KR-Wavenet-A"],
        male:   ["ko-KR-Chirp3-HD-Puck", "ko-KR-Neural2-C", "ko-KR-Wavenet-C"] }
};
const SEX_TAG = { female: "FEMALE", male: "MALE" };
const voiceSexOf = (side) => ((side === "es" ? lset.sexEs : lset.sexKo) === "male" ? "male" : "female");

function ttsError(status, msg){
  let head = "";
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg))
    head = "Cloud TTS 키가 올바르지 않습니다.\n\n";
  else if (status === 403 && /disabled|has not been used|SERVICE_DISABLED/i.test(msg))
    head = "이 키의 프로젝트에서 Cloud Text-to-Speech API 가 켜져 있지 않습니다.\n" +
           "구글 클라우드 콘솔에서 Text-to-Speech API 를 사용 설정하십시오.\n\n";
  else if (status === 403 && /billing/i.test(msg))
    head = "Cloud TTS 키가 막혔습니다 — 그 프로젝트의 결제가 꺼져 있습니다. console.cloud.google.com → 결제(Billing)에서 결제 계정을 연결하십시오.\n\n";
  else if (status === 403)
    head = "Cloud TTS 키에 권한이 없습니다 (키 제한 또는 결제 미연결). console.cloud.google.com 에서 키의 API 제한과 결제를 확인하십시오.\n\n";
  else if (status === 429)
    head = "Cloud TTS 키가 잠시 막혔습니다 — 요청 한도(할당량)에 걸렸습니다. 잠시 뒤 다시 하시거나 console.cloud.google.com 의 할당량을 확인하십시오. 기기 목소리로 바꿔도 됩니다.\n\n";
  const err = new Error(head + "TTS " + status + "\n" + msg);
  err.ttsStatus = status;
  return err;
}

/* One short Korean line for a Cloud TTS failure, plus what to do about it.
   "sticky" causes do not fix themselves (a wrong key, the API switched off,
   no billing, a key restriction): those are remembered so the same failure
   is not shouted at the user every day. Quota, timeouts and the network do
   fix themselves, so they are never remembered. */
const TTS_CAUSES = {
  badkey:   { sticky: true,  short: "Cloud TTS 키가 올바르지 않습니다.",
              fix: "설정 › 오디오 수업 음성에서 키를 다시 붙여 넣으십시오." },
  disabled: { sticky: true,  short: "키의 구글 클라우드 프로젝트에서 Text-to-Speech API 가 꺼져 있습니다.",
              fix: "console.cloud.google.com 에서 Text-to-Speech API 를 사용 설정하십시오." },
  billing:  { sticky: true,  short: "키의 구글 클라우드 프로젝트에 결제가 연결되어 있지 않습니다.",
              fix: "console.cloud.google.com → 결제(Billing)에서 결제 계정을 연결하십시오." },
  denied:   { sticky: true,  short: "이 키에는 Text-to-Speech 를 쓸 권한이 없습니다 (키 제한 또는 결제).",
              fix: "console.cloud.google.com 에서 키의 API 제한과 결제를 확인하십시오." },
  quota:    { sticky: false, short: "Cloud TTS 요청 한도(할당량)에 잠시 걸렸습니다.",
              fix: "잠시 뒤 다시 만드시면 됩니다." },
  timeout:  { sticky: false, short: "Cloud TTS 가 제때 응답하지 않았습니다.",
              fix: "인터넷이 잘 되는 곳에서 다시 만드시면 됩니다." },
  network:  { sticky: false, short: "Cloud TTS 에 연결하지 못했습니다.",
              fix: "인터넷 연결을 확인하신 뒤 다시 만드시면 됩니다." },
  noaudio:  { sticky: false, short: "Cloud TTS 가 오디오를 돌려주지 않았습니다.",
              fix: "잠시 뒤 다시 만드시면 됩니다." },
  novoice:  { sticky: false, short: "이 키로 쓸 수 있는 목소리를 찾지 못했습니다.",
              fix: "설정에서 «음성 확인» 을 눌러 보십시오." },
  server:   { sticky: false, short: "구글 서버가 잠시 응답하지 못했습니다.",
              fix: "잠시 뒤 다시 만드시면 됩니다." },
  unknown:  { sticky: false, short: "원인을 알 수 없는 오류가 났습니다.",
              fix: "아래 «자세히» 의 내용을 확인하십시오." }
};

function ttsCause(err){
  const m = String((err && err.message) || err || "");
  let st = (err && err.ttsStatus) || 0;
  if (!st){ const h = /TTS (\d{3})/.exec(m); if (h) st = Number(h[1]); }
  let code = "unknown";
  if (st === 400 && /API key not valid|API_KEY_INVALID/i.test(m)) code = "badkey";
  else if (st === 403 && /disabled|has not been used|SERVICE_DISABLED/i.test(m)) code = "disabled";
  else if (st === 403 && /billing/i.test(m)) code = "billing";
  else if (st === 403 || st === 401) code = "denied";
  else if (st === 429) code = "quota";
  else if (st >= 500) code = "server";
  else if (/응답하지 않아 끊었습니다/.test(m)) code = "timeout";
  else if (/연결하지 못했습니다/.test(m)) code = "network";
  else if (/오디오가 없습니다|응답을 읽지 못했습니다/.test(m)) code = "noaudio";
  else if (/음성을 찾지 못했습니다/.test(m)) code = "novoice";
  const c = TTS_CAUSES[code];
  return { code: code, status: st, sticky: c.sticky, short: c.short, fix: c.fix };
}

/* Records a failure. Returns true when the user should be told about it:
   always for a passing cause, and only the first time for a sticky one. */
function ttsFailRecord(cause){
  if (!cause.sticky) return true;
  const old = lset.ttsFail;
  const seen = !!(old && old.code === cause.code && old.shown);
  lset.ttsFail = { code: cause.code, status: cause.status, cause: cause.short,
                   fix: cause.fix, date: todayKey(), shown: true };
  lpersist();
  return !seen;
}
function ttsFailClear(){
  if (!lset.ttsFail) return;
  delete lset.ttsFail;
  lpersist();
}

/* The fallback notice: a short cause and what to do on top, the raw error
   (Google's JSON included) folded under «자세히». */
function ttsFailNotice(lead, err, remembered){
  const c = ttsCause(err);
  return {
    text: lead + "\n원인: " + c.short + "\n" + c.fix +
          (remembered ? "\n같은 원인이면 다음부터는 이 안내를 띄우지 않고 설정에만 표시합니다." : ""),
    detail: String((err && err.message) || err || "")
  };
}

/* Aborts every request in flight. fetch() has no timeout of its own, and the
   lesson holds the app's `busy` flag while it runs: one request that opens and
   then never delivers a byte would otherwise freeze the microphone, typing and
   the daily note until the page is reloaded. */
let ttsAbort = null;
const TTS_TIMEOUT_MS = 30000;

function cancelTts(){
  if (ttsAbort){ try { ttsAbort.abort(); } catch (e) {} }
}

async function ttsFetch(url, init, tries){
  tries = tries || 3;
  let last = null;

  for (let i = 0; i < tries; i++){
    if (lessonCancelled) throw new Error("__cancelled__");

    const ctl = (typeof AbortController === "function") ? new AbortController() : null;
    /* the deadline covers the body too: a reply whose headers arrive and whose
       body never does would hang just as badly */
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, TTS_TIMEOUT_MS) : null;
    if (ctl) ttsAbort = ctl;

    let status = 0, raw = null, netErr = null;
    try {
      const res = await fetch(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init);
      status = res.status;
      raw = await res.text();
    } catch (e) {
      netErr = e;
    } finally {
      if (timer) clearTimeout(timer);
      if (ttsAbort === ctl) ttsAbort = null;
    }

    if (netErr){
      if (lessonCancelled) throw new Error("__cancelled__");
      last = (netErr && netErr.name === "AbortError")
        ? new Error("Cloud TTS 가 " + (TTS_TIMEOUT_MS / 1000) + "초 안에 응답하지 않아 끊었습니다.")
        : new Error("Cloud TTS 에 연결하지 못했습니다. 인터넷을 확인하십시오.");
      await sleep(400 * (i + 1));
      continue;
    }

    let j = null;
    try { j = JSON.parse(raw); } catch (e) {}

    if (status >= 200 && status < 300){
      if (j) return j;
      last = new Error("Cloud TTS 의 응답을 읽지 못했습니다.");
      await sleep(400 * (i + 1));
      continue;
    }

    last = ttsError(status, (j && j.error && j.error.message) || String(raw).slice(0, 300));
    if (status === 429 || status >= 500){ await sleep(700 * (i + 1)); continue; }
    throw last;
  }
  throw last;
}

async function ttsListVoices(code){
  const j = await ttsFetch(TTS_VOICES_URL + "?languageCode=" + encodeURIComponent(code),
    { method: "GET", headers: { "x-goog-api-key": lset.ttsKey } }, 2);
  return Array.isArray(j && j.voices) ? j.voices : [];
}

/* Gather every voice this key can actually see across all the candidate
   locales, then choose once. Collecting first matters: the old code returned
   the best voice of the FIRST locale that had any, so an es-MX Wavenet beat an
   es-US Chirp 3: HD purely because es-MX was asked for first. */
async function ttsPickVoice(side){
  const want = voiceSexOf(side);
  const all = [];

  for (let i = 0; i < LANG_TRY[side].length; i++){
    const code = LANG_TRY[side][i];
    let voices = [];
    try { voices = await ttsListVoices(code); }
    catch (e) {
      /* Only "this language code has nothing" is worth trying the next code
         for. A bad key, no permission, a quota or a dead connection must be
         reported as itself — swallowing those would fail all four codes and
         then blame the voice list, sending the user hunting for a problem
         that is not there. */
      const m = (e && e.message) || "";
      if (/__cancelled__|API key|API_KEY_INVALID|권한|결제|한도|연결하지 못했|응답하지 않아|켜져 있지 않/.test(m)) throw e;
      continue;
    }
    for (const v of voices){
      if (!v || !v.name || VOICE_SKIP.test(v.name)) continue;
      all.push({
        name: v.name,
        code: (v.languageCodes && v.languageCodes[0]) || code,
        sex: String(v.ssmlGender || ""),
        localeRank: i
      });
    }
  }
  if (!all.length) return null;

  const byName = new Map();
  for (const v of all) if (!byName.has(v.name)) byName.set(v.name, v);

  /* the named default, but only if this project really has it */
  for (const name of VOICE_PICKS[side][want]) if (byName.has(name)) return byName.get(name);

  /* otherwise: best family, then the requested gender, then the best locale,
     then alphabetical — the last one is what makes this repeatable. Picking
     "the first match the API happened to return" is how two devices with the
     same key ended up on two different voices. */
  const famOf = (n) => {
    for (let i = 0; i < VOICE_RANK.length; i++) if (VOICE_RANK[i].test(n)) return i;
    return VOICE_RANK.length;
  };
  const sexMiss = (v) => (v.sex === SEX_TAG[want] ? 0 : 1);
  all.sort((a, b) =>
    famOf(a.name) - famOf(b.name) ||
    sexMiss(a) - sexMiss(b) ||
    a.localeRank - b.localeRank ||
    a.name.localeCompare(b.name));
  return all[0];
}

async function ttsEnsureVoices(){
  if (!lset.voiceEs){
    const v = await ttsPickVoice("es");
    if (!v) throw new Error("쓸 수 있는 스페인어 음성을 찾지 못했습니다.");
    lset.voiceEs = v.name; lset.voiceEsCode = v.code;
  }
  if (!lset.voiceKo){
    const v = await ttsPickVoice("ko");
    if (!v) throw new Error("쓸 수 있는 한국어 음성을 찾지 못했습니다.");
    lset.voiceKo = v.name; lset.voiceKoCode = v.code;
  }
  lpersist();
}

/* Google's own docs disagree about Chirp 3: HD and speed. The supported-voices
   page still says the family "doesn't support SSML input, speaking rate and
   pitch-audio parameters"; the Chirp 3 page documents a pace control
   ("the speaking_rate parameter", 0.25x-2x) and the release notes date it —
   2025-05-07, "Pace control is available across all locales". The release note
   is the later statement, so speakingRate is expected to work and the other
   page is taken as stale.

   Expected, not verified: this was never run against a real key. So the code
   does not bet on it. speakingRate is sent only for the one deliberately slow
   read, and if that single request is refused for it, the same line is asked
   for again at the voice's own speed. The slow read then simply is not slow,
   and the notice says so — which beats failing the whole lesson over it. */
let ttsRateRefused = false;
/* Deliberately narrow: it must name the speaking rate. The first version also
   matched "audio_config", "not supported" and bare "invalid", which any
   run-of-the-mill 400 (a bad voice name, "Invalid value at ...") satisfies —
   one such error would have latched ttsRateRefused and silently turned the
   slow read off for the rest of the run. */
const RATE_REFUSED = /speaking[_\s-]?rate/i;

async function ttsSay(text, side, rate){
  const name = side === "es" ? lset.voiceEs : lset.voiceKo;
  const code = (side === "es" ? lset.voiceEsCode : lset.voiceKoCode) || (side === "es" ? "es-US" : "ko-KR");
  const base = { audioEncoding: "LINEAR16", sampleRateHertz: TTS_SR };
  const want = rate || 1;

  const send = (cfg) => ttsFetch(TTS_URL, {
    method: "POST",
    headers: { "x-goog-api-key": lset.ttsKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: text },
      voice: { languageCode: code, name: name },
      audioConfig: cfg
    })
  });

  let j = null;
  if (want === 1 || ttsRateRefused){
    /* at normal speed the parameter buys nothing, so it is not sent at all —
       that keeps the risk confined to the handful of slow segments */
    j = await send(base);
  } else {
    try {
      j = await send(Object.assign({}, base, { speakingRate: want }));
    } catch (e) {
      const m = (e && e.message) || "";
      if (!/TTS 400/.test(m) || !RATE_REFUSED.test(m)) throw e;
      ttsRateRefused = true;
      j = await send(base);
    }
  }

  if (!j || !j.audioContent) throw new Error("Cloud TTS 응답에 오디오가 없습니다.");
  return pcmFromBytes(b64ToBytes(j.audioContent));
}

/* ---------------- mp3 encoder (vendored lamejs) ---------------- */

let lamePromise = null;
function loadLame(){
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (lamePromise) return lamePromise;
  lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "lame.min.js";
    /* both failure paths must forget the promise, or one bad load (the service
       worker handing back index.html for a missing file, say) would keep every
       later attempt failing instantly for the life of the page */
    s.onload = () => {
      if (window.lamejs) return resolve(window.lamejs);
      lamePromise = null;
      reject(new Error("mp3 인코더를 불러오지 못했습니다."));
    };
    s.onerror = () => { lamePromise = null; reject(new Error("mp3 인코더 파일을 찾지 못했습니다.")); };
    document.head.appendChild(s);
  });
  return lamePromise;
}

/* Feeds the track into the encoder as it is assembled, so a nine minute
   lesson never has to exist as one giant PCM buffer. */
function mp3Writer(lame, sr){
  const enc = new lame.Mp3Encoder(1, sr, MP3_KBPS);
  const parts = [];
  const BLK = 1152;
  let carry = new Int16Array(0);

  function push(chunk){ if (chunk && chunk.length) parts.push(new Uint8Array(chunk)); }

  return {
    write: function (pcm){
      let src = pcm;
      if (carry.length){
        const join = new Int16Array(carry.length + pcm.length);
        join.set(carry, 0); join.set(pcm, carry.length);
        src = join; carry = new Int16Array(0);
      }
      let i = 0;
      for (; i + BLK <= src.length; i += BLK) push(enc.encodeBuffer(src.subarray(i, i + BLK)));
      if (i < src.length) carry = src.slice(i);
    },
    finish: function (){
      if (carry.length) push(enc.encodeBuffer(carry));
      push(enc.flush());
      return new Blob(parts, { type: "audio/mpeg" });
    }
  };
}

/* ---------------- building the audio ---------------- */

let lessonCancelled = false;

async function pool(items, limit, worker, onDone){
  let next = 0, done = 0;
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++){
    runners.push((async function (){
      for (;;){
        const i = next++;
        if (i >= items.length || lessonCancelled) return;
        /* one runner throwing must not leave the others looping forever,
           issuing paid requests nobody will read */
        try { await worker(items[i], i); } catch (e) { return; }
        done++;
        try { if (onDone) onDone(done, items.length); } catch (e) {}
      }
    })());
  }
  await Promise.all(runners);
}

const cacheKey = (s) => s.speaker + "|" + (s.rate || 1) + "|" + s.text;

function monthNow(){ return new Date().toISOString().slice(0, 7); }
function addTtsChars(n){
  if (!lset.chars || lset.chars.ym !== monthNow()) lset.chars = { ym: monthNow(), n: 0 };
  lset.chars.n += n;
  lpersist();
}

async function lessonSynthesize(lesson, onProgress, onPhase){
  /* Load the encoder BEFORE anything is billed. If it cannot be had, the run
     is doomed anyway, and finding out afterwards would mean paying for a
     hundred TTS requests and throwing the audio away. */
  const lame = await loadLame();
  await ttsEnsureVoices();
  /* a different voice may answer differently, so this is re-decided each run */
  ttsRateRefused = false;

  /* a word is spoken three times in 1교시 and again in 5교시 — synthesise it
     once and reuse the audio, which cuts both requests and billed characters */
  const uniq = new Map();
  for (const s of lesson.segments) if (!uniq.has(cacheKey(s))) uniq.set(cacheKey(s), s);
  const jobs = Array.from(uniq.entries());
  const audio = new Map();
  /* the track rate is the one we asked for, not whichever reply happened to
     land first — the workers run concurrently, so racing for it would make
     the output depend on network timing */
  const sr = TTS_SR;
  let failure = null;

  onProgress(0, jobs.length);
  await pool(jobs, TTS_CONCURRENCY, async (pair) => {
    if (failure) return;
    try {
      const s = pair[1];
      const got = await ttsSay(s.text, s.speaker, s.rate);
      /* count it the moment Google billed it, not at the end — a run that
         fails or is cancelled halfway was still charged for what it sent */
      addTtsChars(s.text.length);
      audio.set(pair[0], got.sr === sr ? got.pcm : resample(got.pcm, got.sr, sr));
    } catch (e) { failure = e; }
  }, onProgress);

  if (lessonCancelled) throw new Error("__cancelled__");
  if (failure) throw failure;
  if (!audio.size) throw new Error("Cloud TTS 에서 오디오를 받지 못했습니다.");

  if (onPhase) onPhase();
  const out = mp3Writer(lame, sr);
  const silences = new Map();
  function silence(sec){
    const n = Math.round(sr * sec);
    if (!silences.has(n)) silences.set(n, new Int16Array(n));
    return silences.get(n);
  }

  /* a breath of silence before the first word: a Bluetooth car kit wakes its
     music link only when sound starts, and swallows the first few hundred ms.
     The timeline starts after it (lesson.padMs), so the highlight still fits. */
  const pad = silence(LEAD_PAD_SEC);
  out.write(pad);

  const segs = lesson.segments;
  const cues = new Map();
  for (let i = 0; i < segs.length; i++){
    const s = segs[i];
    const pcm = audio.get(cacheKey(s));
    if (!pcm) throw new Error("빠진 음성이 있습니다: " + s.text.slice(0, 20));
    /* a story20 chime or tick goes right in front of its line and counts as
       part of it, so the line's row lights up with its cue */
    let cue = null;
    if (s.cue && CUE_MS[s.cue]){
      if (!cues.has(s.cue)) cues.set(s.cue, cuePcm(s.cue, sr));
      cue = cues.get(s.cue);
      out.write(cue);
    }
    /* no rounding: this is the exact length of what was just written, and the
       timeline is the running sum of these */
    s.audioMs = ((cue ? cue.length : 0) + pcm.length) / sr * 1000;
    out.write(pcm);
    /* the pause after the last line is never written: the timeline ends at the
       last word, and trailing silence would leave the bar at 100% while the
       file kept playing */
    if (s.pauseAfter > 0 && i < segs.length - 1) out.write(silence(s.pauseAfter));
  }

  lesson.padMs = pad.length / sr * 1000;
  lessonTimeline(lesson, sr);
  lesson.sampleRate = sr;
  lesson.chars = jobs.reduce((n, p) => n + p[1].text.length, 0);
  return out.finish();
}

/* ---------------- storage (IndexedDB) ---------------- */

const DB_NAME = "interp.lessons", DB_STORE = "lessons";

/* A record's identity, and the thing a save compares itself against. The plain
   timestamp was not enough: two records made in the same millisecond — two tabs,
   or a quick 다시 만들기 — carried the same signature, so a save aimed at one
   could land on the other. The random tail makes it unique; the comparison is
   still a whole-string match, so nothing downstream changes. It still sorts by
   time, because the ISO prefix is fixed width and comes first. */
function lessonStamp(){
  return new Date().toISOString() + "-" + Math.random().toString(36).slice(2, 8);
}

function openDb(){
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("이 브라우저는 저장을 지원하지 않습니다."));
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "date" });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error || new Error("저장소를 열지 못했습니다."));
  });
}
/* every top-level name here lands in the scope app.js shares, so nothing
   generic enough to collide later is declared at this level */
function lessonStore(db, mode){ return db.transaction(DB_STORE, mode).objectStore(DB_STORE); }
function rq2p(rq){
  return new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function lessonSave(rec){
  /* an automatic update must not reload the page out from under this */
  beginSave();
  try {
    const db = await openDb();
    try {
      await rq2p(lessonStore(db,"readwrite").put(rec));
      const all = await rq2p(lessonStore(db,"readonly").getAll());
      all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      for (const old of all.slice(KEEP_LESSONS)) await rq2p(lessonStore(db,"readwrite").delete(old.date));
    } finally { db.close(); }
  } finally { endSave(); }
}
async function lessonList(){
  const db = await openDb();
  try {
    const all = await rq2p(lessonStore(db,"readonly").getAll());
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return all;
  } finally { db.close(); }
}
/* The newest saved lesson from a study day before `iso` that has something to
   review. Today's own record (a 다시 만들기) never counts. */
async function lessonPrevFor(iso){
  const all = await lessonList();
  const older = all.filter((r) => asObj(r) && typeof r.date === "string" && r.date < iso)
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const r of older) if (reviewItemsFrom(r).length) return r;
  return null;
}
async function lessonLoad(date){
  const db = await openDb();
  try { return (await rq2p(lessonStore(db,"readonly").get(date))) || null; }
  finally { db.close(); }
}

/* ---------------- players ---------------- */

const fmtClock = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
};

let player = null;

/* 🔁: when the lesson ends it starts again from the top. Kept on its own key so
   it survives a lesson being re-made and never touches the voice settings. */
const LESSON_LOOP_KEY = "interp.lessonLoop";
let lessonLoop = jget(LESSON_LOOP_KEY, false) === true;

/* Where each saved lesson was last left, so 📚 can pick up from there. Keyed by
   date AND the record's createdAt: 다시 만들기 keeps the date but is a different
   lesson, and must not inherit the old one's place. Only a handful are kept. */
const LESSON_POS_KEY = "interp.lessonPos";
const LESSON_POS_KEEP = 10;
const LESSON_POS_END_MS = 1500;     // this close to the end counts as finished
let lessonPosArmed = false;         // the current mount has actually been played
let lessonPosSec = -1;              // last whole second written, to write ~1/s

function lessonPosId(c){ return c ? String(c.date) + "|" + String(c.createdAt || "") : ""; }
function lessonPosGet(c){
  const all = jget(LESSON_POS_KEY, {});
  const v = all && typeof all === "object" ? all[lessonPosId(c)] : null;
  const ms = v && Number(v.ms);
  return ms > 0 && ms < (c.lesson.totalMs || 0) - LESSON_POS_END_MS ? ms : 0;
}
function lessonPosPut(c, ms){
  if (!c) return;
  const prev = jget(LESSON_POS_KEY, {});
  const all = Object.assign({}, prev && typeof prev === "object" ? prev : {});
  const finished = !(ms > 0) || ms >= (c.lesson.totalMs || 0) - LESSON_POS_END_MS;
  if (finished) delete all[lessonPosId(c)];
  else all[lessonPosId(c)] = { ms: Math.round(ms), t: Date.now() };
  const keep = Object.keys(all)
    .sort((a, b) => (Number(all[b] && all[b].t) || 0) - (Number(all[a] && all[a].t) || 0))
    .slice(0, LESSON_POS_KEEP);
  const out = {};
  for (const k of keep) out[k] = all[k];
  jset(LESSON_POS_KEY, out);
}
/* from onTick: nothing is written until this mount has played at least once,
   so merely opening a lesson (which paints position 0) cannot wipe its place */
function lessonPosNote(ms, playing){
  if (!current) return;
  if (playing) lessonPosArmed = true;
  if (!lessonPosArmed) return;
  const sec = Math.floor(ms / 1000);
  if (sec === lessonPosSec && playing) return;
  lessonPosSec = sec;
  lessonPosPut(current, ms);
}

function clearMediaSession(){
  if (!("mediaSession" in navigator)) return;
  try { navigator.mediaSession.metadata = null; } catch (e) {}
  try { navigator.mediaSession.playbackState = "none"; } catch (e) {}
  for (const k of ["play", "pause", "stop", "seekbackward", "seekforward", "previoustrack", "nexttrack"]){
    try { navigator.mediaSession.setActionHandler(k, null); } catch (e) {}
  }
}

function stopPlayer(){
  if (player && player.destroy){ try { player.destroy(); } catch (e) {} }
  player = null;
  /* otherwise the lock screen keeps advertising a lesson that no longer plays */
  clearMediaSession();
}

/* One audio file: the highlight follows currentTime, so changing the speed
   cannot desynchronise it. */
function audioPlayer(lesson, blob, onTick){
  const url = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = "auto";
  a.src = url;
  /* the element wraps to 0 by itself; the frame loop then reads position 0
     and the highlight and bar follow it back to the top */
  a.loop = lessonLoop;
  let raf = 0, speed = 1, dead = false;

  /* The player reports TIMELINE position, not file position: currentTime runs
     MP3_DELAY_MS ahead of the script because of the codec's own delay. Seeks
     put it back, so a tapped row lands on that row — subtracting on the way in
     without adding it on the way out would light up the row above instead. */
  /* A seek made before the file's metadata has loaded (📚 resuming a lesson the
     moment it mounts) is held here and applied on loadedmetadata: Chrome keeps
     such an early currentTime, but Safari has been known to drop it, and a
     dropped seek would start at 0 and then save 0 over the remembered place. */
  let pendingSeek = null;
  a.addEventListener("loadedmetadata", () => {
    if (pendingSeek == null) return;
    const t = pendingSeek;
    pendingSeek = null;
    try { if (Math.abs(a.currentTime - t) > 0.05) a.currentTime = t; } catch (e) {}
  });
  const posMs = () => Math.max(0, (pendingSeek != null ? pendingSeek : a.currentTime) * 1000 - MP3_DELAY_MS);

  /* destroy() pauses, and that "pause" event lands one task later — by then a
     new lesson may already be mounted, and this tick would paint the old
     audio's position onto the new script for a frame */
  const tick = () => { if (!dead) onTick(posMs(), !a.paused); };

  /* timeupdate alone fires about every 250 ms, which is visibly late on a
     one-word row. The old helper was a 150 ms interval; a frame loop is both
     smoother and cheaper, because it only runs while something is playing and
     the browser stops it outright when the tab is hidden. */
  const stopTimer = () => { if (raf){ cancelAnimationFrame(raf); raf = 0; } };
  const frame = () => {
    if (dead || a.paused){ raf = 0; return; }
    tick();
    raf = requestAnimationFrame(frame);
  };
  const startTimer = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };

  a.addEventListener("timeupdate", tick);
  a.addEventListener("play", () => { startTimer(); tick(); });
  a.addEventListener("playing", startTimer);
  a.addEventListener("pause", () => { stopTimer(); tick(); });
  a.addEventListener("ended", () => { stopTimer(); tick(); });
  /* a play button that silently does nothing is the worst failure here, so
     say what happened instead of swallowing it */
  a.addEventListener("error", () => {
    stopTimer();
    showError("저장된 수업 오디오를 재생하지 못했습니다.\n설정에서 기기 음성으로 바꾸거나, 수업을 다시 만들어 보십시오.");
  });

  return {
    kind: "audio",
    play: () => {
      /* media, not a call: no microphone or capture AudioContext left open
         while the lesson plays (see ensureStream in app.js) */
      if (typeof audioForPlayback === "function") audioForPlayback();
      a.play().catch((e) => {
        showError("재생이 막혔습니다. 화면을 한 번 누른 뒤 다시 시도하십시오.\n" + ((e && e.message) || ""));
      });
    },
    pause: () => a.pause(),
    toggle: function (){ a.paused ? this.play() : this.pause(); },
    /* ms is a timeline position, so the codec delay goes back on here */
    seek: (ms) => {
      const t = (Math.max(0, ms) + MP3_DELAY_MS) / 1000;
      pendingSeek = a.readyState === 0 ? t : null;
      try { a.currentTime = t; } catch (e) {}
      tick();
    },
    /* measured from the timeline position, so repeated nudges cannot drift */
    nudge: function (sec){ this.seek(posMs() + sec * 1000); },
    step: function (d){ this.nudge(d * 10); },
    speed: (v) => { speed = v; a.playbackRate = v; },
    speedNow: () => speed,
    loop: (on) => { a.loop = !!on; },
    at: posMs,
    destroy: () => {
      dead = true;
      stopTimer();
      try { a.pause(); } catch (e) {}
      /* src="" would make the element load the page URL and throw; drop the
         attribute instead */
      a.removeAttribute("src");
      try { a.load(); } catch (e) {}
      URL.revokeObjectURL(url);
    }
  };
}

/* ---------------- device voices (speechSynthesis fallback) ----------------

   Left to itself the browser picks a voice per utterance, and on a device with
   no Spanish installed it happily reads Spanish with a Korean or English
   voice — which is exactly the "발음이 이상하다" the user heard. So: choose one
   voice per language explicitly, remember it by name, and say plainly when
   there is no Spanish voice to choose from. */

/* es-MX first (the user lives in Mexico), then the other Latin American
   codings, then Spain, then anything Spanish at all. */
const DEV_LANG_RANK = {
  es: ["es-mx", "es-us", "es-419", "es-la", "es-es", "es"],
  ko: ["ko-kr", "ko"]
};

function devVoiceList(){
  try {
    const v = window.speechSynthesis && window.speechSynthesis.getVoices();
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

/* Chrome fills the list asynchronously and hands back [] on the first call, so
   a check that ran immediately would report "no Spanish voice" on a device
   that has one. Wait for voiceschanged, but never for long. */
function devVoicesReady(){
  return new Promise((resolve) => {
    if (devVoiceList().length) return resolve(devVoiceList());
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { window.speechSynthesis.removeEventListener("voiceschanged", finish); } catch (e) {}
      resolve(devVoiceList());
    };
    try { window.speechSynthesis.addEventListener("voiceschanged", finish); } catch (e) { return resolve([]); }
    setTimeout(finish, 1200);
  });
}

function devLangScore(side, lang){
  const l = String(lang || "").toLowerCase().replace(/_/g, "-");
  const rank = DEV_LANG_RANK[side];
  for (let i = 0; i < rank.length; i++){
    if (l === rank[i] || l.indexOf(rank[i] + "-") === 0) return i;
  }
  return l.indexOf(side === "es" ? "es" : "ko") === 0 ? rank.length : -1;
}

/* One voice per language, decided the same way every time on the same device:
   closest language coding first, then Google's own voices (clearly better than
   the stock ones on Android), then alphabetically so the answer never depends
   on the order the engine listed them in. */
function devPickVoice(side, voices){
  const usable = [];
  for (const v of voices){
    if (!v || !v.lang) continue;
    const s = devLangScore(side, v.lang);
    if (s >= 0) usable.push({ v: v, s: s });
  }
  if (!usable.length) return null;

  const remembered = side === "es" ? lset.devVoiceEs : lset.devVoiceKo;
  if (remembered){
    const keep = usable.find((x) => x.v.name === remembered);
    if (keep) return keep.v;
  }
  usable.sort((a, b) =>
    a.s - b.s ||
    (/google/i.test(a.v.name) ? 0 : 1) - (/google/i.test(b.v.name) ? 0 : 1) ||
    String(a.v.name).localeCompare(String(b.v.name)));
  return usable[0].v;
}

/* Resolved once per mounted lesson and reused for every line, so the voice
   cannot change halfway through. */
function devVoicePair(voices){
  const es = devPickVoice("es", voices), ko = devPickVoice("ko", voices);
  if (es && lset.devVoiceEs !== es.name){ lset.devVoiceEs = es.name; lpersist(); }
  if (ko && lset.devVoiceKo !== ko.name){ lset.devVoiceKo = ko.name; lpersist(); }
  return { es: es, ko: ko };
}

const NO_ES_VOICE =
  "이 기기에는 스페인어 목소리가 없어 스페인어를 다른 언어 목소리로 읽습니다. 발음이 깨집니다.\n" +
  "설정에서 고품질 음성(Cloud TTS)을 켜시거나, 기기 설정에서 스페인어 음성을 내려받으십시오.";

/* No audio file: the app speaks each line itself, so the highlight is exact
   by construction. Screen off stops it — that is the trade, and it is said
   so on screen. */
function devicePlayer(lesson, onTick){
  let idx = 0, alive = true, running = false, rate = 1, waitTimer = null;
  /* Picked once and then frozen: a lesson that swaps voices halfway is worse
     than one slightly stale pick. The late list from voiceschanged is only
     allowed to fill in an empty pick, and only until the first line is
     spoken — after that `voicesFixed` shuts the door, because the engine can
     fire voiceschanged at any time and would otherwise change the reader
     mid-sentence. */
  let voices = devVoicePair(devVoiceList());
  let voicesFixed = !!(voices.es && voices.ko);
  if (!voicesFixed){
    devVoicesReady().then((list) => {
      if (!alive || voicesFixed) return;
      voices = devVoicePair(list);
      voicesFixed = true;
    }).catch(() => {});
  }
  /* speechSynthesis.cancel() delivers onend/onerror asynchronously, so a
     cancelled line can report finishing AFTER a seek has already started the
     next line. Every chain carries the epoch it began in; anything from an
     older epoch is ignored, which is what stops two chains speaking at once. */
  let epoch = 0;

  const posMs = () => {
    const s = lesson.segments[Math.min(idx, lesson.segments.length - 1)];
    return s ? s.start : 0;
  };
  const report = () => onTick(posMs(), running);

  function halt(){
    running = false;
    epoch++;
    if (waitTimer){ clearTimeout(waitTimer); waitTimer = null; }
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }

  function speakOne(){
    if (!alive || !running) return;
    if (idx >= lesson.segments.length){
      /* 🔁 on: back to the first line instead of stopping */
      if (!lessonLoop || !lesson.segments.length){ running = false; report(); return; }
      idx = 0;
    }
    const s = lesson.segments[idx];
    const mine = epoch;
    report();

    let moved = false;
    const go = () => {
      if (moved || mine !== epoch) return;
      moved = true;
      if (!alive || !running) return;
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (mine !== epoch || !alive || !running) return;
        idx++;
        speakOne();
      }, s.pauseAfter * 1000 / rate);
    };
    try {
      const u = new SpeechSynthesisUtterance(s.text);
      voicesFixed = true;            // from the first line on, the pick is final
      const pick = s.speaker === "es" ? voices.es : voices.ko;
      u.lang = s.speaker === "es" ? "es-MX" : "ko-KR";
      /* naming the voice is what stops the engine reading Spanish with
         whatever voice it feels like; lang alone is only a hint */
      if (pick){ u.voice = pick; u.lang = pick.lang || u.lang; }
      u.rate = Math.max(0.1, Math.min(10, (s.rate || 1) * rate));
      u.onend = go;
      u.onerror = go;
      window.speechSynthesis.speak(u);
      /* some engines never fire onend — fall forward on an estimate */
      setTimeout(go, estimateMs(s) / rate + 4000);
    } catch (e) { go(); }
  }

  function jump(to){
    const was = running;
    halt();
    idx = Math.max(0, Math.min(lesson.segments.length - 1, to));
    if (!was){ report(); return; }
    /* give the engine a tick to finish cancelling before speaking again;
       several of them drop an utterance queued immediately after cancel() */
    running = true;
    const mine = epoch;
    report();
    waitTimer = setTimeout(() => {
      waitTimer = null;
      if (mine === epoch && alive && running) speakOne();
    }, 80);
  }

  return {
    kind: "device",
    play: () => {
      if (running) return;
      /* after the last line idx sits past the end; without this, ▶ would look
         broken until the user tapped a row */
      if (idx >= lesson.segments.length) idx = 0;
      if (typeof audioForPlayback === "function") audioForPlayback();
      running = true;
      speakOne();
    },
    pause: () => { halt(); report(); },
    toggle: function (){ running ? this.pause() : this.play(); },
    seek: (ms) => {
      let k = 0;
      for (let i = 0; i < lesson.segments.length; i++) if (lesson.segments[i].start <= ms) k = i;
      jump(k);
    },
    nudge: function (sec){ this.step(sec > 0 ? 1 : -1); },
    step: (d) => jump(idx + d),
    speed: (v) => { rate = v; },
    speedNow: () => rate,
    loop: () => {},                  // read from lessonLoop at the end of each pass
    at: posMs,
    destroy: () => { alive = false; halt(); }
  };
}

/* ---------------- lesson screen ---------------- */

let current = null;
let curRow = -1;

/* One display row. `p` is the class prefix: "L-" in the app, "" in an exported
   file — the file runs this same function, so both always draw a row alike.
   Unknown kinds fall through to plain narration, so a lesson saved by a later
   version still opens. */
function rowHtml(r, i, p){
  if (p == null) p = "L-";
  const cls = (n) => ' class="' + p + n + '"';
  const badge = r.badge ? "<span" + cls("badge") + ">" + esc(r.badge) + "</span>" : "";
  const from = (r.from ? "<span" + cls("from") + ">" + esc(r.from) + " &rarr;</span>" : "") +
               (r.role ? "<span" + cls("role") + ">" + esc(r.role) + "</span>" : "");
  /* a story20 line the learner answers or repeats, and the hand gesture to go
     with it — both for the eye only, never spoken */
  const cr = r.cr ? "<span" + cls("cr") + ">" + esc(r.cr) + "</span>" : "";
  const gest = r.gesture ? "<div" + cls("gest") + ">✋ " + esc(r.gesture) + "</div>" : "";
  /* a teacher lesson marks who speaks: 🇰🇷 the teacher, 🇲🇽 the native speaker */
  const flag = r.who === "ko" ? "🇰🇷 " : r.who === "es" ? "🇲🇽 " : "";
  let inner;
  if (r.kind === "pair" || r.kind === "slow" || r.kind === "full"){
    inner = "<div" + cls("es") + ">" + flag + from + esc(r.es || "") + badge + cr + "</div>" +
            (r.ko ? "<div" + cls("ko") + ">" + esc(r.ko) + "</div>" : "") + gest;
  } else if (r.kind === "note"){
    inner = "<div" + cls("note") + ">" + esc(r.ko || "") + "</div>";
  } else if (r.kind === "en"){
    inner = "<span" + cls("en") + ">&asymp; EN: " + esc(r.en || "") + "</span>";
  } else if (r.kind === "table" && Array.isArray(r.table)){
    let t = "";
    for (const c of r.table){
      t += "<tr><td" + cls("w") + ">" + esc(c.who || "") + "</td><td" + cls("e") + ">" + esc(c.es || "") +
           "</td><td" + cls("k") + ">" + esc(c.ko || "") + "</td></tr>";
    }
    inner = (r.ko ? "<div" + cls("cap") + ">" + esc(r.ko) + "</div>" : "") +
            "<table" + cls("tbl") + ">" + t + "</table>";
  } else {
    inner = "<div" + cls("say") + ">" + flag + from + esc(r.ko || "") + badge + cr + "</div>" + gest;
  }
  return '<button class="' + p + "row " + r.kind + (r.quiz ? " quiz" : "") + '" data-i="' + i +
    '" type="button">' + inner + "</button>";
}

function renderScript(lesson){
  let html = "", sec = "";
  for (let i = 0; i < lesson.rows.length; i++){
    const r = lesson.rows[i];
    if (r.sectionId !== sec){
      sec = r.sectionId;
      html += '<div class="L-sec">' + esc(r.sectionTitle) + "</div>";
    }
    html += rowHtml(r, i);
  }
  const body = $("lBody");
  body.innerHTML = html;
  body.querySelectorAll(".L-row").forEach((b) => {
    b.onclick = () => { if (player) player.seek(lesson.rows[Number(b.getAttribute("data-i"))].start); };
  });
  quizRows = [];
  body.querySelectorAll(".L-row.quiz").forEach((b) => {
    const r = lesson.rows[Number(b.getAttribute("data-i"))];
    quizRows.push({ el: b, at: (r && Number(r.reveal)) || 0 });
  });
  curRow = -1;
}

/* 0교시: covered until the answer plays, covered again on a seek back before it */
let quizRows = [];
function quizReveal(ms){
  for (const q of quizRows){
    const on = ms >= q.at;
    if (q.el.classList.contains("shown") !== on) q.el.classList.toggle("shown", on);
  }
}

function highlight(i){
  if (i === curRow) return;
  const body = $("lBody");
  const prev = body.querySelector(".L-row.on");
  if (prev) prev.classList.remove("on");
  const now = body.querySelector('.L-row[data-i="' + i + '"]');
  if (now){
    now.classList.add("on");
    centerRow(body, now);
  }
  curRow = i;
}

/* Keep the playing line in the middle of the part of the script you can see.
   The old version used offsetTop, which counts from the dialog — so it carried
   the title and the player bar above the script, and every scroll put the line
   right under the bar instead of where the eye is. Measured against the
   script box itself, the box already excludes the bar above and the question
   panel below. Inside the middle band nothing moves, so a run of short lines
   does not make the page twitch. */
const CENTER_BAND = 0.18;          // +/- around the middle that counts as centred
function centerRow(body, el){
  const box = body.getBoundingClientRect(), r = el.getBoundingClientRect();
  const view = body.clientHeight;
  if (!view) return;
  const top = r.top - box.top;
  let target;
  if (r.height > view * 0.7){
    target = body.scrollTop + top - 12;      // too tall to centre: show its start
  } else {
    const mid = top + r.height / 2;
    if (Math.abs(mid - view / 2) <= view * CENTER_BAND) return;
    target = body.scrollTop + mid - view / 2;
  }
  body.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

function renderTransport(){
  const l = current.lesson;
  const isDev = current.engine === "device";
  /* the elements onTick paints are about to be replaced, so what it last
     painted onto the old ones no longer says anything about the new ones */
  resetTickCache();
  $("lCtl").innerHTML =
    '<div class="L-bar" id="lBar"><i></i></div>' +
    '<div class="L-time"><span id="lAt">0:00</span><span>' + fmtClock(l.totalMs) + "</span></div>" +
    '<div class="L-btns">' +
      '<button class="L-b" id="lBack" type="button">' + (isDev ? "&#9664; 줄" : "&minus;10초") + "</button>" +
      '<button class="L-b big" id="lPlay" type="button">&#9654;</button>' +
      '<button class="L-b" id="lFwd" type="button">' + (isDev ? "줄 &#9654;" : "+10초") + "</button>" +
      '<button class="L-b" id="lSpeed" type="button">1&times;</button>' +
      '<button class="L-b' + (lessonLoop ? " on" : "") + '" id="lLoop" type="button" ' +
        'aria-label="무한 반복" aria-pressed="' + lessonLoop + '">&#128257;</button>' +
    "</div>" +
    (isDev ? '<div class="L-warn">기기 음성으로 읽습니다. 화면을 끄거나 다른 앱으로 넘어가면 멈춥니다. ' +
             "차 블루투스에서는 줄마다 소리가 끊겼다 이어져 앞부분이 잘리거나 안 나올 수 있습니다 — " +
             "차에서는 고품질 음성(mp3)으로 들으십시오. " +
             (lset.ttsKey ? "아래 «🎵 고품질 음성으로 바꾸기» 를 누르면 대본은 그대로 두고 음성만 만듭니다."
                          : "설정에서 Cloud TTS 키를 넣으십시오.") + "</div>" : "");

  $("lPlay").onclick = () => { if (player) player.toggle(); };
  $("lBack").onclick = () => { if (player) player.step(-1); };
  $("lFwd").onclick  = () => { if (player) player.step(1); };
  $("lSpeed").onclick = () => {
    if (!player) return;
    const next = SPEED_STEPS[(SPEED_STEPS.indexOf(player.speedNow()) + 1) % SPEED_STEPS.length];
    player.speed(next);
    $("lSpeed").innerHTML = next + "&times;";
  };
  $("lLoop").onclick = () => {
    lessonLoop = !lessonLoop;
    jset(LESSON_LOOP_KEY, lessonLoop);
    if (player && player.loop) player.loop(lessonLoop);
    $("lLoop").classList.toggle("on", lessonLoop);
    $("lLoop").setAttribute("aria-pressed", String(lessonLoop));
  };
  $("lBar").onclick = (ev) => {
    if (!player) return;
    const box = $("lBar").getBoundingClientRect();
    player.seek(Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * l.totalMs);
  };
}

function sizeLabel(bytes){
  const kb = Math.round(bytes / 1024);
  return kb > 1024 ? (kb / 1024).toFixed(1) + "MB" : kb + "KB";
}

function renderFoot(){
  const l = current.lesson;
  const isToday = current.date === todayKey();
  $("lFoot").innerHTML =
    '<button class="mini" id="lExport" type="button">📄 파일로 저장</button>' +
    '<button class="mini" id="lPastBtn" type="button">🗂 지난 수업</button>' +
    (isToday ? '<button class="mini" id="lRedo" type="button">↻ 다시 만들기</button>' : "") +
    '<span class="L-meta" id="lMeta"></span>';
  $("lExport").onclick = exportLesson;
  $("lPastBtn").onclick = showPast;
  if (!current.blob && lset.ttsKey){
    const b = document.createElement("button");
    b.className = "mini";
    b.id = "lToMp3";
    b.type = "button";
    b.textContent = "🎵 고품질 음성으로 바꾸기";
    b.onclick = () => { lessonToMp3().catch((e) => lessonNotice((e && e.message) || String(e))); };
    $("lFoot").insertBefore(b, $("lFoot").firstChild);
  }
  if (isToday) $("lRedo").onclick = () => {
    const warn = "오늘 수업을 새로 만듭니다.\n대화가 더 쌓였거나 음성 설정을 바꿨을 때 쓰십시오.\n\n" +
      (current.blob ? "지금 저장된 오디오는 지워지고 되돌릴 수 없습니다.\n" : "") +
      "만들 때마다 요금이 듭니다. 계속할까요?";
    if (!confirm(warn)) return;
    stopPlayer();
    openLesson(true).catch((e) => lessonNotice((e && e.message) || String(e)));
  };
  $("lMeta").textContent =
    (l.counts.newWords ? "새 단어 누적 " + l.counts.learned + "개 · " : "") +
    (l.counts.grammarAt ? "문법 진도 " + circNum(l.counts.grammarAt) + "/" + l.counts.grammarOf + " · " : "") +
    (l.counts.review ? "복습 " + l.counts.review + " · " : "") +
    lessonCountsText(l.counts) +
    (current.blob ? " · " + sizeLabel(current.blob.size) : "") +
    (lset.chars && lset.chars.ym === monthNow() && lset.chars.n
      ? " · 이번 달 음성 " + lset.chars.n.toLocaleString("ko-KR") + "자" : "");
}

/* Last values painted, so a tick that changes nothing costs nothing. onTick
   runs on every animation frame now (~60Hz): re-parsing the play button's
   innerHTML, re-setting the same width string and re-assigning
   mediaSession.playbackState sixty times a second is all wasted work on a
   phone. Reset by renderTransport, which rebuilds these elements. */
let tickClock = null, tickPct = null, tickPlaying = null;
function resetTickCache(){ tickClock = null; tickPct = null; tickPlaying = null; }

function onTick(ms, playing){
  if (!current) return;
  highlight(rowAt(current.lesson.rows, ms));
  quizReveal(ms);
  lessonPosNote(ms, playing);

  const clock = fmtClock(ms);
  if (clock !== tickClock){
    const at = $("lAt");
    if (at) at.textContent = clock;
    tickClock = clock;
  }

  /* a tenth of a percent is below one pixel on any real bar */
  const pct = Math.round(
    Math.min(100, current.lesson.totalMs ? (ms / current.lesson.totalMs) * 100 : 0) * 10) / 10;
  if (pct !== tickPct){
    const bar = $("lBar");
    if (bar && bar.firstChild) bar.firstChild.style.width = pct + "%";
    tickPct = pct;
  }

  if (playing !== tickPlaying){
    const p = $("lPlay");
    if (p) p.innerHTML = playing ? "&#10073;&#10073;" : "&#9654;";
    if ("mediaSession" in navigator){
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) {}
    }
    tickPlaying = playing;
  }
}

function wireMediaSession(){
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.lesson.dateLabel + " 스페인어 수업",
      artist: "통역기",
      album: "오늘의 오디오 수업",
      artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }]
    });
  } catch (e) {}
  const set = (k, fn) => { try { navigator.mediaSession.setActionHandler(k, fn); } catch (e) {} };
  set("play", () => { if (player) player.play(); });
  set("pause", () => { if (player) player.pause(); });
  set("stop", () => { if (player) player.pause(); });
  set("seekbackward", () => { if (player) player.nudge(-10); });
  set("seekforward", () => { if (player) player.nudge(10); });
  set("previoustrack", () => { if (player) player.step(-1); });
  set("nexttrack", () => { if (player) player.step(1); });
}

/* The lesson screen is a full-height modal, so showError and setStatus — which
   write the page behind it — are invisible on a phone. Anything the user has
   to read while the lesson is open goes here instead. */
function lessonNotice(note){
  const box = $("lNotice");
  if (!box) return;
  /* a plain string, or { text, detail } where detail is raw technical text
     folded under «자세히». Everything goes in as textContent: error text from
     a server is never parsed as HTML. */
  const text = note && typeof note === "object" ? String(note.text || "") : String(note || "");
  const detail = note && typeof note === "object" ? String(note.detail || "") : "";
  box.textContent = "";
  box.style.display = text ? "block" : "none";
  if (!text) return;

  const x = document.createElement("button");
  x.type = "button";
  x.className = "L-notice-x";
  x.setAttribute("aria-label", "닫기");
  x.textContent = "✕";
  x.onclick = () => { box.style.display = "none"; };
  box.appendChild(x);

  const msg = document.createElement("div");
  msg.textContent = text;
  box.appendChild(msg);

  if (detail){
    const d = document.createElement("details");
    d.className = "L-notice-more";
    const s = document.createElement("summary");
    s.textContent = "자세히";
    const pre = document.createElement("div");
    pre.textContent = detail;
    d.appendChild(s);
    d.appendChild(pre);
    box.appendChild(d);
  }
}

/* NO_ES_VOICE is about the device, which does not change from one lesson to
   the next: once a study day is enough. */
const NO_ES_VOICE_DAY_KEY = "interp.noEsVoiceDay";
function noEsVoiceOnce(){
  let last = "";
  try { last = localStorage.getItem(NO_ES_VOICE_DAY_KEY) || ""; } catch (e) {}
  const today = todayKey();
  if (last === today) return "";
  try { localStorage.setItem(NO_ES_VOICE_DAY_KEY, today); } catch (e) {}
  return NO_ES_VOICE;
}

function mountLesson(rec, notice, opts){
  stopPlayer();
  lessonPosArmed = false;
  lessonPosSec = -1;
  current = { lesson: rec.lesson, blob: rec.mp3 || null, engine: rec.engine, date: rec.date,
              /* the record's own identity, not just its date: 다시 만들기 keeps the
                 date and replaces the record, so a save aimed at the old record
                 must be able to notice that it is gone */
              createdAt: rec.createdAt || "",
              qa: Array.isArray(rec.qa) ? rec.qa : [] };
  /* a new lesson means a new conversation: nothing half-asked carries over, and
     the cached answer audio belonged to the old lesson's turn numbers. The epoch
     moves too, so a question still in flight from the previous mount cannot file
     its answer against this one. */
  askEpoch++;
  askPending = null;
  askConverting = false;
  askAudioCache.clear();
  askShow(true);
  askLock("idle");
  askRender();
  $("lTitle").textContent = rec.lesson.dateLabel + " 수업";
  renderTransport();
  lessonNotice(notice);
  renderScript(rec.lesson);
  renderFoot();
  player = current.blob
    ? audioPlayer(current.lesson, current.blob, onTick)
    : devicePlayer(current.lesson, onTick);
  wireMediaSession();
  onTick(0, false);

  /* 📚 and the past list pick up where this lesson was last left */
  const resumeAt = opts && opts.resume ? lessonPosGet(current) : 0;
  if (resumeAt > 0){
    player.seek(resumeAt);
    if (!notice) lessonNotice("지난번에 멈춘 곳(" + fmtClock(resumeAt) + ")부터 이어 듣습니다.");
    const mine = current;
    const top = document.createElement("button");
    top.className = "mini";
    top.id = "lFromTop";
    top.type = "button";
    top.textContent = "⏮ 처음부터 듣기";
    top.onclick = () => {
      if (current !== mine) return;
      if (player) player.seek(0);
      lessonPosPut(mine, 0);
      lessonNotice("");
      top.remove();
    };
    $("lFoot").insertBefore(top, $("lFoot").firstChild);
  }

  /* A saved device-mode lesson reopened on a phone with no Spanish voice would
     otherwise just sound wrong with nothing said about it. Checked after the
     mount because Chrome hands back an empty voice list on the first call. */
  if (!current.blob && !notice){
    const mine = current;
    devVoicesReady().then((list) => {
      if (current === mine && list.length && !devPickVoice("es", list)){
        const n = noEsVoiceOnce();
        if (n) lessonNotice(n);
      }
    }).catch(() => {});
  }
}

function lessonMessage(title, sub, extraHtml){
  $("lCtl").innerHTML = "";
  resetTickCache();                 // the transport this cache described is gone
  askShow(false);                   // nothing to ask about on a busy/error screen
  lessonNotice("");
  $("lBody").innerHTML = '<div class="L-busy"><div class="L-busy-t">' + esc(title) + "</div>" +
    '<div class="L-busy-s">' + esc(sub || "") + "</div>" + (extraHtml || "") + "</div>";
}
function lessonBusySub(sub){
  const n = $("lBody").querySelector(".L-busy-s");
  if (n) n.textContent = sub;
}

/* ---------------- asking the lesson a question ----------------

   A tutor, not a translator. "아까 mételo 는 왜 붙여 쓰는 거야?" only means
   something next to the lesson it was asked about, so every question carries
   the whole lesson, the line that was playing and the last few turns — and the
   model is told to resolve 아까 그거 / 이 문장 itself rather than ask back. */

const ASK_PROMPT = [
  "You are a patient Spanish tutor for a Korean beginner living in Mexico. They are",
  "listening to today's audio lesson, have stopped it, and are asking you something.",
  "",
  "You are NOT a translator. Do not translate the question — answer it.",
  "",
  "You are given ONE JSON object:",
  "  question — what they asked. If it says the question is in the attached audio,",
  "             listen to the audio: that is the question. They speak Korean and may",
  "             drop Spanish words into it.",
  "  spoken   — true when question is an automatic speech-to-text transcript: a Spanish",
  "             word in it may be misheard as Korean that sounds alike; read it that way.",
  "  lesson   — every line of today's lesson: part (교시), es, ko, and for a grammar",
  "             note grammar:true. This is the material they are studying.",
  "  playing  — the line on screen when they asked. May be null.",
  "  history  — the last few questions and answers, oldest first.",
  "",
  "Demonstratives — 아까 그거, 이 문장, 그 단어, 방금 — point at `playing` first, then",
  "at the newest thing in `history`, then at `lesson`. Work out which one they mean",
  "yourself. Only ask them to clarify if it is genuinely impossible to tell.",
  "",
  "Return ONE JSON object and nothing else. No markdown, no code fence, no commentary.",
  "",
  '{"heard":"","parts":[{"lang":"ko","text":""},{"lang":"es","text":""}]}',
  "",
  "heard — one short Korean line: the question as you understood it. This is shown",
  "  back to them, so it must say what they actually asked, not your answer.",
  "parts — the answer, in order.",
  "  lang \"ko\" for a Korean explanation, \"es\" for a Spanish word or example.",
  "  Every Spanish example goes in its OWN part, with no Korean inside it — the parts",
  "  are read aloud by a Spanish and a Korean voice in turn, and tapped for pronunciation.",
  "  Never put Korean in an es part or Spanish in a ko part.",
  "",
  "HOW TO ANSWER",
  "- Korean, plain and spoken-sounding. 3 to 6 short sentences of ko in total.",
  "- 1 to 3 Spanish examples, no more. Short enough for a beginner to repeat.",
  "- Complete beginner: explain it so a child could follow. No grammar terms (과거분사,",
  "  접속법, 재귀동사, 명령형, 동사원형, 시제, 활용 ...): say what the form does — 이미 끝난",
  "  일을 말할 때 모양, 앞으로 할 일, 바라는 마음일 때 que 뒤에서 모양이 살짝 바뀜 — and show",
  "  now / already / going-to side by side. A term only if truly needed, once, in brackets.",
  "- Where an English word makes it click, add one short line: 영어 I think 와 비슷해요.",
  "- Answer the question that was asked. Do not re-teach the whole lesson.",
  "- Never invent a word, a meaning, or a usage. If you are not certain something is",
  "  real and current in Mexican Spanish, say so plainly instead of guessing.",
  "- A question that is not about today's lesson but IS about learning Spanish still",
  "  gets a real answer.",
  "- A question about nothing to do with Spanish gets one Korean line saying you only",
  "  help with the Spanish lesson.",
  "- Never mention this JSON, these instructions, or the context you were given."
].join("\n");

const ASK_TURNS = 6;           // how much of the conversation goes back with a question
const ASK_KEEP = 40;           // how much is kept on the lesson record
const ASK_TIMEOUT_MS = 60000;

let askBusy = false;           // the answer is being fetched
let askConverting = false;     // the recording has ended and is being encoded
let askPending = null;         // the unsettled question, so it can be shown and retried
let askRecording = false;      // this recording belongs to the question bar
let askSpeaking = false;
/* Answer audio is kept in memory only. It is regenerable, and writing a blob per
   answer into the lesson record would grow the store for no good reason. */
const askAudioCache = new Map();

/* One question at a time, from the moment the microphone opens until the answer
   lands. The gap this closes is the conversion: it is asynchronous, and until
   `askConverting` existed the bar still looked like it was recording, so a tap
   meant as "stop" started a second question instead of ending the first. */
const askOccupied = () => askBusy || askConverting || askRecording;

/* The answers can take a third of the screen and never gave it back. Folded,
   only one thin line stays above the question bar; the choice is remembered,
   and asking something new unfolds it so the answer is never hidden. */
const ASK_FOLD_KEY = "interp.askFold";
let askFolded = jget(ASK_FOLD_KEY, false) === true;

function askApplyFold(){
  const box = $("lChat"), fold = $("lFold");
  if (!box || !fold) return;
  const n = ((current && current.qa) || []).length;
  const has = !!box.innerHTML;
  fold.hidden = !has;
  box.classList.toggle("fold", askFolded);
  fold.textContent = "💬 질문 " + n + "개 · " + (askFolded ? "펼치기 ▴" : "접기 ▾");
  fold.setAttribute("aria-expanded", askFolded ? "false" : "true");
}

function askSetFold(on){
  askFolded = !!on;
  jset(ASK_FOLD_KEY, askFolded);
  askApplyFold();
  if (!askFolded){
    const box = $("lChat");
    if (box) box.scrollTop = box.scrollHeight;
  }
}

/* Which lesson screen a question was asked from. A question is only ever
   delivered back to the same one: the screen must still be open, showing the
   same lesson record, and not have been re-mounted since. Everything else about
   in-flight questions is a race waiting to be found — this is the one check that
   makes a late or orphaned answer harmless whatever the race was. */
let askEpoch = 0;
function lessonAskTag(){
  const dlg = $("lesson");
  return {
    epoch: askEpoch,
    date: current ? current.date : null,
    /* the record's createdAt, which a regenerated lesson changes even though its
       date stays the same */
    createdAt: current ? (current.createdAt || "") : "",
    open: !!(dlg && dlg.open)
  };
}
function askTagValid(tag){
  if (!tag) return false;
  const dlg = $("lesson");
  if (!dlg || !dlg.open) return false;          // the screen was closed
  if (!current) return false;
  if (tag.date !== current.date) return false;  // a different lesson
  if ((tag.createdAt || "") !== (current.createdAt || "")) return false;  // re-made
  return tag.epoch === askEpoch;
}

/* The lesson, compacted. Built from rows rather than from the original content
   because rows are what the record actually stores — so this works for lessons
   that were saved before this feature existed. */
function askLessonJson(){
  const l = current && current.lesson;
  if (!l || !Array.isArray(l.rows)) return null;
  const seen = new Set();
  const items = [];
  for (const r of l.rows){
    /* the review is 1교시 and 4교시 again, and lead/intro/outro lines are narration — neither
       tells the model anything it does not already have */
    if (r.sectionId === "review" || r.sectionId === "intro" || r.sectionId === "outro" || r.sectionId === "recap") continue;
    if (r.kind === "lead") continue;
    const es = r.es || "", ko = r.ko || "";
    const table = Array.isArray(r.table)
      ? r.table.map((c) => (c.who ? c.who + ": " : "") + c.es + " = " + c.ko) : null;
    if (!es && !ko && !r.en && !table) continue;
    const key = r.sectionId + "|" + es + "|" + ko + "|" + (r.en || "") + "|" + (table ? table.join(";") : "");
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { part: r.sectionTitle };
    if (es) item.es = es;
    if (ko) item.ko = ko;
    if (r.from) item.from = r.from;
    if (r.en) item.english = r.en;
    if (table) item.table = table;
    if (r.kind === "note") item.grammar = true;
    items.push(item);
  }
  return { date: l.dateLabel, items: items };
}

/* Whatever was under the highlight when they asked. This is what makes "이 문장"
   resolvable, so it is read from the player's real position, not from the last
   row that happened to be painted. */
function askPlayingJson(){
  const l = current && current.lesson;
  const rows = (l && l.rows) || [];
  if (!rows.length) return null;
  let at = 0;
  try { if (player && player.at) at = player.at(); } catch (e) {}
  const r = rows[rowAt(rows, at)];
  if (!r) return null;
  const out = { part: r.sectionTitle };
  if (r.es) out.es = r.es;
  if (r.ko) out.ko = r.ko;
  if (r.en) out.english = r.en;
  if (Array.isArray(r.table)) out.table = r.table.map((c) => (c.who ? c.who + ": " : "") + c.es + " = " + c.ko);
  return out;
}

function askHistoryJson(){
  const qa = (current && current.qa) || [];
  return qa.slice(-ASK_TURNS)
    .filter((t) => t && t.q && Array.isArray(t.parts))
    .map((t) => ({ q: t.q, a: t.parts.map((p) => p.text).join(" ") }));
}

function askContextJson(pending){
  return JSON.stringify({
    /* a spoken question is either the audio itself (Gemini) or what the
       browser's speech recognition wrote down (Claude) */
    question: pending.via === "voice" && (pending.audio || !pending.q) ? "(in the attached audio)" : pending.q,
    spoken: pending.via === "voice" && !pending.audio && pending.q ? true : undefined,
    lesson: askLessonJson(),
    playing: pending.playing || null,
    history: askHistoryJson()
  });
}

/* A reply that is not the JSON we asked for is still an answer. Showing it as
   one Korean bubble beats throwing away something already paid for — only a
   genuinely empty reply is an error. */
function askParse(text){
  let raw = null;
  try { raw = lessonExtractJson(text); } catch (e) {}

  if (raw && Array.isArray(raw.parts)){
    const parts = [];
    for (const p of raw.parts){
      const t = cleanStr(p && p.text);
      if (!t) continue;
      parts.push({ lang: (p && p.lang) === "es" ? "es" : "ko", text: t });
    }
    if (parts.length) return { heard: cleanStr(raw.heard), parts: parts };
  }

  const plain = cleanStr(String(text || "")
    .replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, ""));
  if (plain) return { heard: "", parts: [{ lang: "ko", text: plain }] };
  throw new Error("답변이 비어 있습니다.");
}

/* ---- the question bar ---- */

/* "idle" | "rec" | "think" */
function askLock(state){
  const q = $("lQ"), mic = $("lQMic"), send = $("lQSend");
  /* words the speech recognition showed while listening are not left in the box */
  if (q && state === "idle" && q.dataset && q.dataset.stt){ q.value = ""; delete q.dataset.stt; }
  if (q) q.disabled = state !== "idle";
  if (send) send.disabled = state !== "idle";
  if (mic){
    mic.disabled = state === "think";
    mic.classList.toggle("rec", state === "rec");
    /* "think" gets its own face rather than a greyed-out microphone: the whole
       reason a stray tap used to start a second question is that this button
       still looked like a live microphone once the recording had ended */
    mic.textContent = state === "rec" ? "■" : (state === "think" ? "…" : "🎤");
  }
}

function askShow(on){
  const ask = $("lAsk");
  if (ask) ask.hidden = !on;
  if (!on){
    const box = $("lChat");
    if (box) box.innerHTML = "";
  }
  askApplyFold();
}

function askBubble(cls, inner){
  return '<div class="Q-turn ' + cls + '"><div class="Q-bub">' + inner + "</div></div>";
}

function askAnswerHtml(parts, idx){
  let inner = "";
  for (const p of parts){
    inner += p.lang === "es"
      ? '<span class="Q-es" data-say="' + esc(p.text) + '">' + esc(p.text) + "</span>"
      : '<div class="Q-ko">' + esc(p.text) + "</div>";
  }
  inner += '<div class="Q-tools"><button class="Q-say" data-i="' + idx +
           '" type="button">&#128266; 읽어주기</button></div>';
  return askBubble("", inner);
}

function askRender(){
  const box = $("lChat");
  if (!box) return;
  const qa = (current && current.qa) || [];
  let html = "";
  for (let i = 0; i < qa.length; i++){
    const t = qa[i];
    if (!t || !Array.isArray(t.parts)) continue;
    html += askBubble("me", '<div class="Q-ko">' + esc(t.q || "") + "</div>");
    html += askAnswerHtml(t.parts, i);
  }
  if (askPending){
    html += askBubble("me", '<div class="Q-ko">' +
      esc(askPending.via === "voice" && !askPending.q ? "🎤 음성 질문" : askPending.q) + "</div>");
    html += askPending.err
      ? askBubble("err", '<div class="Q-ko">' + esc(askPending.err) + "</div>" +
          (askPending.canRetry
            ? '<div class="Q-tools"><button class="Q-retry" id="lQRetry" type="button">다시 시도</button></div>'
            : ""))
      : askBubble("", '<div class="Q-wait">생각 중…</div>');
  }
  box.innerHTML = html;

  box.querySelectorAll(".Q-es").forEach((n) => {
    n.onclick = () => askSpeakEs(n.getAttribute("data-say"));
  });
  box.querySelectorAll(".Q-say").forEach((b) => {
    b.onclick = () => { askSpeak(Number(b.getAttribute("data-i")), b); };
  });
  const retry = $("lQRetry");
  if (retry) retry.onclick = () => {
    const again = askPending;
    if (!again) return;
    askPending = null;
    askAsk(again);
  };

  box.scrollTop = box.scrollHeight;
  askApplyFold();
}

/* ---- speaking an answer ---- */

function askSpeakEs(text){
  if (!text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = devPickVoice("es", devVoiceList());
    u.lang = "es-MX";
    if (v){ u.voice = v; u.lang = v.lang || u.lang; }
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

/* The device engine queues utterances, so pushing them in order is all that is
   needed to alternate the two voices. */
function askSpeakDevice(parts){
  try {
    window.speechSynthesis.cancel();
    const list = devVoiceList();
    const es = devPickVoice("es", list), ko = devPickVoice("ko", list);
    for (const p of parts){
      const u = new SpeechSynthesisUtterance(p.text);
      const v = p.lang === "es" ? es : ko;
      u.lang = p.lang === "es" ? "es-MX" : "ko-KR";
      if (v){ u.voice = v; u.lang = v.lang || u.lang; }
      window.speechSynthesis.speak(u);
    }
  } catch (e) {}
}

/* One mp3 for the whole answer, the two voices alternating by part — the same
   encoder and the same voices the lesson itself uses. Falls back to the device
   voices rather than failing: hearing it in a worse voice beats not hearing it. */
async function askSpeak(i, btn){
  const t = current && current.qa && current.qa[i];
  if (!t || !Array.isArray(t.parts) || askSpeaking) return;

  if (!(lset.engine === "cloud" && lset.ttsKey)){ askSpeakDevice(t.parts); return; }

  /* The screen this answer belongs to. Synthesising it is several requests, and
     the cache is keyed by turn number only — so a lesson opened in the meantime
     would be handed THIS lesson's audio filed under its own turn numbers, and
     would hear it start playing over the top. */
  const tag = lessonAskTag();
  askSpeaking = true;
  const label = btn ? btn.innerHTML : "";
  if (btn){ btn.disabled = true; btn.textContent = "만드는 중…"; }
  try {
    let blob = askAudioCache.get(i);
    if (!blob){
      const lame = await loadLame();
      await ttsEnsureVoices();
      const sr = TTS_SR;
      const out = mp3Writer(lame, sr);
      const gap = new Int16Array(Math.round(sr * 0.35));
      for (let k = 0; k < t.parts.length; k++){
        const p = t.parts[k];
        const got = await ttsSay(p.text, p.lang === "es" ? "es" : "ko", 1);
        addTtsChars(p.text.length);
        out.write(got.sr === sr ? got.pcm : resample(got.pcm, got.sr, sr));
        if (k < t.parts.length - 1) out.write(gap);
      }
      blob = out.finish();
      if (!askTagValid(tag)) return;          // a different lesson is on screen now
      askAudioCache.set(i, blob);
    }
    if (!askTagValid(tag)) return;
    previewPlay(blob);
  } catch (e) {
    if (askTagValid(tag)) askSpeakDevice(t.parts);
  } finally {
    askSpeaking = false;
    if (btn){ btn.disabled = false; btn.innerHTML = label || "&#128266; 읽어주기"; }
  }
}

/* ---- storage ---- */

/* Only the settled turns, and never the audio. The record is read back and put
   whole so nothing else on it is disturbed.

   Both WHAT to write and WHERE to write it are taken at call time and never
   re-read from `current` afterwards. Reading the global after the await was the
   bug: the lookup for lesson A could still be in flight when the user opened
   lesson B, and the write then put B's questions onto A's record. The turns are
   copied, the record is fetched by the tag's own date, and the read and the write
   share one transaction so nothing can be squeezed between them — a lesson
   re-made in the meantime is a different record, and stale history must not land
   on it. */
async function qaPersist(turns, tag){
  if (!tag || !tag.date || !Array.isArray(turns)) return;
  /* copied per turn, so later edits to current.qa cannot reach a write that is
     already on its way */
  /* The screen check reads the DOM and module state, so it belongs outside the
     transaction and is done once, here. */
  if (!askTagValid(tag)) return;
  const snap = turns.map((t) => ({ q: t.q, via: t.via, parts: t.parts, at: t.at }));
  /* an automatic update must not reload between the answer appearing and the
     answer being saved */
  beginSave();
  try {
    const db = await openDb();
    try {
      /* ONE readwrite transaction for the read AND the write. Two transactions
         left a gap wide enough for another tab to put a new record for this date
         into, and this whole-record put would then overwrite that new lesson with
         the old one plus an answer. IndexedDB serialises overlapping readwrite
         transactions on the same store, so nothing can land in between.

         The only await between the get and the put is the get's own request:
         awaiting anything else here would let the transaction go inactive and
         commit early. */
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      const rec = await rq2p(store.get(tag.date));
      if (!rec) return;
      /* the record must still be the one this answer belongs to; createdAt is
         stamped once per record, so a mismatch means it was replaced */
      if ((rec.createdAt || "") !== (tag.createdAt || "")) return;
      rec.qa = snap;
      await rq2p(store.put(rec));
    } finally { db.close(); }
  } catch (e) {
    /* the answer is already on screen; losing only its history is not worth
       interrupting the lesson for */
  } finally { endSave(); }
}

/* ---- asking ---- */

async function askAsk(pending){
  if (askBusy) return;                       // two taps, one question
  if (!current){ return; }
  /* a typed question can go to Claude alone; a spoken one needs Gemini */
  const canAsk = settings.apiKey || (settings.claudeKey && !(pending && pending.audio));
  if (!canAsk){ closeDlg($("lesson")); openSettings(); return; }

  /* the screen this answer belongs to, so a reply that lands after the user has
     closed the lesson or moved to another one is dropped instead of being filed
     against whatever happens to be on screen by then */
  const tag = lessonAskTag();

  askBusy = true;
  askLock("think");
  /* a new question is never asked into a folded panel */
  if (askFolded) askSetFold(false);
  /* they stopped to ask about something — the lesson must not keep talking
     over the answer */
  if (player){ try { player.pause(); } catch (e) {} }

  /* the playing line is captured HERE, before the pause and the round trip can
     move it, so "이 문장" means the line they were actually on */
  askPending = Object.assign({ err: "", canRetry: true }, pending);
  if (!askPending.playing) askPending.playing = askPlayingJson();
  askRender();

  try {
    const input = askPending.audio
      ? [{ type: "text", text: askContextJson(askPending) },
         { type: "audio", data: askPending.audio.data, mime_type: askPending.audio.mime }]
      : [{ type: "text", text: askContextJson(askPending) }];

    /* read now: askPending can be cleared while the answer is on its way */
    const audioMs = askPending.audio ? askPending.audio.ms : 0;
    const gemini = () => callPlain(ASK_PROMPT, input, { temperature: 0.35, thinking_level: "low" }, audioMs);
    /* a typed question goes to Claude when there is a Claude key; a spoken one
       always to Gemini, which is the one that can hear */
    const claudeTurn = !askPending.audio && !!settings.claudeKey;
    const limitMs = ASK_TIMEOUT_MS + (claudeTurn ? CLAUDE_ASK_TIMEOUT_MS : 0);
    const reply = await Promise.race([
      claudeTurn
        ? viaClaude(ASK_PROMPT, input[0].text, gemini, {
            maxTokens: CLAUDE_ASK_MAX_TOKENS, effort: "low", timeoutMs: CLAUDE_ASK_TIMEOUT_MS,
            /* the answer format is one JSON object; a reply without one is
               a failure Gemini should redo, not prose to show as is */
            validate: (t) => {
              const j = lessonExtractJson(t);
              if (!j || typeof j !== "object" || !Array.isArray(j.parts)) throw new Error("답 형식이 올바르지 않습니다.");
            },
            onFallback: (note) => { try { lessonNotice(note); } catch (e) {} }
          })
        : gemini(),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("답이 " + (limitMs / 1000) + "초 안에 오지 않았습니다.")),
        limitMs))
    ]);

    /* the answer arrived, but the screen may have moved on while it was coming */
    if (!askTagValid(tag)){ askPending = null; return; }

    const got = askParse(reply);
    const shown = askPending.via === "voice"
      ? (askPending.q ? "🎤 " + askPending.q : (got.heard || "🎤 음성 질문"))
      : askPending.q;

    if (!current.qa) current.qa = [];
    current.qa.push({ q: shown, via: askPending.via, parts: got.parts,
                      at: new Date().toISOString() });
    if (current.qa.length > ASK_KEEP) current.qa = current.qa.slice(-ASK_KEEP);
    askPending = null;
    askRender();
    /* handed the array and the target as they are right now — qaPersist must not
       look at `current` again once its first await has yielded */
    qaPersist(current.qa, tag);
  } catch (e) {
    /* an error painted onto a screen the user has left is noise, not news */
    if (askPending && askTagValid(tag)){
      askPending.err = (e && e.message) ? String(e.message) : String(e);
      askRender();
    } else {
      askPending = null;
    }
  } finally {
    askBusy = false;
    askConverting = false;
    askLock("idle");
  }
}

function askSend(){
  const q = $("lQ");
  if (!q || askOccupied()) return;
  const text = q.value.trim();
  if (!text) return;
  q.value = "";
  askAsk({ q: text, via: "text" });
}

/* No Gemini key, so nothing can hear a spoken question. With only a Claude key
   that is said in the panel, instead of opening a settings screen that looks
   as if nothing were set up. */
/* a spoken question can be heard by Gemini, or written down by the browser's
   speech recognition for Claude (useStt in app.js) */
function canHearAsk(){ return !!settings.apiKey || useStt(); }
function askNoVoiceKey(){
  if (settings.claudeKey){
    askVoiceError("이 브라우저는 받아쓰기(음성 인식)를 지원하지 않아 음성 질문은 Gemini 키가 필요합니다. 글로 물어보시거나 설정에서 Gemini 키를 넣으십시오.",
                  lessonAskTag());
    return;
  }
  closeDlg($("lesson")); openSettings();
}

/* Borrows the interpreter's recorder: same auto-stop, same encoding, and only
   the destination differs. The destination is handed to startRecording so that
   it belongs to that one recording session (see recSession in app.js). */
async function askMic(){
  if (recording){
    /* a second tap ends OUR recording; a translation that was already running
       when the lesson opened is none of this button's business */
    if (askRecording){ askLock("think"); stopRecording(); }
    return;
  }
  if (askOccupied()) return;
  if (busy) return;
  if (!canHearAsk()){ askNoVoiceKey(); return; }
  if (player){ try { player.pause(); } catch (e) {} }

  askRecording = true;
  askLock("rec");
  await startRecording("ask");
  if (!recording){                      // the microphone never opened
    askRecording = false;
    askLock("idle");
  }
}

/* Making a lesson REPLACES the record the screen is showing, so it counts as a
   lesson change even though the date and the open dialog stay the same. Every
   question in flight belongs to the lesson about to be replaced: its answer must
   reach neither the screen nor the store. Moving the epoch here is what makes the
   existing gate refuse a late answer, instead of it landing on — and reverting —
   the lesson that was just built. */
function askAbandonForNewLesson(){
  discardAskRecording();
  askEpoch++;
  askRecording = false;
  askConverting = false;
  askPending = null;
  askLock("idle");
}

/* the recording ended; encoding it is asynchronous, so the bar stops looking
   like a microphone and starts refusing new questions from here */
function lessonAskConverting(){
  askRecording = false;
  askConverting = true;
  askLock("think");
}

/* called from app.js when a recording aimed at the question bar finishes */
async function lessonAskAudio(b64, mime, ms, tag){
  askRecording = false;
  askConverting = false;
  /* The screen this was asked from may be gone — closed, or showing a different
     lesson. Sending anyway would bill for an answer nobody can see. This is the
     gate that makes the whole class of in-flight races harmless. */
  if (!askTagValid(tag)){ askLock("idle"); return; }
  await askAsk({ q: "", via: "voice", audio: { data: b64, mime: mime, ms: ms } });
}
/* Claude first: the question arrives as the words the browser's speech
   recognition wrote down, through the same screen gate as a recording */
async function lessonAskText(text, tag){
  askRecording = false;
  askConverting = false;
  const q = $("lQ");
  if (q && q.dataset && q.dataset.stt){ q.value = ""; delete q.dataset.stt; }
  if (!askTagValid(tag)){ askLock("idle"); return; }
  await askAsk({ q: String(text || "").trim(), via: "voice" });
}
/* while listening, what has been heard so far shows in the question box */
function lessonAskPreview(text){
  const q = $("lQ");
  if (!q) return;
  if (!text){
    if (q.dataset && q.dataset.stt){ q.value = ""; delete q.dataset.stt; }
    return;
  }
  q.value = text;
  if (q.dataset) q.dataset.stt = "1";
}
function askVoiceError(msg, tag){
  askRecording = false;
  askConverting = false;
  if (!askTagValid(tag)){ askLock("idle"); return; }
  askPending = { q: "🎤 음성 질문", via: "voice", canRetry: false, err: msg };
  if (askFolded) askSetFold(false);
  askRender();
  askLock("idle");
}
function lessonAskTooShort(tag){ askVoiceError("너무 짧습니다 — 다시 말해 주십시오.", tag); }
/* the recording could not be turned into something sendable */
function lessonAskFailed(msg, tag){ askVoiceError(msg || "녹음을 보내지 못했습니다.", tag); }

/* ---------------- the 🎧 button ---------------- */

/* Held for the whole of openLesson, and set before the first await: `busy`
   only goes up once generation starts, so without this a second tap during
   the storage lookup would start — and pay for — a second lesson. */
let lessonOpening = false;

async function openLesson(force){
  /* a silently dead button reads as broken, so say why (stt: still writing down) */
  if (recording || stt){ setStatus("말이 끝난 뒤에 눌러주십시오"); return; }
  if (busy || lessonOpening){ setStatus("아직 하던 일이 끝나지 않았습니다"); return; }
  lessonOpening = true;
  try {
    openDlg($("lesson"));
    $("lTitle").textContent = "오늘의 수업";
    $("lFoot").innerHTML = "";

    if (!force){
      const saved = await lessonLoad(todayKey()).catch(() => null);
      if (saved && saved.lesson){ mountLesson(saved); return; }
    }

    /* the script can be written by Gemini or, with only that key, by Claude */
    if (!settings.apiKey && !settings.claudeKey){ closeDlg($("lesson")); openSettings(); return; }

    /* no conversation today is no longer a reason to stop: the new words,
       the grammar step and the lo·le·se drill do not need one */
    await makeLesson(todaysEntries());
  } finally {
    lessonOpening = false;
  }
}

/* ---------------- the 📚 button ----------------

   Opens what is already saved — never writes a script, never calls TTS. The
   newest lesson goes straight to the player, at the place it was last left;
   the 🗂 지난 수업 button on that screen reaches the other days. */

let lessonShelfOpening = false;

async function openSavedLesson(){
  /* a lesson is being made: show that screen again, and leave the run alone */
  if (lessonMaking){ openDlg($("lesson")); return; }
  if (recording || stt){ setStatus("말이 끝난 뒤에 눌러주십시오"); return; }
  if (busy || lessonOpening || lessonShelfOpening){ setStatus("아직 하던 일이 끝나지 않았습니다"); return; }
  lessonShelfOpening = true;
  try {
    openDlg($("lesson"));
    $("lTitle").textContent = "저장된 수업";
    $("lFoot").innerHTML = "";

    let all = [], listErr = null;
    try { all = await lessonList(); } catch (e) { listErr = e; }
    if (lessonMaking) return;             // a run started meanwhile; its screen wins

    if (listErr || !all.length){
      stopPlayer();
      askShow(false);
      current = null;
      if (listErr) lessonMessage("저장된 수업을 읽지 못했습니다.", (listErr && listErr.message) || String(listErr));
      else lessonMessage("아직 만든 수업이 없습니다.", "🎧 로 오늘 수업을 만들어 주세요.");
      return;
    }
    mountLesson(all[0], "", { resume: true });
  } finally {
    lessonShelfOpening = false;
  }
}

/* Raised synchronously, before makeLessonRun reaches its first await, and
   lowered only when the whole run is over.

   `busy` cannot do this on its own. The voice-list check below can wait over a
   second, and `busy` is not raised until after it, so two taps of 다시 시도
   inside that window each got past `if (!busy)` and started a lesson: two
   Gemini scripts, two sets of paid TTS requests, and two players fighting over
   one screen. The guard has to be set before the first await for that window
   to close at all — which is why this wrapper exists rather than a flag set
   further down. */
let lessonMaking = false;

async function makeLesson(rows){
  if (busy || lessonMaking){ setStatus("아직 하던 일이 끝나지 않았습니다"); return; }
  lessonMaking = true;
  try {
    await makeLessonRun(rows);
  } finally {
    lessonMaking = false;
  }
}

async function makeLessonRun(rows){
  /* Asked BEFORE anything is written, because the script costs Gemini money:
     on a device with no Spanish voice the whole lesson would be read in the
     wrong accent, and the user should get to turn Cloud TTS on first rather
     than find out after paying for it. */
  if (!(lset.engine === "cloud" && lset.ttsKey)){
    const list = await devVoicesReady().catch(() => []);
    if (list.length && !devPickVoice("es", list) && !confirm(NO_ES_VOICE + "\n\n그래도 이대로 만들까요?")){
      /* a blank screen would read as a crash, so say why nothing happened */
      lessonMessage("수업을 만들지 않았습니다.", "설정에서 고품질 음성을 켜신 뒤 다시 눌러주십시오.");
      $("lFoot").innerHTML = '<button class="mini" id="lPastBtn" type="button">🗂 지난 수업</button>';
      $("lPastBtn").onclick = showPast;
      return;
    }
  }

  /* the record this screen is showing is about to be replaced — see the comment
     on askAbandonForNewLesson */
  askAbandonForNewLesson();

  lessonCancelled = false;
  busy = true;
  /* nothing between `busy = true` and this try: a throw in the setup below
     would otherwise leave the flag stuck on, and a stuck `busy` silently
     disables the microphone, the typing box and this button for good */
  try {
    showError("");
    lessonMessage("대본을 쓰는 중…", rows.length
      ? "오늘 대화 " + rows.length + "건을 수업으로 엮고 있습니다."
      : "오늘은 대화 기록이 없어, 지난 대화와 단어 목록으로 수업을 엮고 있습니다.");
    $("lFoot").innerHTML = '<button class="mini" id="lCancel" type="button">그만두기</button>';
    $("lCancel").onclick = () => { lessonCancelled = true; cancelTts(); lessonBusySub("그만두는 중…"); };
    setStatus("수업 대본을 만드는 중…");

    /* what may be taught today — today's lines, older untaught days when
       today is thin, the word list last — is read first, because the one
       script call has to choose from it */
    const now = new Date();
    /* read once, so the script asked for and the lesson built have one length */
    const minutes = lessonMinutes();
    const plan = teachPlan(rows, typeof loadLog === "function" ? loadLog() : rows, studyDate(now), minutes);
    const content = await lessonWriteScript(teachPrompt(), teachBody(plan),
                                            (raw) => teachNormalise(raw, plan));
    if (lessonCancelled) throw new Error("__cancelled__");

    /* the recap is read out of the last saved lesson; a storage error only costs the recap */
    const prev = await lessonPrevFor(studyDate(now)).catch(() => null);
    if (lessonCancelled) throw new Error("__cancelled__");
    const lesson = teachBuild(content, now, prev, plan, minutes);
    let blob = null, fellBack = "", fellErr = null;

    if (lset.engine === "cloud" && lset.ttsKey){
      lessonMessage("음성을 만드는 중…", "0 / ?");
      try {
        blob = await lessonSynthesize(
          lesson,
          (n, m) => lessonBusySub(n + " / " + m),
          () => lessonBusySub("오디오를 합치는 중…")
        );
      } catch (e) {
        if (lessonCancelled || (e && e.message === "__cancelled__")) throw e;
        /* the script is already written and paid for — finish the lesson on the
           device voice rather than throwing all of it away */
        fellBack = (e && e.message) ? String(e.message) : String(e);
        fellErr = e;
        lesson.segments.forEach((s) => { delete s.audioMs; });
        delete lesson.padMs;
      }
      if (lessonCancelled) throw new Error("__cancelled__");
      if (blob) ttsFailClear();
    }
    /* a sticky cause (bad key, API off, billing) is told once, then lives in
       settings; the engine stays as the user set it */
    let failNote = null;
    if (fellBack){
      const cause = ttsCause(fellErr || fellBack);
      if (ttsFailRecord(cause))
        failNote = ttsFailNotice("고품질 음성을 만들지 못해 기기 음성으로 수업을 만들었습니다.",
                                 fellErr || fellBack, cause.sticky);
    }
    if (!blob) lessonEstimate(lesson);

    const rec = {
      date: lesson.date, createdAt: lessonStamp(),
      engine: blob ? "cloud" : "device", lesson: lesson, mp3: blob,
      qa: []                         // questions asked about this lesson
    };

    let saveNote = "";
    /* the words and the grammar step count as learned only once the lesson
       that teaches them is safely stored */
    try { await lessonSave(rec); curriculumCommit(lesson); }
    catch (e) {
      /* not fatal — the lesson still plays — but it will have to be paid for
         again next time, so the user should know */
      saveNote = "이 수업을 기기에 저장하지 못했습니다. 지금은 들으실 수 있지만, " +
                 "앱을 닫으면 사라지고 다시 만들어야 합니다. 저장 공간을 확인하십시오.";
    }

    /* Warmed, not read raw. On the cloud-failed-so-fall-back-to-device path
       nothing has asked for the voice list yet, and Chrome answers the first
       call with an empty array — so a phone that does have Spanish would have
       been told it does not. */
    let noEsVoice = false;
    if (!blob){
      const devList = await devVoicesReady().catch(() => []);
      noEsVoice = devList.length > 0 && !devPickVoice("es", devList);
    }

    const noticeText = [
      failNote ? failNote.text : "",
      /* the docs disagree about this voice family and speed; if the API refused
         the slow read, say so rather than let it look like a bug */
      blob && ttsRateRefused
        ? "이 음성은 «느리게 읽기» 를 지원하지 않아, 느린 문장도 보통 속도로 읽습니다." : "",
      noEsVoice ? noEsVoiceOnce() : "",
      saveNote
    ].filter(Boolean).join("\n\n");
    const notice = noticeText
      ? (failNote ? { text: noticeText, detail: failNote.detail } : noticeText)
      : "";

    mountLesson(rec, notice);
    setStatus((fellBack ? "기기 음성으로 준비됨 · " : "수업 준비됨 · ") + fmtClock(lesson.totalMs));
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (msg === "__cancelled__"){
      closeDlg($("lesson"));
      setStatus("수업 만들기를 그만뒀습니다");
    } else {
      lessonMessage("수업을 만들지 못했습니다.", "", '<div class="L-err">' + esc(msg) + "</div>");
      $("lFoot").innerHTML = '<button class="mini" id="lRetry" type="button">다시 시도</button>';
      /* no `if (!busy)` here any more: that test was the hole — it passed for
         both of two quick taps. makeLesson's own guard is the authority, and
         the button is disabled on the way in so the second tap does nothing
         even before the call is made */
      $("lRetry").onclick = (ev) => {
        const b = ev.currentTarget;
        if (b) b.disabled = true;
        makeLesson(rows).finally(() => { if (b && b.isConnected) b.disabled = false; });
      };
      setStatus("수업 만들기에 실패했습니다");
    }
  } finally {
    busy = false;
  }
}

/* A lesson read by the device voice, turned into one mp3 with the Cloud voice:
   the script is kept as it is (no new script call), only the audio is made.
   One continuous file is what a car's Bluetooth plays properly — the device
   voice starts and stops at every line, and the car clips each start. */
async function lessonToMp3(){
  if (!current || current.blob || !lset.ttsKey) return;
  if (busy || lessonMaking || recording){ lessonNotice("아직 하던 일이 끝나지 않았습니다."); return; }
  if (!confirm("이 수업을 고품질 음성(mp3)으로 만듭니다. 대본은 그대로이고, 음성 요금만 듭니다. 계속할까요?")) return;
  const mine = current;
  const lesson = JSON.parse(JSON.stringify(mine.lesson));
  lessonMaking = true;
  busy = true;
  lessonCancelled = false;
  stopPlayer();
  try {
    lessonMessage("음성을 만드는 중…", "0 / ?");
    $("lFoot").innerHTML = '<button class="mini" id="lCancel" type="button">그만두기</button>';
    $("lCancel").onclick = () => { lessonCancelled = true; cancelTts(); lessonBusySub("그만두는 중…"); };
    let blob = null, err = null;
    try {
      blob = await lessonSynthesize(lesson, (n, m) => lessonBusySub(n + " / " + m),
                                    () => lessonBusySub("오디오를 합치는 중…"));
    } catch (e) { err = e; }
    /* the saved record is the one this screen showed, or nothing is written */
    const saved = await lessonLoad(mine.date).catch(() => null);
    const same = saved && String(saved.createdAt || "") === String(mine.createdAt || "");
    if (!blob || !same){
      const back = saved && saved.lesson ? saved : { date: mine.date, createdAt: mine.createdAt, engine: "device",
                                                    lesson: mine.lesson, mp3: null, qa: mine.qa };
      const why = lessonCancelled || (err && err.message === "__cancelled__") ? "" :
        !same && saved ? "그사이 수업이 바뀌어 음성을 저장하지 않았습니다." :
        err ? (ttsFailRecord(ttsCause(err)),
               ttsFailNotice("고품질 음성을 만들지 못했습니다.", err, false)) :
        "고품질 음성을 만들지 못했습니다.";
      mountLesson(back, why);
      return;
    }
    ttsFailClear();
    const rec = Object.assign({}, saved, { engine: "cloud", lesson: lesson, mp3: blob });
    let note = "";
    try { await lessonSave(rec); }
    catch (e) { note = "음성을 기기에 저장하지 못했습니다. 지금은 들으실 수 있습니다."; }
    mountLesson(rec, note);
  } finally {
    busy = false;
    lessonMaking = false;
  }
}

/* ---------------- past lessons ---------------- */

/* Which past-lesson tap is the live one. IndexedDB reads finish in whatever
   order they like, so tapping A then B could mount A last and leave the user
   looking at the lesson they did not pick. Only the newest tap may mount. */
let pastPick = 0;

async function showPast(){
  let all = [], listErr = null;
  try { all = await lessonList(); } catch (e) { listErr = e; }
  stopPlayer();
  askShow(false);
  current = null;

  if (listErr){
    /* "none saved" and "could not read what is saved" are different problems
       and send the user looking in different places */
    lessonMessage("저장된 수업을 읽지 못했습니다.", (listErr && listErr.message) || String(listErr));
  } else if (!all.length){
    lessonMessage("저장된 수업이 없습니다.", "수업을 만들면 최근 " + KEEP_LESSONS + "개까지 여기에 남습니다.");
  } else {
    let html = '<div class="L-sec">지난 수업</div>';
    for (const r of all){
      html += '<button class="L-row past" data-d="' + esc(r.date) + '" type="button">' +
        '<div class="L-say">' + esc((r.lesson && r.lesson.dateLabel) || r.date) +
          '<span class="L-badge">' + fmtClock((r.lesson && r.lesson.totalMs) || 0) + "</span></div>" +
        '<div class="L-ko">' + (r.engine === "cloud" ? "오디오" : "기기 음성") +
          (r.mp3 ? " · " + sizeLabel(r.mp3.size) : "") + "</div></button>";
    }
    $("lCtl").innerHTML = "";
    $("lBody").innerHTML = html;
    $("lBody").querySelectorAll(".L-row.past").forEach((b) => {
      b.onclick = () => {
        const mine = ++pastPick;
        lessonLoad(b.getAttribute("data-d"))
          .then((rec) => { if (mine === pastPick && rec) mountLesson(rec, "", { resume: true }); })
          .catch((e) => {
            if (mine !== pastPick) return;      // a later tap already won
            lessonNotice("그 수업을 열지 못했습니다.\n" + ((e && e.message) || e));
          });
      };
    });
  }
  $("lFoot").innerHTML = '<button class="mini" id="lBackToday" type="button">&larr; 오늘 수업</button>';
  $("lBackToday").onclick = () => { openLesson().catch(() => {}); };
}

/* ---------------- single file export ---------------- */

function bytesToB64(u8){
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(out);
}

function safeJson(obj){
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/* ---- asking from the exported file ----

   The file asks exactly the way the lesson screen does: the same prompt, the
   same context (whole lesson + the line playing + the last few turns), the same
   answer format and the same bubbles. Rather than a second copy of that code,
   the app's own functions are written into the file as source text.

   The API key is NEVER written into the file — files get passed around on
   KakaoTalk. The file asks for a key the first time it is used and keeps it in
   that browser's own storage. */

/* Function source, made safe to sit inside a <script> element: "</script" or
   "<!--" anywhere in it (they only ever occur inside strings, regexes and
   comments, where "<\/" means the same thing) would end or confuse the block. */
function scriptSafe(js){
  return String(js).replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
function fnSource(fn, name){
  const s = String(fn);
  return /^(async\s+)?function\b/.test(s) ? s : "var " + name + " = " + s + ";";
}

/* Runs ONLY inside an exported file, never in the app: exportAskHtml writes it
   into the file next to the app's own question functions and the names below
   (current, player, ASK_MODEL, ...) are the ones that file defines. */
function exportAskRuntime(){
  const KEY_STORE = "interp.fileKey";
  const QA_STORE = "interp.fileQA." + (current.lesson.date || "");
  const q = $("lQ"), mic = $("lQMic"), send = $("lQSend"), box = $("lChat");
  const keyRow = $("lKey"), keyIn = $("lKeyIn"), keyMsg = $("lKeyMsg");
  const KEY_HINT = keyMsg.textContent;
  let pending = null, busy = false, waiting = null;
  let rec = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;

  const saved = jget(QA_STORE, []);
  if (Array.isArray(saved)) current.qa = saved.slice(-ASK_KEEP);

  function render(){
    const qa = current.qa;
    let html = "";
    for (let i = 0; i < qa.length; i++){
      const t = qa[i];
      if (!t || !Array.isArray(t.parts)) continue;
      html += askBubble("me", '<div class="Q-ko">' + esc(t.q || "") + "</div>");
      html += askAnswerHtml(t.parts, i);
    }
    if (pending){
      html += askBubble("me", '<div class="Q-ko">' +
        esc(pending.via === "voice" && !pending.q ? "🎤 음성 질문" : pending.q) + "</div>");
      html += pending.err
        ? askBubble("err", '<div class="Q-ko">' + esc(pending.err) + "</div>" +
            (pending.canRetry
              ? '<div class="Q-tools"><button class="Q-retry" id="lQRetry" type="button">다시 시도</button></div>'
              : ""))
        : askBubble("", '<div class="Q-wait">생각 중…</div>');
    }
    box.innerHTML = html;
    box.querySelectorAll(".Q-es").forEach((n) => {
      n.onclick = () => askSpeakEs(n.getAttribute("data-say"));
    });
    box.querySelectorAll(".Q-say").forEach((b) => {
      b.onclick = () => {
        const t = current.qa[Number(b.getAttribute("data-i"))];
        if (t) askSpeakDevice(t.parts);
      };
    });
    const retry = $("lQRetry");
    if (retry) retry.onclick = () => {
      const again = pending;
      if (!again) return;
      pending = null;
      ask(again);
    };
    box.scrollTop = box.scrollHeight;
    askApplyFold();
  }

  function showError(p, msg){
    pending = Object.assign({ q: "", via: "text", canRetry: false }, p, { err: msg });
    if (askFolded) askSetFold(false);
    render();
  }

  function askForKey(msg){
    keyRow.hidden = false;
    keyMsg.textContent = msg || KEY_HINT;
    try { keyIn.focus(); } catch (e) {}
  }

  async function ask(p){
    if (busy) return;
    const key = jget(KEY_STORE, "");
    if (!key){ waiting = p; askForKey(""); return; }

    busy = true;
    askLock("think");
    if (askFolded) askSetFold(false);
    try { player.pause(); } catch (e) {}
    pending = Object.assign({ err: "", canRetry: true }, p);
    if (!pending.playing) pending.playing = askPlayingJson();
    render();

    let badKey = false;
    try {
      const input = pending.audio
        ? [{ type: "text", text: askContextJson(pending) },
           { type: "audio", data: pending.audio.data, mime_type: pending.audio.mime }]
        : [{ type: "text", text: askContextJson(pending) }];
      const call = async () => {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: ASK_MODEL,
            system_instruction: ASK_PROMPT,
            input: input,
            generation_config: { temperature: 0.35, thinking_level: "low" }
          })
        });
        const raw = await res.text();
        let json = null; try { json = JSON.parse(raw); } catch (e) {}
        if (!res.ok){
          const msg = (json && json.error && json.error.message) || raw.slice(0, 300);
          badKey = res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key/i.test(msg));
          throw new Error((badKey ? "API 키가 맞지 않습니다. 아래에 다시 넣어주십시오.\n" : "") +
                          "API " + res.status + "\n" + msg);
        }
        const text = extractText(json || {});
        if (!text) throw new Error("답변이 비어 있습니다.");
        return text.trim();
      };
      const reply = await Promise.race([
        call(),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error("답이 " + (ASK_TIMEOUT_MS / 1000) + "초 안에 오지 않았습니다.")),
          ASK_TIMEOUT_MS))
      ]);
      const got = askParse(reply);
      const shown = pending.via === "voice" ? (got.heard || "🎤 음성 질문") : pending.q;
      current.qa.push({ q: shown, via: pending.via, parts: got.parts, at: new Date().toISOString() });
      if (current.qa.length > ASK_KEEP) current.qa = current.qa.slice(-ASK_KEEP);
      pending = null;
      jset(QA_STORE, current.qa);
      render();
    } catch (e) {
      if (pending){
        pending.err = (e && e.message) ? String(e.message) : String(e);
        render();
      }
      if (badKey) askForKey("API 키가 맞지 않습니다. 다시 넣어주십시오.");
    } finally {
      busy = false;
      askLock("idle");
    }
  }

  function sendText(){
    const text = q.value.trim();
    if (!text || busy || rec) return;
    q.value = "";
    ask({ q: text, via: "text" });
  }
  send.onclick = sendText;
  q.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); sendText(); }
  };

  $("lKeySave").onclick = () => {
    const k = keyIn.value.trim();
    if (!k){ askForKey(""); return; }
    jset(KEY_STORE, k);
    keyIn.value = "";
    keyRow.hidden = true;
    const p = waiting;
    waiting = null;
    if (p) ask(p);
  };
  keyIn.onkeydown = (ev) => {
    if (ev.key === "Enter"){ ev.preventDefault(); $("lKeySave").click(); }
  };

  /* ---- the microphone: a plain start/stop recorder ----
     Some browsers refuse the microphone to a page opened from a file. Then the
     button goes away and the question bar is text only. */
  const micOk = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
                   typeof MediaRecorder !== "undefined");
  if (!micOk) mic.hidden = true;

  function stopRec(){
    if (!rec) return;
    if (recTimer){ clearTimeout(recTimer); recTimer = null; }
    askLock("think");
    try { rec.stop(); } catch (e) { recStopped(); }
  }

  async function recStopped(){
    const r = rec;
    rec = null;
    const ms = Date.now() - recStart;
    try { recStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    recStream = null;
    const mime = baseMime(r && r.mimeType);
    const blob = new Blob(recChunks, { type: mime });
    recChunks = [];
    if (ms < 700 || blob.size < 1000){
      askLock("idle");
      showError({ q: "🎤 음성 질문", via: "voice" }, "너무 짧습니다 — 다시 말해 주십시오.");
      return;
    }
    let b64 = "";
    try { b64 = await blobToBase64(blob); }
    catch (e) {
      askLock("idle");
      showError({ q: "🎤 음성 질문", via: "voice" }, "녹음을 읽지 못했습니다.");
      return;
    }
    askLock("idle");
    ask({ q: "", via: "voice", audio: { data: b64, mime: mime, ms: ms } });
  }

  mic.onclick = async () => {
    if (rec){ stopRec(); return; }
    if (busy) return;
    if (!jget(KEY_STORE, "")){ askForKey(""); return; }
    try { player.pause(); } catch (e) {}
    try {
      recStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      mic.hidden = true;
      showError({ q: "🎤 음성 질문", via: "voice" },
        "이 브라우저는 파일에서 마이크를 열 수 없습니다. 글로 물어봐 주십시오.");
      return;
    }
    const want = pickMime();
    try { rec = want ? new MediaRecorder(recStream, { mimeType: want }) : new MediaRecorder(recStream); }
    catch (e) { rec = new MediaRecorder(recStream); }
    recChunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    rec.onstop = recStopped;
    rec.start();
    recStart = Date.now();
    askLock("rec");
    recTimer = setTimeout(stopRec, 60000);
  };

  $("lFold").onclick = () => askSetFold(!askFolded);
  askLock("idle");
  render();
}

/* the question panel's styles, the same as the lesson screen's */
function exportAskCss(){
  return [
'.Q-chat{max-height:38dvh;overflow-y:auto;padding:9px 13px 3px;border-top:1px solid var(--line);',
'-webkit-overflow-scrolling:touch}',
'.Q-chat:empty,.Q-chat.fold{display:none}',
'.Q-fold{display:block;width:100%;border:none;border-top:1px solid var(--line);background:var(--surface);',
'color:var(--dim);font-size:11.5px;font-weight:700;padding:6px 13px;cursor:pointer;font-family:inherit}',
'.Q-fold[hidden],.Q-key[hidden],.Q-mic[hidden]{display:none}',
'.Q-turn{display:flex;margin-bottom:9px}',
'.Q-turn.me{justify-content:flex-end}',
'.Q-bub{max-width:86%;border:1px solid var(--line);background:var(--surface-2);',
'border-radius:13px;padding:9px 11px;font-size:13.5px;line-height:1.6;word-break:break-word}',
'.Q-turn.me .Q-bub{background:#1b2b40;border-color:#31506f}',
'.Q-turn.err .Q-bub{background:#2a1618;border-color:#5a2b2f;color:#ffc9c9}',
'.Q-ko{color:var(--text);white-space:pre-wrap}',
'.Q-es{display:block;color:var(--es);font-weight:650;font-size:15px;margin:5px 0 2px;cursor:pointer}',
'.Q-tools{display:flex;gap:6px;margin-top:7px}',
'.Q-say,.Q-retry{border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:8px;',
'padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit}',
'.Q-wait{font-size:12.5px;color:var(--dim)}',
'.Q-ask{display:flex;align-items:center;gap:7px;padding:9px 13px calc(9px + env(safe-area-inset-bottom));',
'border-top:1px solid var(--line);background:var(--surface)}',
'.Q-in{flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--line);color:var(--text);',
'border-radius:11px;padding:10px 12px;font-size:14px;font-family:inherit}',
'.Q-in:focus{outline:none;border-color:#3d4a5a}',
'.Q-mic,.Q-send{flex:none;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);',
'border-radius:11px;padding:9px 12px;font-size:15px;cursor:pointer;font-family:inherit}',
'.Q-mic.rec{background:#7f1d2d;border-color:#a3263a;color:#fff}',
'.Q-send{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:700;font-size:13px}',
'.Q-mic:disabled,.Q-send:disabled,.Q-in:disabled{opacity:.5;cursor:default}',
'.Q-key{padding:10px 13px;border-top:1px solid var(--line);background:var(--surface)}',
'.Q-key-t{font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:8px;white-space:pre-wrap}',
'.Q-key-r{display:flex;gap:7px}'
  ].join("\n");
}

/* The question panel and the code behind it. Every value goes in through
   safeJson and every function through scriptSafe, so nothing in either can
   close the <script> element early. */
function exportAskHtml(){
  const v = (name, value) => "var " + name + " = " + safeJson(value) + ";";
  const fns = [
    fnSource(cleanStr, "cleanStr"), lessonExtractJson, askParse, rowAt,
    askLessonJson, askPlayingJson, askHistoryJson, askContextJson,
    askBubble, askAnswerHtml, askLock, askApplyFold, askSetFold,
    devVoiceList, devLangScore, devPickVoice, askSpeakEs, askSpeakDevice,
    jget, jset, esc, extractText, pickMime, fnSource(baseMime, "baseMime"), blobToBase64,
    exportAskRuntime
  ].map((f) => (typeof f === "string" ? f : String(f)));

  const js = [
    "(function(){",
    '"use strict";',
    v("ASK_PROMPT", ASK_PROMPT),
    v("ASK_TURNS", ASK_TURNS), v("ASK_KEEP", ASK_KEEP), v("ASK_TIMEOUT_MS", ASK_TIMEOUT_MS),
    v("ASK_MODEL", DEFAULTS.model), v("API_URL", API_URL),
    v("DEV_LANG_RANK", DEV_LANG_RANK), v("ASK_FOLD_KEY", ASK_FOLD_KEY),
    "var lset = {};",
    "var $ = function(id){ return document.getElementById(id); };",
    "var current = { lesson: window.__lesson.data, qa: [] };",
    "var player = { at: function(){ return window.__lesson.player.at(); },",
    "               pause: function(){ window.__lesson.player.pause(); } };",
    fns.join("\n"),
    "var askFolded = jget(ASK_FOLD_KEY, false) === true;",
    "exportAskRuntime();",
    "})();"
  ].join("\n");

  return [
'<button class="Q-fold" id="lFold" type="button" hidden></button>',
'<div class="Q-chat" id="lChat"></div>',
'<div class="Q-key" id="lKey" hidden>',
'<div class="Q-key-t" id="lKeyMsg">질문하려면 Gemini API 키가 필요합니다. 이 기기의 브라우저에만 저장되고, 파일 안에는 들어가지 않습니다.</div>',
'<div class="Q-key-r"><input class="Q-in" id="lKeyIn" type="password" placeholder="Gemini API 키" ',
'autocomplete="off" spellcheck="false"><button class="Q-send" id="lKeySave" type="button">저장</button></div>',
'</div>',
'<div class="Q-ask" id="lAsk">',
'<input class="Q-in" id="lQ" type="text" placeholder="궁금한 걸 물어보세요" autocomplete="off" spellcheck="false" enterkeyhint="send">',
'<button class="Q-mic" id="lQMic" type="button" aria-label="말로 질문">🎤</button>',
'<button class="Q-send" id="lQSend" type="button">질문</button>',
'</div>',
'<script>',
scriptSafe(js),
'<\/script>'
  ].join("\n");
}

/* Everything inline: the script, the audio, the timeline and a player.
   No external reference at all, so file:// on a PC works the same as a phone. */
function exportHtml(lesson, b64){
  /* the timeline is floating point; 0.1 ms is far finer than anything audible
     and keeps the embedded JSON from carrying 17 digits per row */
  const ms1 = (v) => Math.round((v || 0) * 10) / 10;
  const data = {
    dateLabel: lesson.dateLabel, date: lesson.date, counts: lesson.counts,
    totalMs: ms1(lesson.totalMs), hasAudio: !!b64,
    /* the same codec delay the app corrects for — see MP3_DELAY_MS */
    delayMs: b64 ? MP3_DELAY_MS : 0,
    rows: lesson.rows.map((r) => {
      const o = {
        kind: r.kind, es: r.es || "", ko: r.ko || "", badge: r.badge || "", from: r.from || "",
        sectionId: r.sectionId, sectionTitle: r.sectionTitle, start: ms1(r.start)
      };
      if (r.en) o.en = r.en;
      if (Array.isArray(r.table)) o.table = r.table;
      if (r.quiz){ o.quiz = true; o.reveal = ms1(r.reveal); }
      if (r.cr) o.cr = r.cr;
      if (r.role) o.role = r.role;
      if (r.gesture) o.gesture = r.gesture;
      if (r.who) o.who = r.who;
      return o;
    }),
    segments: lesson.segments.map((s) => ({
      speaker: s.speaker, text: s.text, rate: s.rate, pauseAfter: s.pauseAfter, start: ms1(s.start)
    }))
  };

  const head = [
'<!DOCTYPE html>',
'<html lang="ko"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<title>' + esc(lesson.dateLabel) + ' 스페인어 수업</title>',
'<style>',
':root{--bg:#0b0d10;--surface:#14181d;--surface-2:#1c222a;--line:#2a323c;--text:#f2f5f8;',
'--muted:#8d99a6;--dim:#5f6b78;--es:#ffd166;--ko:#7cc4ff;--ok:#5ddba4}',
'*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'html,body{height:100%}',
'body{margin:0;background:var(--bg);color:var(--text);display:flex;flex-direction:column;',
'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Noto Sans KR",sans-serif}',
'header{padding:13px 15px 10px;border-bottom:1px solid var(--line)}',
'h1{margin:0;font-size:16px}',
'.sub{color:var(--dim);font-size:11.5px;margin-top:4px}',
'.ctl{padding:11px 15px;border-bottom:1px solid var(--line);background:var(--surface)}',
'.bar{height:5px;border-radius:3px;background:var(--surface-2);overflow:hidden;cursor:pointer}',
'.bar i{display:block;height:100%;width:0;background:var(--ok)}',
'.time{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);',
'margin-top:5px;font-variant-numeric:tabular-nums}',
'.btns{display:flex;gap:7px;margin-top:9px;justify-content:center}',
'.b{border:1px solid var(--line);background:var(--surface-2);color:var(--muted);border-radius:11px;',
'padding:9px 13px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}',
'.b.big{background:#2563eb;color:#fff;border-color:#2563eb;min-width:66px;font-size:16px}',
'.body{flex:1;overflow-y:auto;padding:6px 13px 44px;-webkit-overflow-scrolling:touch}',
'.body::after{content:"";display:block;height:32vh}',
'.sec{font-size:10.5px;font-weight:700;letter-spacing:.8px;color:var(--dim);',
'text-transform:uppercase;margin:19px 3px 8px}',
'.row{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;',
'border-radius:12px;padding:9px 11px;margin-bottom:3px;cursor:pointer;font-family:inherit;color:inherit}',
'.row.on{background:var(--surface-2);border-color:#3d4a5a}',
'.row.quiz:not(.shown) .es{background:var(--surface-2);color:transparent;border-radius:5px;',
'user-select:none;box-shadow:inset 0 0 0 1px var(--line)}',
'.es{font-size:18px;font-weight:650;color:var(--es);line-height:1.4;word-break:break-word}',
'.ko{font-size:13px;color:var(--muted);margin-top:3px;line-height:1.45;word-break:break-word}',
'.say{font-size:14px;color:var(--ko);line-height:1.5;word-break:break-word}',
'.note{font-size:13px;color:#e8d5a8;line-height:1.5;padding-left:9px;',
'border-left:2px solid rgba(255,209,102,.4)}',
'.badge{display:inline-block;margin-left:7px;font-size:10px;font-weight:700;color:var(--dim);',
'border:1px solid var(--line);border-radius:6px;padding:1px 5px;vertical-align:2px}',
'.from{color:var(--dim);font-size:12px;font-weight:600;margin-right:6px}',
'.role{color:var(--ko);font-size:12px;font-weight:700;margin-right:7px}',
'.cr{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;color:var(--ok);',
'border:1px solid rgba(93,219,164,.45);border-radius:6px;padding:1px 6px;vertical-align:2px}',
'.gest{font-size:12px;color:var(--dim);margin-top:4px}',
'.row.full .es,.row.slow .es{font-size:16px}',
'.en{display:inline-block;font-size:11.5px;font-weight:700;color:#b9c7f5;background:rgba(124,150,255,.1);',
'border:1px solid rgba(124,150,255,.3);border-radius:7px;padding:2px 7px}',
'.cap{font-size:11.5px;color:var(--dim);margin-bottom:5px}',
'.tbl{width:100%;border-collapse:collapse;font-size:13px}',
'.tbl td{padding:4px 6px;border-top:1px solid var(--line);vertical-align:top;word-break:break-word}',
'.tbl tr:first-child td{border-top:none}',
'.tbl .w{color:var(--dim);font-size:11.5px;font-weight:700;white-space:nowrap;width:1%}',
'.tbl .e{color:var(--es);font-weight:650}',
'.tbl .k{color:var(--muted)}',
'.warn{font-size:11.5px;color:#e8d5a8;background:rgba(255,209,102,.07);',
'border:1px solid rgba(255,209,102,.22);border-radius:10px;padding:8px 10px;margin-top:9px;line-height:1.5}',
'.b.on{background:rgba(93,219,164,.14);border-color:var(--ok);color:var(--ok)}',
exportAskCss(),
'</style></head><body>',
'<header><h1>' + esc(lesson.dateLabel) + ' 스페인어 수업</h1>',
'<div class="sub">' + (lesson.counts.newWords ? '새 단어 ' + lesson.counts.newWords + ' · ' : '') +
  (lesson.counts.grammarAt ? '문법 ' + circNum(lesson.counts.grammarAt) + '/' + lesson.counts.grammarOf + ' · ' : '') +
  (lesson.counts.review ? '복습 ' + lesson.counts.review + ' · ' : '') +
  esc(lessonCountsText(lesson.counts)) + ' · ' + fmtClock(lesson.totalMs) +
  (b64 ? '' : ' · 기기 음성') + '</div></header>',
'<div class="ctl">',
'<div class="bar" id="bar"><i></i></div>',
'<div class="time"><span id="at">0:00</span><span>' + fmtClock(lesson.totalMs) + '</span></div>',
'<div class="btns">',
'<button class="b" id="back" type="button">' + (b64 ? "&minus;10초" : "&#9664; 줄") + '</button>',
'<button class="b big" id="play" type="button">&#9654;</button>',
'<button class="b" id="fwd" type="button">' + (b64 ? "+10초" : "줄 &#9654;") + '</button>',
'<button class="b" id="spd" type="button">1&times;</button>',
'<button class="b" id="loop" type="button" aria-label="무한 반복" aria-pressed="false">&#128257;</button>',
'</div>',
(b64 ? '' : '<div class="warn">이 파일에는 녹음된 소리가 들어 있지 않고, 여는 기기의 음성으로 읽습니다. ' +
            '스페인어와 한국어 음성이 깔린 기기에서 열어주십시오. 화면을 끄면 멈춥니다.</div>'),
/* shown only once the voice list says this device has no Spanish voice */
(b64 ? '' : '<div class="warn" id="novoice" style="display:none">이 기기에는 스페인어 목소리가 없어 ' +
            '스페인어를 다른 언어 목소리로 읽습니다. 발음이 깨집니다. ' +
            '기기 설정에서 스페인어 음성을 내려받으신 뒤 다시 열어주십시오.</div>'),
'</div>',
'<div class="body" id="body"></div>',
'<script id="L" type="application/json">' + safeJson(data) + '<\/script>',
(b64 ? '<script id="A" type="text/plain">' + b64 + '<\/script>' : '')
  ].join("\n");

  const player = [
'<script>',
'(function(){',
'"use strict";',
'var D = JSON.parse(document.getElementById("L").textContent);',
'var body = document.getElementById("body"), cur = -1;',
'var ENT = {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"};',
'var esc = function(s){ return String(s).replace(/[&<>"\']/g, function(c){ return ENT[c]; }); };',
'var clock = function(ms){ var t = Math.max(0, Math.round(ms/1000));',
'  return Math.floor(t/60) + ":" + String(t%60).padStart(2,"0"); };',
/* the app's own centring and row drawing, so the file scrolls and looks the same */
'var CENTER_BAND = ' + CENTER_BAND + ';',
scriptSafe(String(centerRow)),
scriptSafe(String(rowHtml)),
'',
'var html = "", sec = "";',
'for (var i = 0; i < D.rows.length; i++){',
'  var r = D.rows[i];',
'  if (r.sectionId !== sec){ sec = r.sectionId; html += \'<div class="sec">\' + esc(r.sectionTitle) + "</div>"; }',
'  html += rowHtml(r, i, "");',
'}',
'body.innerHTML = html;',
'/* 0교시: the Spanish answer stays covered until it plays */',
'var QZ = [];',
'body.querySelectorAll(".row.quiz").forEach(function(n){',
'  QZ.push({ el: n, at: Number(D.rows[Number(n.getAttribute("data-i"))].reveal) || 0 }); });',
'var reveal = function(ms){ for (var q = 0; q < QZ.length; q++){ var on2 = ms >= QZ[q].at;',
'  if (QZ[q].el.classList.contains("shown") !== on2) QZ[q].el.classList.toggle("shown", on2); } };',
'',
'var mark = function(i){',
'  if (i === cur) return;',
'  var p = body.querySelector(".row.on"); if (p) p.classList.remove("on");',
'  var n = body.querySelector(\'.row[data-i="\' + i + \'"]\');',
'  if (n){ n.classList.add("on"); centerRow(body, n); }',
'  cur = i;',
'};',
'var rowAt = function(ms){ var lo = 0, hi = D.rows.length - 1, best = 0;',
'  while (lo <= hi){ var m = (lo+hi) >> 1;',
'    if (D.rows[m].start <= ms){ best = m; lo = m + 1; } else hi = m - 1; }',
'  return best; };',
'',
'var barEl = document.getElementById("bar"), atEl = document.getElementById("at");',
'var playEl = document.getElementById("play"), spdEl = document.getElementById("spd");',
'var STEPS = [0.8, 1, 1.2], P = null;',
'/* 🔁 is remembered by whatever this browser lets a file keep; if it lets it',
'   keep nothing, the button still works for as long as the file is open */',
'var LOOP = false;',
'try { LOOP = localStorage.getItem("interp.lessonLoop") === "true"; } catch (e){}',
'/* tick runs once per animation frame, so nothing is written unless it changed:',
'   re-parsing innerHTML and re-setting the same width string 60 times a second',
'   is pure waste on a phone. */',
'var lastC = null, lastP = null, lastOn = null;',
'var tick = function(ms, on){',
'  mark(rowAt(ms));',
'  reveal(ms);',
'  var c = clock(ms);',
'  if (c !== lastC){ atEl.textContent = c; lastC = c; }',
'  var pc = Math.round((D.totalMs ? Math.min(100, ms/D.totalMs*100) : 0) * 10) / 10;',
'  if (pc !== lastP){ barEl.firstChild.style.width = pc + "%"; lastP = pc; }',
'  if (on !== lastOn){ playEl.innerHTML = on ? "&#10073;&#10073;" : "&#9654;"; lastOn = on; }',
'};',
'',
'if (D.hasAudio){',
'  var b64 = document.getElementById("A").textContent.replace(/\\s/g, "");',
'  var dataUri = function(){ return "data:audio/mpeg;base64," + b64; };',
'  var a = new Audio(), timer = null, sp = 1, fellBack = false;',
'  try {',
'    var s = atob(b64), u = new Uint8Array(s.length);',
'    for (var k = 0; k < s.length; k++) u[k] = s.charCodeAt(k);',
'    a.src = URL.createObjectURL(new Blob([u], { type: "audio/mpeg" }));',
'  } catch (e){ a.src = dataUri(); fellBack = true; }',
'  a.addEventListener("error", function(){ if (!fellBack){ fellBack = true; a.src = dataUri(); } });',
'  a.loop = LOOP;',
'  /* currentTime runs D.delayMs ahead of the script because of the mp3 codec',
'     delay, so reads subtract it and seeks add it back. */',
'  var pos = function(){ return Math.max(0, a.currentTime*1000 - D.delayMs); };',
'  var t = function(){ tick(pos(), !a.paused); };',
'  var stopT = function(){ if (timer){ cancelAnimationFrame(timer); timer = null; } };',
'  var frame = function(){ if (a.paused){ timer = null; return; }',
'    t(); timer = requestAnimationFrame(frame); };',
'  var startT = function(){ if (!timer) timer = requestAnimationFrame(frame); };',
'  a.addEventListener("timeupdate", t);',
'  a.addEventListener("play", function(){ startT(); t(); });',
'  a.addEventListener("playing", startT);',
'  a.addEventListener("pause", function(){ stopT(); t(); });',
'  a.addEventListener("ended", function(){ stopT(); t(); });',
'  P = { toggle: function(){ a.paused ? a.play() : a.pause(); },',
'        seek: function(ms){ try { a.currentTime = (Math.max(0, ms) + D.delayMs)/1000; } catch (e){} t(); },',
'        step: function(d){ P.seek(pos() + d*10000); },',
'        speed: function(v){ sp = v; a.playbackRate = v; }, now: function(){ return sp; },',
'        loop: function(on){ a.loop = !!on; }, at: pos, pause: function(){ a.pause(); } };',
'} else {',
'  var idx = 0, run = false, rate = 1, wt = null, epoch = 0;',
'  /* Naming the voice is what stops the engine reading Spanish with a Korean',
'     or English voice on a device that has no Spanish installed. Same ranking',
'     as the app: closest coding, then Google voices, then alphabetical. */',
'  var RANK = { es: ["es-mx","es-us","es-419","es-la","es-es","es"], ko: ["ko-kr","ko"] };',
'  var vlist = function(){ try { var v = speechSynthesis.getVoices(); return v || []; } catch (e){ return []; } };',
'  var score = function(side, lang){',
'    var l = String(lang||"").toLowerCase().replace(/_/g,"-"), r = RANK[side];',
'    for (var i = 0; i < r.length; i++) if (l === r[i] || l.indexOf(r[i]+"-") === 0) return i;',
'    return l.indexOf(side === "es" ? "es" : "ko") === 0 ? r.length : -1; };',
'  var pickV = function(side){',
'    var u = [], all = vlist();',
'    for (var i = 0; i < all.length; i++){ var s2 = score(side, all[i].lang);',
'      if (s2 >= 0) u.push({ v: all[i], s: s2 }); }',
'    if (!u.length) return null;',
'    u.sort(function(a,b){ return a.s - b.s ||',
'      (/google/i.test(a.v.name)?0:1) - (/google/i.test(b.v.name)?0:1) ||',
'      String(a.v.name).localeCompare(String(b.v.name)); });',
'    return u[0].v; };',
'  var VO = { es: null, ko: null };',
'  var warnEl = document.getElementById("novoice");',
'  var setVoices = function(){ VO.es = pickV("es"); VO.ko = pickV("ko");',
'    if (warnEl) warnEl.style.display = VO.es ? "none" : "block"; };',
'  setVoices();',
'  /* Chrome fills the list asynchronously and returns [] on the first call */',
'  try { speechSynthesis.addEventListener("voiceschanged", setVoices); } catch (e){}',
'  setTimeout(setVoices, 1200);',
'  var pos = function(){ var s = D.segments[Math.min(idx, D.segments.length-1)]; return s ? s.start : 0; };',
'  var rep = function(){ tick(pos(), run); };',
'  /* cancel() reports onend asynchronously, so a cancelled line can finish',
'     after a seek already started the next one. The epoch retires old chains. */',
'  var halt = function(){ run = false; epoch++; if (wt){ clearTimeout(wt); wt = null; }',
'    try { speechSynthesis.cancel(); } catch (e){} };',
'  var est = function(s){ return Math.max(500, s.text.length*(s.speaker === "es" ? 68 : 96)/(s.rate||1)); };',
'  var step1 = function(){',
'    if (!run) return;',
'    if (idx >= D.segments.length){',
'      if (!LOOP || !D.segments.length){ run = false; rep(); return; }',
'      idx = 0; }',
'    var s = D.segments[idx], moved = false, mine = epoch;',
'    rep();',
'    var go = function(){ if (moved || mine !== epoch) return; moved = true; if (!run) return;',
'      wt = setTimeout(function(){ wt = null;',
'        if (mine !== epoch || !run) return;',
'        idx++; step1(); }, s.pauseAfter*1000/rate); };',
'    try {',
'      var u = new SpeechSynthesisUtterance(s.text);',
'      var pv = s.speaker === "es" ? VO.es : VO.ko;',
'      u.lang = s.speaker === "es" ? "es-MX" : "ko-KR";',
'      if (pv){ u.voice = pv; u.lang = pv.lang || u.lang; }',
'      u.rate = Math.max(0.1, Math.min(10, (s.rate||1)*rate));',
'      u.onend = go; u.onerror = go;',
'      speechSynthesis.speak(u);',
'      setTimeout(go, est(s)/rate + 4000);',
'    } catch (e){ go(); }',
'  };',
'  var jump = function(to){ var was = run; halt();',
'    idx = Math.max(0, Math.min(D.segments.length-1, to));',
'    if (!was){ rep(); return; }',
'    run = true; var mine = epoch; rep();',
'    wt = setTimeout(function(){ wt = null; if (mine === epoch && run) step1(); }, 80); };',
'  P = { toggle: function(){ if (run){ halt(); rep(); return; }',
'          if (idx >= D.segments.length) idx = 0;',
'          run = true; step1(); },',
'        seek: function(ms){ var k = 0;',
'          for (var i2 = 0; i2 < D.segments.length; i2++) if (D.segments[i2].start <= ms) k = i2;',
'          jump(k); },',
'        step: function(d){ jump(idx + d); },',
'        speed: function(v){ rate = v; }, now: function(){ return rate; },',
'        loop: function(){}, at: pos, pause: function(){ if (run){ halt(); rep(); } } };',
'}',
'',
'playEl.onclick = function(){ P.toggle(); };',
'document.getElementById("back").onclick = function(){ P.step(-1); };',
'document.getElementById("fwd").onclick = function(){ P.step(1); };',
'spdEl.onclick = function(){ var n = STEPS[(STEPS.indexOf(P.now()) + 1) % STEPS.length];',
'  P.speed(n); spdEl.innerHTML = n + "&times;"; };',
'var loopEl = document.getElementById("loop");',
'var paintLoop = function(){ loopEl.classList.toggle("on", LOOP); loopEl.setAttribute("aria-pressed", String(LOOP)); };',
'loopEl.onclick = function(){ LOOP = !LOOP; P.loop(LOOP); paintLoop();',
'  try { localStorage.setItem("interp.lessonLoop", String(LOOP)); } catch (e){} };',
'paintLoop();',
'barEl.onclick = function(ev){ var r2 = barEl.getBoundingClientRect();',
'  P.seek(Math.max(0, Math.min(1, (ev.clientX - r2.left)/r2.width)) * D.totalMs); };',
'body.querySelectorAll(".row").forEach(function(b){',
'  b.onclick = function(){ P.seek(D.rows[Number(b.getAttribute("data-i"))].start); };',
'});',
'window.__lesson = { tick: tick, rowAt: rowAt, mark: mark, player: P, data: D,',
'  current: function(){ return cur; } };',
'tick(0, false);',
'})();',
'<\/script>'
  ].join("\n");

  return head + "\n" + player + "\n" + exportAskHtml() + "\n</body></html>";
}

async function exportLesson(){
  if (!current) return;
  /* Taken once, here. Reading `current` again after the awaits below was the same
     mistake the save path made: an mp3 of several megabytes takes a moment to
     read, and the share sheet stays open for as long as the user leaves it open.
     Switch lessons in either window and the file came out with one lesson's audio
     under another lesson's script and filename. */
  const lesson = current.lesson, blob = current.blob;
  const btn = $("lExport");
  if (btn){ btn.disabled = true; btn.textContent = "만드는 중…"; }
  try {
    let b64 = "";
    if (blob) b64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));

    const name = "수업_" + lesson.date + ".html";
    const file = new File([exportHtml(lesson, b64)], name, { type: "text/html" });

    let sent = false;
    if (navigator.canShare && navigator.share){
      try {
        if (navigator.canShare({ files: [file] })){
          await navigator.share({ files: [file], title: lesson.dateLabel + " 스페인어 수업" });
          sent = true;
        }
      } catch (e) { if (e && e.name === "AbortError") sent = true; }
    }
    if (!sent){
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  } catch (e) {
    showError("파일을 만들지 못했습니다.\n" + ((e && e.message) || e));
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = "📄 파일로 저장"; }
  }
}

/* ---------------- settings panel (called from app.js) ---------------- */

function lessonVoiceLine(){
  if (lset.engine === "cloud" && (lset.voiceEs || lset.voiceKo))
    return "쓰는 음성: " + (lset.voiceEs || "—") + " / " + (lset.voiceKo || "—");
  if (lset.devVoiceEs || lset.devVoiceKo)
    return "기기 음성: " + (lset.devVoiceEs || "—") + " / " + (lset.devVoiceKo || "—");
  return "";
}

function lessonFillSettings(){
  const eng = $("lEngine");
  if (!eng) return;
  eng.value = lset.engine;
  $("lTtsKey").value = lset.ttsKey;
  lessonFillTtsFail();
  const se = $("lSexEs"), sk = $("lSexKo");
  if (se) se.value = lset.sexEs === "male" ? "male" : "female";
  if (sk) sk.value = lset.sexKo === "male" ? "male" : "female";
  const lm = $("lMinutes");
  if (lm) lm.value = String(lessonMinutes());
  /* the device list is what fills in the "기기 음성: …" line, and on Chrome it
     is empty until voiceschanged fires */
  devVoicesReady().then((list) => {
    devVoicePair(list);
    const vm = $("lVoiceMsg");
    if (vm && !vm.dataset.busy) vm.textContent = lessonVoiceLine();
  }).catch(() => {});
  const vm = $("lVoiceMsg");
  if (vm) vm.textContent = lessonVoiceLine();
  lessonFillProgress();
}

/* 설정 › 오디오 수업 음성: the remembered Cloud TTS failure, under the key */
function lessonFillTtsFail(){
  const box = $("lTtsFail");
  if (!box) return;
  const f = lset.ttsFail;
  box.hidden = !f;
  box.textContent = f
    ? "최근 수업에서 고품질 음성이 실패했습니다 (" + (f.date || "") + (f.status ? ", TTS " + f.status : "") + ").\n" +
      (f.cause || "") + "\n" + (f.fix || "") + "\n고친 뒤 다음 수업이 고품질 음성으로 만들어지면 이 안내는 사라집니다."
    : "";
}

/* 설정 › 수업 진도 */
function lessonFillProgress(){
  const box = $("lProgress");
  if (!box) return;
  const g = grammarState(), T = GRAMMAR_STEPS.length;
  box.textContent = "새 단어 진도: " + newWordsCount() + "개 배움 (목록 " + wordList().length + "개)" +
    " · 다음 문법: " + circNum(g.n % T + 1) + "/" + T + (g.n >= T ? " (복습 회차)" : "");
}
function lessonResetWords(){
  if (!confirm("새 단어 진도를 처음부터 다시 시작합니다.\n지금까지 배운 단어 기록(" + newWordsCount() +
               "개)이 지워지고 되돌릴 수 없습니다. 계속할까요?")) return;
  jset(NEW_WORDS_KEY, { learned: {} });
  lessonFillProgress();
}

function lessonSaveSettings(){
  const eng = $("lEngine");
  if (!eng) return;
  const before = lset.ttsKey;
  const sexBefore = lset.sexEs + "|" + lset.sexKo;
  lset.engine = eng.value === "cloud" ? "cloud" : "device";
  lset.ttsKey = $("lTtsKey").value.trim();
  if ($("lSexEs")) lset.sexEs = $("lSexEs").value === "male" ? "male" : "female";
  if ($("lSexKo")) lset.sexKo = $("lSexKo").value === "male" ? "male" : "female";
  if ($("lMinutes")) lset.minutes = $("lMinutes").value === "20" ? 20 : 10;
  /* a new key means a new project, and a new gender means a different voice:
     either way the remembered pick has to be made again */
  if (lset.ttsKey !== before || sexBefore !== lset.sexEs + "|" + lset.sexKo){
    lset.voiceEs = ""; lset.voiceEsCode = ""; lset.voiceKo = ""; lset.voiceKoCode = "";
  }
  /* a different key gets a fresh chance: the old key's failure says nothing about it */
  if (lset.ttsKey !== before) delete lset.ttsFail;
  lpersist();
}

let testAudio = null, testUrl = "";

/* ---- 시험 듣기 ---- */

const PREVIEW_TEXT = {
  es: "Buenas tardes. Vamos a empezar la lección de hoy.",
  ko: "안녕하세요. 오늘 수업을 시작하겠습니다."
};
/* One line per voice is billed once and then replayed from here: the point of
   the button is to compare voices, and comparing should not cost per press.
   Capped, because the map would otherwise hold every voice ever auditioned —
   each one a few tens of kB of mp3 — for the life of the page. */
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 8;

function previewRemember(name, blob){
  previewCache.delete(name);                       // re-insert so it counts as newest
  previewCache.set(name, blob);
  while (previewCache.size > PREVIEW_CACHE_MAX){
    previewCache.delete(previewCache.keys().next().value);
  }
}

/* Only the three voice buttons touch this; they share one global `lset`, so
   two of them running at once would interleave their snapshot/restore and one
   would put back what the other had just changed. */
let voiceBusy = false;
function voiceBtns(disabled){
  for (const id of ["lTestVoice", "lTryEs", "lTryKo"]){
    const b = $(id);
    if (b) b.disabled = disabled;
  }
}

function previewPlay(blob){
  /* pressing a second time before the first finished used to leak the first
     object URL: the audio was paused but the URL was never revoked */
  if (testAudio){ try { testAudio.pause(); } catch (e) {} }
  if (testUrl){ try { URL.revokeObjectURL(testUrl); } catch (e) {} testUrl = ""; }

  const url = URL.createObjectURL(blob);
  testUrl = url;
  const a = new Audio(url);
  testAudio = a;
  const done = () => {
    if (testUrl === url){ try { URL.revokeObjectURL(url); } catch (e) {} testUrl = ""; }
    if (testAudio === a) testAudio = null;
  };
  a.onended = done;
  a.onerror = done;
  a.play().catch(done);
}

/* Everything the voice buttons are allowed to change, so it can be put back
   exactly. Auditioning is not saving: only the 저장 button may persist. */
function voiceSnapshot(){
  return { ttsKey: lset.ttsKey, sexEs: lset.sexEs, sexKo: lset.sexKo,
           voiceEs: lset.voiceEs, voiceEsCode: lset.voiceEsCode,
           voiceKo: lset.voiceKo, voiceKoCode: lset.voiceKoCode };
}
/* `chars` is deliberately outside the snapshot: a preview that really was
   synthesised really was billed, and that count must survive the restore. */
function voiceRestore(snap){
  Object.assign(lset, snap);
  lpersist();
}
/* the dialog's own values, which may differ from what is stored */
function voiceApplyDialog(key){
  lset.ttsKey = key;
  if ($("lSexEs")) lset.sexEs = $("lSexEs").value === "male" ? "male" : "female";
  if ($("lSexKo")) lset.sexKo = $("lSexKo").value === "male" ? "male" : "female";
  lset.voiceEs = ""; lset.voiceEsCode = ""; lset.voiceKo = ""; lset.voiceKoCode = "";
}

async function lessonPreview(side){
  const msg = $("lVoiceMsg");
  if (!msg || voiceBusy) return;
  const text = PREVIEW_TEXT[side];

  voiceBusy = true;
  voiceBtns(true);
  msg.dataset.busy = "1";

  /* whichever engine the dialog is currently set to, not whichever was saved */
  const wantCloud = $("lEngine") && $("lEngine").value === "cloud";
  const key = $("lTtsKey") ? $("lTtsKey").value.trim() : "";
  /* Put back no matter how this ends, success included: auditioning a voice
     must never be what writes settings — only 저장 does that. */
  const snap = voiceSnapshot();

  try {
    if (!wantCloud || !key){
      const list = await devVoicesReady().catch(() => []);
      const v = devPickVoice(side, list);
      if (!v){
        msg.textContent = side === "es"
          ? "이 기기에는 스페인어 목소리가 없습니다. 고품질 음성을 켜시는 것을 권합니다."
          : "이 기기에는 한국어 목소리가 없습니다.";
        return;
      }
      /* the device pick IS remembered — it is a property of this phone, not of
         an unsaved dialog, and nothing is billed for it */
      devVoicePair(list);
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.voice = v; u.lang = v.lang || (side === "es" ? "es-MX" : "ko-KR");
        window.speechSynthesis.speak(u);
        msg.textContent = "기기 음성: " + v.name;
      } catch (e) { msg.textContent = "기기 음성을 재생하지 못했습니다."; }
      return;
    }

    voiceApplyDialog(key);
    msg.textContent = "듣는 중…";
    try {
      const lame = await loadLame();
      await ttsEnsureVoices();
      const name = side === "es" ? lset.voiceEs : lset.voiceKo;

      let blob = previewCache.get(name);
      if (!blob){
        const got = await ttsSay(text, side, 1);
        addTtsChars(text.length);
        const w = mp3Writer(lame, got.sr);
        w.write(got.pcm);
        blob = w.finish();
        previewRemember(name, blob);
      }
      previewPlay(blob);
      msg.textContent = name;
    } catch (e) {
      msg.textContent = (e && e.message) ? String(e.message).split("\n")[0] : "들어보지 못했습니다.";
    }
  } finally {
    /* ttsEnsureVoices persists the moment it picks, so this has to undo disk
       as well as memory — on the way out of every path, not just the failures */
    if (wantCloud && key) voiceRestore(snap);
    delete msg.dataset.busy;
    voiceBtns(false);
    voiceBusy = false;
  }
}

async function lessonTestVoice(){
  const msg = $("lVoiceMsg");
  if (!msg || voiceBusy) return;
  const key = $("lTtsKey").value.trim();
  if (!key){ msg.textContent = "키를 먼저 넣어주십시오."; return; }

  voiceBusy = true;
  voiceBtns(true);
  /* The dialog can still be dismissed without saving, so the test must not be
     what writes settings — not even when it succeeds. Work on a copy and put
     the copy back on the way out; 저장 is the only thing that persists. */
  const snap = voiceSnapshot();
  voiceApplyDialog(key);
  msg.dataset.busy = "1";
  msg.textContent = "확인 중…";

  try {
    const lame = await loadLame();
    await ttsEnsureVoices();
    const text = PREVIEW_TEXT.es;
    /* read before the restore puts the old names back */
    const esName = lset.voiceEs, koName = lset.voiceKo;

    let blob = previewCache.get(esName);
    if (!blob){
      const got = await ttsSay(text, "es", 1);
      addTtsChars(text.length);
      const w = mp3Writer(lame, got.sr);
      w.write(got.pcm);
      blob = w.finish();
      previewRemember(esName, blob);
    }
    previewPlay(blob);

    msg.textContent = "정상입니다. " + esName + " / " + koName;
    if ($("lEngine")) $("lEngine").value = "cloud";   // a working key clearly means they want it
  } catch (e) {
    msg.textContent = (e && e.message) ? String(e.message).split("\n")[0] : "확인에 실패했습니다.";
  } finally {
    voiceRestore(snap);                               // memory and disk, on every path
    delete msg.dataset.busy;
    voiceBtns(false);
    voiceBusy = false;
  }
}

/* ---------------- wire up ---------------- */

(function wireLesson(){
  const open = $("openLesson");
  if (open) open.onclick = () => { openLesson().catch((e) => showError((e && e.message) || String(e))); };
  const shelf = $("openShelf");
  if (shelf) shelf.onclick = () => { openSavedLesson().catch((e) => showError((e && e.message) || String(e))); };
  const close = $("lClose");
  if (close) close.onclick = () => { stopPlayer(); closeDlg($("lesson")); };

  const qIn = $("lQ");
  if (qIn) qIn.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); askSend(); }
  };
  const qSend = $("lQSend");
  if (qSend) qSend.onclick = askSend;
  const qMic = $("lQMic");
  if (qMic) qMic.onclick = () => { askMic().catch(() => {}); };
  const qFold = $("lFold");
  if (qFold) qFold.onclick = () => askSetFold(!askFolded);
  const test = $("lTestVoice");
  if (test) test.onclick = lessonTestVoice;
  const tryEs = $("lTryEs");
  if (tryEs) tryEs.onclick = () => { lessonPreview("es").catch(() => {}); };
  const tryKo = $("lTryKo");
  if (tryKo) tryKo.onclick = () => { lessonPreview("ko").catch(() => {}); };
  const wReset = $("lWordsReset");
  if (wReset) wReset.onclick = lessonResetWords;
  const dlg = $("lesson");
  if (dlg) dlg.addEventListener("close", () => {
    stopPlayer();
    /* Every question still in flight — recording or converting — is abandoned,
       not sent: discardAskRecording marks all of them, so none can be inherited
       by the next translation. The epoch moves as well, which is what stops an
       answer already on its way from being filed against a reopened screen. */
    discardAskRecording();
    askEpoch++;
    askRecording = false;
    askConverting = false;
    askPending = null;
    askLock("idle");
    try { window.speechSynthesis.cancel(); } catch (e) {}
  });
})();
