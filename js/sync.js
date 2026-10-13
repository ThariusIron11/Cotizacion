// Caché local + sincronización ligera con Firestore.
//
// Cómo funciona (para gastar muy pocas lecturas):
//  1. Las fichas y los comercios se guardan en IndexedDB (la caché del navegador). Al abrir la app se
//     muestran al instante desde ahí, sin leer Firestore.
//  2. Existe un documento pequeño "meta/version" con contadores. Cada vez que la app guarda o elimina
//     algo, sube el contador correspondiente en la MISMA operación (writeBatch).
//  3. Cada INTERVALO_MS (30 s) la app lee SOLO ese documento (1 lectura). Si ningún contador cambió, no
//     hace nada más. Si cambió:
//       - fichas: baja solo las fichas modificadas desde la última sincronización (campo "actualizado");
//         si hubo una eliminación, vuelve a bajar la colección completa;
//       - comercios: vuelve a bajar la colección (es pequeña).
//  4. No consulta mientras la pestaña está oculta; al volver a verla sincroniza si pasaron más de 30 s.
import {
  doc, getDocs, getDocFromServer, query, where, Timestamp, increment
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";

export const INTERVALO_MS = 30000; // <- cada cuánto se revisa si hubo cambios
const SOLAPE_SEG = 60;             // margen al pedir "lo modificado desde..." por si hay desfases de reloj

const metaRef = doc(db, "meta", "version");

// ---------- Caché en IndexedDB ----------
let bdPromesa = null;
const abrirBD = () => (bdPromesa ??= new Promise((res, rej) => {
  const r = indexedDB.open("cache-precios", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));

async function leerCache(clave) {
  try {
    const bd = await abrirBD();
    return await new Promise((res, rej) => {
      const r = bd.transaction("kv").objectStore("kv").get(clave);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
}

async function guardarCache(clave, valor) {
  try {
    const bd = await abrirBD();
    await new Promise((res, rej) => {
      const t = bd.transaction("kv", "readwrite");
      t.objectStore("kv").put(valor, clave);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  } catch (err) { console.warn("No se pudo guardar la caché local:", err); }
}

// Los Timestamp de Firestore no se pueden guardar tal cual: se pasan a { seconds, nanoseconds }
const plano = (data) => {
  const o = {};
  for (const [k, v] of Object.entries(data)) {
    o[k] = v && typeof v.toMillis === "function" ? { seconds: v.seconds, nanoseconds: v.nanoseconds } : v;
  }
  return o;
};

const ultimoCambio = (datos) => {
  let max = 0;
  for (const x of datos.values()) max = Math.max(max, x.actualizado?.seconds ?? 0);
  return max;
};

// ---------- Fuentes de datos ----------
const fuentes = [];

// nombre: "fichas" | "comercios" (también es el contador en meta/version)
// incremental: true si los documentos traen el campo "actualizado" (serverTimestamp) en cada guardado
// alCambiar(lista): se llama con la lista completa cada vez que cambian los datos (caché o servidor)
// alError(err): solo se llama si falla la lectura y no hay nada en caché que mostrar
export function crearFuente({ nombre, ref, incremental = false, alCambiar, alError = () => {} }) {
  const campoBorrados = nombre + "Borrados";
  const estado = { datos: new Map(), version: null, borrados: 0 };

  const fuente = {
    lista: () => [...estado.datos.values()],
    emitir: () => alCambiar(fuente.lista()),
    fallar: (err) => { if (estado.version === null) alError(err); }, // sin caché no hay nada que mostrar

    async cargarCache() {
      const c = await leerCache("cache:" + nombre);
      if (!c || !Array.isArray(c.datos)) return false;
      estado.datos = new Map(c.datos.map((x) => [String(x.id), x]));
      estado.version = c.version ?? null;
      estado.borrados = c.borrados ?? 0;
      return true;
    },

    // meta: contenido de meta/version ({} si no existe). Devuelve true si cambiaron los datos.
    async sincronizar(meta) {
      const v = meta[nombre] ?? 0;
      const b = meta[campoBorrados] ?? 0;
      if (estado.version !== null && v === estado.version && b === estado.borrados) return false;

      try {
        const completo = estado.version === null || !incremental || b !== estado.borrados;
        if (completo) {
          const snap = await getDocs(ref);
          estado.datos = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...plano(d.data()) }]));
        } else {
          const desde = Timestamp.fromMillis(Math.max(0, ultimoCambio(estado.datos) - SOLAPE_SEG) * 1000);
          const snap = await getDocs(query(ref, where("actualizado", ">", desde)));
          for (const d of snap.docs) estado.datos.set(d.id, { id: d.id, ...plano(d.data()) });
        }
      } catch (err) {
        fuente.fallar(err);
        throw err;
      }

      estado.version = v;
      estado.borrados = b;
      await guardarCache("cache:" + nombre, { datos: fuente.lista(), version: v, borrados: b });
      return true;
    }
  };

  fuentes.push(fuente);
  return fuente;
}

// Súmalo al writeBatch de cada guardado/eliminación para que los demás equipos detecten el cambio.
// borrado: true cuando se elimina un documento (obliga a las fuentes incrementales a rebajar todo).
export function registrarCambio(batch, nombre, { borrado = false } = {}) {
  const campos = { [nombre]: increment(1) };
  if (borrado) campos[nombre + "Borrados"] = increment(1);
  batch.set(metaRef, campos, { merge: true });
}

// ---------- Sincronización ----------
let enCurso = null;
let repetir = false;
let ultimaSync = 0;

// Nunca rechaza: los errores quedan en consola. Si se pide mientras ya hay una en curso, se repite al terminar.
export function sincronizarAhora() {
  if (enCurso) { repetir = true; return enCurso; }
  enCurso = (async () => {
    do {
      repetir = false;
      try {
        const snap = await getDocFromServer(metaRef); // 1 lectura
        const meta = snap.exists() ? snap.data() : {};
        for (const f of fuentes) {
          try { if (await f.sincronizar(meta)) f.emitir(); }
          catch (err) { console.error("Sincronización:", err); }
        }
        ultimaSync = Date.now();
      } catch (err) {
        console.error("No se pudo leer meta/version:", err);
        for (const f of fuentes) f.fallar(err);
      }
    } while (repetir);
  })().finally(() => { enCurso = null; });
  return enCurso;
}

// Llamar una vez, cuando ya se crearon todas las fuentes.
export async function iniciarSync() {
  // 1) Mostrar lo que haya en caché (sin leer Firestore)
  await Promise.all(fuentes.map(async (f) => { if (await f.cargarCache()) f.emitir(); }));
  // 2) Primera revisión contra Firestore
  await sincronizarAhora();
  // 3) Revisión periódica
  setInterval(() => { if (!document.hidden) sincronizarAhora(); }, INTERVALO_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - ultimaSync > INTERVALO_MS) sincronizarAhora();
  });
  window.addEventListener("online", () => sincronizarAhora());
}

// Se usa al cerrar sesión: borra los datos guardados en este navegador.
export async function borrarCache() {
  try { (await abrirBD()).close(); } catch { /* no había caché abierta */ }
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase("cache-precios");
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
}
