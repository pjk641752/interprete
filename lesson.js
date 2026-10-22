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
  chars: { ym: "", n: 0 }
};
let lset = Object.assign({}, LESSON_DEFAULTS, jget(LESSON_KEY, {}));
function lpersist(){ jset(LESSON_KEY, lset); }

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

const SCRIPT_TIMEOUT_MS = 150000;   // writing the script is one long reasoning call

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
  section: 1.0                 // added on top, at a section boundary
};

const SEC = {
  intro:  { id: "intro",  title: "시작" },
  yday:   { id: "yday",   title: "0교시 · 어제 복습" },     // the date is added per lesson
  /* the ids stay what they were: 0교시 reads yesterday's rows by sectionId */
  newwords: { id: "newwords", title: "1교시 · 오늘의 새 단어" },
  words: { id: "words",  title: "2교시 · 대화 단어" },
  idioms: { id: "idioms", title: "3교시 · 연계 숙어" },
  sents:  { id: "sents",  title: "4교시 · 문장 해부" },
  grammar: { id: "grammar", title: "5교시 · 문법 한 칸" },
  pron:   { id: "pron",   title: "6교시 · lo·le·se 연습" },
  frames: { id: "frames", title: "7교시 · 말의 뼈대" },
  review: { id: "review", title: "마무리 복습" },
  outro:  { id: "outro",  title: "마무리" }
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

/* ---------------- lesson content from Gemini ---------------- */

const LESSON_PROMPT = [
  "You are writing the content of a spoken Spanish lesson for a Korean speaker living in",
  "Mexico, a complete beginner. Below is one JSON object:",
  "  today        — everything they interpreted today: es (Spanish), ko (Korean), an optional",
  "                 tip, and the study chunks they already saw. It may be EMPTY.",
  "  new_words    — today's new words for the beginner, chosen by the app (may be empty).",
  "  grammar_step — today's grammar topic: title, core (what to teach), how (how to explain it).",
  "  pronoun_hits — today's Spanish lines where the app spotted lo/la/le/se/me/te (may be empty).",
  "",
  "Return ONE JSON object and nothing else. No markdown, no code fence, no commentary.",
  "",
  "{",
  '  "new_words": [{"es":"","ko":"","example":{"es":"","ko":""},',
  '                 "times":[{"when":"지금","es":"","ko":""}],"en":"","en_say":""}],',
  '  "words":     [{"es":"","ko":"","note":"","en":"","en_say":""}],',
  '  "idioms":    [{"es":"","ko":"","from":"","note":"","en":"","en_say":""}],',
  '  "sentences": [{"es":"","ko":"","chunks":[{"es":"","ko":"","note":"","en":"","en_say":"",',
  '                 "times":[{"when":"지금","es":"","ko":""}]}]}],',
  '  "frames":    [{"type":"frame","es":"","ko":"","note":"","en":"","en_say":"",',
  '                 "today":{"es":"","ko":""},"swaps":[{"es":"","ko":""}],',
  '                 "forms":[{"who":"나","es":"","ko":""}]}],',
  '  "grammar":   {"explain":[""],"rule":"","examples":[{"es":"","ko":""}],',
  '                "table":[{"label":"","es":"","ko":""}],"en":"","en_say":"","quiz":[{"ko":"","es":""}]},',
  '  "pronoun":   {"points":[{"es":"","ko":"","who":"","what":""}],"quiz":[{"ko":"","es":""}]},',
  '  "outro": ""',
  "}",
  "",
  "If today is empty, return words, idioms, sentences and frames as empty arrays and write",
  "everything else as usual.",
  "",
  "new_words — exactly one item per entry of the input new_words, same order, es copied EXACTLY.",
  "  ko: the plain Korean meaning, short (a verb as ~하다, a word ending in -se as 자기 ~하다",
  "    only if that is how Koreans say it, e.g. bañarse 씻다, 목욕하다).",
  "  example: ONE very easy sentence of at most 7 words using the word, about the kitchen or",
  "    daily life when that is natural, in plain Mexican Spanish, with its Korean.",
  "  times: ONLY when the word is a verb: the same verb with 나 — now / already done / going to:",
  '    [{"when":"지금","es":"como","ko":"나는 먹어"},',
  '     {"when":"이미","es":"comí","ko":"나는 먹었어"},',
  '     {"when":"앞으로","es":"voy a comer","ko":"나는 먹을 거야"}]',
  "    For a word ending in -se use me: me baño / me bañé / me voy a bañar. Otherwise leave it empty.",
  "  Mexico first: when a word has a second meaning a beginner in Mexico will meet, put both in",
  "    ko, short (camión 트럭, 버스 / cuarto 방, 4분의 1 / llave 열쇠, 수도꼭지 / despedir 배웅하다,",
  "    해고하다 / almuerzo 늦은 아침 — 직장 점심은 la comida). caliente is for food and things only:",
  "    a hot person says tengo calor. Food words (huevo, leche, chile, plátano, pepino) are used",
  "    only in their food meaning — never build a double-meaning phrase with them.",
  "",
  "grammar — teach grammar_step, following its core and how, for a complete beginner.",
  "  explain: 2 or 3 short Korean sentences a child could follow. Show, do not name.",
  "  rule: the whole point in ONE short Korean line.",
  "  examples: 4 to 6 short, correct Mexican Spanish sentences that show the point, using",
  "    today's words and new_words where natural, each with its Korean.",
  "  table: OPTIONAL, 2 to 6 rows, only when a small table helps (persons, now/already/going-to,",
  "    endings). label is a short Korean tag: 나, 너, 그(당신), 우리, 그들 / 지금, 이미, 앞으로 / 그것을 …",
  "  en / en_say: OPTIONAL, one short English phrase that works the same way (I gave it to him).",
  "  quiz: exactly 2: a short Korean sentence and its Spanish answer, using today's point.",
  "",
  "pronoun — a two-minute drill on the little words lo, la, los, las, le, les, se, me, te.",
  "  points: 1 to 3. Prefer real lines from pronoun_hits, copied EXACTLY (the whole line or the",
  "    part that carries the little word). Skip a hit that is not really one of them — la or los",
  "    in front of a noun means 'the' and is not one. If no real hit is left, write 1 or 2 plain",
  "    everyday examples instead.",
  "    who: to whom, in plain Korean (그에게, 나에게, 자기 자신에게), or empty.",
  "    what: what, in plain Korean (그것을, 밥을), or empty.",
  "  quiz: exactly 3: a short Korean request or sentence and its Spanish, each using one of",
  "    these little words (그에게 그것을 줘 → Dáselo).",
  "",
  "words — 6 to 12 items: the Spanish worth memorising from today, most useful first.",
  "  es: the word or short chunk exactly as it appeared today. Never invent one.",
  "  ko: the plain dictionary meaning in Korean, short.",
  "  note: OPTIONAL one short Korean line, and only when there is something real to say —",
  "    an origin worth knowing (refri 는 refrigerador 를 줄인 말입니다), a Mexico-only usage,",
  "    a gender trap, a false friend. Otherwise leave it empty. Never restate the meaning.",
  "    An obvious or filler note is worse than no note.",
  "",
  "idioms — 2 to 4 set expressions that BRANCH OFF the words above",
  "  (fuego -> a fuego lento, meter -> meter la pata, moler -> no me muelas).",
  "  - Only expressions genuinely in daily use in Mexico. If you are not certain an expression",
  "    is real and common, leave it out. Returning 2 is better than inventing a 4th.",
  "  - from: the es of the word above that it branches from, exactly.",
  "  - note: one short Korean line on when it is used. Korean only — no Spanish inside it.",
  "",
  "sentences — 3 to 5 sentences from today worth memorising, copied EXACTLY as they appear.",
  "  ko: the Korean meaning.",
  "  chunks: 2 to 5 pieces, in the order they appear in the Spanish, together covering the",
  "    sentence. Each chunk is a unit: a verb phrase, a set expression (an idiom inside the",
  "    sentence is its own chunk), a noun with its article, a question opener.",
  "  chunks[].note: ONE short grammar line in Korean that a child could follow, about THIS chunk.",
  "    Good: al + 동작을 나타내는 말 은 '~할 때' 라는 뜻이에요 /",
  "          pon 은 poner(놓다)로 '놓아 줘' 하고 부탁할 때 쓰는 모양이에요 /",
  "          pedí 는 이미 끝난 일을 말할 때 모양이에요",
  "    Bad: anything that only re-translates the chunk, or any grammar term.",
  "    If a chunk carries no grammar worth a line, leave note empty.",
  "  chunks[].times: OPTIONAL, only for a chunk built on a verb, and in at most 3 chunks of",
  "    the whole lesson. The same verb side by side: now / already done / going to —",
  '    [{"when":"지금","es":"pido","ko":"나는 주문해"},',
  '     {"when":"이미","es":"pedí","ko":"나는 주문했어"},',
  '     {"when":"앞으로","es":"voy a pedir","ko":"나는 주문할 거야"}]',
  "    when is exactly 지금, 이미 or 앞으로. Use 나 as the person unless the chunk needs another.",
  "",
  "frames — 3 to 6 items: the BONES of speaking. Two kinds:",
  '  type "link": a connecting word that glues sentences together',
  "    (pero 그런데 / entonces 그러니까 / que ~라는 것 / pues 음, 그럼 / porque 왜냐하면 / así que 그래서).",
  '  type "frame": a fixed opening you keep and only swap the verb or noun after it',
  "    (creo que … 나는 ~라고 생각해 / quiero + 동작 / voy a + 동작 / parece que … /",
  "     tengo que + 동작 / puedo + 동작 / dicen que … / hay que + 동작).",
  "  Take the ones that are IN today's sentences first. Only if fewer than 3 are there, add basic",
  "  ones that fit naturally onto today's sentences.",
  '  es: only the fixed words, no placeholder and no Korean ("voy a", "creo que", "pero").',
  "  ko: what it means, with ~ where the swapped part goes (나는 ~할 거야).",
  "  note: OPTIONAL one child-simple Korean line on when people say it.",
  "  today: the sentence (or the part of it) from today's data that uses it, copied EXACTLY,",
  "    with its Korean. If none of today's sentences has it, leave today empty — never write",
  "    a made-up sentence in today.",
  "  swaps: 2 or 3 new short examples: the same frame with a different verb or noun, using",
  "    today's words where they fit (voy a moler el chile / voy a freír la calabaza).",
  '  forms: REQUIRED when es starts with a verb (voy a, quiero, tengo que, puedo, creo que...):',
  "    the frame with ONE example verb for each person, in this order, who exactly as written:",
  '    [{"who":"나","es":"voy a comer","ko":"나는 먹을 거야"},',
  '     {"who":"너","es":"vas a comer","ko":"너는 먹을 거야"},',
  '     {"who":"그(당신)","es":"va a comer","ko":"그는(당신은) 먹을 거야"},',
  '     {"who":"우리","es":"vamos a comer","ko":"우리는 먹을 거야"}]',
  '    For type "link" and for frames that do not change with the person (hay que, parece que),',
  "    leave forms empty.",
  "",
  "en / en_say — on new_words, words, idioms, chunks, frames and grammar, OPTIONAL: the closest English, so a",
  "  Korean who knows a little English gets it at once (creo que -> I think, a lo mejor -> maybe,",
  "  entonces -> so, pero -> but, voy a -> I'm going to ~). en is the English, 1 to 4 words.",
  "  en_say is how a Korean would write that English in Hangul (아이 띵크, 메이비, 아임 고잉 투).",
  "  Only when the match is real and helps; an English word that is merely the translation",
  "  of a plain noun (tazón -> bowl) is fine too, but leave both empty when nothing fits.",
  "",
  "GRAMMAR, CHILD-SIMPLE — applies to every Korean line you write:",
  "- Never use grammar terms: 과거분사, 현재분사, 접속법, 직설법, 재귀동사, 명령형, 부정사,",
  "  동사원형, 시제, 활용, 인칭, 목적격, 대명사, 전치사, 관사, 과거형, 미래형,",
  "  목적어, 주어, 동사, 명사, 형용사, 점과거, 불완료과거, 현재완료, 가정법.",
  "  Say what it DOES instead: 이미 끝난 일을 말할 때 모양 / 앞으로 할 일 /",
  "  바라는 마음일 때 que 뒤에서 모양이 살짝 바뀜 / 자기 몸에 하는 일일 때 붙는 me·te·se.",
  "  If a term is truly unavoidable, put it once in brackets after the plain words.",
  "- Prefer showing over naming: now / already / going-to side by side beats any rule.",
  "",
  "outro — ONE short Korean line closing the lesson, naming a concrete situation from today's",
  "  data where they should try one of these tomorrow. Under 60 characters.",
  "",
  "HARD RULES",
  "- Never introduce a Spanish word, name, number, price, time or place that is not in the data.",
  "  The exceptions are idioms (only expressions you are certain of), the swaps, forms and",
  "  times of a frame or chunk, and everything in new_words, grammar and pronoun — and those",
  "  must be plain, correct, everyday Spanish built on today's words where possible.",
  "  today is never an exception: it is always a real quote.",
  "- Every Korean line is plain, short and meant to be heard out loud. No markdown, no brackets",
  "  (the one exception: a bracketed term that grammar_step.how explicitly allows, once).",
  "- Skip greetings, yes/no, bare numbers and anything with no learning in it.",
  "- Merge duplicates. If the same phrase came up five times it appears once."
].join("\n");

/* Pull the JSON out of a reply that may carry a fence or stray prose. */
function lessonExtractJson(text){
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("JSON 을 찾지 못했습니다.");
  return JSON.parse(s.slice(a, b + 1));
}

/* English beside a Spanish item: shown as a badge, said once by the Korean
   voice. en must look like English and en_say like Hangul; anything else is
   dropped rather than read out wrong. Without en_say the Korean voice reads
   the English itself. */
const EN_RE = /^[A-Za-z][A-Za-z '’~.,?!\/-]{0,39}$/;
const EN_SAY_RE = /^[가-힣][가-힣 ~·',.-]{0,29}$/;
function cleanEn(x){
  const en = cleanStr(x && x.en);
  if (!en || !EN_RE.test(en)) return { en: "", enSay: "" };
  const say = cleanStr(x && x.en_say);
  return { en: en, enSay: EN_SAY_RE.test(say) ? say : "" };
}

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
function cleanPair(v){
  const o = asObj(v);
  const es = cleanStr(o && o.es), ko = cleanStr(o && o.ko);
  return es && ko ? { es: es, ko: ko } : null;
}
function cleanPairs(list, max){
  return (Array.isArray(list) ? list : []).map(cleanPair).filter(Boolean).slice(0, max);
}

/* A small table — the persons of a frame, or now / already / going-to of a
   verb. Rows are keyed by their label, kept in a fixed order, and a table of
   fewer than two rows is no table at all. */
const WHO_MAP = {
  "나": "나", "yo": "나",
  "너": "너", "tú": "너", "tu": "너",
  "그": "그(당신)", "그(당신)": "그(당신)", "그/당신": "그(당신)", "당신": "그(당신)",
  "그녀": "그(당신)", "él": "그(당신)", "el": "그(당신)", "usted": "그(당신)",
  "우리": "우리", "nosotros": "우리"
};
const WHO_ORDER = ["나", "너", "그(당신)", "우리"];
const WHEN_MAP = { "지금": "지금", "이미": "이미", "앞으로": "앞으로" };
const WHEN_ORDER = ["지금", "이미", "앞으로"];
function cleanTable(list, field, map, order){
  const got = new Map();
  for (const c of (Array.isArray(list) ? list : [])){
    const o = asObj(c);
    const key = map[cleanStr(o && o[field]).replace(/\s+/g, "").toLowerCase()];
    const p = cleanPair(o);
    if (!key || !p || got.has(key)) continue;
    got.set(key, { who: key, es: p.es, ko: p.ko });
  }
  const out = order.filter((k) => got.has(k)).map((k) => got.get(k));
  return out.length >= 2 ? out : [];
}

/* The frame itself is what gets spoken, so placeholders go: "voy a + 동사" and
   "creo que …" are said as "voy a" and "creo que". Korean left inside means
   the model ignored the format, and the item is not trusted. */
function cleanFrameEs(v){
  const s = cleanStr(v).replace(/\s*\+.*$/, "").replace(/…|\.{2,}|~/g, "").replace(/\s+/g, " ").trim();
  return /[가-힣]/.test(s) ? "" : s;
}

/* "today" must be a real quote. It is checked against what was actually
   interpreted today, punctuation and case aside; a line that is not there is
   not thrown away but no longer called today's — it becomes a made example. */
function quoteKey(s){
  return " " + String(s || "").toLowerCase().normalize("NFC")
    .replace(/[¿¡.,!?;:"'«»“”()]/g, " ").replace(/\s+/g, " ").trim() + " ";
}
function isQuoted(es, sources){
  if (!sources) return true;
  const k = quoteKey(es);
  return k.trim() !== "" && sources.some((s) => s.indexOf(k) >= 0);
}

const MAX_FRAMES = 6, MAX_TIMES = 3;

function cleanFrames(list, sources){
  const out = [], seen = new Set();
  for (const f of (Array.isArray(list) ? list : [])){
    const o = asObj(f);
    if (!o) continue;
    const es = cleanFrameEs(o.es), ko = cleanStr(o.ko);
    if (!es || !ko || seen.has(es.toLowerCase())) continue;
    let today = cleanPair(o.today);
    let swaps = cleanPairs(o.swaps, 3);
    if (today && !isQuoted(today.es, sources)){
      swaps = [today].concat(swaps).slice(0, 3);
      today = null;
    }
    /* meaning, then at least one example: a frame with nothing to show is dropped */
    if (!today && !swaps.length) continue;
    seen.add(es.toLowerCase());
    out.push(Object.assign({
      type: o.type === "link" ? "link" : "frame",
      es: es, ko: ko, note: cleanStr(o.note),
      today: today, swaps: swaps,
      forms: o.type === "link" ? [] : cleanTable(o.forms, "who", WHO_MAP, WHO_ORDER)
    }, cleanEn(o)));
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
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

/* A small table whose first column is a free short Korean label (나, 이미,
   그것을 …), as the grammar part writes it. */
function cleanLabelTable(list){
  const out = [];
  for (const c of (Array.isArray(list) ? list : [])){
    const o = asObj(c), p = cleanPair(o);
    const label = cleanStr(o && (o.label || o.who || o.when));
    if (!p || !label || label.length > 12) continue;
    out.push({ who: label, es: p.es, ko: p.ko });
    if (out.length >= 6) break;
  }
  return out.length >= 2 ? out : [];
}

/* new_words: only the words the app asked for, in its order. A missing or
   half-written one is simply not taught today — and so not counted as learned. */
function cleanNewWords(list, want, ban){
  const got = new Map();
  for (const x of (Array.isArray(list) ? list : [])){
    const o = asObj(x);
    const es = cleanStr(o && o.es), ko = cleanStr(o && o.ko);
    if (!es || !ko || got.has(foldEs(es))) continue;
    got.set(foldEs(es), o);
  }
  const out = [];
  for (const w of (Array.isArray(want) ? want : [])){
    const o = got.get(foldEs(w));
    if (!o) continue;
    const ex = cleanPair(o.example);
    out.push(Object.assign({
      es: w, ko: cleanStr(o.ko), ex: ex,
      times: cleanTable(o.times, "when", WHEN_MAP, WHEN_ORDER)
    }, cleanEn(o)));
  }
  return out;
}

function cleanGrammar(raw, ban){
  const o = asObj(raw);
  if (!o) return null;
  const explain = (Array.isArray(o.explain) ? o.explain : [o.explain])
    .map((s) => banScrub(s, ban)).filter(Boolean).slice(0, 3);
  const examples = cleanPairs(o.examples, 6);
  const quiz = (Array.isArray(o.quiz) ? o.quiz : []).map(cleanPair).filter(Boolean).slice(0, 2);
  const g = Object.assign({
    explain: explain, rule: banScrub(o.rule, ban), examples: examples,
    table: cleanLabelTable(o.table), quiz: quiz
  }, cleanEn(o));
  return g.explain.length || g.rule || g.examples.length || g.quiz.length ? g : null;
}

function cleanPronoun(raw, sources, ban){
  const o = asObj(raw);
  if (!o) return null;
  const short = (v) => { const s = banScrub(v, ban); return s.length <= 14 ? s : ""; };
  const points = (Array.isArray(o.points) ? o.points : []).map((x) => {
    const p = cleanPair(x);
    return p ? { es: p.es, ko: p.ko, who: short(x.who), what: short(x.what),
                 today: !!sources && sources.length > 0 && isQuoted(p.es, sources) } : null;
  }).filter(Boolean).slice(0, 3);
  const quiz = (Array.isArray(o.quiz) ? o.quiz : []).map(cleanPair).filter(Boolean).slice(0, 3);
  return points.length || quiz.length ? { points: points, quiz: quiz } : null;
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
   silent segment or a blank line later on. Every new part is optional: a
   reply cut short loses that part, never the lesson.
   `sourceEs`, when given, is the Spanish actually said today; it is what a
   frame's "today" example is checked against. An EMPTY array means nothing
   was said today: then nothing may claim to come from today's talk.
   `cur`, when given, is the day's curriculum plan (curriculumPlan). */
function lessonNormalise(raw, sourceEs, cur){
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("대본 형식이 올바르지 않습니다.");
  const sources = Array.isArray(sourceEs) ? sourceEs.map(quoteKey) : null;
  const silent = Array.isArray(sourceEs) && sourceEs.length === 0;
  const ban = { used: false };
  const note = (v) => banScrub(v, ban);

  const words = (silent ? [] : Array.isArray(raw.words) ? raw.words : [])
    .map((w) => Object.assign({ es: cleanStr(w && w.es), ko: cleanStr(w && w.ko), note: note(w && w.note) },
                              cleanEn(w)))
    .filter((w) => w.es && w.ko)
    .slice(0, 14);

  /* today's new words, minus any that turned up in today's own words */
  const talked = new Set(words.map((w) => foldEs(w.es)));
  const newWords = cleanNewWords(raw.new_words, cur && cur.newWords, ban)
    .filter((w) => !talked.has(foldEs(w.es)));
  const grammar = cur && cur.grammar ? cleanGrammar(raw.grammar, ban) : null;
  if (!words.length && !newWords.length && !grammar) throw new Error("대본에 단어가 없습니다.");

  const known = words.map((w) => w.es);
  const idioms = (silent ? [] : Array.isArray(raw.idioms) ? raw.idioms : [])
    .map((x) => Object.assign({
      es: cleanStr(x && x.es), ko: cleanStr(x && x.ko),
      from: cleanStr(x && x.from), note: note(x && x.note)
    }, cleanEn(x)))
    .filter((x) => x.es && x.ko)
    .slice(0, 5);
  for (const x of idioms) if (known.indexOf(x.from) < 0) x.from = "";

  let timesLeft = MAX_TIMES;
  const sentences = (silent ? [] : Array.isArray(raw.sentences) ? raw.sentences : [])
    .map((s) => ({
      es: cleanStr(s && s.es), ko: cleanStr(s && s.ko),
      chunks: (Array.isArray(s && s.chunks) ? s.chunks : [])
        .map((c) => Object.assign({
          es: cleanStr(c && c.es), ko: cleanStr(c && c.ko), note: note(c && c.note),
          times: cleanTable(c && c.times, "when", WHEN_MAP, WHEN_ORDER)
        }, cleanEn(c)))
        .filter((c) => c.es && c.ko)
        .slice(0, 6)
    }))
    .filter((s) => s.es && s.ko)
    .slice(0, 6);
  /* a verb table is a treat, not every chunk: only the first few survive */
  for (const s of sentences) for (const c of s.chunks){
    if (c.times.length && timesLeft > 0) timesLeft--; else c.times = [];
  }

  const frames = silent ? [] : cleanFrames(raw.frames, sources);
  for (const f of frames) f.note = note(f.note);

  return {
    newWords: newWords,
    words: words,
    idioms: idioms,
    sentences: sentences,
    grammar: grammar,
    pronoun: cleanPronoun(raw.pronoun, sources, ban),
    frames: frames,
    outro: banScrub(raw.outro, ban) || "오늘 수업 끝. 내일 한 번 꼭 써먹어 보세요."
  };
}

/* `cur` is the day's curriculum plan: which new words to explain, which
   grammar step, and the lines where a lo/le/se was spotted. It travels in the
   same single call as today's conversation. */
async function lessonWriteScript(rows, cur){
  const payload = rows.map((e) => ({
    es: spanishOf(e),
    ko: koreanOf(e),
    tip: e.tip || undefined,
    chunks: (e.study || []).map((s) => s.es + " = " + s.ko)
  }));
  const step = cur && cur.grammar ? GRAMMAR_STEPS[cur.grammar.idx] : null;
  const body = JSON.stringify({
    today: payload,
    new_words: cur ? cur.newWords : [],
    grammar_step: step ? { title: step.title, core: step.core, how: step.how } : null,
    pronoun_hits: cur ? cur.pronounHits : []
  });
  /* the reply is long now (ten new words, a grammar part, a drill on top of
     the old parts): the cap is set well above it, so a cut-off reply means
     something went wrong rather than that the lesson simply grew */
  const cfg = { temperature: 0.4, thinking_level: "medium", max_output_tokens: 32768 };

  const replies = [];
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++){
    const nudge = attempt === 0 ? "" :
      "\n\nYour previous reply could not be parsed. Return ONLY the JSON object, starting " +
      "with { and ending with }. No fence, no text before it and none after it.";
    try {
      /* callPlain has no deadline of its own, and this call holds the app's
         `busy` flag: without a cap, one stalled request would leave the
         microphone and the typing box disabled until a reload */
      const reply = await Promise.race([
        callPlain(LESSON_PROMPT + nudge, body, cfg),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error("대본 요청이 " + (SCRIPT_TIMEOUT_MS / 1000) + "초 안에 끝나지 않았습니다.")),
          SCRIPT_TIMEOUT_MS))
      ]);
      replies.push(String(reply || ""));
      return lessonNormalise(lessonExtractJson(reply), payload.map((p) => p.es), cur);
    } catch (e) {
      if (/API \d{3}/.test((e && e.message) || "")) throw e;   // key, quota, model: do not retry
      lastErr = e;
    }
  }
  /* both replies were cut off or malformed: keep what the longer one finished
     — a part that was cut is simply missing, the rest of the lesson stands */
  const longest = replies.sort((a, b) => b.length - a.length)[0];
  if (longest){
    try { return lessonNormalise(lessonSalvageJson(longest), payload.map((p) => p.es), cur); }
    catch (e) {}
  }
  throw new Error("대본을 만들지 못했습니다.\n" + ((lastErr && lastErr.message) || ""));
}

/* ---------------- segments and display rows ---------------- */

/* 와 or 과 after a Hangul word, by whether its last syllable ends in a
   consonant; after anything else (English the Korean voice reads as is)
   a spaced 하고, which never sounds wrong. */
function withKo(word){
  const s = String(word || "").replace(/[\s~.,'·-]+$/, "");
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 ? "과" : "와";
  return " 하고";
}
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
function isoLabel(iso){ return Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일"; }

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
const PRON_LEAD = "lo·le·se 연습이에요. 문장마다 ‘누구에게?’ 와 ‘무엇을?’ 만 짚어 볼게요.";
const PRON_QUIZ_LEAD = "퀴즈 세 개예요. 한국어를 듣고, 3초 안에 스페인어로 말해 보세요.";

/* What the drill teaches today: Gemini's points and quiz where it wrote
   them, the base set filling whatever is missing. Never empty. */
function pronounPlan(p, iso){
  const L = PRON_BASE.length;
  const start = ((dayNum(iso) * 5) % L + L) % L;          // a different few each day
  const points = p && p.points ? p.points.slice(0, 3) : [];
  const quiz = p && p.quiz ? p.quiz.slice(0, PRON_QUIZ) : [];
  const used = new Set(points.concat(quiz).map((x) => foldEs(x.es)));
  const spare = [];
  for (let i = 0; i < L; i++){
    const b = PRON_BASE[(start + i) % L];
    if (!used.has(foldEs(b.es))) spare.push(b);
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
  return {
    iso: iso,
    newWords: pick.words, wordsAgain: pick.again, oldWords: pick.oldWords,
    learnedBefore: pick.learnedBefore,
    wordReview: newWordsReview(iso),
    grammar: grammarPick(iso),
    pronounHits: pronounHits(sourceEs)
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
}

/* ---------------- 0교시 — yesterday's review ----------------

   Built by code from the previous saved lesson — no extra Gemini call. It reads
   that lesson's display rows, whose sectionId/kind/es/ko have been the same
   since the first version, so a lesson from before 4교시 existed simply has no
   frames to offer. Words are never reviewed here: sentences, expressions and
   frames are. What the user asked about yesterday comes first. */
const YDAY_SENTS = 2, YDAY_EXPR_MIN = 3, YDAY_EXPR_MAX = 6;
const YDAY_MAX_MS = 270000;         // about four and a half minutes, everything in
const YDAY_PRI = { frame: 1, idiom: 2, sent: 3 };

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

/* The content becomes a flat segment list (what gets spoken) plus display rows
   (what gets shown). A three-times repeat is several segments inside one row.
   `prev`, when given, is the saved lesson before this one: 0교시 reviews it.
   `cur`, when given, is the day's course plan (curriculumPlan): the new words
   to review in 0교시, and the grammar step 5교시 teaches. */
function lessonBuild(content, when, prev, cur){
  const segs = [], rows = [];
  let sid = 0, gid = 0;

  function row(sec, kind, fields){
    gid++;
    rows.push(Object.assign({ gid: "g" + gid, sectionId: sec.id, sectionTitle: sec.title, kind: kind }, fields));
    return "g" + gid;
  }
  function seg(sec, g, speaker, text, pause, rate){
    text = cleanStr(text);
    if (!text) return;
    sid++;
    segs.push({
      id: "s" + sid, speaker: speaker, text: text, rate: rate || 1,
      pauseAfter: pause, sectionId: sec.id, sectionTitle: sec.title, gid: g
    });
  }

  /* the English comparison: a badge on screen, one short Korean line aloud.
     The ~ comes out of the spoken text only — the Korean voice reads it aloud
     as «물결». The badge on screen is built from item.en and keeps it. */
  function enLine(sec, item){
    if (!item.en) return;
    const say = (item.enSay || item.en).replace(/\s*~\s*/g, " ").replace(/\s+/g, " ").trim();
    const gg = row(sec, "en", { en: item.en });
    seg(sec, gg, "ko", "영어로는 " + say + withKo(say) + " 비슷해요.", P.en);
  }
  /* a small table on screen; aloud, every line Spanish then Korean */
  function tableRow(sec, cap, capSay, table){
    const gg = row(sec, "table", { ko: cap, table: table });
    seg(sec, gg, "ko", capSay, P.tableLead);
    table.forEach((c, k) => {
      seg(sec, gg, "es", c.es, P.frameEs);
      seg(sec, gg, "ko", sayKo(c.ko), k === table.length - 1 ? P.wordKoLast : P.frameKo);
    });
  }

  /* a quiz line: the Korean, a gap to answer in, the Spanish, a gap to repeat.
     On screen the Spanish stays covered until it plays (see lessonTimeline). */
  /* a meaning may be written "~ 뒤에": the ~ is for the eye, not the ear */
  const plain = (s) => String(s || "").replace(/\s*~\s*/g, " ").replace(/\s+/g, " ").trim();
  function quizRow(sec, item, badge){
    const gg = row(sec, "pair", { es: item.es, ko: item.ko, badge: badge, quiz: true });
    seg(sec, gg, "ko", plain(item.ko), P.quizThink);
    seg(sec, gg, "es", item.es, P.quizFollow);
  }

  const frames = Array.isArray(content.frames) ? content.frames : [];
  const newWords = Array.isArray(content.newWords) ? content.newWords : [];
  const W = content.words.length, I = content.idioms.length, S = content.sentences.length;
  const F = frames.length, NW = newWords.length;
  /* the study day (03:00 local boundary, see studyDate in app.js), so the
     stored key, the spoken date and the label on screen are all the one day —
     a lesson made at half past midnight is still yesterday's lesson */
  const iso = studyDate(when);
  const dateLabel = Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일";

  const plan = reviewPlan(prev, iso);
  const wordQuiz = cur && Array.isArray(cur.wordReview) ? cur.wordReview : [];
  const R = (plan ? plan.items.length : 0) + wordQuiz.length;
  const G = cur && cur.grammar ? cur.grammar : null;
  const step = G ? GRAMMAR_STEPS[G.idx] : null;
  /* something 0교시 just reviewed is said once today, not three times */
  const reviewed = new Set(plan ? plan.items.map((it) => it.key) : []);
  const again = (es) => reviewed.size > 0 && reviewed.has(reviewKey(String(es || "").replace(/\s*…$/, "")));

  /* intro */
  const parts = [];
  if (NW) parts.push("새 단어 " + NW + "개");
  if (step) parts.push("문법은 ‘" + step.title.split(" — ")[0] + "’");
  if (W) parts.push((NW ? "대화 단어 " : "단어 ") + W + "개");
  if (W || I) parts.push("보너스 숙어 " + I + "개");
  if (W || S) parts.push("문장 " + S + "개");
  if (F) parts.push("말의 뼈대 " + F + "개");
  const introText = dateLabel + " 스페인어 수업입니다. " +
    (R ? "먼저 " + (plan ? (plan.yesterday ? "어제" : "지난 수업에서") : "지난번에") +
         " 배운 표현 " + R + "개를 복습하고, 오늘은 " : "오늘은 ") +
    parts.join(", ") + (parts.length ? ", 그리고 " : "") + "lo·le·se 연습" +
    "입니다. 눈 감고, 들리는 대로 따라 하세요.";
  let g = row(SEC.intro, "say", { ko: introText });
  seg(SEC.intro, g, "ko", introText, P.intro);

  /* 0교시 — yesterday, as a quiz: the meaning, a gap to answer, the answer.
     On screen the Spanish stays covered until its segment plays. The new
     words of the last day, and a couple from about a week ago, come after. */
  if (plan || wordQuiz.length){
    const label = plan ? plan.label : isoLabel(wordQuiz[0].d);
    const Y = { id: SEC.yday.id, title: SEC.yday.title + " (" + label + ")" };
    const BADGE = { frame: "어제 뼈대", idiom: "어제 숙어", sent: "어제 문장" };
    const lead = plan ? plan.lead : "먼저 지난번에 배운 새 단어를 복습할게요. " + REVIEW_HOW;
    g = row(Y, "say", { ko: lead });
    seg(Y, g, "ko", lead, P.lead);
    for (const it of (plan ? plan.items : [])){
      const parts = reviewSegs(it);
      g = row(Y, "pair", { es: it.show, ko: it.ko, badge: BADGE[it.type], quiz: true });
      let exRow = null;
      for (const s of parts){
        if (s.ex && !exRow) exRow = row(Y, "pair", { es: it.ex.es, ko: it.ex.ko, badge: "바꿔 끼우기" });
        seg(Y, s.ex ? exRow : g, s.speaker, s.text, s.pause);
      }
    }
    if (wordQuiz.length){
      if (plan){
        g = row(Y, "say", { ko: "이번엔 새 단어예요." });
        seg(Y, g, "ko", "이번엔 새 단어예요.", P.lead);
      }
      for (const w of wordQuiz) quizRow(Y, w, w.when === "week" ? "지난주 단어" : "지난번 새 단어");
    }
    g = row(Y, "say", { ko: REVIEW_END });
    seg(Y, g, "ko", REVIEW_END, P.lead);
  }

  /* 1교시 — today's new words from the course list: the meaning, the word
     three times, one easy example, now / already / going-to for a verb */
  if (NW){
    const lead0 = "오늘의 새 단어 " + NW + "개예요." +
      (cur && cur.wordsAgain ? " 목록을 한 바퀴 다 돌아서, 오래전에 배운 단어도 다시 꺼냈어요." : "") +
      " 들릴 때마다 소리 내어 따라 하세요.";
    g = row(SEC.newwords, "say", { ko: lead0 });
    seg(SEC.newwords, g, "ko", lead0, P.lead);
    newWords.forEach((w, i) => {
      const lead = ordKo(i + 1) + ". " + w.ko + ".";
      g = row(SEC.newwords, "lead", { ko: lead });
      seg(SEC.newwords, g, "ko", plain(lead), P.lead);
      g = row(SEC.newwords, "pair", { es: w.es, ko: w.ko, badge: "×3" });
      for (let k = 0; k < 3; k++){
        seg(SEC.newwords, g, "es", w.es, P.wordEs);
        seg(SEC.newwords, g, "ko", plain(w.ko), k === 2 ? P.wordKoLast : P.wordKo);
      }
      if (w.ex){
        g = row(SEC.newwords, "pair", { es: w.ex.es, ko: w.ex.ko, badge: "예문" });
        seg(SEC.newwords, g, "es", w.ex.es, P.frameEs);
        seg(SEC.newwords, g, "ko", w.ex.ko, P.frameKo);
      }
      if (w.times && w.times.length){
        tableRow(SEC.newwords, "지금 · 이미 · 앞으로",
          "지금, 이미 끝난 일, 앞으로 할 일로 들어 볼게요.", w.times);
      }
      enLine(SEC.newwords, w);
    });
  }

  /* 2교시 — each word three times */
  content.words.forEach((w, i) => {
    const lead = ordKo(i + 1) + ". " + w.ko + "." + (w.note ? " " + w.note : "");
    g = row(SEC.words, "lead", { ko: lead });
    seg(SEC.words, g, "ko", lead, P.lead);

    const n = again(w.es) ? 1 : 3;
    g = row(SEC.words, "pair", { es: w.es, ko: w.ko, badge: n === 1 ? "어제 복습" : "×3" });
    for (let k = 0; k < n; k++){
      seg(SEC.words, g, "es", w.es, P.wordEs);
      seg(SEC.words, g, "ko", w.ko, k === n - 1 ? P.wordKoLast : P.wordKo);
    }
    enLine(SEC.words, w);
  });

  /* 2교시 — expressions branching off those words */
  content.idioms.forEach((x, i) => {
    const lead = "보너스 " + ordKo(i + 1) + ". " + x.ko + "." + (x.note ? " " + x.note : "");
    g = row(SEC.idioms, "lead", { ko: lead, from: x.from });
    seg(SEC.idioms, g, "ko", lead, P.lead);

    const n = again(x.es) ? 1 : 3;
    g = row(SEC.idioms, "pair", { es: x.es, ko: x.ko, badge: n === 1 ? "어제 복습" : "×3", from: x.from });
    for (let k = 0; k < n; k++){
      seg(SEC.idioms, g, "es", x.es, P.wordEs);
      seg(SEC.idioms, g, "ko", x.ko, k === n - 1 ? P.wordKoLast : P.wordKo);
    }
    if (n === 3) enLine(SEC.idioms, x);
  });

  /* 3교시 — a sentence taken apart, then put back together */
  content.sentences.forEach((s, i) => {
    const lead = ordKo(i + 1) + " 문장입니다.";
    g = row(SEC.sents, "lead", { ko: lead });
    seg(SEC.sents, g, "ko", lead, P.sentLead);

    g = row(SEC.sents, "slow", { es: s.es, badge: "느리게" });
    seg(SEC.sents, g, "es", s.es, P.sentSlow, SLOW_RATE);

    g = row(SEC.sents, "say", { ko: s.ko });
    seg(SEC.sents, g, "ko", s.ko, P.sentMean);

    s.chunks.forEach((c) => {
      if (c.note){
        g = row(SEC.sents, "note", { ko: c.note });
        seg(SEC.sents, g, "ko", c.note, P.note);
      }
      g = row(SEC.sents, "pair", { es: c.es, ko: c.ko, badge: "×2" });
      seg(SEC.sents, g, "es", c.es, P.chunkEs);
      seg(SEC.sents, g, "ko", c.ko, P.chunkKo);
      seg(SEC.sents, g, "es", c.es, P.chunkEs);
      enLine(SEC.sents, c);
      if (c.times && c.times.length){
        tableRow(SEC.sents, "지금 · 이미 · 앞으로",
          "지금, 이미 끝난 일, 앞으로 할 일로 나란히 들어 볼게요.", c.times);
      }
    });

    g = row(SEC.sents, "full", { es: s.es, ko: s.ko, badge: "×2" });
    seg(SEC.sents, g, "es", s.es, P.full);
    seg(SEC.sents, g, "es", s.es, P.full);
  });

  /* 5교시 — one step of the grammar course. The last two steps first, in a
     line each; then today's: plain words, the rule in one line, examples, a
     small table, English, and two quiz lines. Whatever Gemini did not write
     falls back to the step's own rule and examples, so the step is never
     skipped. */
  if (step){
    const gc = content.grammar || null;
    if (G.recap.length){
      g = row(SEC.grammar, "say", { ko: "지난 문법 다시 보기예요." });
      seg(SEC.grammar, g, "ko", "지난 문법 다시 보기예요.", P.lead);
      for (const r of G.recap){
        const st = GRAMMAR_STEPS[r], x = st.ex[0];
        g = row(SEC.grammar, "pair", { es: x.es, ko: x.ko, badge: st.title.split(" — ")[0] });
        seg(SEC.grammar, g, "ko", sayKo(st.rule), P.lead);
        seg(SEC.grammar, g, "es", x.es, P.frameEs);
        seg(SEC.grammar, g, "ko", x.ko, P.frameKo);
      }
    }
    const head = "오늘의 문법, " + ordKo(G.idx + 1) + " 칸이에요. " + step.title.replace(" — ", ", ") + "." +
      (G.round > 0 ? " 한 바퀴를 다 돌아서, 이번은 복습 회차예요." : "");
    g = row(SEC.grammar, "lead", { ko: head, badge: circNum(G.idx + 1) + "/" + G.total });
    seg(SEC.grammar, g, "ko", sayKo(head), P.lead);
    for (const line of (gc ? gc.explain : [])){
      g = row(SEC.grammar, "say", { ko: line });
      seg(SEC.grammar, g, "ko", sayKo(line), P.note);
    }
    const rule = (gc && gc.rule) || step.rule;
    g = row(SEC.grammar, "note", { ko: "규칙: " + rule });
    seg(SEC.grammar, g, "ko", "규칙 한 줄. " + sayKo(rule), P.sentMean);
    const exs = gc && gc.examples.length >= 2 ? gc.examples : step.ex;
    exs.forEach((x, k) => {
      g = row(SEC.grammar, "pair", { es: x.es, ko: x.ko, badge: "예문" });
      if (k === 0) seg(SEC.grammar, g, "ko", "예문으로 들어 볼게요.", P.lead);
      seg(SEC.grammar, g, "es", x.es, P.frameEs);
      seg(SEC.grammar, g, "ko", x.ko, P.frameKo);
    });
    if (gc && gc.table.length) tableRow(SEC.grammar, "한눈에 보기", "표로 한 번에 볼게요.", gc.table);
    if (gc) enLine(SEC.grammar, gc);
    const quiz = gc && gc.quiz.length ? gc.quiz : step.ex.map((x) => ({ es: x.es, ko: x.ko }));
    g = row(SEC.grammar, "say", { ko: "퀴즈예요. " + REVIEW_HOW });
    seg(SEC.grammar, g, "ko", "퀴즈예요. " + REVIEW_HOW, P.lead);
    for (const q of quiz) quizRow(SEC.grammar, q, "퀴즈");
  }

  /* 6교시 — lo·le·se, every lesson, about two minutes: today's own lines when
     they carry one, else the base set; who gets it, what is given; three
     quiz lines. */
  {
    const pp = pronounPlan(content.pronoun, iso);
    g = row(SEC.pron, "say", { ko: PRON_LEAD });
    seg(SEC.pron, g, "ko", PRON_LEAD, P.lead);
    for (const p of pp.points){
      g = row(SEC.pron, "pair", { es: p.es, ko: p.ko, badge: p.today ? "오늘 문장" : "예문" });
      seg(SEC.pron, g, "es", p.es, P.frameEs);
      seg(SEC.pron, g, "ko", p.ko, P.frameKo);
      const ask = [p.who ? "누구에게? " + p.who : "", p.what ? "무엇을? " + p.what : ""].filter(Boolean);
      if (ask.length){
        g = row(SEC.pron, "note", { ko: ask.join(" · ") });
        seg(SEC.pron, g, "ko", ask.join(". ") + ".", P.note);
      }
    }
    g = row(SEC.pron, "say", { ko: PRON_QUIZ_LEAD });
    seg(SEC.pron, g, "ko", PRON_QUIZ_LEAD, P.lead);
    for (const q of pp.quiz) quizRow(SEC.pron, q, "퀴즈");
  }

  /* 7교시 — the bones of speaking: what glues sentences, and the openings you
     keep while swapping the verb. Meaning, today's real use, swapped examples,
     then the same frame for each person. */
  frames.forEach((f, i) => {
    /* reviewed in 0교시 a few minutes ago: once, short, and today's real use only */
    if (again(f.es)){
      const lead = ordKo(i + 1) + " 뼈대. " + f.ko + ". 아까 어제 복습에서 했던 틀이에요.";
      g = row(SEC.frames, "lead", { ko: lead });
      seg(SEC.frames, g, "ko", sayKo(lead), P.lead);
      g = row(SEC.frames, "pair", { es: f.type === "link" ? f.es : f.es + " …", ko: f.ko, badge: "어제 복습" });
      seg(SEC.frames, g, "es", f.es, P.frameEs);
      seg(SEC.frames, g, "ko", sayKo(f.ko), P.frameKo);
      if (f.today){
        g = row(SEC.frames, "pair", { es: f.today.es, ko: f.today.ko, badge: "오늘 문장" });
        seg(SEC.frames, g, "es", f.today.es, P.frameEs);
        seg(SEC.frames, g, "ko", f.today.ko, P.frameKo);
      }
      return;
    }
    const lead = ordKo(i + 1) + " 뼈대. " + (f.type === "link" ? "이어 주는 말, " : "") + f.ko + "." +
      (f.note ? " " + f.note : "") +
      (f.today ? "" : " 오늘 문장에는 없었지만, 오늘 말에 붙여 쓰기 좋은 틀이에요.");
    g = row(SEC.frames, "lead", { ko: lead });
    seg(SEC.frames, g, "ko", sayKo(lead), P.lead);

    g = row(SEC.frames, "pair", { es: f.type === "link" ? f.es : f.es + " …", ko: f.ko, badge: "×2" });
    seg(SEC.frames, g, "es", f.es, P.frameEs);
    seg(SEC.frames, g, "ko", sayKo(f.ko), P.frameKo);
    seg(SEC.frames, g, "es", f.es, P.frameEs);
    enLine(SEC.frames, f);

    if (f.today){
      g = row(SEC.frames, "pair", { es: f.today.es, ko: f.today.ko, badge: "오늘 문장" });
      seg(SEC.frames, g, "ko", "오늘 문장에서는 이렇게 나왔어요.", P.lead);
      seg(SEC.frames, g, "es", f.today.es, P.frameEs);
      seg(SEC.frames, g, "ko", f.today.ko, P.frameKo);
    }
    f.swaps.forEach((x, k) => {
      g = row(SEC.frames, "pair", { es: x.es, ko: x.ko, badge: "바꿔 끼우기" });
      if (k === 0) seg(SEC.frames, g, "ko", "바꿔 끼워 볼게요.", P.lead);
      seg(SEC.frames, g, "es", x.es, P.frameEs);
      seg(SEC.frames, g, "ko", x.ko, P.frameKo);
    });
    if (f.forms && f.forms.length){
      tableRow(SEC.frames, "누가 하느냐에 따라",
        "누가 하느냐에 따라 모양이 바뀌어요. 나, 너, 그 사람, 우리 순서예요.", f.forms);
    }
  });

  /* 마무리 — every new word and every word once more, quickly, then every frame */
  newWords.forEach((w) => {
    g = row(SEC.review, "pair", { es: w.es, ko: w.ko });
    seg(SEC.review, g, "es", w.es, P.reviewEs);
    seg(SEC.review, g, "ko", plain(w.ko), P.reviewKo);
  });
  content.words.forEach((w) => {
    g = row(SEC.review, "pair", { es: w.es, ko: w.ko });
    seg(SEC.review, g, "es", w.es, P.reviewEs);
    seg(SEC.review, g, "ko", w.ko, P.reviewKo);
  });
  frames.forEach((f) => {
    g = row(SEC.review, "pair", { es: f.type === "link" ? f.es : f.es + " …", ko: f.ko });
    seg(SEC.review, g, "es", f.es, P.reviewEs);
    seg(SEC.review, g, "ko", sayKo(f.ko), P.reviewKo);
  });

  /* outro */
  g = row(SEC.outro, "say", { ko: content.outro });
  seg(SEC.outro, g, "ko", content.outro, P.outro);

  /* a beat of air between lessons */
  for (let i = 0; i < segs.length - 1; i++){
    if (segs[i].sectionId !== segs[i + 1].sectionId) segs[i].pauseAfter += P.section;
  }

  /* what curriculumCommit records once this lesson is saved; the counts are
     what the footer shows — the totals as they will stand after this lesson */
  const oldOnes = cur && Array.isArray(cur.oldWords) ? cur.oldWords : [];
  const learnedNow = cur ? cur.learnedBefore + newWords.filter((w) => oldOnes.indexOf(w.es) < 0).length : 0;
  const course = cur ? {
    iso: iso,
    newWords: newWords.map((w) => ({ es: w.es, ko: w.ko })),
    grammar: G ? { k: G.k, idx: G.idx } : null
  } : null;

  return Object.assign({
    date: iso, dateLabel: dateLabel,
    counts: Object.assign({ words: W, idioms: I, sentences: S, frames: F },
                          (plan || wordQuiz.length) ? { review: R } : {},
                          cur ? { newWords: NW, learned: learnedNow } : {},
                          G ? { grammarAt: G.idx + 1, grammarOf: G.total } : {}),
    reviewOf: plan ? plan.date : "",
    segments: segs, rows: rows
  }, course ? { curriculum: course } : {});
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
  let t = 0;
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
  else if (status === 403)
    head = "Cloud TTS 키에 권한이 없습니다. 이 API 는 결제 계정을 연결해야 동작합니다.\n\n";
  else if (status === 429)
    head = "Cloud TTS 한도에 걸렸습니다. 잠시 뒤 다시 시도하십시오.\n\n";
  return new Error(head + "TTS " + status + "\n" + msg);
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

  const segs = lesson.segments;
  for (let i = 0; i < segs.length; i++){
    const s = segs[i];
    const pcm = audio.get(cacheKey(s));
    if (!pcm) throw new Error("빠진 음성이 있습니다: " + s.text.slice(0, 20));
    /* no rounding: this is the exact length of what was just written, and the
       timeline is the running sum of these */
    s.audioMs = pcm.length / sr * 1000;
    out.write(pcm);
    /* the pause after the last line is never written: the timeline ends at the
       last word, and trailing silence would leave the bar at 100% while the
       file kept playing */
    if (s.pauseAfter > 0 && i < segs.length - 1) out.write(silence(s.pauseAfter));
  }

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
  const from = r.from ? "<span" + cls("from") + ">" + esc(r.from) + " &rarr;</span>" : "";
  let inner;
  if (r.kind === "pair" || r.kind === "slow" || r.kind === "full"){
    inner = "<div" + cls("es") + ">" + from + esc(r.es || "") + badge + "</div>" +
            (r.ko ? "<div" + cls("ko") + ">" + esc(r.ko) + "</div>" : "");
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
    inner = "<div" + cls("say") + ">" + from + esc(r.ko || "") + badge + "</div>";
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
             "끊기지 않게 들으시려면 설정에서 Cloud TTS 키를 넣으십시오.</div>" : "");

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
    "단어 " + l.counts.words + " · 숙어 " + l.counts.idioms + " · 문장 " + l.counts.sentences +
    (l.counts.frames ? " · 뼈대 " + l.counts.frames : "") +
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
function lessonNotice(text){
  const box = $("lNotice");
  if (!box) return;
  box.textContent = text || "";
  box.style.display = text ? "block" : "none";
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
      if (current === mine && list.length && !devPickVoice("es", list)) lessonNotice(NO_ES_VOICE);
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
    if (r.sectionId === "review" || r.sectionId === "intro" || r.sectionId === "outro") continue;
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
    question: pending.via === "voice" ? "(in the attached audio)" : pending.q,
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
  if (!settings.apiKey){ closeDlg($("lesson")); openSettings(); return; }

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

    const reply = await Promise.race([
      callPlain(ASK_PROMPT, input, { temperature: 0.35, thinking_level: "low" },
                askPending.audio ? askPending.audio.ms : 0),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("답이 " + (ASK_TIMEOUT_MS / 1000) + "초 안에 오지 않았습니다.")),
        ASK_TIMEOUT_MS))
    ]);

    /* the answer arrived, but the screen may have moved on while it was coming */
    if (!askTagValid(tag)){ askPending = null; return; }

    const got = askParse(reply);
    const shown = askPending.via === "voice"
      ? (got.heard || "🎤 음성 질문")
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
  if (!settings.apiKey){ closeDlg($("lesson")); openSettings(); return; }
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
  /* a silently dead button reads as broken, so say why */
  if (recording){ setStatus("말이 끝난 뒤에 눌러주십시오"); return; }
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

    if (!settings.apiKey){ closeDlg($("lesson")); openSettings(); return; }

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
  if (recording){ setStatus("말이 끝난 뒤에 눌러주십시오"); return; }
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
      : "오늘은 대화 기록이 없어, 새 단어와 문법으로 수업을 엮고 있습니다.");
    $("lFoot").innerHTML = '<button class="mini" id="lCancel" type="button">그만두기</button>';
    $("lCancel").onclick = () => { lessonCancelled = true; cancelTts(); lessonBusySub("그만두는 중…"); };
    setStatus("수업 대본을 만드는 중…");

    /* the day's course — new words, grammar step, lo·le·se lines — is read
       first, because the one script call has to explain it */
    const now = new Date();
    const cur = curriculumPlan(rows.map((e) => spanishOf(e)), studyDate(now));
    const content = await lessonWriteScript(rows, cur);
    if (lessonCancelled) throw new Error("__cancelled__");

    /* 0교시 is read out of the last saved lesson; a storage error only costs the review */
    const prev = await lessonPrevFor(studyDate(now)).catch(() => null);
    if (lessonCancelled) throw new Error("__cancelled__");
    const lesson = lessonBuild(content, now, prev, cur);
    let blob = null, fellBack = "";

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
        lesson.segments.forEach((s) => { delete s.audioMs; });
      }
      if (lessonCancelled) throw new Error("__cancelled__");
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

    const notice = [
      fellBack ? "고품질 음성을 만들지 못해 기기 음성으로 수업을 만들었습니다.\n" + fellBack : "",
      /* the docs disagree about this voice family and speed; if the API refused
         the slow read, say so rather than let it look like a bug */
      blob && ttsRateRefused
        ? "이 음성은 «느리게 읽기» 를 지원하지 않아, 느린 문장도 보통 속도로 읽습니다." : "",
      noEsVoice ? NO_ES_VOICE : "",
      saveNote
    ].filter(Boolean).join("\n\n");

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
  '단어 ' + lesson.counts.words + ' · 숙어 ' + lesson.counts.idioms +
  ' · 문장 ' + lesson.counts.sentences +
  (lesson.counts.frames ? ' · 뼈대 ' + lesson.counts.frames : '') + ' · ' + fmtClock(lesson.totalMs) +
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
  const se = $("lSexEs"), sk = $("lSexKo");
  if (se) se.value = lset.sexEs === "male" ? "male" : "female";
  if (sk) sk.value = lset.sexKo === "male" ? "male" : "female";
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
  /* a new key means a new project, and a new gender means a different voice:
     either way the remembered pick has to be made again */
  if (lset.ttsKey !== before || sexBefore !== lset.sexEs + "|" + lset.sexKo){
    lset.voiceEs = ""; lset.voiceEsCode = ""; lset.voiceKo = ""; lset.voiceKoCode = "";
  }
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
