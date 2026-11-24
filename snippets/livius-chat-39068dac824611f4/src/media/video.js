// Video nel browser: schermo e webcam codificati in H.264 (WebCodecs), stessi pacchetti
// dell'app (Annex B), e decodifica degli stream degli altri.

const CODEC = "avc1.640028";
// Per codificare: si prova dal migliore. Firefox (OpenH264) sa fare solo il profilo Baseline.
const ENC_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e028", "avc1.42e01f", "avc1.42001f"];

async function pickConfig(w, h, fps, kbps) {
  for (const codec of ENC_CODECS) {
    for (const annexb of [true, false]) {
      for (const hw of ["no-preference", "prefer-software"]) {
        const cfg = { codec, width: w, height: h, bitrate: kbps * 1000, framerate: fps, latencyMode: "realtime", hardwareAcceleration: hw };
        if (annexb) cfg.avc = { format: "annexb" };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r && r.supported) return { cfg, annexb };
        } catch (_) {}
      }
    }
  }
  return null;
}

// Da avc (lunghezze di 4 byte) ad Annex B; sui fotogrammi chiave mette davanti SPS e PPS.
function toAnnexB(b, desc, key) {
  const out = [];
  const start = [0, 0, 0, 1];
  if (key && desc) {
    const d = new Uint8Array(desc);
    let i = 5;
    const nsps = d[i++] & 31;
    for (let k = 0; k < nsps && i + 2 <= d.length; k++) {
      const n = (d[i] << 8) | d[i + 1]; i += 2;
      out.push(...start, ...d.subarray(i, i + n)); i += n;
    }
    const npps = d[i++];
    for (let k = 0; k < npps && i + 2 <= d.length; k++) {
      const n = (d[i] << 8) | d[i + 1]; i += 2;
      out.push(...start, ...d.subarray(i, i + n)); i += n;
    }
  }
  const head = new Uint8Array(out);
  const parts = [head];
  let len = head.length;
  for (let i = 0; i + 4 <= b.length; ) {
    const n = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    i += 4;
    if (n <= 0 || i + n > b.length) break;
    parts.push(new Uint8Array(start), b.subarray(i, i + n));
    len += 4 + n;
    i += n;
  }
  const r = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { r.set(p, o); o += p.length; }
  return r;
}
const src = [null, null]; // 0 schermo, 1 webcam
const dec = new Map();

function size(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.round((w * k) / 2) * 2, Math.round((h * k) / 2) * 2];
}

// Avvia la condivisione (0 schermo, 1 webcam). onPacket(dati, key, w, h).
export async function video_start(kind, maxSide, fps, kbps, onPacket) {
  if (typeof VideoEncoder === "undefined") throw new Error("Questo browser non supporta il video (serve WebCodecs)");
  video_stop(kind);
  if (!(await pickConfig(1280, 720, fps, kbps))) throw new Error("questo browser non sa codificare il video H.264");
  const stream = kind === 0
    ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
    : await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: fps }, audio: false });
  const track = stream.getVideoTracks()[0];
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.srcObject = stream;
  await el.play();
  const s = { stream, el, enc: null, w: 0, h: 0, timer: null, key: true, frames: 0, stopped: false };
  src[kind] = s;
  track.onended = () => video_stop(kind);
  const canvas = new OffscreenCanvas(2, 2);
  const g = canvas.getContext("2d");
  const t0 = performance.now();
  const tick = () => {
    if (s.stopped) return;
    const vw = el.videoWidth, vh = el.videoHeight;
    if (vw && vh) {
      const [w, h] = size(vw, vh, maxSide);
      if (!s.failed && !s.choosing && (!s.enc || w !== s.w || h !== s.h)) {
        try { s.enc && s.enc.close(); } catch (_) {}
        s.w = w; s.h = h;
        canvas.width = w; canvas.height = h;
        s.enc = null;
        s.choosing = true;
        pickConfig(w, h, fps, kbps).then((pick) => {
          s.choosing = false;
          if (s.stopped) return;
          if (!pick) {
            console.warn("[livius] video: questo browser non sa codificare H.264");
            s.failed = true;
            video_stop(kind);
            return;
          }
          console.info("[livius] video, codifica:", pick.cfg.codec, pick.annexb ? "annexb" : "avc");
          let desc = null;
          const enc = new VideoEncoder({
            output: (chunk, meta) => {
              if (meta && meta.decoderConfig && meta.decoderConfig.description) desc = meta.decoderConfig.description;
              let b = new Uint8Array(chunk.byteLength);
              chunk.copyTo(b);
              const key = chunk.type === "key";
              if (!pick.annexb) b = toAnnexB(b, desc, key);
              onPacket(b, key, s.w, s.h);
            },
            error: (e) => { console.warn("[livius] video, codifica:", e); s.enc = null; s.w = 0; },
          });
          enc.configure(pick.cfg);
          s.enc = enc;
          s.key = true;
        });
      }
      if (s.enc && s.enc.state === "configured" && s.enc.encodeQueueSize < 3) {
        g.drawImage(el, 0, 0, s.w, s.h);
        const f = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000) });
        const key = s.key || s.frames % (fps * 3) === 0;
        s.key = false;
        s.frames++;
        s.enc.encode(f, { keyFrame: key });
        f.close();
      }
    }
    s.timer = setTimeout(tick, 1000 / fps);
  };
  tick();
}

export function video_stop(kind) {
  const s = src[kind];
  if (!s) return;
  s.stopped = true;
  clearTimeout(s.timer);
  try { s.enc && s.enc.close(); } catch (_) {}
  s.stream.getTracks().forEach((t) => t.stop());
  src[kind] = null;
}

export function video_active(kind) {
  return !!src[kind];
}

export function video_key(kind) {
  if (src[kind]) src[kind].key = true;
}

// Visione di uno stream: i pacchetti entrano, l'ultimo fotogramma si legge in RGBA.
export function video_watch_start(id) {
  video_watch_stop(id);
  const d = { frame: null, err: false, canvas: new OffscreenCanvas(2, 2), dec: null, fresh: false };
  d.g = d.canvas.getContext("2d", { willReadFrequently: true });
  d.dec = new VideoDecoder({
    output: (f) => {
      const w = f.displayWidth, h = f.displayHeight;
      if (d.canvas.width !== w || d.canvas.height !== h) { d.canvas.width = w; d.canvas.height = h; }
      d.g.drawImage(f, 0, 0);
      f.close();
      d.fresh = true;
    },
    error: (e) => { d.err = true; console.warn("[livius] video, decodifica:", e); },
  });
  d.dec.configure({ codec: CODEC, optimizeForLatency: true });
  dec.set(id, d);
}

export function video_watch_push(id, data, key, ts) {
  const d = dec.get(id);
  if (!d) return false;
  if (d.err || d.dec.state !== "configured") {
    if (!key) return false;
    try { d.dec.close(); } catch (_) {}
    video_watch_start(id);
    return video_watch_push(id, data, key, ts);
  }
  try {
    d.dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts, data }));
  } catch (e) { d.err = true; return false; }
  return true;
}

// [w, h, rgba] dell'ultimo fotogramma nuovo, oppure null.
export function video_watch_take(id) {
  const d = dec.get(id);
  if (!d || !d.fresh) return null;
  d.fresh = false;
  const w = d.canvas.width, h = d.canvas.height;
  const img = d.g.getImageData(0, 0, w, h);
  return [w, h, new Uint8Array(img.data.buffer)];
}

export function video_watch_error(id) {
  const d = dec.get(id);
  return !!(d && d.err);
}

export function video_watch_stop(id) {
  const d = dec.get(id);
  if (d) { try { d.dec.close(); } catch (_) {} }
  dec.delete(id);
}
