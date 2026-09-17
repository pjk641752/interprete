"use strict";

/* ============================================================
   통역기 — Korean <-> Spanish live interpreter
   Single-utterance requests: no conversation history is ever
   sent, so the model cannot drift no matter how long it runs.
   ============================================================ */

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
  "openUsage","openSettings",
  "mToday","mLeft","mCost","mBar",
  "settings","saveSettings","shareBtn","apiKey","model","dialect",
  "autoSpeak","autoStop","silence","stream","freeLimit","fx",
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

function systemInstruction(){
  return [
    "You are a live two-way interpreter between Korean and Spanish.",
    "You are NOT an assistant. Never answer, comment on, explain or react to what is said. Only interpret.",
    "",
    "Detect the language actually spoken:",
    "- Korean -> translate into " + settings.dialect + ".",
    "- Spanish or any other language -> translate into natural spoken Korean.",
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
    "If the recording is empty or truly unintelligible, put UNCLEAR after <<<DST>>> and stop.",
    "",
    "Answer in EXACTLY this order and nothing else:",
    "<<<LANG>>>ko or es",
    "<<<DST>>>the translation",
    "<<<SRC>>>the tidied sentence in the language that was spoken"
  ].join("\n");
}

/* Parse whatever has arrived so far; safe to call on partial text. */
function partialParse(acc){
  const lang = /<<<LANG>>>\s*([a-z]+)/i.exec(acc);
  const dstAt = acc.indexOf("<<<DST>>>");
  const srcAt = acc.indexOf("<<<SRC>>>");
  let dst = "", src = "";
  if (dstAt >= 0) dst = acc.slice(dstAt + 9, srcAt >= 0 ? srcAt : undefined);
  if (srcAt >= 0) src = acc.slice(srcAt + 9);
  return {
    lang: lang ? lang[1].toLowerCase() : "",
    dst: dst.trim(),
    src: src.trim(),
    dstDone: srcAt >= 0
  };
}

/* ---------------- API ---------------- */

function buildBody(base64, mimeType, model, stream){
  return {
    model: model,
    system_instruction: systemInstruction(),
    input: [
      { type: "text", text: "Interpret this audio. Reply only in the required format." },
      { type: "audio", data: base64, mime_type: mimeType }
    ],
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

async function callStreaming(base64, mime, model, onPartial){
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(base64, mime, model, true))
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

async function callBlocking(base64, mime, model){
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(base64, mime, model, false))
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

async function interpret(base64, mime, onPartial){
  const model = settings.model;
  if (settings.stream){
    try {
      const r = await callStreaming(base64, mime, model, onPartial);
      if (r) return Object.assign(r, { model: model });
    } catch (e) {
      // a real API error (bad key, quota, bad model) must surface, not silently retry
      if (/API \d{3}/.test(e.message)) throw e;
    }
  }
  const r = await callBlocking(base64, mime, model);
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

  busy = true;
  el.mic.classList.remove("rec");
  el.mic.classList.add("busy");
  el.mic.textContent = "…";
  el.mic.disabled = true;
  setStatus("번역 중…");

  const t0 = Date.now();
  let firstTextAt = 0;

  try {
    const b64 = await blobToBase64(blob);
    const out = await interpret(b64, mime, (acc) => {
      if (!firstTextAt) firstTextAt = Date.now();
      const p = partialParse(acc);
      if (p.dst) renderLive(p);
    });

    const p = partialParse(out.text);
    if (!p.dst) throw new Error("형식을 알 수 없는 응답입니다.\n" + out.text.slice(0, 300));

    const elapsed = Date.now() - t0;
    const audTok = Math.round((durationMs / 1000) * AUDIO_TOKENS_PER_SEC);
    const inTok = (out.usage && out.usage.inTok) || (audTok + 260);
    const outTok = (out.usage && out.usage.outTok) || Math.round((p.dst.length + p.src.length) / 2.5);
    const cost = computeCost(out.model, inTok, outTok, audTok);
    addUsage(inTok, outTok, audTok, cost);
    refreshMeter();

    if (/^UNCLEAR$/i.test(p.dst)){
      setStatus("잘 안 들렸습니다 — 다시 말해 주십시오");
      el.result.innerHTML = "";
      renderHistoryOnly();
    } else {
      const lang = p.lang || guessLang(p.src);
      const entry = {
        at: new Date().toISOString(),
        from: lang,
        to: lang === "ko" ? "es" : "ko",
        src: p.src,
        dst: p.dst,
        model: out.model,
        ms: elapsed,
        audioMs: durationMs,
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
  }
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
    '</div>';
}

function render(entry){
  el.result.innerHTML =
    '<div class="card live">' +
      '<div class="dir">' + dirLabel(entry.from, entry.to) + '</div>' +
      '<p class="dst ' + entry.to + '">' + esc(entry.dst) + '</p>' +
      '<p class="src">' + esc(entry.src) + '</p>' +
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

function renderHistoryOnly(){
  const log = loadLog().slice(0, -1).slice(-30).reverse();
  if (!log.length){ el.histWrap.innerHTML = ""; return; }
  let html = '<div class="hist-title">지난 문장</div>';
  for (const e of log){
    html += '<div class="hist">' +
      '<div class="h-dst ' + e.to + '">' + esc(e.dst) + '</div>' +
      '<div class="h-src">' + esc(e.src) + '</div>' +
    '</div>';
  }
  el.histWrap.innerHTML = html;
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

el.openUsage.onclick = el.meter.onclick = () => { refreshUsageDialog(); openDlg(el.usage); };
el.closeUsage.onclick = () => closeDlg(el.usage);
el.exportBtn.onclick = exportLog;
el.resetUsage.onclick = () => {
  if (!confirm("오늘과 이번 달 사용량 집계를 0으로 되돌립니다. 대화 기록은 지워지지 않습니다.")) return;
  try { localStorage.removeItem("interp.usage"); } catch (e) {}
  refreshMeter(); refreshUsageDialog();
};

el.mic.onclick = () => { if (busy) return; recording ? stopRecording() : startRecording(); };

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
if ("serviceWorker" in navigator && secureCtx){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
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
