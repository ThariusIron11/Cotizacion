import {
  collection, doc, getDoc, writeBatch, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase.js";
import { crearFuente, registrarCambio, iniciarSync, sincronizarAhora } from "./sync.js";
import { iniciarAuth, puedeEditar } from "./auth.js";
import { iniciarComercios, getCatalogo, usaMarcas } from "./comercios.js";
import { iniciarElementoSingular } from "./elemento-singular.js";
import { iniciarTracking } from "./tracking.js";
import { UMBRAL_CAMBIO, construirIndice, buscarCambio, descripcionCambio } from "./alerta-precios.js";

const fichasRef = collection(db, "fichas");

// ---------- Estado ----------
let remisiones = [];
let compras = [];          // [{ nombre, fecha, elementos: [...], _nom, _marca, _cant, _precio }]
let editandoId = null;     // null = nueva cotización
let borrador = null;       // borrador de una cotización nueva mientras se edita otra ficha
let todasLasFichas = [];
let indicePrecios = new Map(); // historial de precios por elemento (ver alerta-precios.js)

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const modal = $("modal");
const form = $("formFicha");
const inputId = $("fichaId");
const inputCliente = $("cliente");
const inputRemision = $("remisionInput");
const inputObs = $("observaciones");
const listaRemisiones = $("listaRemisiones");
const listaCompras = $("listaCompras");
const avisoCatalogo = $("avisoCatalogo");
const resultados = $("resultados");
const buscador = $("buscador");
const buscadorId = $("buscadorId");
const mensaje = $("mensaje");

const svg = (contenido) => `<svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${contenido}</svg>`;
const ICONO_EMPRESA = svg('<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/>');
const ICONO_ALERTA = svg('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>');
const ICONO_BAJA = svg('<path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>');
const ICONO_COMERCIO = svg('<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/>');

// ---------- Utilidades ----------
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const moneda = (n) => Number(n).toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const fmtNum = (n) => Number(n).toLocaleString("es-CO", { maximumFractionDigits: 3 });
// Muestra el valor crudo ("1234567.5") como "$ 1.234.567,5" mientras se escribe
const fmtPrecioInput = (raw) => {
  if (raw === "" || raw == null) return "";
  const [ent, dec] = String(raw).split(".");
  const miles = Number(ent || "0").toLocaleString("es-CO");
  return "$ " + miles + (dec !== undefined ? "," + dec : "");
};
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const redondear = (n) => Math.round(n * 100) / 100;

// "2026-10-12" -> "12/10/2026" (sin pasar por Date para evitar desfases de zona horaria)
function fechaCorta(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

let temporizador;
function avisar(texto, tipo = "ok", ms = 3500) {
  mensaje.textContent = texto;
  mensaje.className = `${tipo} visible`;
  clearTimeout(temporizador);
  temporizador = setTimeout(() => { mensaje.className = ""; }, ms);
}

// ---------- Menú principal (Cotizaciones / Elemento singular / Tracking / Comercios) ----------
document.querySelectorAll(".menu-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".menu-btn").forEach((b) => b.classList.toggle("activo", b === btn));
    $("vista-fichas").hidden = btn.dataset.vista !== "fichas";
    $("vista-singular").hidden = btn.dataset.vista !== "singular";
    $("vista-tracking").hidden = btn.dataset.vista !== "tracking";
    $("vista-comercios").hidden = btn.dataset.vista !== "comercios";
  });
});

// ---------- Pestañas de la ventana ----------
const tabs = document.querySelectorAll(".tab");
const paneles = document.querySelectorAll(".panel");

function irATab(nombre) {
  tabs.forEach((t) => {
    const activa = t.dataset.tab === nombre;
    t.classList.toggle("activo", activa);
    t.setAttribute("aria-selected", String(activa));
  });
  paneles.forEach((p) => { p.hidden = p.dataset.panel !== nombre; });
}
tabs.forEach((t) => t.addEventListener("click", () => irATab(t.dataset.tab)));

// ---------- Datos: elementos y compras ----------
// Normaliza un elemento. Las fichas viejas solo tenían "precio": se interpretan como cantidad 1.
function elementoNormal(e) {
  const cantidad = Number(e.cantidad ?? 1);
  const valorUnitario = Number(e.valorUnitario ?? e.precio ?? 0);
  return {
    nombre: e.nombre || "",
    marca: e.marca || "",
    cantidad,
    valorUnitario,
    valorTotal: Number(e.valorTotal ?? redondear(cantidad * valorUnitario))
  };
}

const nuevaCompra = () => ({ nombre: "", fecha: "", elementos: [], _nom: "", _marca: "", _cant: "1", _precio: "" });

const copiarCompras = (arr) => arr.map((c) => ({
  nombre: c.nombre || "",
  fecha: c.fecha || "",
  elementos: (c.elementos || []).map(elementoNormal),
  _nom: c._nom || "",
  _marca: c._marca || "",
  _cant: c._cant ?? "1",
  _precio: c._precio || ""
}));

// Compatibilidad con formatos anteriores de la ficha
function comprasDe(f) {
  if (Array.isArray(f.compras)) return f.compras;
  if (Array.isArray(f.comercios)) return f.comercios;
  if (Array.isArray(f.elementos) && f.elementos.length) return [{ nombre: "", fecha: "", elementos: f.elementos }];
  return [];
}

// ---------- Datos del formulario ----------
const vacio = () => ({ id: "", cliente: "", remisiones: [], compras: [], observaciones: "" });

function capturar() {
  return {
    id: inputId.value,
    cliente: inputCliente.value,
    remisiones: [...remisiones],
    compras: copiarCompras(compras),
    observaciones: inputObs.value
  };
}

function cargar(d) {
  inputId.value = d.id || "";
  inputCliente.value = d.cliente || "";
  inputRemision.value = "";
  inputObs.value = d.observaciones || "";
  remisiones = [...(d.remisiones || [])];
  compras = copiarCompras(comprasDe(d));
  pintarRemisiones();
  pintarCompras();
}

// ---------- Ventana emergente ----------
function configurarModo() {
  $("tituloForm").textContent = editandoId ? `Editar ficha ${editandoId}` : "Nueva cotización";
  inputId.disabled = !!editandoId;
  $("btnEliminar").hidden = !editandoId;
}

function mostrarModal() {
  configurarModo();
  irATab("general");
  modal.hidden = false;
  document.body.classList.add("modal-abierto");
  (editandoId ? inputCliente : inputId).focus();
}

// Cierra la ventana SIN borrar lo escrito
function ocultarModal() {
  modal.hidden = true;
  document.body.classList.remove("modal-abierto");
}

// Cierra la ventana y borra los campos
function terminar() {
  if (editandoId) {
    editandoId = null;
    cargar(borrador || vacio());   // recupera la cotización nueva que estaba a medias
  } else {
    borrador = null;
    cargar(vacio());
  }
  configurarModo();
  ocultarModal();
}

function abrirNueva() {
  if (!puedeEditar()) return;
  if (editandoId) {
    editandoId = null;
    cargar(borrador || vacio());
  }
  mostrarModal();
}

function abrirEditar(ficha) {
  if (!puedeEditar()) return;
  if (!editandoId) borrador = capturar(); // guarda lo que había en "nueva cotización"
  editandoId = ficha.id;
  cargar(ficha);
  mostrarModal();
}

$("btnNueva").addEventListener("click", abrirNueva);
$("btnCerrar").addEventListener("click", terminar);

// Clic fuera de la ventana: se cierra pero se conserva todo
modal.addEventListener("mousedown", (e) => {
  if (e.target === modal) ocultarModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) ocultarModal();
});

// ---------- Remisiones ----------
function pintarRemisiones() {
  listaRemisiones.innerHTML = remisiones
    .map((r, i) => `<li>${esc(r)} <button type="button" class="quitar" data-i="${i}" title="Quitar">×</button></li>`)
    .join("");
}

$("btnAddRemision").addEventListener("click", () => {
  const valor = inputRemision.value.trim();
  if (!valor) return;
  if (remisiones.includes(valor)) return avisar("Esa remisión ya está agregada.", "error");
  remisiones.push(valor);
  inputRemision.value = "";
  pintarRemisiones();
  inputRemision.focus();
});

inputRemision.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("btnAddRemision").click(); }
});

listaRemisiones.addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  remisiones.splice(Number(i), 1);
  pintarRemisiones();
});

// ---------- Compras (pestaña "Compras" del formulario) ----------
function totalPendiente(c) {
  const cantidad = c._cant === "" ? 1 : parseFloat(c._cant);
  const valor = parseFloat(c._precio);
  if (isNaN(cantidad) || isNaN(valor)) return 0;
  return redondear(cantidad * valor);
}

function opcionesComercio(actual) {
  const nombres = getCatalogo().map((c) => c.nombre);
  // Si la ficha trae un comercio que no está registrado, se conserva como opción
  if (actual && !nombres.includes(actual)) nombres.push(actual);
  return `<option value="">— Selecciona un comercio —</option>` +
    nombres.map((n) => `<option value="${esc(n)}" ${n === actual ? "selected" : ""}>${esc(n)}${getCatalogo().some((c) => c.nombre === n) ? "" : " (no registrado)"}</option>`).join("");
}

// ---------- Control de precios (alarma por aumento o disminución) ----------
// Se compara el mismo elemento (nombre + marca) en el MISMO comercio. Ver alerta-precios.js.
const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const textoCambio = (a) => descripcionCambio(a, { moneda, fechaCorta });

// Elementos ya agregados en el formulario (sin guardar): también sirven de referencia entre sí
function extrasDelFormulario(excluir = null) {
  const out = [];
  compras.forEach((c, ci) => c.elementos.forEach((el, ei) => {
    if (excluir && excluir.ci === ci && excluir.ei === ei) return;
    if (!c.fecha || !Number.isFinite(el.valorUnitario)) return;
    out.push({ nombre: el.nombre, marca: el.marca, comercio: c.nombre, valorUnitario: el.valorUnitario, fecha: c.fecha });
  }));
  return out;
}

// Cambio de precio del elemento que se está escribiendo en la fila de captura
function cambioPendiente(ci) {
  const c = compras[ci];
  const valorUnitario = parseFloat(c._precio);
  if (!c._nom.trim() || isNaN(valorUnitario)) return null;
  return buscarCambio(indicePrecios, {
    nombre: c._nom, marca: usaMarcas(c.nombre) ? c._marca : "", comercio: c.nombre, valorUnitario,
    fecha: c.fecha || hoyISO(), excluirFicha: editandoId, extras: extrasDelFormulario()
  });
}

// Cambio de precio de un elemento ya agregado al formulario
function cambioDeElemento(ci, ei) {
  const c = compras[ci], el = c.elementos[ei];
  return buscarCambio(indicePrecios, {
    nombre: el.nombre, marca: el.marca, comercio: c.nombre, valorUnitario: el.valorUnitario,
    fecha: c.fecha || hoyISO(), excluirFicha: editandoId, extras: extrasDelFormulario({ ci, ei })
  });
}

const bloqueAlerta = (a) => a.tipo === "aumento"
  ? `<div class="alerta-precio" role="alert">${ICONO_ALERTA}<span><strong>Aumento de precio.</strong> ${esc(textoCambio(a))}</span></div>`
  : `<div class="alerta-precio baja-precio" role="status">${ICONO_BAJA}<span><strong>Disminución de precio.</strong> ${esc(textoCambio(a))}</span></div>`;

// Rellena los avisos del formulario (fila de captura y elementos ya agregados) sin repintar los campos
function actualizarAlertas() {
  compras.forEach((c, ci) => {
    const caja = listaCompras.querySelector(`[data-ci="${ci}"]`);
    if (!caja) return;
    const a = cambioPendiente(ci);
    caja.querySelector(".alerta-slot").innerHTML = a ? bloqueAlerta(a) : "";
    c.elementos.forEach((_, ei) => {
      const slot = caja.querySelector(`[data-alerta-el="${ei}"]`);
      if (!slot) return;
      const x = cambioDeElemento(ci, ei);
      slot.innerHTML = x ? bloqueAlerta(x) : "";
    });
  });
}

// Elementos del formulario con aumento o disminución (para avisar al guardar)
function cambiosDelFormulario() {
  const lista = [];
  compras.forEach((c, ci) => c.elementos.forEach((el, ei) => {
    const a = cambioDeElemento(ci, ei);
    if (a) lista.push({ nombre: el.nombre, a });
  }));
  return lista;
}

// Marca visible en las fichas guardadas
const htmlCambio = (a) => {
  const sube = a.tipo === "aumento";
  return `<div class="${sube ? "alza" : "baja"}" title="${esc(textoCambio(a))}">${sube ? "▲ +" : "▼ -"}${moneda(Math.abs(a.diferencia))} <small>vs ${moneda(a.anterior.valorUnitario)} · ${fechaCorta(a.anterior.fecha)}</small></div>`;
};

function marcaCambio(nombre, marca, comercio, valorUnitario, fecha) {
  const a = buscarCambio(indicePrecios, { nombre, marca, comercio, valorUnitario, fecha });
  return a ? htmlCambio(a) : "";
}

// ---------- Autorelleno de "Elemento comprado" y "Marca" ----------
// Sugiere (máx. 3) elementos ya registrados en otras fichas. Si el comercio emplea marcas,
// la sugerencia se muestra como "elemento - marca" y al elegirla se llenan ambos campos.
const MAX_SUGERENCIAS = 3;
let sugerencias = { ci: -1, items: [], activo: -1, ul: null };

function elementosConocidos(conMarca) {
  const mapa = new Map();
  const agregar = (el) => {
    const nombre = (el.nombre || "").trim();
    if (!nombre) return;
    const marca = conMarca ? (el.marca || "").trim() : "";
    const clave = norm(nombre) + "|" + norm(marca);
    const x = mapa.get(clave);
    if (x) x.usos++; else mapa.set(clave, { nombre, marca, usos: 1 });
  };
  todasLasFichas.forEach((f) => comprasDe(f).forEach((c) => (c.elementos || []).forEach(agregar)));
  compras.forEach((c) => c.elementos.forEach(agregar)); // también lo agregado en esta ventana sin guardar
  return [...mapa.values()];
}

function buscarSugerencias(c, campo) {
  const conMarca = usaMarcas(c.nombre);
  if (campo === "_marca" && !conMarca) return [];
  const qNom = norm(c._nom).trim();
  const qMarca = campo === "_marca" ? norm(c._marca).trim() : "";
  if (campo === "_nom" && !qNom) return [];
  if (campo === "_marca" && !qMarca) return [];

  const lista = [];
  for (const x of elementosConocidos(conMarca)) {
    const n = norm(x.nombre), m = norm(x.marca);
    if (qNom && !n.includes(qNom)) continue;
    if (qMarca && !m.includes(qMarca)) continue;
    // No sugerir lo que ya está escrito exactamente
    if (n === qNom && (!conMarca || m === norm(c._marca).trim())) continue;
    const empieza = (campo === "_nom" ? n.startsWith(qNom) : m.startsWith(qMarca)) ? 0 : 1;
    lista.push({ ...x, empieza });
  }
  lista.sort((a, b) => a.empieza - b.empieza || b.usos - a.usos || a.nombre.localeCompare(b.nombre, "es"));
  return lista.slice(0, MAX_SUGERENCIAS);
}

function cerrarSugerencias() {
  if (sugerencias.ul) sugerencias.ul.remove();
  sugerencias = { ci: -1, items: [], activo: -1, ul: null };
}

function mostrarSugerencias(input) {
  cerrarSugerencias();
  const caja = input.closest(".comercio");
  if (!caja) return;
  const ci = Number(caja.dataset.ci);
  const items = buscarSugerencias(compras[ci], input.dataset.campo);
  if (!items.length) return;
  const ul = document.createElement("ul");
  ul.className = "sugerencias";
  ul.setAttribute("role", "listbox");
  ul.innerHTML = items.map((x, i) =>
    `<li role="option" data-i="${i}">${esc(x.nombre)}${x.marca ? ` - <em>${esc(x.marca)}</em>` : ""}</li>`
  ).join("");
  input.closest("label").appendChild(ul);
  sugerencias = { ci, items, activo: -1, ul };
}

function marcarSugerencia(i) {
  sugerencias.activo = i;
  [...sugerencias.ul.children].forEach((li, k) => li.classList.toggle("activa", k === i));
}

function elegirSugerencia(i) {
  const x = sugerencias.items[i];
  if (!x) return;
  const ci = sugerencias.ci;
  const c = compras[ci];
  c._nom = x.nombre;
  if (usaMarcas(c.nombre)) c._marca = x.marca;
  cerrarSugerencias();
  const caja = listaCompras.querySelector(`[data-ci="${ci}"]`);
  caja.querySelector('[data-campo="_nom"]').value = c._nom;
  const inputMarca = caja.querySelector('[data-campo="_marca"]');
  if (inputMarca) inputMarca.value = c._marca;
  actualizarAlertas();
  caja.querySelector('[data-campo="_precio"]').focus();
}

// Elegir con el mouse o el dedo (mousedown evita que el campo pierda el foco antes)
listaCompras.addEventListener("mousedown", (e) => {
  const li = e.target.closest(".sugerencias li");
  if (!li) return;
  e.preventDefault();
  elegirSugerencia(Number(li.dataset.i));
});
listaCompras.addEventListener("focusout", () => cerrarSugerencias());

function pintarCompras(foco) {
  cerrarSugerencias();
  avisoCatalogo.hidden = getCatalogo().length > 0;

  listaCompras.innerHTML = compras.map((c, ci) => {
    const conMarca = usaMarcas(c.nombre);
    return `
    <div class="comercio" data-ci="${ci}">
      <div class="comercio-cab">
        <label>Comercio
          <select data-campo="nombre">${opcionesComercio(c.nombre)}</select>
        </label>
        <label>Fecha de compra o facturación
          <input type="date" data-campo="fecha" value="${esc(c.fecha)}">
        </label>
        <button type="button" class="peligro" data-accion="quitarCom">Quitar comercio</button>
      </div>

      <div class="fila-item">
        <label class="campo campo-nombre">Elemento comprado
          <input type="text" data-campo="_nom" value="${esc(c._nom)}" placeholder="Elemento comprado" autocomplete="off">
        </label>
        ${conMarca ? `
        <label class="campo campo-marca">Marca <small>(opcional)</small>
          <input type="text" data-campo="_marca" value="${esc(c._marca)}" placeholder="Marca" autocomplete="off">
        </label>` : ""}
        <label class="campo campo-num">Cantidad
          <input type="number" data-campo="_cant" value="${esc(c._cant)}" min="0" step="any">
        </label>
        <label class="campo campo-val">Valor unitario
          <input type="text" inputmode="decimal" data-campo="_precio" value="${esc(fmtPrecioInput(c._precio))}" placeholder="$ 0" autocomplete="off">
        </label>
        <label class="campo campo-val">Valor total
          <input type="text" class="total-pend" value="${moneda(totalPendiente(c))}" readonly tabindex="-1">
        </label>
        <button type="button" data-accion="addEl">Agregar</button>
      </div>
      <div class="alerta-slot"></div>

      <ul class="items">
        ${c.elementos.map((el, ei) => `
          <li class="item-edit" data-ei="${ei}">
            <div class="fila-item">
              <label class="campo campo-nombre">
                <input type="text" data-el="nombre" value="${esc(el.nombre)}" aria-label="Descripción del elemento" autocomplete="off">
              </label>
              ${conMarca ? `
              <label class="campo campo-marca">
                <input type="text" data-el="marca" value="${esc(el.marca)}" placeholder="Marca" aria-label="Marca" autocomplete="off">
              </label>` : ""}
              <label class="campo campo-num">
                <input type="number" data-el="cantidad" value="${esc(el.cantidad)}" min="0" step="any" aria-label="Cantidad">
              </label>
              <label class="campo campo-val">
                <input type="text" inputmode="decimal" data-el="valorUnitario" value="${esc(fmtPrecioInput(el.valorUnitario))}" placeholder="$ 0" aria-label="Valor unitario" autocomplete="off">
              </label>
              <label class="campo campo-val">
                <input type="text" class="total-pend" data-total value="${moneda(el.valorTotal)}" readonly tabindex="-1" aria-label="Valor total">
              </label>
              <button type="button" class="quitar" data-accion="quitarEl" data-ei="${ei}" title="Quitar">×</button>
            </div>
            <div data-alerta-el="${ei}"></div>
          </li>`).join("")}
      </ul>
    </div>`;
  }).join("") || '<p class="vacio">Aún no hay comercios en esta cotización. Usa «+ Agregar comercio».</p>';

  actualizarAlertas();

  if (foco) {
    const el = listaCompras.querySelector(`[data-ci="${foco.ci}"] [data-campo="${foco.campo}"]`);
    if (el) el.focus();
  }
}

function agregarElemento(ci) {
  const c = compras[ci];
  if (!c.nombre) return avisar("Primero selecciona el comercio.", "error");

  const nombre = c._nom.trim();
  const cantidad = c._cant === "" ? 1 : parseFloat(c._cant);
  const valorUnitario = parseFloat(c._precio);
  if (!nombre || isNaN(valorUnitario) || valorUnitario < 0) return avisar("Escribe el elemento y su valor unitario.", "error");
  if (isNaN(cantidad) || cantidad <= 0) return avisar("La cantidad debe ser mayor que 0.", "error");

  c.elementos.push({
    nombre,
    marca: usaMarcas(c.nombre) ? c._marca.trim() : "",
    cantidad,
    valorUnitario,
    valorTotal: redondear(cantidad * valorUnitario)
  });
  c._nom = "";
  c._marca = "";
  c._cant = "1";
  c._precio = "";
  pintarCompras({ ci, campo: "_nom" });
}

$("btnAddCompra").addEventListener("click", () => {
  compras.push(nuevaCompra());
  pintarCompras({ ci: compras.length - 1, campo: "nombre" });
});

// Da formato "$ 1.234,5" a un campo de valor mientras se escribe, conserva el cursor y devuelve el valor crudo ("1234.5")
function formatearPrecioEnInput(input) {
  const caret = input.selectionStart;
  // Cuántos dígitos o comas hay a la izquierda del cursor
  const izq = input.value.slice(0, caret).replace(/[^\d,]/g, "").length;

  // Solo dígitos y una coma decimal
  const txt = input.value.replace(/[^\d,]/g, "");
  const i = txt.indexOf(",");
  let ent = i === -1 ? txt : txt.slice(0, i);
  const dec = i === -1 ? undefined : txt.slice(i + 1).replace(/,/g, "");
  ent = ent.replace(/^0+(?=\d)/, "");

  const raw = ent === "" && dec === undefined ? "" : (ent || "0") + (dec !== undefined ? "." + dec : "");
  input.value = fmtPrecioInput(raw);

  // Devuelve el cursor a su lugar tras el formato
  let n = 0, pos = 0;
  for (; pos < input.value.length && n < izq; pos++) {
    if (/[\d,]/.test(input.value[pos])) n++;
  }
  input.setSelectionRange(pos, pos);
  return raw;
}

// Edición de un elemento ya agregado (descripción, marca, cantidad y valor unitario)
listaCompras.addEventListener("input", (e) => {
  const campo = e.target.dataset.el;
  if (!campo) return;
  const caja = e.target.closest(".comercio");
  const li = e.target.closest("li[data-ei]");
  if (!caja || !li) return;
  const el = compras[Number(caja.dataset.ci)].elementos[Number(li.dataset.ei)];

  if (campo === "nombre" || campo === "marca") {
    el[campo] = e.target.value;
  } else if (campo === "cantidad") {
    el.cantidad = e.target.value === "" ? NaN : parseFloat(e.target.value);
  } else if (campo === "valorUnitario") {
    const raw = formatearPrecioEnInput(e.target);
    el.valorUnitario = raw === "" ? NaN : parseFloat(raw);
  }

  if (campo === "cantidad" || campo === "valorUnitario") {
    const ok = Number.isFinite(el.cantidad) && Number.isFinite(el.valorUnitario);
    el.valorTotal = ok ? redondear(el.cantidad * el.valorUnitario) : 0;
    li.querySelector("[data-total]").value = ok ? moneda(el.valorTotal) : "—";
  }
  actualizarAlertas();
});

// Lo que se escribe se guarda en el estado sin repintar (no se pierde el foco)
listaCompras.addEventListener("input", (e) => {
  const campo = e.target.dataset.campo;
  const caja = e.target.closest(".comercio");
  if (!campo || !caja) return;
  const ci = Number(caja.dataset.ci);

  if (campo === "_precio") {
    compras[ci]._precio = formatearPrecioEnInput(e.target);
  } else {
    compras[ci][campo] = e.target.value;
  }

  if (campo === "_cant" || campo === "_precio") {
    caja.querySelector(".total-pend").value = moneda(totalPendiente(compras[ci]));
  }

  if (campo === "_nom" || campo === "_marca") mostrarSugerencias(e.target);
  else cerrarSugerencias();

  if (campo === "_nom" || campo === "_marca" || campo === "_precio" || campo === "fecha") actualizarAlertas();
});

// Al elegir comercio se repinta: así aparece o desaparece el campo Marca
listaCompras.addEventListener("change", (e) => {
  if (e.target.dataset.campo !== "nombre") return;
  const caja = e.target.closest(".comercio");
  const ci = Number(caja.dataset.ci);
  compras[ci].nombre = e.target.value;
  if (!usaMarcas(compras[ci].nombre)) compras[ci]._marca = "";
  pintarCompras({ ci, campo: "_nom" });
});

listaCompras.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-accion]");
  const caja = e.target.closest(".comercio");
  if (!btn || !caja) return;
  const ci = Number(caja.dataset.ci);
  const accion = btn.dataset.accion;

  if (accion === "quitarCom") {
    compras.splice(ci, 1);
    pintarCompras();
  } else if (accion === "quitarEl") {
    compras[ci].elementos.splice(Number(btn.dataset.ei), 1);
    pintarCompras();
  } else if (accion === "addEl") {
    agregarElemento(ci);
  }
});

listaCompras.addEventListener("keydown", (e) => {
  // Navegación del autorelleno con el teclado
  if (sugerencias.items.length) {
    const n = sugerencias.items.length;
    if (e.key === "ArrowDown") { e.preventDefault(); return marcarSugerencia((sugerencias.activo + 1) % n); }
    if (e.key === "ArrowUp") { e.preventDefault(); return marcarSugerencia((sugerencias.activo - 1 + n) % n); }
    if (e.key === "Escape") { e.stopPropagation(); return cerrarSugerencias(); } // no cierra la ventana
    if (e.key === "Enter" && sugerencias.activo >= 0) { e.preventDefault(); return elegirSugerencia(sugerencias.activo); }
  }
  if (e.key === "Enter" && e.target.dataset.el) { e.preventDefault(); return; }
  if (e.key !== "Enter") return;
  const campo = e.target.dataset.campo;
  const caja = e.target.closest(".comercio");
  if (!campo || !caja) return;
  e.preventDefault(); // que Enter no envíe el formulario
  if (campo.startsWith("_")) agregarElemento(Number(caja.dataset.ci));
});

// Antes de guardar: agrega elementos pendientes, quita compras vacías y valida
function consolidarCompras() {
  for (const c of compras) {
    const nom = c._nom.trim();
    const hayAlgo = nom || c._precio !== "" || c._marca.trim();
    if (!hayAlgo) continue;

    const cantidad = c._cant === "" ? 1 : parseFloat(c._cant);
    const valorUnitario = parseFloat(c._precio);
    if (c.nombre && nom && !isNaN(valorUnitario) && valorUnitario >= 0 && !isNaN(cantidad) && cantidad > 0) {
      c.elementos.push({
        nombre: nom,
        marca: usaMarcas(c.nombre) ? c._marca.trim() : "",
        cantidad,
        valorUnitario,
        valorTotal: redondear(cantidad * valorUnitario)
      });
      c._nom = ""; c._marca = ""; c._cant = "1"; c._precio = "";
    } else {
      return `Termina de agregar el elemento pendiente en «${c.nombre || "comercio sin elegir"}» (comercio, elemento y valor unitario).`;
    }
  }
  for (const c of compras) {
    for (const el of c.elementos) {
      el.nombre = String(el.nombre).trim();
      el.marca = String(el.marca || "").trim();
      if (!el.nombre || !Number.isFinite(el.valorUnitario) || el.valorUnitario < 0 || !Number.isFinite(el.cantidad) || el.cantidad <= 0) {
        return `Revisa los elementos de «${c.nombre || "comercio sin elegir"}»: cada uno necesita descripción, cantidad mayor que 0 y valor unitario.`;
      }
      el.valorTotal = redondear(el.cantidad * el.valorUnitario);
    }
  }
  compras = compras.filter((c) => c.nombre || c.fecha || c.elementos.length);
  if (compras.some((c) => !c.nombre)) return "Cada compra necesita elegir el comercio.";
  return null;
}

// ---------- Guardar ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!puedeEditar()) return avisar("Tu usuario es de solo lectura.", "error");
  const id = (editandoId || inputId.value).trim();
  if (!id) {
    irATab("general");
    inputId.focus();
    return avisar("Escribe el ID de la ficha.", "error");
  }
  if (id.includes("/")) {
    irATab("general");
    return avisar('El ID no puede contener "/".', "error");
  }

  const problema = consolidarCompras();
  pintarCompras();
  if (problema) {
    irATab("compras");
    return avisar(problema, "error");
  }

  const cambios = cambiosDelFormulario(); // se calcula antes de guardar y de limpiar el formulario

  try {
    if (!editandoId) {
      const existente = await getDoc(doc(fichasRef, id));
      if (existente.exists()) {
        irATab("general");
        return avisar("Ya existe una ficha con ese ID.", "error");
      }
    }
    const eraEdicion = !!editandoId;
    const batch = writeBatch(db);
    batch.set(doc(fichasRef, id), {
      id,
      cliente: inputCliente.value.trim(),
      remisiones,
      compras: compras.map((c) => ({
        nombre: c.nombre,
        fecha: c.fecha || "",
        elementos: c.elementos.map((el) => ({
          nombre: el.nombre,
          marca: el.marca || "",
          cantidad: el.cantidad,
          valorUnitario: el.valorUnitario,
          valorTotal: el.valorTotal
        }))
      })),
      observaciones: inputObs.value.trim(),
      comercios: deleteField(),  // limpia formatos anteriores de la ficha
      elementos: deleteField(),
      actualizado: serverTimestamp()
    }, { merge: true });
    registrarCambio(batch, "fichas"); // avisa a los demás equipos (y a este) que hubo un cambio
    await batch.commit();
    sincronizarAhora();               // trae de inmediato lo guardado, sin esperar los 30 s
    terminar();
    const base = eraEdicion ? "Ficha actualizada." : "Ficha guardada.";
    const resumen = (lista) => lista.slice(0, 3).map((x) => `${x.nombre} (${moneda(Math.abs(x.a.diferencia))})`).join(", ")
      + (lista.length > 3 ? ` y ${lista.length - 3} más` : "");
    const aumentos = cambios.filter((x) => x.a.tipo === "aumento");
    const bajas = cambios.filter((x) => x.a.tipo === "disminucion");
    const partes = [];
    if (aumentos.length) partes.push(`⚠ Aumento de precio (más de ${moneda(UMBRAL_CAMBIO)}): ${resumen(aumentos)}`);
    if (bajas.length) partes.push(`▼ Disminución de precio (más de ${moneda(UMBRAL_CAMBIO)}): ${resumen(bajas)}`);
    if (partes.length) avisar(`${base} ${partes.join(" · ")}`, aumentos.length ? "error" : "ok", 10000);
    else avisar(base);
  } catch (err) {
    console.error(err);
    avisar("Error al guardar: " + err.message, "error");
  }
});

// ---------- Eliminar (solo desde la ventana de edición) ----------
$("btnEliminar").addEventListener("click", async () => {
  if (!editandoId || !puedeEditar()) return;
  if (!confirm(`¿Eliminar la ficha ${editandoId}? Esta acción no se puede deshacer.`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(fichasRef, editandoId));
    registrarCambio(batch, "fichas", { borrado: true });
    await batch.commit();
    sincronizarAhora();
    terminar();
    avisar("Ficha eliminada.");
  } catch (err) {
    avisar("Error al eliminar: " + err.message, "error");
  }
});

// ---------- Listado y búsqueda ----------
function coincide(ficha, q) {
  if (!q) return true;
  const t = norm(q);
  return (
    norm(ficha.cliente || "").includes(t) ||
    (ficha.remisiones || []).some((r) => norm(r).includes(t)) ||
    comprasDe(ficha).some((c) =>
      norm(c.nombre || "").includes(t) ||
      (c.elementos || []).some((el) => norm(el.nombre || "").includes(t) || norm(el.marca || "").includes(t))
    )
  );
}

function tablaCompra(c) {
  const els = (c.elementos || []).map(elementoNormal);
  const conMarca = els.some((e) => e.marca);
  const columnas = conMarca ? 5 : 4;
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr>
          <th>Elemento</th>${conMarca ? "<th>Marca</th>" : ""}
          <th class="num">Cant.</th><th class="precio">V. unitario</th><th class="precio">V. total</th>
        </tr></thead>
        <tbody>
          ${els.map((e) => `<tr>
            <td>${esc(e.nombre)}</td>${conMarca ? `<td>${esc(e.marca) || "—"}</td>` : ""}
            <td class="num">${fmtNum(e.cantidad)}</td>
            <td class="precio">${moneda(e.valorUnitario)}${marcaCambio(e.nombre, e.marca, c.nombre, e.valorUnitario, c.fecha)}</td>
            <td class="precio">${moneda(e.valorTotal)}</td>
          </tr>`).join("") || `<tr><td colspan="${columnas}">Sin elementos</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

// Buscador de ID (independiente del general)
const coincideId = (ficha, q) => !q || norm(ficha.id).includes(norm(q));

function pintarFichas() {
  const q = buscador.value.trim();
  const qId = buscadorId.value.trim();
  const lista = todasLasFichas.filter((f) => coincideId(f, qId) && coincide(f, q));
  $("contador").textContent = `(${lista.length})`;

  if (!lista.length) {
    resultados.innerHTML = "<p>No hay fichas que coincidan.</p>";
    return;
  }

  resultados.innerHTML = lista.map((f) => `
    <article class="ficha" data-id="${esc(f.id)}" ${puedeEditar() ? `tabindex="0" role="button" aria-label="Editar ficha ${esc(f.id)}"` : ""}>
      <h3>
        <span>ID: ${esc(f.id)}</span>
        ${f.cliente ? `<span class="cliente">${ICONO_EMPRESA} ${esc(f.cliente)}</span>` : ""}
      </h3>
      <div><strong>Remisiones:</strong> ${(f.remisiones || []).map(esc).join(", ") || "—"}</div>
      ${comprasDe(f).map((c, ci) => `
        <div class="compra">
          <div class="compra-cab">
            <span class="compra-nombre">${ICONO_COMERCIO} ${esc(c.nombre || "Sin comercio")}</span>
            ${c.fecha ? `<span class="compra-fecha">Fecha: ${fechaCorta(c.fecha)}</span>` : ""}
            <button type="button" class="btn-copiar" data-copiar="${ci}" title="Copiar lo comprado en este comercio">Copiar</button>
          </div>
          ${tablaCompra(c)}
        </div>
      `).join("") || '<p class="vacio">Sin compras registradas</p>'}
      ${f.observaciones ? `<div class="obs"><strong>Observaciones:</strong> ${esc(f.observaciones)}</div>` : ""}
    </article>
  `).join("");
}

buscador.addEventListener("input", pintarFichas);
buscadorId.addEventListener("input", pintarFichas);

function fichaDesdeEvento(e) {
  const tarjeta = e.target.closest(".ficha");
  if (!tarjeta) return null;
  return todasLasFichas.find((f) => f.id === tarjeta.dataset.id) || null;
}

// Texto de una compra para copiar:
// Se compró de Soltrancia:
//
// * Sprocket 100B25 x 1 - $ 100.000 c/u
function textoCompra(c) {
  const lineas = (c.elementos || []).map(elementoNormal).filter((e) => e.nombre).map((e) =>
    `* ${e.nombre} x ${e.cantidad} - ${moneda(e.valorUnitario).replace(/\s/g, " ")} c/u`);
  return `Se compró de ${c.nombre || "(sin comercio)"}:\n\n${lineas.join("\n")}`;
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Respaldo para páginas abiertas sin https
    const ta = document.createElement("textarea");
    ta.value = texto;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("No se pudo copiar");
  }
}

resultados.addEventListener("click", async (e) => {
  const btnCopiar = e.target.closest("[data-copiar]");
  if (btnCopiar) {
    const f = fichaDesdeEvento(e);
    const c = f && comprasDe(f)[Number(btnCopiar.dataset.copiar)];
    if (!c) return;
    try {
      await copiarTexto(textoCompra(c));
      avisar(`Copiado: ${c.nombre || "compra"}.`);
    } catch (err) {
      console.error(err);
      avisar("No se pudo copiar.", "error");
    }
    return;
  }
  // Solo la parte blanca de la ficha abre la edición: los bloques de compras y las observaciones no
  if (e.target.closest(".compra, .obs")) return;
  const ficha = fichaDesdeEvento(e);
  if (ficha) abrirEditar(ficha);
});

resultados.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const ficha = fichaDesdeEvento(e);
  if (ficha) { e.preventDefault(); abrirEditar(ficha); }
});

// ---------- Datos desde Firestore (caché local + revisión cada 30 s, ver sync.js) ----------
const singular = iniciarElementoSingular({ comprasDe, elementoNormal, moneda, fechaCorta });
const tracking = iniciarTracking({ comprasDe, elementoNormal, moneda });

crearFuente({
  nombre: "fichas",
  ref: fichasRef,
  incremental: true,
  alCambiar: (lista) => {
    todasLasFichas = lista
      .sort((a, b) => String(a.id).localeCompare(String(b.id), "es", { numeric: true }));
    indicePrecios = construirIndice(todasLasFichas, { comprasDe, elementoNormal });
    pintarFichas();
    singular.actualizar(todasLasFichas);
    tracking.actualizar(todasLasFichas);
    actualizarAlertas(); // por si hay una ventana abierta y alguien más guardó precios
  },
  alError: (err) => {
    resultados.innerHTML = `<p class="error">No se pudo conectar con Firebase: ${esc(err.message)}</p>`;
  }
});

// ---------- Arranque ----------
iniciarComercios({ alCambiar: () => pintarCompras(), avisar });
pintarRemisiones();
pintarCompras();
configurarModo();
irATab("general");
// Los datos solo se piden a Firestore cuando hay sesión iniciada (ver auth.js)
iniciarAuth({ alEntrar: () => iniciarSync() });
