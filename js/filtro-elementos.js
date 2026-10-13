// Buscador compartido por "Elemento singular" y "Tracking":
// un campo de texto (solo mira el nombre del elemento) + filtro de marca + botón × para borrar.
const SIN_MARCA = "__sin_marca__";

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// alCambiar se llama cada vez que cambia el texto o la marca elegida.
export function crearFiltro({ input, btnLimpiar, select, alCambiar }) {
  const cambiar = () => { btnLimpiar.hidden = !input.value; alCambiar(); };

  input.addEventListener("input", cambiar);
  select.addEventListener("change", cambiar);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; cambiar(); }
  });
  btnLimpiar.addEventListener("click", () => {
    input.value = "";
    cambiar();
    input.focus();
  });
  btnLimpiar.hidden = !input.value;

  return {
    // Hay texto escrito o una marca elegida
    hayFiltro: () => !!(input.value.trim() || select.value),

    // Llena el filtro con todas las marcas de las filas (cada fila tiene .marca)
    // y conserva la elegida si sigue existiendo
    llenarMarcas(filas) {
      const previa = select.value;
      const mapa = new Map();
      let haySinMarca = false;
      for (const r of filas) {
        if (!r.marca) { haySinMarca = true; continue; }
        const k = norm(r.marca).trim();
        if (!mapa.has(k)) mapa.set(k, r.marca);
      }
      const marcas = [...mapa.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
      select.innerHTML =
        `<option value="">Todas las marcas</option>` +
        marcas.map(([k, m]) => `<option value="${esc(k)}">${esc(m)}</option>`).join("") +
        (haySinMarca ? `<option value="${SIN_MARCA}">Sin marca</option>` : "");
      select.value = [...select.options].some((o) => o.value === previa) ? previa : "";
    },

    // Devuelve solo las filas (con .nombre y .marca) que cumplen el texto y la marca
    aplicar(filas) {
      const palabras = norm(input.value.trim()).split(/\s+/).filter(Boolean);
      const marca = select.value;
      return filas.filter((r) => {
        if (!palabras.every((p) => norm(r.nombre).includes(p))) return false;
        if (!marca) return true;
        return marca === SIN_MARCA ? !r.marca : norm(r.marca).trim() === marca;
      });
    }
  };
}
