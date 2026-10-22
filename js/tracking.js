// Pestaña "Tracking": una fila por elemento único de un comercio (nombre + marca + comercio),
// con su último precio y la tasa de cambio frente a la compra anterior en ESE mismo comercio.
// Mismo buscador que "Elemento singular". Muestra 50 por página.
import { crearFiltro } from "./filtro-elementos.js";
import { claveElemento } from "./alerta-precios.js";

const POR_PAGINA = 50;

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// +12,5%  /  -8%  /  0%
const fmtPct = (n) => {
  const txt = Math.abs(n).toLocaleString("es-CO", { maximumFractionDigits: 1 });
  return (n > 0 ? "+" : n < 0 ? "-" : "") + txt + "%";
};

const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const fmtFecha = (iso) => { const [a, m, d] = iso.split("-"); return `${d}/${m}/${a}`; };
const ts = (iso) => new Date(iso + "T00:00:00").getTime();

export function iniciarTracking({ comprasDe, elementoNormal, moneda }) {
  const contador = document.getElementById("contadorTracking");
  const resultados = document.getElementById("resultadosTracking");
  const paginacion = document.getElementById("paginacionTracking");

  let filas = [];   // [{ nombre, marca, comercio, valorUnitario, tasa, anterior }]
  let pagina = 1;
  let listaActual = []; // lista filtrada completa (para saber qué fila se pulsó)

  const filtro = crearFiltro({
    input: document.getElementById("buscadorTracking"),
    btnLimpiar: document.getElementById("btnLimpiarTracking"),
    btnQuitarTodo: document.getElementById("btnQuitarFiltrosTracking"),
    marcas: document.getElementById("chipsMarcaTracking"),
    comercios: document.getElementById("chipsComercioTracking"),
    alCambiar: () => { pagina = 1; pintar(); }
  });

  function construirFilas(fichas) {
    const grupos = new Map();
    for (const f of fichas) {
      const orden = f.actualizado?.seconds ?? 0;
      for (const c of comprasDe(f)) {
        for (const raw of c.elementos || []) {
          const e = elementoNormal(raw);
          if (!e.nombre) continue;
          const k = claveElemento(e.nombre, e.marca, c.nombre);
          if (!grupos.has(k)) grupos.set(k, []);
          grupos.get(k).push({
            nombre: e.nombre, marca: (e.marca || "").trim(), comercio: c.nombre || "",
            valorUnitario: e.valorUnitario, fecha: c.fecha || "", orden
          });
        }
      }
    }

    const out = [];
    for (const regs of grupos.values()) {
      // Más reciente primero; las compras sin fecha quedan al final
      regs.sort((a, b) => (!a.fecha - !b.fecha) || b.fecha.localeCompare(a.fecha) || b.orden - a.orden);
      const ultimo = regs[0];
      // Compra anterior: la de la fecha más reciente ANTERIOR a la última (misma regla que la alarma)
      const previo = ultimo.fecha ? regs.find((r) => r.fecha && r.fecha < ultimo.fecha) : null;
      const tasa = previo && previo.valorUnitario > 0
        ? ((ultimo.valorUnitario - previo.valorUnitario) / previo.valorUnitario) * 100
        : null;
      out.push({
        nombre: ultimo.nombre, marca: ultimo.marca, comercio: ultimo.comercio,
        valorUnitario: ultimo.valorUnitario, tasa, anterior: previo ? previo.valorUnitario : null,
        // historial de más antiguo a más reciente (solo compras con fecha)
        historial: [...regs].reverse()
          .filter((r) => r.fecha)
          .map((r) => ({ fecha: r.fecha, valorUnitario: r.valorUnitario }))
      });
    }
    return out.sort((a, b) =>
      a.nombre.localeCompare(b.nombre, "es") ||
      a.marca.localeCompare(b.marca, "es") ||
      a.comercio.localeCompare(b.comercio, "es"));
  }

  function celdaTasa(r) {
    if (r.tasa == null) return '<span class="sin-dato" title="Sin compra anterior en este comercio">—</span>';
    const detalle = `<small>vs ${moneda(r.anterior)}</small>`;
    if (r.tasa > 0) return `<span class="alza">▲ ${fmtPct(r.tasa)}${detalle}</span>`;
    if (r.tasa < 0) return `<span class="baja">▼ ${fmtPct(r.tasa)}${detalle}</span>`;
    return `<span class="igual">0%${detalle}</span>`;
  }

  function pintar() {
    const lista = filtro.aplicar(filas);
    const total = lista.length;
    listaActual = lista;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(Math.max(pagina, 1), paginas);
    contador.textContent = `(${total})`;

    if (!total) {
      resultados.innerHTML = filas.length
        ? "<p>No hay elementos que coincidan.</p>"
        : '<p class="vacio">Aún no hay compras registradas.</p>';
      paginacion.innerHTML = "";
      return;
    }

    const ini = (pagina - 1) * POR_PAGINA;
    const visibles = lista.slice(ini, ini + POR_PAGINA);

    resultados.innerHTML = `
      <div class="tabla-scroll">
        <table class="tabla-singular">
          <thead><tr>
            <th>Elemento</th><th>Marca</th><th class="precio">V. unitario</th><th>Comercio</th><th class="precio">Tasa de cambio</th><th></th>
          </tr></thead>
          <tbody>
            ${visibles.map((r, i) => `<tr>
              <td>${esc(r.nombre)}</td>
              <td>${esc(r.marca) || "—"}</td>
              <td class="precio">${moneda(r.valorUnitario)}</td>
              <td>${esc(r.comercio) || "—"}</td>
              <td class="precio">${celdaTasa(r)}</td>
              <td><button type="button" class="secundario btn-graf" data-graf="${ini + i}" ${r.historial.length ? "" : "disabled"} title="Ver historial de precios">📈 Gráfica</button></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    paginacion.innerHTML = paginas > 1 ? `
      <button type="button" class="secundario" data-pag="-1" ${pagina === 1 ? "disabled" : ""}>« Anterior</button>
      <span>Página ${pagina} de ${paginas} · ${ini + 1}–${ini + visibles.length} de ${total}</span>
      <button type="button" class="secundario" data-pag="1" ${pagina === paginas ? "disabled" : ""}>Siguiente »</button>` : "";
  }

  paginacion.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pag]");
    if (!b || b.disabled) return;
    pagina += Number(b.dataset.pag);
    pintar();
    document.getElementById("vista-tracking").scrollIntoView({ block: "start" });
  });

  // ---------- Gráfica anual ----------
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal modal-grafica" role="dialog" aria-modal="true" aria-labelledby="grafTitulo">
      <h2 id="grafTitulo"></h2>
      <p id="grafSub" class="vacio"></p>
      <label class="filtro-marca">Año
        <select id="grafAnio"></select>
      </label>
      <div id="grafCuerpo"></div>
      <div class="fila acciones"><button type="button" id="grafCerrar" class="secundario">Cerrar</button></div>
    </div>`;
  document.body.appendChild(overlay);

  const grafTitulo = overlay.querySelector("#grafTitulo");
  const grafSub = overlay.querySelector("#grafSub");
  const grafAnio = overlay.querySelector("#grafAnio");
  const grafCuerpo = overlay.querySelector("#grafCuerpo");
  let actual = null;

  const cerrarGrafica = () => { overlay.hidden = true; document.body.classList.remove("modal-abierto"); };
  overlay.querySelector("#grafCerrar").addEventListener("click", cerrarGrafica);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) cerrarGrafica(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) cerrarGrafica(); });
  grafAnio.addEventListener("change", dibujar);

  function abrirGrafica(r) {
    actual = r;
    grafTitulo.textContent = r.nombre;
    grafSub.textContent = [r.marca || "Sin marca", r.comercio || "Sin comercio"].join(" · ");
    const anios = [...new Set(r.historial.map((p) => p.fecha.slice(0, 4)))].sort().reverse();
    grafAnio.innerHTML = `<option value="todos">Todos los años</option>` +
      anios.map((a) => `<option value="${a}">${a}</option>`).join("");
    grafAnio.value = anios[0] || "todos"; // por defecto el año más reciente
    overlay.hidden = false;
    document.body.classList.add("modal-abierto");
    dibujar();
  }

  function dibujar() {
    const anio = grafAnio.value;
    const pts = actual.historial.filter((p) => anio === "todos" || p.fecha.startsWith(anio));
    if (!pts.length) { grafCuerpo.innerHTML = "<p>Sin compras en ese año.</p>"; return; }

    const W = 700, H = 320, M = { l: 84, r: 20, t: 20, b: 40 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    // Eje X
    let x0, x1;
    if (anio === "todos") {
      x0 = ts(pts[0].fecha); x1 = ts(pts[pts.length - 1].fecha);
      if (x0 === x1) { x0 -= 15 * 864e5; x1 += 15 * 864e5; }
    } else { x0 = ts(`${anio}-01-01`); x1 = ts(`${anio}-12-31`); }
    const X = (t) => M.l + ((t - x0) / (x1 - x0)) * iw;

    // Eje Y
    let y0 = Math.min(...pts.map((p) => p.valorUnitario));
    let y1 = Math.max(...pts.map((p) => p.valorUnitario));
    if (y0 === y1) { y0 *= 0.9; y1 = y1 * 1.1 || 1; }
    const pad = (y1 - y0) * 0.1; y0 = Math.max(0, y0 - pad); y1 += pad;
    const Y = (v) => M.t + ih - ((v - y0) / (y1 - y0)) * ih;

    let g = "";
    for (let i = 0; i <= 4; i++) {            // cuadrícula horizontal
      const v = y0 + ((y1 - y0) * i) / 4, y = Y(v);
      g += `<line class="g-grid" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/>
            <text class="g-txt" x="${M.l - 8}" y="${y + 4}" text-anchor="end">${esc(moneda(Math.round(v)))}</text>`;
    }
    if (anio === "todos") {                   // 5 fechas repartidas
      for (let i = 0; i <= 4; i++) {
        const t = x0 + ((x1 - x0) * i) / 4, d = new Date(t);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        g += `<text class="g-txt" x="${X(t)}" y="${H - 14}" text-anchor="middle">${fmtFecha(iso)}</text>`;
      }
    } else {                                  // 12 meses
      MESES.forEach((m, i) => {
        const t = ts(`${anio}-${String(i + 1).padStart(2, "0")}-01`);
        g += `<line class="g-grid" x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${M.t + ih}"/>
              <text class="g-txt" x="${X(t) + 2}" y="${H - 14}">${m}</text>`;
      });
    }

    const linea = pts.map((p, i) => `${i ? "L" : "M"}${X(ts(p.fecha)).toFixed(1)},${Y(p.valorUnitario).toFixed(1)}`).join(" ");
    const puntos = pts.map((p) => `<circle class="g-pto" cx="${X(ts(p.fecha)).toFixed(1)}" cy="${Y(p.valorUnitario).toFixed(1)}" r="5">
        <title>${fmtFecha(p.fecha)}: ${esc(moneda(p.valorUnitario))}</title></circle>`).join("");

    // Resumen
    const min = Math.min(...pts.map((p) => p.valorUnitario));
    const max = Math.max(...pts.map((p) => p.valorUnitario));
    const prim = pts[0].valorUnitario, ult = pts[pts.length - 1].valorUnitario;
    const var_ = prim > 0 ? ((ult - prim) / prim) * 100 : null;
    const clase = var_ > 0 ? "alza" : var_ < 0 ? "baja" : "igual";

    grafCuerpo.innerHTML = `
      <svg class="grafica" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historial de precios">
        ${g}<path class="g-linea" d="${linea}"/>${puntos}
      </svg>
      <p class="grafica-resumen">
        <span>${pts.length} compra${pts.length === 1 ? "" : "s"}</span>
        <span>Mínimo: <b>${esc(moneda(min))}</b></span>
        <span>Máximo: <b>${esc(moneda(max))}</b></span>
        ${var_ == null ? "" : `<span>Variación del período: <b class="${clase}">${fmtPct(var_)}</b></span>`}
      </p>`;
  }

  resultados.addEventListener("click", (e) => {
    const b = e.target.closest("[data-graf]");
    if (!b || b.disabled) return;
    const r = listaActual[Number(b.dataset.graf)];
    if (r) abrirGrafica(r);
  });

  filtro.llenarOpciones(filas);
  pintar();

  // app.js lo llama cada vez que cambian las fichas en Firestore
  return {
    actualizar(fichas) {
      filas = construirFilas(fichas);
      filtro.llenarOpciones(filas);
      pintar();
    }
  };
}
