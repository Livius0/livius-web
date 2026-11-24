// Archivio dei file nel browser: IndexedDB (molto più spazio del localStorage).
// All'avvio si carica tutto in memoria; ogni scrittura viene salvata subito dopo.

let db = null;

function open() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open("livius-chat", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("file");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

// Tutte le voci: [chiave, Uint8Array] alternati in un array piatto.
export async function archivio_carica() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  db = await open();
  const out = [];
  await new Promise((ok, ko) => {
    const tx = db.transaction("file", "readonly");
    const req = tx.objectStore("file").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        out.push(String(c.key), c.value instanceof Uint8Array ? c.value : new Uint8Array(c.value));
        c.continue();
      } else ok();
    };
    req.onerror = () => ko(req.error);
  });
  return out;
}

export function archivio_scrivi(key, data) {
  if (!db) return;
  try { db.transaction("file", "readwrite").objectStore("file").put(data.slice(), key); } catch (e) { console.warn("[livius] archivio:", e); }
}

export function archivio_togli(key) {
  if (!db) return;
  try { db.transaction("file", "readwrite").objectStore("file").delete(key); } catch (e) { console.warn("[livius] archivio:", e); }
}

// Scarica un file ricevuto: lo passa al browser come download.
export function scarica_file(name, data) {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Scelta di file dal computer o dal telefono (input nascosto). I file letti restano qui finché
// l'app non li prende con file_scelti().
const scelti = [];
export function scegli_file(kind, accept, multiple) {
  const i = document.createElement("input");
  i.type = "file";
  if (accept) i.accept = accept;
  i.multiple = !!multiple;
  i.style.display = "none";
  i.onchange = async () => {
    for (const f of i.files) {
      const b = new Uint8Array(await f.arrayBuffer());
      scelti.push(kind, f.name, b);
    }
    i.remove();
  };
  document.body.appendChild(i);
  i.click();
}

export function file_scelti() {
  const out = scelti.splice(0, scelti.length);
  return out;
}
