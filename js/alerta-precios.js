// Control de precios: avisa cuando el precio de un elemento SUBE o BAJA más de UMBRAL_CAMBIO
// pesos por unidad frente a su último precio registrado.
//
// Regla:
//  - "Mismo elemento" = mismo nombre, misma marca Y mismo comercio
//    (sin importar mayúsculas, tildes ni espacios dobles). El mismo elemento en otro comercio no se compara.
//  - Se compara con el precio de la fecha de compra MÁS RECIENTE anterior a la de la compra que se revisa.
//  - Hay alarma si la diferencia (en valor absoluto) es MAYOR que el umbral: "aumento" si subió, "disminucion" si bajó.
//  - Las compras sin fecha no sirven de referencia (no se sabe cuál es la más reciente).
export const UMBRAL_CAMBIO = 5000; // <- cambia aquí el valor del umbral (en pesos)

const norm = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Identidad de un elemento único en un comercio (la usan también Tracking y el índice)
export const claveElemento = (nombre, marca, comercio) => norm(nombre) + "|" + norm(marca) + "|" + norm(comercio);

// Historial de precios por elemento y comercio:
// Map clave -> [{ valorUnitario, fecha, comercio, ficha, orden }]
export function construirIndice(fichas, { comprasDe, elementoNormal }) {
  const indice = new Map();
  for (const f of fichas) {
    const orden = f.actualizado?.seconds ?? 0; // desempata compras de una misma fecha
    for (const c of comprasDe(f)) {
      if (!c.fecha) continue;
      for (const raw of c.elementos || []) {
        const e = elementoNormal(raw);
        if (!e.nombre) continue;
        const k = claveElemento(e.nombre, e.marca, c.nombre);
        if (!indice.has(k)) indice.set(k, []);
        indice.get(k).push({ valorUnitario: e.valorUnitario, fecha: c.fecha, comercio: c.nombre || "", ficha: String(f.id), orden });
      }
    }
  }
  return indice;
}

// Devuelve null si no hay alarma, o { tipo, anterior, diferencia, porcentaje }:
//  tipo: "aumento" | "disminucion"; diferencia y porcentaje llevan signo (negativos si bajó).
//  excluirFicha: ficha cuyos datos guardados se ignoran (la que se está editando)
//  extras: registros sin guardar [{ nombre, marca, comercio, valorUnitario, fecha }] que también cuentan
export function buscarCambio(indice, { nombre, marca = "", comercio = "", valorUnitario, fecha, excluirFicha = null, extras = [] }) {
  if (!nombre || !fecha || !Number.isFinite(valorUnitario)) return null;
  const k = claveElemento(nombre, marca, comercio);
  const candidatos = (indice.get(k) || [])
    .filter((r) => r.ficha !== excluirFicha)
    .concat(extras
      .filter((r) => claveElemento(r.nombre, r.marca, r.comercio) === k)
      .map((r) => ({ ...r, ficha: "", orden: Number.MAX_SAFE_INTEGER })))
    .filter((r) => r.fecha < fecha); // las fechas ISO (AAAA-MM-DD) se comparan como texto
  if (!candidatos.length) return null;

  const anterior = candidatos.reduce((a, b) =>
    b.fecha > a.fecha || (b.fecha === a.fecha && b.orden > a.orden) ? b : a);
  const diferencia = valorUnitario - anterior.valorUnitario;
  if (Math.abs(diferencia) <= UMBRAL_CAMBIO) return null;
  const porcentaje = anterior.valorUnitario > 0 ? (diferencia / anterior.valorUnitario) * 100 : null;
  return { tipo: diferencia > 0 ? "aumento" : "disminucion", anterior, diferencia, porcentaje };
}

// "Subió $8.000 (+67%) frente a $12.000 del 01/03/2026." / "Bajó $8.000 (-40%) frente a ..."
export function descripcionCambio(a, { moneda, fechaCorta }) {
  const subio = a.tipo === "aumento";
  const pct = a.porcentaje == null ? "" : ` (${subio ? "+" : "-"}${Math.round(Math.abs(a.porcentaje))}%)`;
  return `${subio ? "Subió" : "Bajó"} ${moneda(Math.abs(a.diferencia))}${pct} frente a ${moneda(a.anterior.valorUnitario)} del ${fechaCorta(a.anterior.fecha)}.`;
}
