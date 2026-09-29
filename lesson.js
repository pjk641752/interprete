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
  full: 4.0,
  reviewEs: 0.6, reviewKo: 0.8,
  outro: 0.4,
  section: 1.0                 // added on top, at a section boundary
};

const SEC = {
  intro:  { id: "intro",  title: "시작" },
  words:  { id: "words",  title: "1교시 · 오늘의 단어" },
  idioms: { id: "idioms", title: "2교시 · 연계 숙어" },
  sents:  { id: "sents",  title: "3교시 · 문장 해부" },
  review: { id: "review", title: "4교시 · 마무리 복습" },
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
  "Mexico. Below is everything they interpreted today as JSON: es (Spanish), ko (Korean),",
  "an optional tip, and the study chunks they already saw.",
  "",
  "Return ONE JSON object and nothing else. No markdown, no code fence, no commentary.",
  "",
  "{",
  '  "words":     [{"es":"","ko":"","note":""}],',
  '  "idioms":    [{"es":"","ko":"","from":"","note":""}],',
  '  "sentences": [{"es":"","ko":"","chunks":[{"es":"","ko":"","note":""}]}],',
  '  "outro": ""',
  "}",
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
  "    sentence. Each chunk is a unit: a verb phrase, a set expression, a noun with its",
  "    article, a question opener.",
  "  chunks[].note: ONE short grammar line in Korean for a complete beginner, about THIS chunk.",
  "    Good: al + 동사원형은 ~할 때 라는 뜻입니다 / pon 은 poner 의 반말 명령형입니다",
  "    Bad: anything that only re-translates the chunk, or names a tense without explaining it.",
  "    If a chunk carries no grammar worth a line, leave note empty.",
  "",
  "outro — ONE short Korean line closing the lesson, naming a concrete situation from today's",
  "  data where they should try one of these tomorrow. Under 60 characters.",
  "",
  "HARD RULES",
  "- Never introduce a Spanish word, name, number, price, time or place that is not in the data.",
  "  The idioms section is the only exception, and only for expressions you are certain of.",
  "- Every Korean line is plain, short and meant to be heard out loud. No markdown, no brackets.",
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

/* Drop anything missing a side, so a half-written item can never become a
   silent segment or a blank line later on. */
function lessonNormalise(raw){
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("대본 형식이 올바르지 않습니다.");

  const words = (Array.isArray(raw.words) ? raw.words : [])
    .map((w) => ({ es: cleanStr(w && w.es), ko: cleanStr(w && w.ko), note: cleanStr(w && w.note) }))
    .filter((w) => w.es && w.ko)
    .slice(0, 14);
  if (!words.length) throw new Error("대본에 단어가 없습니다.");

  const known = words.map((w) => w.es);
  const idioms = (Array.isArray(raw.idioms) ? raw.idioms : [])
    .map((x) => ({
      es: cleanStr(x && x.es), ko: cleanStr(x && x.ko),
      from: cleanStr(x && x.from), note: cleanStr(x && x.note)
    }))
    .filter((x) => x.es && x.ko)
    .slice(0, 5);
  for (const x of idioms) if (known.indexOf(x.from) < 0) x.from = "";

  const sentences = (Array.isArray(raw.sentences) ? raw.sentences : [])
    .map((s) => ({
      es: cleanStr(s && s.es), ko: cleanStr(s && s.ko),
      chunks: (Array.isArray(s && s.chunks) ? s.chunks : [])
        .map((c) => ({ es: cleanStr(c && c.es), ko: cleanStr(c && c.ko), note: cleanStr(c && c.note) }))
        .filter((c) => c.es && c.ko)
        .slice(0, 6)
    }))
    .filter((s) => s.es && s.ko)
    .slice(0, 6);

  return {
    words: words,
    idioms: idioms,
    sentences: sentences,
    outro: cleanStr(raw.outro) || "오늘 수업 끝. 내일 한 번 꼭 써먹어 보세요."
  };
}

async function lessonWriteScript(rows){
  const payload = rows.map((e) => ({
    es: spanishOf(e),
    ko: koreanOf(e),
    tip: e.tip || undefined,
    chunks: (e.study || []).map((s) => s.es + " = " + s.ko)
  }));
  const body = JSON.stringify(payload);
  const cfg = { temperature: 0.4, thinking_level: "medium" };

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
      return lessonNormalise(lessonExtractJson(reply));
    } catch (e) {
      if (/API \d{3}/.test((e && e.message) || "")) throw e;   // key, quota, model: do not retry
      lastErr = e;
    }
  }
  throw new Error("대본을 만들지 못했습니다.\n" + ((lastErr && lastErr.message) || ""));
}

/* ---------------- segments and display rows ---------------- */

/* The content becomes a flat segment list (what gets spoken) plus display rows
   (what gets shown). A three-times repeat is several segments inside one row. */
function lessonBuild(content, when){
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

  const W = content.words.length, I = content.idioms.length, S = content.sentences.length;
  /* the study day (03:00 local boundary, see studyDate in app.js), so the
     stored key, the spoken date and the label on screen are all the one day —
     a lesson made at half past midnight is still yesterday's lesson */
  const iso = studyDate(when);
  const dateLabel = Number(iso.slice(5, 7)) + "월 " + Number(iso.slice(8, 10)) + "일";

  /* intro */
  const introText = dateLabel + " 스페인어 수업입니다. 오늘은 단어 " + W + "개, 보너스 숙어 " +
    I + "개, 문장 " + S + "개입니다. 눈 감고, 들리는 대로 따라 하세요.";
  let g = row(SEC.intro, "say", { ko: introText });
  seg(SEC.intro, g, "ko", introText, P.intro);

  /* 1교시 — each word three times */
  content.words.forEach((w, i) => {
    const lead = ordKo(i + 1) + ". " + w.ko + "." + (w.note ? " " + w.note : "");
    g = row(SEC.words, "lead", { ko: lead });
    seg(SEC.words, g, "ko", lead, P.lead);

    g = row(SEC.words, "pair", { es: w.es, ko: w.ko, badge: "×3" });
    for (let k = 0; k < 3; k++){
      seg(SEC.words, g, "es", w.es, P.wordEs);
      seg(SEC.words, g, "ko", w.ko, k === 2 ? P.wordKoLast : P.wordKo);
    }
  });

  /* 2교시 — expressions branching off those words */
  content.idioms.forEach((x, i) => {
    const lead = "보너스 " + ordKo(i + 1) + ". " + x.ko + "." + (x.note ? " " + x.note : "");
    g = row(SEC.idioms, "lead", { ko: lead, from: x.from });
    seg(SEC.idioms, g, "ko", lead, P.lead);

    g = row(SEC.idioms, "pair", { es: x.es, ko: x.ko, badge: "×3", from: x.from });
    for (let k = 0; k < 3; k++){
      seg(SEC.idioms, g, "es", x.es, P.wordEs);
      seg(SEC.idioms, g, "ko", x.ko, k === 2 ? P.wordKoLast : P.wordKo);
    }
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
    });

    g = row(SEC.sents, "full", { es: s.es, ko: s.ko, badge: "×2" });
    seg(SEC.sents, g, "es", s.es, P.full);
    seg(SEC.sents, g, "es", s.es, P.full);
  });

  /* 4교시 — every word once more, quickly */
  content.words.forEach((w) => {
    g = row(SEC.review, "pair", { es: w.es, ko: w.ko });
    seg(SEC.review, g, "es", w.es, P.reviewEs);
    seg(SEC.review, g, "ko", w.ko, P.reviewKo);
  });

  /* outro */
  g = row(SEC.outro, "say", { ko: content.outro });
  seg(SEC.outro, g, "ko", content.outro, P.outro);

  /* a beat of air between lessons */
  for (let i = 0; i < segs.length - 1; i++){
    if (segs[i].sectionId !== segs[i + 1].sectionId) segs[i].pauseAfter += P.section;
  }

  return {
    date: iso, dateLabel: dateLabel,
    counts: { words: W, idioms: I, sentences: S },
    segments: segs, rows: rows
  };
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

  /* a word is spoken three times in 1교시 and again in 4교시 — synthesise it
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
  const db = await openDb();
  try {
    await rq2p(lessonStore(db,"readwrite").put(rec));
    const all = await rq2p(lessonStore(db,"readonly").getAll());
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    for (const old of all.slice(KEEP_LESSONS)) await rq2p(lessonStore(db,"readwrite").delete(old.date));
  } finally { db.close(); }
}
async function lessonList(){
  const db = await openDb();
  try {
    const all = await rq2p(lessonStore(db,"readonly").getAll());
    all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return all;
  } finally { db.close(); }
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
  let raf = 0, speed = 1, dead = false;

  /* The player reports TIMELINE position, not file position: currentTime runs
     MP3_DELAY_MS ahead of the script because of the codec's own delay. Seeks
     put it back, so a tapped row lands on that row — subtracting on the way in
     without adding it on the way out would light up the row above instead. */
  const posMs = () => Math.max(0, a.currentTime * 1000 - MP3_DELAY_MS);

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
      try { a.currentTime = (Math.max(0, ms) + MP3_DELAY_MS) / 1000; } catch (e) {}
      tick();
    },
    /* measured from the timeline position, so repeated nudges cannot drift */
    nudge: function (sec){ this.seek(posMs() + sec * 1000); },
    step: function (d){ this.nudge(d * 10); },
    speed: (v) => { speed = v; a.playbackRate = v; },
    speedNow: () => speed,
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
    if (idx >= lesson.segments.length){ running = false; report(); return; }
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
    at: posMs,
    destroy: () => { alive = false; halt(); }
  };
}

/* ---------------- lesson screen ---------------- */

let current = null;
let curRow = -1;

function rowHtml(r, i){
  const badge = r.badge ? '<span class="L-badge">' + esc(r.badge) + "</span>" : "";
  const from = r.from ? '<span class="L-from">' + esc(r.from) + " &rarr;</span>" : "";
  let inner;
  if (r.kind === "pair" || r.kind === "slow" || r.kind === "full"){
    inner = '<div class="L-es">' + from + esc(r.es || "") + badge + "</div>" +
            (r.ko ? '<div class="L-ko">' + esc(r.ko) + "</div>" : "");
  } else if (r.kind === "note"){
    inner = '<div class="L-note">' + esc(r.ko || "") + "</div>";
  } else {
    inner = '<div class="L-say">' + from + esc(r.ko || "") + badge + "</div>";
  }
  return '<button class="L-row ' + r.kind + '" data-i="' + i + '" type="button">' + inner + "</button>";
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
  curRow = -1;
}

function highlight(i){
  if (i === curRow) return;
  const body = $("lBody");
  const prev = body.querySelector(".L-row.on");
  if (prev) prev.classList.remove("on");
  const now = body.querySelector('.L-row[data-i="' + i + '"]');
  if (now){
    now.classList.add("on");
    const top = now.offsetTop, h = now.offsetHeight, view = body.clientHeight;
    if (top < body.scrollTop + 40 || top + h > body.scrollTop + view - 40){
      body.scrollTo({ top: Math.max(0, top - view * 0.38), behavior: "smooth" });
    }
  }
  curRow = i;
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
    "단어 " + l.counts.words + " · 숙어 " + l.counts.idioms + " · 문장 " + l.counts.sentences +
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

function mountLesson(rec, notice){
  stopPlayer();
  current = { lesson: rec.lesson, blob: rec.mp3 || null, engine: rec.engine, date: rec.date,
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
  "- Complete beginner: explain the thing itself. Do not drop a grammar term without",
  "  explaining it in the same breath.",
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
    open: !!(dlg && dlg.open)
  };
}
function askTagValid(tag){
  if (!tag) return false;
  const dlg = $("lesson");
  if (!dlg || !dlg.open) return false;          // the screen was closed
  if (!current) return false;
  return tag.epoch === askEpoch && tag.date === current.date;
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
    /* 4교시 is 1교시 again, and lead/intro/outro lines are narration — neither
       tells the model anything it does not already have */
    if (r.sectionId === "review" || r.sectionId === "intro" || r.sectionId === "outro") continue;
    if (r.kind === "lead") continue;
    const es = r.es || "", ko = r.ko || "";
    if (!es && !ko) continue;
    const key = r.sectionId + "|" + es + "|" + ko;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { part: r.sectionTitle };
    if (es) item.es = es;
    if (ko) item.ko = ko;
    if (r.from) item.from = r.from;
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
      askAudioCache.set(i, blob);
    }
    previewPlay(blob);
  } catch (e) {
    askSpeakDevice(t.parts);
  } finally {
    askSpeaking = false;
    if (btn){ btn.disabled = false; btn.innerHTML = label || "&#128266; 읽어주기"; }
  }
}

/* ---- storage ---- */

/* Only the settled turns, and never the audio. The record is read back and put
   whole so nothing else on it is disturbed. */
async function qaPersist(){
  if (!current || !current.date) return;
  try {
    const db = await openDb();
    try {
      const rec = await rq2p(lessonStore(db, "readonly").get(current.date));
      if (!rec) return;
      rec.qa = (current.qa || []).map((t) => ({
        q: t.q, via: t.via, parts: t.parts, at: t.at
      }));
      await rq2p(lessonStore(db, "readwrite").put(rec));
    } finally { db.close(); }
  } catch (e) {
    /* the answer is already on screen; losing only its history is not worth
       interrupting the lesson for */
  }
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
    qaPersist();
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

    const rows = todaysEntries();
    if (!rows.length){
      lessonMessage("오늘 나눈 대화가 없습니다.", "몇 마디 통역하고 나서 다시 눌러주십시오.");
      $("lFoot").innerHTML = '<button class="mini" id="lPastBtn" type="button">🗂 지난 수업</button>';
      $("lPastBtn").onclick = showPast;
      return;
    }
    await makeLesson(rows);
  } finally {
    lessonOpening = false;
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

  lessonCancelled = false;
  busy = true;
  /* nothing between `busy = true` and this try: a throw in the setup below
     would otherwise leave the flag stuck on, and a stuck `busy` silently
     disables the microphone, the typing box and this button for good */
  try {
    showError("");
    lessonMessage("대본을 쓰는 중…", "오늘 대화 " + rows.length + "건을 수업으로 엮고 있습니다.");
    $("lFoot").innerHTML = '<button class="mini" id="lCancel" type="button">그만두기</button>';
    $("lCancel").onclick = () => { lessonCancelled = true; cancelTts(); lessonBusySub("그만두는 중…"); };
    setStatus("수업 대본을 만드는 중…");

    const content = await lessonWriteScript(rows);
    if (lessonCancelled) throw new Error("__cancelled__");

    const lesson = lessonBuild(content, new Date());
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
      date: lesson.date, createdAt: new Date().toISOString(),
      engine: blob ? "cloud" : "device", lesson: lesson, mp3: blob,
      qa: []                         // questions asked about this lesson
    };

    let saveNote = "";
    try { await lessonSave(rec); }
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
        lessonLoad(b.getAttribute("data-d"))
          .then((rec) => { if (rec) mountLesson(rec); })
          .catch((e) => lessonNotice("그 수업을 열지 못했습니다.\n" + ((e && e.message) || e)));
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
    rows: lesson.rows.map((r) => ({
      kind: r.kind, es: r.es || "", ko: r.ko || "", badge: r.badge || "", from: r.from || "",
      sectionId: r.sectionId, sectionTitle: r.sectionTitle, start: ms1(r.start)
    })),
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
'.sec{font-size:10.5px;font-weight:700;letter-spacing:.8px;color:var(--dim);',
'text-transform:uppercase;margin:19px 3px 8px}',
'.row{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;',
'border-radius:12px;padding:9px 11px;margin-bottom:3px;cursor:pointer;font-family:inherit;color:inherit}',
'.row.on{background:var(--surface-2);border-color:#3d4a5a}',
'.es{font-size:18px;font-weight:650;color:var(--es);line-height:1.4;word-break:break-word}',
'.ko{font-size:13px;color:var(--muted);margin-top:3px;line-height:1.45;word-break:break-word}',
'.say{font-size:14px;color:var(--ko);line-height:1.5;word-break:break-word}',
'.note{font-size:13px;color:#e8d5a8;line-height:1.5;padding-left:9px;',
'border-left:2px solid rgba(255,209,102,.4)}',
'.badge{display:inline-block;margin-left:7px;font-size:10px;font-weight:700;color:var(--dim);',
'border:1px solid var(--line);border-radius:6px;padding:1px 5px;vertical-align:2px}',
'.from{color:var(--dim);font-size:12px;font-weight:600;margin-right:6px}',
'.row.full .es,.row.slow .es{font-size:16px}',
'.warn{font-size:11.5px;color:#e8d5a8;background:rgba(255,209,102,.07);',
'border:1px solid rgba(255,209,102,.22);border-radius:10px;padding:8px 10px;margin-top:9px;line-height:1.5}',
'</style></head><body>',
'<header><h1>' + esc(lesson.dateLabel) + ' 스페인어 수업</h1>',
'<div class="sub">단어 ' + lesson.counts.words + ' · 숙어 ' + lesson.counts.idioms +
  ' · 문장 ' + lesson.counts.sentences + ' · ' + fmtClock(lesson.totalMs) +
  (b64 ? '' : ' · 기기 음성') + '</div></header>',
'<div class="ctl">',
'<div class="bar" id="bar"><i></i></div>',
'<div class="time"><span id="at">0:00</span><span>' + fmtClock(lesson.totalMs) + '</span></div>',
'<div class="btns">',
'<button class="b" id="back" type="button">' + (b64 ? "&minus;10초" : "&#9664; 줄") + '</button>',
'<button class="b big" id="play" type="button">&#9654;</button>',
'<button class="b" id="fwd" type="button">' + (b64 ? "+10초" : "줄 &#9654;") + '</button>',
'<button class="b" id="spd" type="button">1&times;</button>',
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
'',
'var html = "", sec = "";',
'for (var i = 0; i < D.rows.length; i++){',
'  var r = D.rows[i];',
'  if (r.sectionId !== sec){ sec = r.sectionId; html += \'<div class="sec">\' + esc(r.sectionTitle) + "</div>"; }',
'  var bd = r.badge ? \'<span class="badge">\' + esc(r.badge) + "</span>" : "";',
'  var fr = r.from ? \'<span class="from">\' + esc(r.from) + " &rarr;</span>" : "";',
'  var inner;',
'  if (r.kind === "pair" || r.kind === "slow" || r.kind === "full"){',
'    inner = \'<div class="es">\' + fr + esc(r.es) + bd + "</div>" +',
'            (r.ko ? \'<div class="ko">\' + esc(r.ko) + "</div>" : "");',
'  } else if (r.kind === "note"){ inner = \'<div class="note">\' + esc(r.ko) + "</div>"; }',
'  else { inner = \'<div class="say">\' + fr + esc(r.ko) + bd + "</div>"; }',
'  html += \'<button class="row \' + r.kind + \'" data-i="\' + i + \'" type="button">\' + inner + "</button>";',
'}',
'body.innerHTML = html;',
'',
'var mark = function(i){',
'  if (i === cur) return;',
'  var p = body.querySelector(".row.on"); if (p) p.classList.remove("on");',
'  var n = body.querySelector(\'.row[data-i="\' + i + \'"]\');',
'  if (n){ n.classList.add("on");',
'    var top = n.offsetTop, h = n.offsetHeight, v = body.clientHeight;',
'    if (top < body.scrollTop + 40 || top + h > body.scrollTop + v - 40)',
'      body.scrollTo({ top: Math.max(0, top - v*0.38), behavior: "smooth" });',
'  }',
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
'/* tick runs once per animation frame, so nothing is written unless it changed:',
'   re-parsing innerHTML and re-setting the same width string 60 times a second',
'   is pure waste on a phone. */',
'var lastC = null, lastP = null, lastOn = null;',
'var tick = function(ms, on){',
'  mark(rowAt(ms));',
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
'        speed: function(v){ sp = v; a.playbackRate = v; }, now: function(){ return sp; } };',
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
'    if (idx >= D.segments.length){ run = false; rep(); return; }',
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
'        speed: function(v){ rate = v; }, now: function(){ return rate; } };',
'}',
'',
'playEl.onclick = function(){ P.toggle(); };',
'document.getElementById("back").onclick = function(){ P.step(-1); };',
'document.getElementById("fwd").onclick = function(){ P.step(1); };',
'spdEl.onclick = function(){ var n = STEPS[(STEPS.indexOf(P.now()) + 1) % STEPS.length];',
'  P.speed(n); spdEl.innerHTML = n + "&times;"; };',
'barEl.onclick = function(ev){ var r2 = barEl.getBoundingClientRect();',
'  P.seek(Math.max(0, Math.min(1, (ev.clientX - r2.left)/r2.width)) * D.totalMs); };',
'body.querySelectorAll(".row").forEach(function(b){',
'  b.onclick = function(){ P.seek(D.rows[Number(b.getAttribute("data-i"))].start); };',
'});',
'window.__lesson = { tick: tick, rowAt: rowAt, mark: mark, player: P, data: D,',
'  current: function(){ return cur; } };',
'tick(0, false);',
'})();',
'<\/script>',
'</body></html>'
  ].join("\n");

  return head + "\n" + player;
}

async function exportLesson(){
  if (!current) return;
  const btn = $("lExport");
  if (btn){ btn.disabled = true; btn.textContent = "만드는 중…"; }
  try {
    let b64 = "";
    if (current.blob) b64 = bytesToB64(new Uint8Array(await current.blob.arrayBuffer()));

    const name = "수업_" + current.lesson.date + ".html";
    const file = new File([exportHtml(current.lesson, b64)], name, { type: "text/html" });

    let sent = false;
    if (navigator.canShare && navigator.share){
      try {
        if (navigator.canShare({ files: [file] })){
          await navigator.share({ files: [file], title: current.lesson.dateLabel + " 스페인어 수업" });
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
  const test = $("lTestVoice");
  if (test) test.onclick = lessonTestVoice;
  const tryEs = $("lTryEs");
  if (tryEs) tryEs.onclick = () => { lessonPreview("es").catch(() => {}); };
  const tryKo = $("lTryKo");
  if (tryKo) tryKo.onclick = () => { lessonPreview("ko").catch(() => {}); };
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
