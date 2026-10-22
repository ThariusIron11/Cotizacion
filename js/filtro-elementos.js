// Buscador compartido por "Elemento singular" y "Tracking":
// un campo de texto (solo mira el nombre del elemento) + filtros de Marca y Comercio
// (se escribe para autocompletar y cada elección queda como una pastilla con ×) + botón × para borrar el texto.
const SIN_MARCA = "__sin_marca__";
const SIN_COMERCIO = "__sin_comercio__";

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const clave = (v, sin) => (v ? norm(v).trim() : sin);

// Filtro de pastillas con autocompletado. Varias pastillas = coincide con cualquiera de ellas.
// Las pastillas elegidas no se dibujan aquí sino en "destino" (la fila que queda entre los filtros y la tabla).
function crearChips({ contenedor, destino, tipo, etiqueta, placeholder, alCambiar }) {
  const idInput = contenedor.id + "-in";
  contenedor.innerHTML = `
    <label class="chips-etiqueta" for="${idInput}">${esc(etiqueta)}</label>
    <div class="chips-caja">
      <input type="text" id="${idInput}" class="chips-input" placeholder="${esc(placeholder)}"
             autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false">
    </div>
    <ul class="sugerencias" role="listbox" hidden></ul>`;
  const caja = contenedor.querySelector(".chips-caja");
  const input = contenedor.querySelector(".chips-input");
  const lista = contenedor.querySelector(".sugerencias");

  let opciones = [];   // [{ valor, texto }]
  let elegidos = [];   // valores elegidos, en el orden en que se agregaron
  let visibles = [];   // sugerencias que se están mostrando
  let activa = -1;

  const textoDe = (v) => (opciones.find((o) => o.valor === v) || { texto: v }).texto;

  function pintarPastillas() {
    destino.innerHTML = elegidos.map((v) => `
      <span class="pastilla pastilla-${tipo}"><span class="pastilla-tipo">${esc(etiqueta)}:</span> ${esc(textoDe(v))}<button type="button" class="quitar" data-quitar="${esc(v)}" aria-label="Quitar ${esc(etiqueta)} ${esc(textoDe(v))}">×</button></span>`).join("");
  }

  function pintarLista() {
    lista.innerHTML = visibles.length
      ? visibles.map((o, i) => `<li role="option" data-i="${i}" class="${i === activa ? "activa" : ""}">${esc(o.texto)}</li>`).join("")
      : '<li class="sin-resultados">Sin coincidencias</li>';
  }

  function sugerir() {
    const texto = input.value.trim();
    const palabras = norm(texto).split(/\s+/).filter(Boolean);
    visibles = opciones
      .filter((o) => !elegidos.includes(o.valor) && palabras.every((p) => norm(o.texto).includes(p)))
      .slice(0, 30);
    activa = texto && visibles.length ? 0 : -1;
    lista.hidden = !visibles.length && !texto; // sin texto y sin opciones, no hay nada que mostrar
    pintarLista();
    input.setAttribute("aria-expanded", String(!lista.hidden));
  }

  const cerrar = () => { lista.hidden = true; input.setAttribute("aria-expanded", "false"); };

  function agregar(valor) {
    if (!elegidos.includes(valor)) elegidos.push(valor);
    input.value = "";
    pintarPastillas();
    sugerir();
    alCambiar();
  }

  function quitar(valor) {
    elegidos = elegidos.filter((v) => v !== valor);
    pintarPastillas();
    if (document.activeElement === input) sugerir();
    alCambiar();
  }

  input.addEventListener("input", sugerir);
  input.addEventListener("focus", sugerir);
  input.addEventListener("blur", () => { cerrar(); input.value = ""; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (lista.hidden) sugerir();
      if (!visibles.length) return;
      e.preventDefault();
      const paso = e.key === "ArrowDown" ? 1 : -1;
      activa = (activa + paso + visibles.length) % visibles.length;
      pintarLista();
      lista.querySelector(".activa")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activa >= 0 && visibles[activa]) agregar(visibles[activa].valor);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = "";
      cerrar();
    } else if (e.key === "Backspace" && !input.value && elegidos.length) {
      quitar(elegidos[elegidos.length - 1]);
    }
  });

  // mousedown (no click) para que el campo no pierda el foco antes de elegir
  lista.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("li[data-i]");
    if (li) agregar(visibles[Number(li.dataset.i)].valor);
  });

  caja.addEventListener("click", () => input.focus());
  destino.addEventListener("click", (e) => {
    const x = e.target.closest("[data-quitar]");
    if (x) quitar(x.dataset.quitar);
  });

  return {
    hay: () => elegidos.length > 0,
    // Quita todas las pastillas (no avisa: quien llama decide cuándo repintar)
    limpiar() {
      elegidos = [];
      input.value = "";
      pintarPastillas();
      cerrar();
    },
    valores: () => new Set(elegidos),
    // Actualiza las opciones disponibles y conserva lo elegido si sigue existiendo
    llenar(nuevas) {
      opciones = nuevas;
      elegidos = elegidos.filter((v) => nuevas.some((o) => o.valor === v));
      pintarPastillas();
      if (document.activeElement === input) sugerir();
    }
  };
}

// Opciones distintas de un campo de las filas (ordenadas), más "Sin ..." si alguna fila no lo tiene
function opcionesDe(filas, campo, valorSin, textoSin) {
  const mapa = new Map();
  let haySin = false;
  for (const r of filas) {
    if (!r[campo]) { haySin = true; continue; }
    const k = norm(r[campo]).trim();
    if (!mapa.has(k)) mapa.set(k, r[campo]);
  }
  const lista = [...mapa.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "es"))
    .map(([valor, texto]) => ({ valor, texto }));
  if (haySin) lista.push({ valor: valorSin, texto: textoSin });
  return lista;
}

// marcas / comercios: <div> vacíos donde se dibujan los filtros de pastillas.
// alCambiar se llama cada vez que cambia el texto, una marca o un comercio.
// btnQuitarTodo: botón que limpia texto, marcas y comercios a la vez (solo se ve si hay algún filtro)
export function crearFiltro({ input, btnLimpiar, btnQuitarTodo, marcas, comercios, alCambiar }) {
  // Fila de pastillas: justo debajo de la fila de filtros y encima de la tabla
  const fila = document.createElement("div");
  fila.className = "pastillas-fila";
  fila.hidden = true;
  const grupoMarca = document.createElement("span");
  const grupoComercio = document.createElement("span");
  grupoMarca.className = grupoComercio.className = "pastillas-grupo";
  fila.append(grupoMarca, grupoComercio);
  marcas.parentElement.after(fila);

  const hayFiltro = () => !!(input.value.trim() || chipsMarca.hay() || chipsComercio.hay());
  const refrescarControles = () => {
    btnLimpiar.hidden = !input.value;
    btnQuitarTodo.hidden = !hayFiltro();
    fila.hidden = !(chipsMarca.hay() || chipsComercio.hay());
  };
  const cambiar = () => { refrescarControles(); alCambiar(); };
  const chipsMarca = crearChips({ contenedor: marcas, destino: grupoMarca, tipo: "marca", etiqueta: "Marca", placeholder: "Escribe una marca…", alCambiar: cambiar });
  const chipsComercio = crearChips({ contenedor: comercios, destino: grupoComercio, tipo: "comercio", etiqueta: "Comercio", placeholder: "Escribe un comercio…", alCambiar: cambiar });

  input.addEventListener("input", cambiar);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; cambiar(); }
  });
  btnLimpiar.addEventListener("click", () => {
    input.value = "";
    cambiar();
    input.focus();
  });
  btnQuitarTodo.addEventListener("click", () => {
    input.value = "";
    chipsMarca.limpiar();
    chipsComercio.limpiar();
    cambiar();
  });
  refrescarControles();

  return {
    // Hay texto escrito o alguna marca/comercio elegido
    hayFiltro,

    // Llena las opciones de Marca y Comercio con las de las filas (cada fila tiene .marca y .comercio)
    llenarOpciones(filas) {
      chipsMarca.llenar(opcionesDe(filas, "marca", SIN_MARCA, "Sin marca"));
      chipsComercio.llenar(opcionesDe(filas, "comercio", SIN_COMERCIO, "Sin comercio"));
      refrescarControles(); // por si una opción elegida ya no existe
    },

    // Devuelve solo las filas (con .nombre, .marca y .comercio) que cumplen texto, marca y comercio
    aplicar(filas) {
      const palabras = norm(input.value.trim()).split(/\s+/).filter(Boolean);
      const marcasSel = chipsMarca.valores();
      const comerciosSel = chipsComercio.valores();
      return filas.filter((r) => {
        if (!palabras.every((p) => norm(r.nombre).includes(p))) return false;
        if (marcasSel.size && !marcasSel.has(clave(r.marca, SIN_MARCA))) return false;
        if (comerciosSel.size && !comerciosSel.has(clave(r.comercio, SIN_COMERCIO))) return false;
        return true;
      });
    }
  };
}
