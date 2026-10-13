// Pestaña "Elemento singular": historial de precios de un elemento.
// El buscador solo mira el nombre del elemento; el filtro "Marca" acota por marca.
import { crearFiltro } from "./filtro-elementos.js";

const MAX_FILAS = 20;

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Recibe de app.js lo que depende del formato de las fichas y del formato de moneda/fecha,
// para que haya una sola versión de esa lógica.
export function iniciarElementoSingular({ comprasDe, elementoNormal, moneda, fechaCorta }) {
  const contador = document.getElementById("contadorSingular");
  const resultados = document.getElementById("resultadosSingular");

  let filas = []; // todas las compras de todos los elementos

  const filtro = crearFiltro({
    input: document.getElementById("buscadorElemento"),
    btnLimpiar: document.getElementById("btnLimpiarElemento"),
    select: document.getElementById("filtroMarca"),
    alCambiar: () => pintar()
  });

  function construirHistorial(fichas) {
    const out = [];
    for (const f of fichas) {
      for (const c of comprasDe(f)) {
        for (const raw of c.elementos || []) {
          const e = elementoNormal(raw);
          if (!e.nombre) continue;
          out.push({
            nombre: e.nombre,
            marca: (e.marca || "").trim(),
            valorUnitario: e.valorUnitario,
            comercio: c.nombre || "",
            fecha: c.fecha || "",
            ficha: String(f.id)
          });
        }
      }
    }
    return out;
  }

  function pintar() {
    if (!filtro.hayFiltro()) {
      contador.textContent = "";
      resultados.innerHTML = '<p class="vacio">Escribe un elemento o elige una marca para ver su historial de precios, del más reciente al más antiguo.</p>';
      return;
    }

    const todas = filtro.aplicar(filas).sort((a, b) =>
      (!a.fecha - !b.fecha) ||                          // sin fecha al final
      b.fecha.localeCompare(a.fecha) ||                 // más reciente primero
      b.ficha.localeCompare(a.ficha, "es", { numeric: true })
    );
    const lista = todas.slice(0, MAX_FILAS);

    contador.textContent = todas.length > MAX_FILAS ? `(${MAX_FILAS} de ${todas.length})` : `(${todas.length})`;

    if (!lista.length) {
      resultados.innerHTML = "<p>No hay compras registradas con ese elemento y marca.</p>";
      return;
    }

    resultados.innerHTML = `
      <div class="tabla-scroll">
        <table class="tabla-singular">
          <thead><tr>
            <th>Elemento</th><th>Marca</th><th class="precio">V. unitario</th><th>Comercio</th><th>Fecha de compra</th><th>ID ficha</th>
          </tr></thead>
          <tbody>
            ${lista.map((r) => `<tr>
              <td>${esc(r.nombre)}</td>
              <td>${esc(r.marca) || "—"}</td>
              <td class="precio">${moneda(r.valorUnitario)}</td>
              <td>${esc(r.comercio) || "—"}</td>
              <td class="fecha">${r.fecha ? fechaCorta(r.fecha) : "—"}</td>
              <td class="fecha">${esc(r.ficha) || "—"}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  filtro.llenarMarcas(filas);
  pintar();

  // app.js lo llama cada vez que cambian las fichas en Firestore
  return {
    actualizar(fichas) {
      filas = construirHistorial(fichas);
      filtro.llenarMarcas(filas);
      pintar();
    }
  };
}
