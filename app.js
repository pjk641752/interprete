"use strict";

/* ============================================================
   통역기 — Korean <-> Spanish live interpreter
   Single-utterance requests: no conversation history is ever
   sent, so the model cannot drift no matter how long it runs.
   ============================================================ */

const APP_VERSION = "2026-09-18.4";

const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/* Audio is billed at 32 tokens per second of input. */
const AUDIO_TOKENS_PER_SEC = 32;

/* USD per 1M tokens. `audio` is only present where Google lists a
   separate audio input rate; otherwise audio bills at the `in` rate. */
const PRICES = {
  "gemini-3.8-flash":       { in: 0.75, out: 3.75 },
  "gemini-3.7-flash":       { in: 0.75, out: 3.75 },
  "gemini-3.6-flash":       { in: 0.75, out: 3.75 },
  "gemini-3.5-flash":       { in: 1.50, out: 9.00 },
  "gemini-3.5-flash-lite":  { in: 0.30, out: 2.50 },
  "gemini-3.1-flash-lite":  { in: 0.25, out: 1.50, audio: 0.50 },
  "gemini-2.5-flash":       { in: 0.30, out: 2.50, audio: 1.00 },
  "gemini-2.5-flash-lite":  { in: 0.10, out: 0.40, audio: 0.30 },
  "gemini-3.1-pro":         { in: 2.00, out: 12.00 }
};
const FALLBACK_PRICE = { in: 0.50, out: 3.00 };

const DEFAULTS = {
  apiKey: "",
  model: "gemini-3.8-flash",
  dialect: "멕시코 구어체 스페인어",
  autoSpeak: false,
  autoStop: true,
  silenceMs: 2000,
  stream: true,
  freeLimit: 250,
  fx: 18
};

const SILENCE_RMS = 0.012;
const MIN_SPEECH_MS = 350;
/* Total voiced time required before auto-stop may fire. Stops a stray
   cough or a single "음..." from ending the recording. */
const MIN_VOICED_MS = 900;
/* Each time the speaker pauses and starts again, they get more patience. */
const PAUSE_BONUS_MS = 450;
const MAX_PAUSE_MS = 4000;
const MAX_RECORD_MS = 60000;
const AUDIO_BPS = 24000; // opus at 24 kbps: small upload, speech stays clear

const $ = (id) => document.getElementById(id);
const el = {};
[
  "main","errBox","result","histWrap","status","mic","lvl","meter",
  "textIn","textSend",
  "sendKakao","openUsage","openSettings",
  "mToday","mLeft","mCost","mBar",
  "settings","saveSettings","shareBtn","apiKey","model","dialect",
  "autoSpeak","autoStop","silence","stream","freeLimit","fx",
  "verNow","checkUpdate","verMsg",
  "usage","closeUsage","exportBtn","resetUsage",
  "uMonthCost","uMonthPeso","uDayReq","uDayLeft","uDayIn","uDayOut","uDayCost",
  "uMonReq","uMonIn","uMonOut","uAvg","uPrices"
].forEach((k) => { el[k] = $(k); });

/* ---------------- storage ---------------- */

function jget(key, fallback){
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function jset(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

let settings = Object.assign({}, DEFAULTS, jget("interp.settings", {}));

/* Migrate from the old two-mode build (빠름/정확) to a single model. */
(function migrate(){
  if (!settings.model) settings.model = settings.modelGood || settings.modelFast || DEFAULTS.model;
  if (settings.model === "gemini-3.5-flash-lite") settings.model = DEFAULTS.model;
  if (settings.silenceMs && settings.silenceMs < 1500) settings.silenceMs = DEFAULTS.silenceMs;
  delete settings.modelFast; delete settings.modelGood; delete settings.mode; delete settings.tidy;
})();

function persist(){ jset("interp.settings", settings); }

function loadLog(){ return jget("interp.log", []); }
function appendLog(entry){
  const log = loadLog();
  log.push(entry);
  while (log.length > 5000) log.shift();
  jset("interp.log", log);
}

const todayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

function loadUsage(){
  const u = jget("interp.usage", null) || {};
  if (!u.day || u.day.date !== todayKey()) u.day = { date: todayKey(), req:0, inTok:0, outTok:0, audTok:0, cost:0 };
  if (!u.month || u.month.ym !== monthKey()) u.month = { ym: monthKey(), req:0, inTok:0, outTok:0, audTok:0, cost:0 };
  return u;
}
function addUsage(inTok, outTok, audTok, cost){
  const u = loadUsage();
  for (const b of [u.day, u.month]){
    b.req += 1; b.inTok += inTok; b.outTok += outTok; b.audTok += audTok; b.cost += cost;
  }
  jset("interp.usage", u);
  return u;
}

/* ---------------- pricing ---------------- */

function priceFor(model){ return PRICES[model] || FALLBACK_PRICE; }

function computeCost(model, inTok, outTok, audTok){
  const p = priceFor(model);
  const audio = Math.min(audTok, inTok);
  const text = Math.max(0, inTok - audio);
  const audioRate = (typeof p.audio === "number") ? p.audio : p.in;
  return (text * p.in + audio * audioRate + outTok * p.out) / 1e6;
}

const fmtUsd = (n) => "$" + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
const fmtNum = (n) => Math.round(n).toLocaleString("ko-KR");

/* ---------------- usage UI ---------------- */

function refreshMeter(){
  const u = loadUsage();
  el.mToday.textContent = u.day.req + "회";
  el.mCost.textContent = fmtUsd(u.month.cost);

  const limit = Number(settings.freeLimit) || 0;
  if (limit > 0){
    const left = Math.max(0, limit - u.day.req);
    const pct = Math.min(100, (u.day.req / limit) * 100);
    el.mLeft.textContent = left + "회";
    el.mBar.style.width = pct + "%";
    el.mLeft.className = "v" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    el.mBar.className = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  } else {
    el.mLeft.textContent = "—";
    el.mBar.style.width = "0%";
    el.mLeft.className = "v";
  }
}

function refreshUsageDialog(){
  const u = loadUsage();
  const limit = Number(settings.freeLimit) || 0;
  const fx = Number(settings.fx) || 0;

  el.uMonthCost.textContent = fmtUsd(u.month.cost);
  el.uMonthPeso.textContent = fx > 0
    ? "약 " + (u.month.cost * fx).toFixed(2) + " 페소 (1달러 = " + fx + "페소 기준)"
    : "페소 환산을 보려면 설정에서 환율을 넣으십시오.";

  el.uDayReq.textContent = u.day.req + "회";
  el.uDayLeft.textContent = limit > 0 ? Math.max(0, limit - u.day.req) + "회 남음" : "한도 미설정";
  el.uDayIn.textContent = fmtNum(u.day.inTok);
  el.uDayOut.textContent = fmtNum(u.day.outTok);
  el.uDayCost.textContent = fmtUsd(u.day.cost);

  el.uMonReq.textContent = u.month.req + "회";
  el.uMonIn.textContent = fmtNum(u.month.inTok);
  el.uMonOut.textContent = fmtNum(u.month.outTok);
  el.uAvg.textContent = u.month.req
    ? fmtUsd(u.month.cost / u.month.req) + " · " + fmtNum((u.month.inTok + u.month.outTok) / u.month.req) + "토큰"
    : "—";

  const p = priceFor(settings.model);
  el.uPrices.innerHTML =
    "적용 중인 단가 (100만 토큰당)<br>" +
    settings.model + " — 입력 $" + p.in + " / 출력 $" + p.out +
      (p.audio ? " / 음성 $" + p.audio : "") + "<br><br>" +
    "음성은 1초에 " + AUDIO_TOKENS_PER_SEC + "토큰으로 계산됩니다. " +
    "요금은 이 단가표로 추산한 값이며 구글의 실제 청구서와 다를 수 있습니다.";
}

/* ---------------- prompt ---------------- */

function systemInstruction(kind){
  const spoken = kind !== "text";
  const head = [
    "You are a live two-way interpreter between Korean and Spanish.",
    "You are NOT an assistant. Never answer, comment on, explain or react to the content. Only interpret.",
    "",
    "Detect the language of the input:",
    "- Korean -> translate into " + settings.dialect + ".",
    "- Spanish or any other language -> translate into natural spoken Korean."
  ];

  const tail = [
    "",
    "ONE TIP",
    "Give the single most useful thing a Korean learner should know about THIS sentence,",
    "in ONE short Korean line. Pick by this priority:",
    "1. Something that would cause a misunderstanding, or make them sound rude or too formal.",
    "2. A Mexican-specific usage a textbook would get wrong (ahorita, mande, ¿bueno?, güey, chido...).",
    "3. What a local would more naturally say instead, if this phrasing is stiff or bookish.",
    "4. A mistake Korean speakers specifically make here (ser/estar, por/para, gender, false friends).",
    "5. A pronunciation trap in this exact sentence.",
    "Write it in Korean, plainly, under 60 characters. No lead-in, no 'Tip:', just the fact.",
    "If there is genuinely nothing worth saying, output the line empty. An obvious or filler tip",
    "is worse than none — never state what the sentence means or that it is a question.",
    "",
    "STUDY BREAKDOWN",
    "The user is a Korean speaker learning Spanish. After the translation, break the SPANISH",
    "side of this exchange into the pieces worth memorising — whichever side the Spanish is on.",
    "- 2 to 6 items. Fewer is fine for a short sentence.",
    "- Each item is a word or a short chunk that works as a unit: a verb phrase, a set expression,",
    "  a noun with its article, a question opener. Prefer useful chunks over single words.",
    "- Give the plain dictionary-style Korean meaning, not a re-translation of the whole sentence.",
    "- Skip bare function words (el, la, de, y, que) unless they are part of a chunk.",
    "- Order them as they appear in the Spanish.",
    "- One per line, exactly: spanish :: korean",
    "",
    "Answer in EXACTLY this order and nothing else:",
    "<<<LANG>>>ko or es",
    "<<<DST>>>the translation",
    "<<<SRC>>>the tidied sentence in the language that was given",
    "<<<TIP>>>one short Korean line, or nothing at all",
    "<<<STUDY>>>",
    "spanish :: korean",
    "spanish :: korean"
  ];

  if (!spoken){
    return head.concat([
      "",
      "THIS INPUT WAS TYPED OR PASTED, NOT SPOKEN.",
      "It is already deliberate, so translate it faithfully. Do not rewrite, shorten, soften or",
      "'improve' it. Keep line breaks where they carry meaning. Fix nothing except obvious typos.",
      "Slang, abbreviations and emoji are normal in messages: read them as a native would.",
      "If it is a message from someone else, keep their tone — blunt stays blunt, polite stays polite.",
      "",
      "Translate meaning, not words. Keep names, numbers, prices and times exact.",
      "Never add greetings, notes, apologies, romanization or alternative translations.",
      "If the text is empty, put UNCLEAR after <<<DST>>> and stop."
    ]).concat(tail).join("\n");
  }

  return head.concat([
    "",
    "HOW THE SPEAKER TALKS",
    "This person is thinking out loud, live and unrehearsed. Expect heavy disfluency:",
    "- filler sounds and filler words",
    "- long hesitations in the middle of a sentence",
    "- the same word or phrase repeated several times",
    "- false starts and abandoned sentences",
    "- mid-sentence self-corrections",
    "- tangents, backtracking, and ideas finished out of order",
    "- sentences that trail off without ever finishing",
    "",
    "YOUR JOB",
    "Work out the ONE thing the speaker is actually trying to get across, and say it as a clean,",
    "natural, complete sentence — the way they would have said it if they had planned it first.",
    "",
    "- Listen to the WHOLE recording before deciding. The real point often arrives at the very end.",
    "- If they correct themselves, keep ONLY the final corrected version. Discard what it replaced.",
    "- If they restart a sentence, keep only the last attempt.",
    "- If a sentence trails off but the intended ending is obvious, finish it naturally.",
    "- If they circle the same idea several times, merge it into one clear sentence.",
    "- Drop every sound and word that carries no meaning.",
    "- Silence and hesitation carry no meaning. Ignore them entirely.",
    "",
    "LIMITS ON WHAT YOU MAY SUPPLY",
    "You may complete the grammar and the shape of the sentence. You may NOT supply content:",
    "never introduce a fact, name, number, price, time, place, opinion or intention the speaker",
    "did not actually express. Finishing 'I want to... uh...' as 'I want to go' is only allowed",
    "when the rest of the recording makes it unmistakable. When it is not, translate the fragment",
    "as a fragment rather than guessing.",
    "",
    "OUTPUT",
    "Translate meaning, not words. Use how a native actually speaks in casual conversation.",
    "Keep the speaker's register and tone. Keep names, numbers, prices and times exact.",
    "If the speaker genuinely said several separate things, use several short sentences.",
    "Never mention that you cleaned anything up. Never note that the speech was unclear or hesitant.",
    "Never add greetings, notes, apologies, romanization or alternative translations.",
    "If the recording is empty or truly unintelligible, put UNCLEAR after <<<DST>>> and stop."
  ]).concat(tail).join("\n");
}

const MARKERS = ["LANG", "DST", "SRC", "TIP", "STUDY"];

/* Split the reply into its marked sections. Order-independent and safe to
   call on a half-arrived stream, so adding a section cannot break parsing. */
function splitSections(acc){
  const found = [];
  for (const name of MARKERS){
    const tag = "<<<" + name + ">>>";
    const at = acc.indexOf(tag);
    if (at >= 0) found.push({ name: name, at: at, end: at + tag.length });
  }
  found.sort((a, b) => a.at - b.at);

  const out = {};
  for (let i = 0; i < found.length; i++){
    const next = found[i + 1];
    out[found[i].name] = acc.slice(found[i].end, next ? next.at : undefined).trim();
  }
  return out;
}

function parseStudy(raw){
  const study = [];
  if (!raw) return study;
  for (const line of raw.split("\n")){
    const i = line.indexOf("::");
    if (i < 0) continue;
    const es = line.slice(0, i).trim().replace(/^[-*\d.\s]+/, "");
    const ko = line.slice(i + 2).trim();
    if (es && ko) study.push({ es: es, ko: ko });
  }
  return study;
}

function partialParse(acc){
  const s = splitSections(acc);
  const tip = (s.TIP || "").replace(/^(tip|팁)\s*[:：]\s*/i, "").trim();
  return {
    lang: (s.LANG || "").toLowerCase().replace(/[^a-z]/g, ""),
    dst: s.DST || "",
    src: s.SRC || "",
    tip: tip,
    study: parseStudy(s.STUDY),
    // the translation is settled once any later section has started
    dstDone: ("SRC" in s) || ("TIP" in s) || ("STUDY" in s)
  };
}

/* ---------------- API ---------------- */

/* src is either {kind:"audio", data, mime} or {kind:"text", text} */
function buildBody(src, model, stream){
  const input = (src.kind === "text")
    ? [{ type: "text", text: "Interpret this text. Reply only in the required format.\n\n---\n" + src.text + "\n---" }]
    : [
        { type: "text", text: "Interpret this audio. Reply only in the required format." },
        { type: "audio", data: src.data, mime_type: src.mime }
      ];
  return {
    model: model,
    system_instruction: systemInstruction(src.kind),
    input: input,
    generation_config: {
      temperature: 0.2,
      // untangling false starts and self-corrections is reasoning work,
      // so this is deliberately not the cheapest setting
      thinking_level: "medium"
    },
    stream: !!stream
  };
}

function readUsage(obj){
  const u = obj && (obj.usage || obj.usage_metadata || obj.usageMetadata);
  if (!u) return null;
  const inTok = u.total_input_tokens ?? u.input_tokens ?? u.prompt_token_count ?? u.promptTokenCount;
  const outTok = u.total_output_tokens ?? u.output_tokens ?? u.candidates_token_count ?? u.candidatesTokenCount;
  const thought = u.total_thought_tokens ?? u.thought_tokens ?? 0;
  if (typeof inTok !== "number" && typeof outTok !== "number") return null;
  return { inTok: inTok || 0, outTok: (outTok || 0) + (thought || 0) };
}

function extractText(json){
  const out = [];
  if (Array.isArray(json && json.steps)){
    for (const step of json.steps){
      if (step && step.type === "model_output" && Array.isArray(step.content)){
        for (const c of step.content){
          if (c && c.type === "text" && typeof c.text === "string") out.push(c.text);
        }
      }
    }
  }
  if (out.length) return out.join("");
  if (typeof json.output_text === "string") return json.output_text;
  const p = json && json.candidates && json.candidates[0] &&
            json.candidates[0].content && json.candidates[0].content.parts;
  if (Array.isArray(p)) return p.map((x) => x && x.text).filter(Boolean).join("");
  return "";
}

function apiError(status, msg, model){
  let friendly = "";
  if (status === 429){
    friendly = "무료 한도에 걸렸습니다. 잠시 기다렸다 다시 말하시거나, 빠름 모드로 바꾸거나, 결제를 연결하십시오.\n\n";
  } else if (status === 400 && /model|not found|not supported|invalid/i.test(msg)){
    friendly = "모델 이름이 맞지 않습니다. 설정에서 모델을 바꿔주십시오.\n\n";
  } else if (status === 401 || status === 403){
    friendly = "API 키가 잘못되었거나 권한이 없습니다. 설정에서 키를 다시 확인하십시오.\n\n";
  }
  return new Error(friendly + "API " + status + " (" + model + ")\n" + msg);
}

/* Pull one JSON object out of each SSE "data:" line. */
function feedSse(buffer, onEvent){
  const parts = buffer.split("\n");
  const tail = parts.pop();
  for (let line of parts){
    line = line.trim();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line || line === "[DONE]") continue;
    try { onEvent(JSON.parse(line)); } catch (e) { /* partial or non-JSON keepalive */ }
  }
  return tail;
}

function deltaText(ev){
  if (!ev) return "";
  if (ev.event_type === "step.delta" || ev.type === "step.delta" || ev.event === "step.delta"){
    const d = ev.delta;
    if (d && (d.type === "text" || typeof d.text === "string") && typeof d.text === "string") return d.text;
  }
  if (ev.delta && typeof ev.delta.text === "string") return ev.delta.text;
  return "";
}

async function callStreaming(src, model, onPartial){
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(src, model, true))
  });

  if (!res.ok){
    const raw = await res.text();
    let j = null; try { j = JSON.parse(raw); } catch (e) {}
    throw apiError(res.status, (j && j.error && j.error.message) || raw.slice(0, 400), model);
  }
  if (!res.body || !res.body.getReader) return null; // no streaming support here

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "", usage = null;

  for (;;){
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    buf = feedSse(buf, (ev) => {
      const t = deltaText(ev);
      if (t){ acc += t; onPartial(acc); }
      const u = readUsage(ev) || readUsage(ev && ev.interaction);
      if (u) usage = u;
    });
  }
  buf = feedSse(buf + "\n", (ev) => {
    const t = deltaText(ev);
    if (t){ acc += t; onPartial(acc); }
    const u = readUsage(ev) || readUsage(ev && ev.interaction);
    if (u) usage = u;
  });

  return acc ? { text: acc, usage: usage } : null;
}

async function callBlocking(src, model){
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(src, model, false))
  });
  const raw = await res.text();
  let json = null; try { json = JSON.parse(raw); } catch (e) {}
  if (!res.ok){
    throw apiError(res.status, (json && json.error && json.error.message) || raw.slice(0, 400), model);
  }
  const text = extractText(json);
  if (!text) throw new Error("응답에서 번역문을 찾지 못했습니다.\n" + raw.slice(0, 400));
  return { text: text, usage: readUsage(json) };
}

async function interpret(src, onPartial){
  const model = settings.model;
  if (settings.stream){
    try {
      const r = await callStreaming(src, model, onPartial);
      if (r) return Object.assign(r, { model: model });
    } catch (e) {
      // a real API error (bad key, quota, bad model) must surface, not silently retry
      if (/API \d{3}/.test(e.message)) throw e;
    }
  }
  const r = await callBlocking(src, model);
  return Object.assign(r, { model: model });
}

/* ---------------- recording ---------------- */

function pickMime(){
  const want = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/aac","audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of want){
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return "";
}
const baseMime = (m) => (m || "audio/webm").split(";")[0].trim();

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("녹음 파일을 읽지 못했습니다."));
    r.onload = () => {
      const s = String(r.result), i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.readAsDataURL(blob);
  });
}

let stream = null, recorder = null, chunks = [];
let audioCtx = null, analyser = null, levelTimer = null;
let recording = false, busy = false;
let startedAt = 0, sawSpeech = false, silentSince = 0, hardStop = null, durationMs = 0;
let voicedMs = 0, pauses = 0, lastTick = 0, wasVoiced = false;

/* How long a pause is tolerated before the recording is closed.
   Grows every time the speaker stops and starts again, so someone who
   thinks mid-sentence is given more room, not less. */
function pauseAllowance(){
  const base = Number(settings.silenceMs) || DEFAULTS.silenceMs;
  return Math.min(MAX_PAUSE_MS, base + pauses * PAUSE_BONUS_MS);
}

async function ensureStream(){
  if (stream && stream.active) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  return stream;
}

function startLevelMeter(src){
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(src).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    levelTimer = setInterval(() => {
      if (!recording || !analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      el.lvl.style.width = Math.min(100, Math.round(rms * 900)) + "%";

      const now = Date.now();
      const dt = lastTick ? now - lastTick : 0;
      lastTick = now;
      const voiced = rms > SILENCE_RMS;

      if (voiced){
        if (!wasVoiced && sawSpeech) pauses++;   // they picked the thread back up
        sawSpeech = true;
        wasVoiced = true;
        silentSince = 0;
        voicedMs += dt;
        setStatus("듣는 중…");
      } else if (sawSpeech){
        wasVoiced = false;
        if (!silentSince) silentSince = now;
        const waited = now - silentSince;
        const allowance = pauseAllowance();

        if (waited > 600){
          const left = Math.max(0, Math.ceil((allowance - waited) / 1000));
          setStatus("계속 말씀하셔도 됩니다 · " + left + "초 뒤 자동 종료");
        }
        if (settings.autoStop &&
            waited > allowance &&
            voicedMs > MIN_VOICED_MS &&
            now - startedAt > MIN_SPEECH_MS){
          stopRecording();
        }
      }
    }, 80);
  } catch (e) {}
}

function stopLevelMeter(){
  if (levelTimer){ clearInterval(levelTimer); levelTimer = null; }
  analyser = null;
  el.lvl.style.width = "0%";
}

async function startRecording(){
  if (busy || recording) return;
  if (!settings.apiKey){ openSettings(); return; }
  showError("");

  try {
    const s = await ensureStream();
    const mime = pickMime();
    const opts = mime ? { mimeType: mime, audioBitsPerSecond: AUDIO_BPS } : { audioBitsPerSecond: AUDIO_BPS };
    try { recorder = new MediaRecorder(s, opts); }
    catch (e) { recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); }

    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start();

    recording = true; sawSpeech = false; silentSince = 0; startedAt = Date.now();
    voicedMs = 0; pauses = 0; lastTick = 0; wasVoiced = false;
    el.mic.classList.add("rec");
    el.mic.textContent = "■";
    setStatus("듣는 중…");
    startLevelMeter(s);
    hardStop = setTimeout(() => { if (recording) stopRecording(); }, MAX_RECORD_MS);
  } catch (e) {
    showError("마이크를 열지 못했습니다.\n" + (e && e.message ? e.message : e) +
      "\n\n주소가 https 로 시작해야 마이크가 열립니다. 브라우저 설정에서 이 사이트의 마이크 권한도 확인하십시오.");
    resetMic();
  }
}

function stopRecording(){
  if (!recording) return;
  recording = false;
  durationMs = Date.now() - startedAt;
  if (hardStop){ clearTimeout(hardStop); hardStop = null; }
  stopLevelMeter();
  try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch (e) {}
}

async function onRecordingStopped(){
  const mime = baseMime(recorder && recorder.mimeType);
  const blob = new Blob(chunks, { type: mime });
  chunks = [];

  if (durationMs < MIN_SPEECH_MS || blob.size < 1000){
    setStatus("너무 짧습니다 — 다시 말해 주십시오");
    resetMic();
    return;
  }

  const b64 = await blobToBase64(blob);
  await runInterpret({ kind: "audio", data: b64, mime: mime }, durationMs);
}

/* Shared path for both spoken and typed input. */
async function runInterpret(src, audioMs){
  busy = true;
  showError("");
  el.mic.classList.remove("rec");
  el.mic.classList.add("busy");
  el.mic.textContent = "…";
  el.mic.disabled = true;
  el.textSend.disabled = true;
  setStatus("번역 중…");

  const t0 = Date.now();
  let firstTextAt = 0;

  try {
    const out = await interpret(src, (acc) => {
      if (!firstTextAt) firstTextAt = Date.now();
      const p = partialParse(acc);
      if (p.dst) renderLive(p);
    });

    const p = partialParse(out.text);
    if (!p.dst) throw new Error("형식을 알 수 없는 응답입니다.\n" + out.text.slice(0, 300));

    const elapsed = Date.now() - t0;
    const audTok = audioMs ? Math.round((audioMs / 1000) * AUDIO_TOKENS_PER_SEC) : 0;
    const inTok = (out.usage && out.usage.inTok) || (audTok + 320);
    const outTok = (out.usage && out.usage.outTok) || Math.round((p.dst.length + p.src.length) / 2.5);
    const cost = computeCost(out.model, inTok, outTok, audTok);
    addUsage(inTok, outTok, audTok, cost);
    refreshMeter();

    if (/^UNCLEAR$/i.test(p.dst)){
      setStatus(src.kind === "text" ? "번역할 내용을 알아보지 못했습니다" : "잘 안 들렸습니다 — 다시 말해 주십시오");
      el.result.innerHTML = "";
      renderHistoryOnly();
    } else {
      const lang = p.lang || guessLang(p.src);
      const entry = {
        at: new Date().toISOString(),
        via: src.kind,
        from: lang,
        to: lang === "ko" ? "es" : "ko",
        src: p.src,
        dst: p.dst,
        tip: p.tip,
        study: p.study,
        model: out.model,
        ms: elapsed,
        audioMs: audioMs || 0,
        inTok: inTok, outTok: outTok, cost: cost
      };
      appendLog(entry);
      render(entry);
      if (settings.autoSpeak) speak(entry.dst, entry.to);
      const shown = firstTextAt ? ((firstTextAt - t0) / 1000).toFixed(1) + "초 만에 시작 · " : "";
      setStatus(shown + (elapsed / 1000).toFixed(1) + "초 · " + out.model);
    }
  } catch (e) {
    showError((e && e.message) ? e.message : String(e));
    setStatus("실패했습니다");
  } finally {
    busy = false;
    resetMic();
    el.textSend.disabled = false;
    if (reloadPending) setTimeout(flushPendingReload, 1500);
  }
}

async function translateTyped(){
  if (busy || recording) return;
  if (!settings.apiKey){ openSettings(); return; }
  const text = el.textIn.value.trim();
  if (!text) return;
  if (text.length > 6000){ showError("글이 너무 깁니다. 6000자 이내로 나눠서 넣어주십시오."); return; }
  el.textIn.blur();
  await runInterpret({ kind: "text", text: text }, 0);
  el.textIn.value = "";
  autoGrow();
}

function guessLang(text){ return /[가-힣]/.test(text) ? "ko" : "es"; }

function resetMic(){
  el.mic.classList.remove("rec","busy");
  el.mic.textContent = "🎙";
  el.mic.disabled = false;
}

/* ---------------- rendering ---------------- */

function esc(s){
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function dirLabel(from, to){
  const n = { ko:"한국어", es:"스페인어", other:"외국어" };
  return (n[from] || from) + " <b>&rarr;</b> " + (n[to] || to);
}

/* live streaming view: translation appears while it is still being written */
function renderLive(p){
  const lang = p.lang || "es";
  const to = lang === "ko" ? "es" : "ko";
  el.result.innerHTML =
    '<div class="card live">' +
      '<div class="dir">' + dirLabel(lang, to) + '</div>' +
      '<p class="dst ' + to + '">' + esc(p.dst) +
        (p.dstDone ? "" : '<span class="caret"></span>') + '</p>' +
      '<p class="src">' + esc(p.src) + '</p>' +
      tipHtml(p.tip) +
    '</div>';
}

function tipHtml(tip){
  return tip ? '<div class="tip"><span>💡</span><p>' + esc(tip) + '</p></div>' : "";
}

function render(entry){
  el.result.innerHTML =
    '<div class="card live">' +
      '<div class="dir">' + dirLabel(entry.from, entry.to) + '</div>' +
      '<p class="dst ' + entry.to + '">' + esc(entry.dst) + '</p>' +
      '<p class="src">' + esc(entry.src) + '</p>' +
      tipHtml(entry.tip) +
      '<div class="row">' +
        '<button class="mini" data-act="speak">🔊 읽어주기</button>' +
        '<button class="mini" data-act="copy">복사</button>' +
      '</div>' +
    '</div>';
  el.result.querySelector('[data-act="speak"]').onclick = () => speak(entry.dst, entry.to);
  el.result.querySelector('[data-act="copy"]').onclick = async (ev) => {
    try {
      await navigator.clipboard.writeText(entry.dst);
      ev.target.textContent = "복사됨";
      setTimeout(() => { ev.target.textContent = "복사"; }, 1200);
    } catch (e) {}
  };
  renderHistoryOnly();
  el.main.scrollTop = 0;
}

/* Whichever way the exchange went, the Spanish side is what gets studied. */
function spanishOf(e){ return e.to === "es" ? e.dst : e.src; }
function koreanOf(e){ return e.to === "es" ? e.src : e.dst; }

let hideMeaning = jget("interp.hideMeaning", false);

function renderHistoryOnly(){
  const log = loadLog().slice(0, -1).slice(-40).reverse();
  if (!log.length){ el.histWrap.innerHTML = ""; return; }

  let html =
    '<div class="study-head">' +
      '<span class="hist-title">공부할 표현</span>' +
      '<button class="mini" id="toggleMeaning">' + (hideMeaning ? "뜻 보이기" : "뜻 가리기") + '</button>' +
    '</div>';

  for (let i = 0; i < log.length; i++){
    const e = log[i];
    const items = Array.isArray(e.study) ? e.study : [];
    html += '<div class="scard">' +
      '<div class="s-es">' + esc(spanishOf(e)) + '</div>' +
      '<div class="s-ko' + (hideMeaning ? " masked" : "") + '">' + esc(koreanOf(e)) + '</div>';
    if (items.length){
      html += '<div class="chips">';
      for (let j = 0; j < items.length; j++){
        html += '<button class="chip-item" data-say="' + esc(items[j].es) + '">' +
            '<span class="c-es">' + esc(items[j].es) + '</span>' +
            '<span class="c-ko' + (hideMeaning ? " masked" : "") + '">' + esc(items[j].ko) + '</span>' +
          '</button>';
      }
      html += '</div>';
    }
    html += tipHtml(e.tip);
    html += '</div>';
  }
  el.histWrap.innerHTML = html;

  const tog = $("toggleMeaning");
  if (tog) tog.onclick = () => {
    hideMeaning = !hideMeaning;
    jset("interp.hideMeaning", hideMeaning);
    renderHistoryOnly();
  };
  el.histWrap.querySelectorAll(".chip-item").forEach((b) => {
    b.onclick = () => {
      const ko = b.querySelector(".c-ko");
      if (ko && ko.classList.contains("masked")) { ko.classList.remove("masked"); return; }
      speak(b.getAttribute("data-say"), "es");
    };
  });
  el.histWrap.querySelectorAll(".s-ko.masked").forEach((n) => {
    n.onclick = () => n.classList.remove("masked");
  });
}

function speak(text, lang){
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "es" ? "es-MX" : "ko-KR";
    u.rate = 0.98;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

function showError(msg){ el.errBox.innerHTML = msg ? '<div class="err">' + esc(msg) + '</div>' : ""; }
function setStatus(s){ el.status.textContent = s; }

function showWelcome(){
  const log = loadLog();
  if (log.length){ render(log[log.length - 1]); return; }
  el.result.innerHTML =
    '<div class="hint">' +
      '버튼을 누르고 <b>한국어</b>로 말하면 스페인어가,<br>' +
      '<b>스페인어</b>로 말하면 한국어가 나옵니다.<br><br>' +
      '방향은 자동으로 정해집니다.<br>' +
      '더듬거나 반복해도 알아서 정리해 줍니다.<br>' +
      '문장마다 따로 처리하므로 오래 써도 딴소리하지 않습니다.' +
    '</div>';
}

/* ---------------- daily study note ---------------- */

const SUMMARY_PROMPT = [
  "You are making a study note for a Korean speaker living in Mexico who is learning Spanish.",
  "Below is everything they interpreted today, as JSON. Each row has the Spanish (es),",
  "the Korean (ko), an optional tip, and the study chunks they already saw.",
  "",
  "Write ONE plain-text note in Korean they can read on their phone. Rules:",
  "- Plain text only. No markdown, no #, no *, no tables. KakaoTalk cannot render them.",
  "- Merge duplicates and near-duplicates. If they hit the same phrase five times, list it once.",
  "- Put the highest-value items first. Value = they will need it again soon.",
  "- Drop anything trivial, one-off, or that carries no learning (greetings, yes/no, bare numbers).",
  "- Never invent a word or sentence that is not in the data.",
  "",
  "Use exactly this shape, and omit any section that would be empty:",
  "",
  "[MONTH]월 [DAY]일 스페인어",
  "대화 [N]회",
  "",
  "[ 오늘의 단어 ]",
  "- spanish : 한국어 뜻",
  "(up to 12, most useful first)",
  "",
  "[ 꼭 외울 문장 ]",
  "1. spanish",
  "   한국어",
  "(up to 6, the ones actually worth memorising)",
  "",
  "[ 알아둘 것 ]",
  "- one short Korean line",
  "(up to 4, merge overlapping tips, skip the section if there are none)",
  "",
  "Output the note only. No preamble, no closing remark."
].join("\n");

async function callPlain(systemInstr, userText){
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      system_instruction: systemInstr,
      input: userText,
      generation_config: { temperature: 0.3, thinking_level: "low" }
    })
  });
  const raw = await res.text();
  let json = null; try { json = JSON.parse(raw); } catch (e) {}
  if (!res.ok){
    throw apiError(res.status, (json && json.error && json.error.message) || raw.slice(0, 400), settings.model);
  }
  const text = extractText(json);
  if (!text) throw new Error("정리 결과를 받지 못했습니다.\n" + raw.slice(0, 300));
  const u = readUsage(json);
  if (u){
    addUsage(u.inTok, u.outTok, 0, computeCost(settings.model, u.inTok, u.outTok, 0));
    refreshMeter();
  }
  return text.trim();
}

function todaysEntries(){
  const d = todayKey();
  return loadLog().filter((e) => (e.at || "").slice(0, 10) === d);
}

async function buildDailyNote(rows){
  const payload = rows.map((e) => ({
    es: spanishOf(e),
    ko: koreanOf(e),
    tip: e.tip || undefined,
    chunks: (e.study || []).map((s) => s.es + " = " + s.ko)
  }));
  const now = new Date();
  const header = "오늘은 " + (now.getMonth() + 1) + "월 " + now.getDate() +
                 "일이고, 대화는 " + rows.length + "회입니다.\n\n";
  return await callPlain(SUMMARY_PROMPT, header + JSON.stringify(payload));
}

async function sendDailyNote(){
  if (busy || recording) return;
  if (!settings.apiKey){ openSettings(); return; }

  const rows = todaysEntries();
  if (!rows.length){ alert("오늘 나눈 대화가 없습니다."); return; }

  const btn = el.sendKakao;
  busy = true;
  if (btn) btn.disabled = true;
  showError("");
  setStatus("오늘 대화를 정리하는 중…");

  try {
    const note = await buildDailyNote(rows);
    setStatus("보내는 중…");

    let handled = false;
    if (navigator.share){
      try { await navigator.share({ text: note }); handled = true; }
      catch (e) { if (e && e.name === "AbortError") handled = true; } // user closed the sheet
    }
    if (!handled){
      try {
        await navigator.clipboard.writeText(note);
        alert("복사했습니다.\n카카오톡 → 나와의 채팅 에 붙여넣으십시오.");
      } catch (e) {
        showError("보내기와 복사가 모두 막혔습니다. 아래 내용을 직접 복사하십시오.\n\n" + note);
      }
    }
    setStatus("정리 " + rows.length + "건 보냄");
  } catch (e) {
    showError((e && e.message) ? e.message : String(e));
    setStatus("정리에 실패했습니다");
  } finally {
    busy = false;
    if (btn) btn.disabled = false;
  }
}

/* ---------------- export / share ---------------- */

function exportLog(){
  const log = loadLog();
  if (!log.length){ alert("내보낼 기록이 없습니다."); return; }
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "interprete_" + todayKey() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function shareApp(){
  const url = location.href.split("#")[0];
  const data = {
    title: "통역기",
    text: "한국어-스페인어 실시간 통역기입니다. 열어서 본인 Gemini API 키만 넣으면 바로 쓸 수 있습니다.",
    url: url
  };
  try {
    if (navigator.share){ await navigator.share(data); return; }
    await navigator.clipboard.writeText(url);
    alert("주소를 복사했습니다. 동료에게 보내주십시오.\n\n" + url);
  } catch (e) {}
}

/* ---------------- dialogs ---------------- */

function openDlg(d){
  if (typeof d.showModal === "function"){ try { d.showModal(); return; } catch (e) {} }
  d.setAttribute("open", "");
}
function closeDlg(d){
  if (typeof d.close === "function"){ try { d.close(); return; } catch (e) {} }
  d.removeAttribute("open");
}

function openSettings(){
  el.verNow.textContent = APP_VERSION;
  el.verMsg.textContent = "";
  el.apiKey.value = settings.apiKey;
  el.model.value = settings.model;
  el.dialect.value = settings.dialect;
  el.autoSpeak.checked = !!settings.autoSpeak;
  el.autoStop.checked = !!settings.autoStop;
  el.silence.value = settings.silenceMs;
  el.stream.checked = !!settings.stream;
  el.freeLimit.value = settings.freeLimit;
  el.fx.value = settings.fx;
  openDlg(el.settings);
}

el.openSettings.onclick = openSettings;
el.saveSettings.onclick = () => {
  settings.apiKey = el.apiKey.value.trim();
  settings.model = el.model.value.trim() || DEFAULTS.model;
  settings.dialect = el.dialect.value;
  settings.autoSpeak = el.autoSpeak.checked;
  settings.autoStop = el.autoStop.checked;
  settings.silenceMs = Math.min(MAX_PAUSE_MS, Math.max(800, Number(el.silence.value) || DEFAULTS.silenceMs));
  settings.stream = el.stream.checked;
  settings.freeLimit = Math.max(0, Number(el.freeLimit.value) || 0);
  settings.fx = Math.max(0, Number(el.fx.value) || 0);
  persist();
  closeDlg(el.settings);
  showError("");
  refreshMeter();
  setStatus(settings.apiKey ? "준비됨 — 버튼을 누르고 말하십시오" : "API 키를 먼저 넣어주십시오");
};
el.shareBtn.onclick = shareApp;

el.checkUpdate.onclick = async () => {
  el.verMsg.textContent = " 확인 중…";
  try {
    // ask the server directly, bypassing every cache
    const res = await fetch("app.js?t=" + Date.now(), { cache: "no-store" });
    const txt = await res.text();
    const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(txt);
    const latest = m ? m[1] : null;
    if (!latest){ el.verMsg.textContent = " 확인하지 못했습니다."; return; }
    if (latest === APP_VERSION){ el.verMsg.textContent = " 최신입니다 (" + latest + ")"; return; }
    el.verMsg.textContent = " 새 버전 " + latest + " — 적용합니다…";
    if (swReg) { try { await swReg.update(); } catch (e) {} }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    el.verMsg.textContent = " 확인 실패 — 인터넷을 확인하십시오.";
  }
};

el.sendKakao.onclick = sendDailyNote;
el.openUsage.onclick = el.meter.onclick = () => { refreshUsageDialog(); openDlg(el.usage); };
el.closeUsage.onclick = () => closeDlg(el.usage);
el.exportBtn.onclick = exportLog;
el.resetUsage.onclick = () => {
  if (!confirm("오늘과 이번 달 사용량 집계를 0으로 되돌립니다. 대화 기록은 지워지지 않습니다.")) return;
  try { localStorage.removeItem("interp.usage"); } catch (e) {}
  refreshMeter(); refreshUsageDialog();
};

el.mic.onclick = () => { if (busy) return; recording ? stopRecording() : startRecording(); };

function autoGrow(){
  el.textIn.style.height = "auto";
  el.textIn.style.height = Math.min(120, el.textIn.scrollHeight) + "px";
}
el.textIn.addEventListener("input", autoGrow);
el.textSend.onclick = translateTyped;
el.textIn.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter makes a new line
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); translateTyped(); }
});

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body){ e.preventDefault(); el.mic.click(); }
});

/* ---------------- PWA ---------------- */

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const bar = document.createElement("div");
  bar.className = "card";
  bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:13px 15px";
  bar.innerHTML = '<div style="flex:1;font-size:13.5px;line-height:1.5">앱으로 설치하면 아이콘으로 바로 열 수 있습니다.</div>' +
                  '<button class="mini" id="doInstall">설치</button>' +
                  '<button class="mini" id="noInstall">나중에</button>';
  el.errBox.after(bar);
  bar.querySelector("#doInstall").onclick = async () => {
    bar.remove();
    try { installPrompt.prompt(); await installPrompt.userChoice; } catch (err) {}
    installPrompt = null;
  };
  bar.querySelector("#noInstall").onclick = () => bar.remove();
});

const secureCtx = location.protocol === "https:" ||
                  location.hostname === "localhost" || location.hostname === "127.0.0.1";

/* Updates land by themselves. When a new service worker takes control we
   reload — but never in the middle of a recording or a translation, or the
   user loses the sentence they were saying. */
let swReg = null, reloadPending = false, reloading = false;

function reloadForUpdate(){
  if (reloading) return;
  if (recording || busy){ reloadPending = true; setStatus("업데이트 준비됨 — 이 문장 끝나면 적용됩니다"); return; }
  reloading = true;
  location.reload();
}
function flushPendingReload(){ if (reloadPending && !recording && !busy) reloadForUpdate(); }

if ("serviceWorker" in navigator && secureCtx){
  navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdate);

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      swReg = reg;
      // an update that installed while the page was open
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) reloadForUpdate();
        });
      });
    }).catch(() => {});
  });

  // check for a new version whenever the app is brought back to the front
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && swReg){
      swReg.update().catch(() => {});
      flushPendingReload();
    }
  });
  window.addEventListener("focus", () => { if (swReg) swReg.update().catch(() => {}); });
}

/* ---------------- boot ---------------- */

persist();
refreshMeter();
showWelcome();

if (!settings.apiKey){
  setStatus("API 키를 먼저 넣어주십시오");
  openSettings();
}
if (!navigator.mediaDevices || !window.MediaRecorder){
  showError("이 브라우저는 녹음을 지원하지 않습니다. 크롬 또는 사파리 최신 버전에서 열어주십시오.");
}
