// Pestaña "Comercios": registra los comercios y si emplean marcas.
// El resto de la app usa este catálogo para elegir el comercio en las compras.
import {
  collection, doc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { crearFuente, registrarCambio, sincronizarAhora } from "./sync.js";
import { puedeEditar } from "./auth.js";

const comerciosRef = collection(db, "comercios");
let catalogo = []; // [{ id, nombre, usaMarcas }]

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const ICONO_COMERCIO = `<svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/></svg>`;

// ---------- API para el resto de la app ----------
export const getCatalogo = () => catalogo;

export function usaMarcas(nombre) {
  if (!nombre) return false;
  const t = norm(nombre);
  const c = catalogo.find((x) => norm(x.nombre) === t);
  return !!(c && c.usaMarcas);
}

// ---------- Vista de la pestaña ----------
export function iniciarComercios({ alCambiar = () => {}, avisar = () => {} } = {}) {
  const form = document.getElementById("formComercio");
  const inputNombre = document.getElementById("comercioNombre");
  const inputMarcas = document.getElementById("comercioMarcas");
  const lista = document.getElementById("listaComerciosReg");
  const contador = document.getElementById("contadorComercios");

  function pintar() {
    contador.textContent = `(${catalogo.length})`;
    lista.innerHTML = catalogo.map((c) => `
      <li class="comercio-item">
        <span class="nombre">${ICONO_COMERCIO} ${esc(c.nombre)}</span>
        <label class="check">
          <input type="checkbox" data-accion="marcas" data-id="${esc(c.id)}" ${c.usaMarcas ? "checked" : ""} ${puedeEditar() ? "" : "disabled"}>
          Emplea marcas
        </label>
        <button type="button" class="peligro" data-accion="borrar" data-id="${esc(c.id)}">Eliminar</button>
      </li>
    `).join("") || '<li class="vacio">Aún no hay comercios registrados.</li>';
  }

  // Agregar comercio
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!puedeEditar()) return;
    const nombre = inputNombre.value.trim().replace(/\s+/g, " ");
    if (!nombre) return;
    if (catalogo.some((c) => norm(c.nombre) === norm(nombre))) {
      return avisar("Ese comercio ya está registrado.", "error");
    }
    try {
      const batch = writeBatch(db);
      batch.set(doc(comerciosRef), {
        nombre,
        usaMarcas: inputMarcas.checked,
        creado: serverTimestamp()
      });
      registrarCambio(batch, "comercios");
      await batch.commit();
      sincronizarAhora();
      form.reset();
      inputNombre.focus();
      avisar("Comercio agregado.");
    } catch (err) {
      console.error(err);
      avisar("Error al agregar: " + err.message, "error");
    }
  });

  // Cambiar "Emplea marcas"
  lista.addEventListener("change", async (e) => {
    if (e.target.dataset.accion !== "marcas" || !puedeEditar()) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(comerciosRef, e.target.dataset.id), { usaMarcas: e.target.checked });
      registrarCambio(batch, "comercios");
      await batch.commit();
      sincronizarAhora();
    } catch (err) {
      console.error(err);
      avisar("Error al actualizar: " + err.message, "error");
    }
  });

  // Eliminar comercio
  lista.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-accion="borrar"]');
    if (!btn || !puedeEditar()) return;
    const c = catalogo.find((x) => x.id === btn.dataset.id);
    if (!c) return;
    if (!confirm(`¿Eliminar el comercio «${c.nombre}»?\nLas fichas que ya lo usan conservan su nombre.`)) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(comerciosRef, c.id));
      registrarCambio(batch, "comercios", { borrado: true });
      await batch.commit();
      sincronizarAhora();
      avisar("Comercio eliminado.");
    } catch (err) {
      console.error(err);
      avisar("Error al eliminar: " + err.message, "error");
    }
  });

  // Datos: caché local + revisión cada 30 s (ver sync.js)
  crearFuente({
    nombre: "comercios",
    ref: comerciosRef,
    alCambiar: (datos) => {
      catalogo = datos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      pintar();
      alCambiar(catalogo);
    },
    alError: (err) => {
      lista.innerHTML = `<li class="error">No se pudieron leer los comercios: ${esc(err.message)}. Revisa que las reglas de Firestore permitan las colecciones «comercios» y «meta».</li>`;
    }
  });
}
