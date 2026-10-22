// Inicio de sesión con usuario y contraseña (Firebase Authentication).
// - Si escribes un usuario sin "@" (ej. "mario"), se usa "mario@cotizacion.local" como correo interno.
//   Los usuarios se crean en la consola de Firebase (Authentication > Users) con ese correo.
// - "Recordarme": mantiene la sesión abierta y recuerda el usuario en este equipo.
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { borrarCache } from "./sync.js";

const DOMINIO = "@cotizacion.local";
const CLAVE_USUARIO = "usuario-recordado";

const aCorreo = (u) => { const t = u.trim().toLowerCase(); return t.includes("@") ? t : t + DOMINIO; };
const aUsuario = (correo) => (correo.endsWith(DOMINIO) ? correo.slice(0, -DOMINIO.length) : correo);

const MENSAJES = {
  "auth/invalid-credential": "Usuario o contraseña incorrectos.",
  "auth/invalid-login-credentials": "Usuario o contraseña incorrectos.",
  "auth/wrong-password": "Usuario o contraseña incorrectos.",
  "auth/user-not-found": "Usuario o contraseña incorrectos.",
  "auth/invalid-email": "El usuario no es válido.",
  "auth/user-disabled": "Este usuario está deshabilitado.",
  "auth/too-many-requests": "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.",
  "auth/network-request-failed": "Sin conexión. Revisa tu internet."
};

const leerRecordado = () => { try { return localStorage.getItem(CLAVE_USUARIO) || ""; } catch { return ""; } };
const guardarRecordado = (v) => {
  try { v ? localStorage.setItem(CLAVE_USUARIO, v) : localStorage.removeItem(CLAVE_USUARIO); } catch { /* sin almacenamiento */ }
};

// Rol del usuario: "editor" (puede crear, editar y eliminar) o "lector" (solo ver, buscar y copiar).
// Se define en Firestore: documento usuarios/{uid} con el campo rol = "editor". Sin ese documento es lector.
// La protección real está en las reglas de Firestore; esto solo adapta la pantalla.
let rol = "lector";
export const puedeEditar = () => rol === "editor";

async function leerRol(uid) {
  try {
    const snap = await getDoc(doc(db, "usuarios", uid));
    return snap.exists() && snap.data().rol === "editor" ? "editor" : "lector";
  } catch (err) {
    console.warn("No se pudo leer el rol, se entra como lector:", err);
    return "lector";
  }
}

// alEntrar(usuario) se llama una vez cuando hay sesión (al iniciar o al volver a abrir la app)
export function iniciarAuth({ alEntrar }) {
  const $ = (id) => document.getElementById(id);
  const form = $("formLogin"), inUsuario = $("loginUsuario"), inClave = $("loginClave");
  const chkRecordar = $("loginRecordar"), lblError = $("loginError"), btnEntrar = $("btnEntrar");
  const btnSalir = $("btnSalir"), lblUsuario = $("usuarioActual");

  const recordado = leerRecordado();
  inUsuario.value = recordado;
  chkRecordar.checked = true;

  let huboSesion = false;
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      if (huboSesion) return;
      huboSesion = true;
      rol = await leerRol(user.uid); // se conoce antes de mostrar y de cargar datos
      lblUsuario.textContent = aUsuario(user.email || "") + (puedeEditar() ? "" : " · solo lectura");
      document.body.dataset.rol = rol;
      document.body.dataset.sesion = "dentro";
      alEntrar(user);
    } else if (huboSesion) {
      location.reload(); // la sesión se cerró: vuelve a la pantalla de inicio limpia
    } else {
      document.body.dataset.sesion = "fuera";
      (recordado ? inClave : inUsuario).focus();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    lblError.textContent = "";
    btnEntrar.disabled = true;
    try {
      await setPersistence(auth, chkRecordar.checked ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(auth, aCorreo(inUsuario.value), inClave.value);
      guardarRecordado(chkRecordar.checked ? inUsuario.value.trim() : "");
      inClave.value = "";
    } catch (err) {
      console.error(err);
      lblError.textContent = MENSAJES[err.code] || "No se pudo iniciar sesión: " + err.message;
      inClave.value = "";
      inClave.focus();
    } finally {
      btnEntrar.disabled = false;
    }
  });

  btnSalir.addEventListener("click", async () => {
    await borrarCache();   // en equipos compartidos no quedan datos guardados
    await signOut(auth);   // al cerrar sesión se recarga la página (ver arriba)
  });
}
