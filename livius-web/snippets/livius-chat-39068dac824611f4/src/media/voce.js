// Voce nel browser: microfono -> Opus (WebCodecs) e Opus -> altoparlanti.
// Stessi pacchetti dell'app: Opus mono a 48 kHz, 20 ms per pacchetto.

const RATE = 48000;
const FRAME = 960;
const PREBUFFER = FRAME * 3;
const MAX_BUFFER = FRAME * 10;

let ctx = null;
let stream = null;
let encoder = null;
let micNode = null;
let outNode = null;
let muted = false;
let deaf = false;
let level = 0;
let acc = new Float32Array(0);
let ts = 0;
let hang = 0;
const peers = new Map();
// Suoni della soundboard da mescolare al microfono (li sentono tutti) e da sentire qui.
let effetto = new Float32Array(0);

// Sui telefoni (Chrome, Samsung Internet, Safari) l'audio parte solo dopo un tocco:
// a ogni tocco o clic si risvegliano i contesti audio sospesi.
function sveglia() {
  for (const c of [ctx, fx]) {
    if (c && c.state !== "running" && c.state !== "closed") c.resume().catch(() => {});
  }
}
for (const ev of ["pointerdown", "touchend", "keydown", "click"]) {
  document.addEventListener(ev, sveglia, { capture: true, passive: true });
}

function concat(a, b) {
  const c = new Float32Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

export async function voce_start(onPacket) {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") {
    throw new Error("Questo browser non supporta la voce (serve WebCodecs: Chrome, Edge, Firefox o Safari recenti)");
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  // Alcuni telefoni non accettano 48 kHz fissi: si usa la frequenza del dispositivo e si
  // ricampiona qui (il codificatore Opus vuole 48 kHz).
  try { ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" }); } catch (_) { ctx = new AudioContext({ latencyHint: "interactive" }); }
  // Non si aspetta: sul telefono senza un tocco la promessa resterebbe ferma per sempre.
  if (ctx.state !== "running") ctx.resume().catch(() => {});

  encoder = new AudioEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      onPacket(b, level);
    },
    error: (e) => console.warn("[livius] voce, codifica:", e),
  });
  encoder.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1, bitrate: 40000, opus: { frameDuration: 20000 } });

  // Microfono: blocchi da 20 ms al codificatore (solo quando si parla, con 300 ms di coda).
  const src = ctx.createMediaStreamSource(stream);
  micNode = ctx.createScriptProcessor(1024, 1, 1);
  const inRate = ctx.sampleRate;
  micNode.onaudioprocess = (e) => {
    acc = concat(acc, inRate === RATE ? e.inputBuffer.getChannelData(0) : ricampiona(e.inputBuffer.getChannelData(0), inRate, RATE));
    while (acc.length >= FRAME) {
      const frame = acc.slice(0, FRAME);
      acc = acc.slice(FRAME);
      if (muted) frame.fill(0);
      if (effetto.length > 0) {
        const n = Math.min(FRAME, effetto.length);
        for (let k = 0; k < n; k++) frame[k] = Math.max(-1, Math.min(1, frame[k] + effetto[k]));
        effetto = effetto.slice(n);
        hang = 15;
      }
      let sum = 0;
      for (let i = 0; i < FRAME; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / FRAME);
      level = Math.min(1, rms * 4);
      if (rms > 0.012) hang = 15;
      ts += 20000;
      if (hang <= 0 || encoder.state !== "configured") {
        continue;
      }
      hang--;
      const ad = new AudioData({ format: "f32", sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: ts, data: frame });
      encoder.encode(ad);
      ad.close();
    }
  };
  const silent = ctx.createGain();
  silent.gain.value = 0;
  src.connect(micNode);
  micNode.connect(silent);
  silent.connect(ctx.destination);

  // Uscita: mescola le code di tutti i peer (a 48 kHz; se il dispositivo va a un'altra
  // frequenza si ricampiona l'uscita).
  outNode = ctx.createScriptProcessor(1024, 0, 1);
  outNode.onaudioprocess = (e) => {
    const real = e.outputBuffer.getChannelData(0);
    const need = inRate === RATE ? real.length : Math.ceil(real.length * RATE / inRate);
    const out = inRate === RATE ? real : new Float32Array(need);
    real.fill(0);
    out.fill(0);
    if (deaf) return;
    for (const p of peers.values()) {
      if (!p.playing) {
        if (p.buf.length >= PREBUFFER) p.playing = true;
        else continue;
      }
      const n = Math.min(out.length, p.buf.length);
      for (let i = 0; i < n; i++) out[i] += p.buf[i];
      p.buf = p.buf.slice(n);
      if (p.buf.length === 0) p.playing = false;
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    if (out !== real) {
      const r = ricampiona(out, RATE, inRate);
      real.set(r.subarray(0, Math.min(r.length, real.length)));
    }
  };
  outNode.connect(ctx.destination);
}

// Ricampionatore lineare (voce: basta e avanza).
function ricampiona(x, from, to) {
  const n = Math.floor(x.length * to / from);
  const y = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * k;
    const a = Math.floor(p);
    const f = p - a;
    y[i] = (x[a] || 0) * (1 - f) + (x[Math.min(a + 1, x.length - 1)] || 0) * f;
  }
  return y;
}

export function voce_stop() {
  try { micNode && micNode.disconnect(); } catch (_) {}
  try { outNode && outNode.disconnect(); } catch (_) {}
  try { encoder && encoder.state !== "closed" && encoder.close(); } catch (_) {}
  for (const p of peers.values()) {
    try { p.dec.close(); } catch (_) {}
  }
  peers.clear();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close();
  ctx = stream = encoder = micNode = outNode = null;
  acc = new Float32Array(0);
  level = 0;
}

export function voce_mute(m) {
  muted = m;
}

export function voce_deaf(d) {
  deaf = d;
}

export function voce_level() {
  return muted ? 0 : level;
}

export function voce_play(peer, seq, opus) {
  if (!ctx || deaf) return;
  let p = peers.get(peer);
  if (!p) {
    p = { buf: new Float32Array(0), playing: false, dec: null };
    p.dec = new AudioDecoder({
      output: (ad) => {
        const n = ad.numberOfFrames;
        const f = new Float32Array(n);
        ad.copyTo(f, { planeIndex: 0, format: "f32-planar" });
        ad.close();
        p.buf = concat(p.buf, f);
        if (p.buf.length > MAX_BUFFER) p.buf = p.buf.slice(p.buf.length - PREBUFFER);
      },
      error: (e) => console.warn("[livius] voce, decodifica:", e),
    });
    p.dec.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 1 });
    peers.set(peer, p);
  }
  if (p.dec.state !== "configured") return;
  p.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: seq * 20000, data: opus }));
}

// Suoni dell'interfaccia (già sintetizzati in Rust, 48 kHz mono).
let fx = null;
export function suono_play(pcm) {
  try {
    if (!fx) fx = new AudioContext({ sampleRate: RATE });
    if (fx.state === "suspended") fx.resume();
    const b = fx.createBuffer(1, pcm.length, RATE);
    b.copyToChannel(new Float32Array(pcm), 0);
    const s = fx.createBufferSource();
    s.buffer = b;
    s.connect(fx.destination);
    s.start();
  } catch (e) {}
}

// Suono della soundboard (file mp3/wav/ogg): decodificato dal browser.
export async function voce_effetto(file) {
  if (!ctx) return;
  try {
    const buf = await ctx.decodeAudioData(new Uint8Array(file).buffer);
    const ch = buf.getChannelData(0);
    effetto = concat(effetto, ch.slice(0, RATE * 15));
    const me = peers.get("__io") || { buf: new Float32Array(0), playing: false, dec: { close() {}, state: "closed" } };
    me.buf = concat(me.buf, ch.slice(0, RATE * 15));
    peers.set("__io", me);
  } catch (e) { console.warn("[livius] suono:", e); }
}
