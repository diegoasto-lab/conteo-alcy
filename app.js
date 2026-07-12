/* Conteo Alcy — lógica de la PWA.
   - Catálogo: catalogo.json (cacheado offline por el service worker).
   - Conteos pendientes: IndexedDB (sobreviven cierres de app y falta de internet).
   - Ajustes (URL del relay + token): localStorage.
   - Sync: POST al Web App de Google Apps Script. Se envía con
     Content-Type text/plain para evitar el preflight CORS que Apps Script
     no soporta (limitación real de GAS: no responde a OPTIONS). */

"use strict";

// ---------- Estado ----------
let catalogo = [];
let ubicacion = localStorage.getItem("ubicacion") || null;
let productoElegido = null;
let editandoId = null; // si se está editando un pendiente existente

const $ = (id) => document.getElementById(id);

// ---------- IndexedDB ----------
const DB_NAME = "conteo-alcy";
const STORE = "pendientes";
let db = null;

function abrirDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => { db = req.result; res(db); };
    req.onerror = () => rej(req.error);
  });
}
function dbPut(obj) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(obj);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
function dbDelete(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
function dbTodos() {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

// ---------- Utilidades ----------
function toast(txt, ms = 2600) {
  const t = $("toast");
  t.textContent = txt;
  t.classList.remove("oculto");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("oculto"), ms);
}
function normalizar(s) {
  return (s || "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function nombreUbicacion(u) {
  return u === "PUESTO" ? "Puesto de venta" : "Almacén";
}
function horaLocal(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("es-PE") + " " +
         d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}
function nuevoId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ---------- Ubicación ----------
function pintarUbicacion() {
  document.querySelectorAll(".btn-ubicacion").forEach((b) => {
    b.classList.toggle("activa", b.dataset.ubicacion === ubicacion);
  });
}
document.querySelectorAll(".btn-ubicacion").forEach((b) => {
  b.addEventListener("click", () => {
    ubicacion = b.dataset.ubicacion;
    localStorage.setItem("ubicacion", ubicacion);
    pintarUbicacion();
  });
});

// ---------- Buscador y lista de productos ----------
function pintarLista() {
  const q = normalizar($("buscador").value.trim());
  const ul = $("lista-productos");
  ul.innerHTML = "";
  let items = catalogo;
  if (q) {
    items = catalogo.filter((p) =>
      normalizar(p.codigo).includes(q) ||
      normalizar(p.producto).includes(q) ||
      normalizar(p.tipo).includes(q)
    );
  }
  if (!items.length) {
    ul.innerHTML = '<li class="lista-vacia">Sin resultados. Prueba con otra palabra.</li>';
    return;
  }
  for (const p of items.slice(0, 60)) {
    const li = document.createElement("li");
    li.innerHTML =
      `<div><div class="lp-nombre"></div><div class="lp-detalle"></div></div>` +
      `<span class="lp-codigo"></span>`;
    li.querySelector(".lp-nombre").textContent = p.producto;
    li.querySelector(".lp-detalle").textContent =
      [p.tipo, p.unidad, p.fabricante].filter(Boolean).join(" · ");
    li.querySelector(".lp-codigo").textContent = p.codigo;
    li.addEventListener("click", () => elegirProducto(p));
    ul.appendChild(li);
  }
}
$("buscador").addEventListener("input", pintarLista);

// ---------- Panel de conteo ----------
function elegirProducto(p, cantidadPrevia = "", idEdicion = null) {
  if (!ubicacion) {
    toast("Primero elige la ubicación (Puesto o Almacén)");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  productoElegido = p;
  editandoId = idEdicion;
  $("producto-elegido").innerHTML =
    `<b></b><span></span>`;
  $("producto-elegido").querySelector("b").textContent = p.producto;
  $("producto-elegido").querySelector("span").textContent =
    `Código ${p.codigo}` + (p.unidad ? ` · Unidad: ${p.unidad}` : "") +
    ` · Ubicación: ${nombreUbicacion(ubicacion)}`;
  $("cantidad").value = cantidadPrevia;
  $("panel-conteo").classList.remove("oculto");
  $("panel-conteo").scrollIntoView({ behavior: "smooth" });
  $("cantidad").focus();
}
$("btn-cancelar").addEventListener("click", () => {
  productoElegido = null; editandoId = null;
  $("panel-conteo").classList.add("oculto");
});
$("btn-guardar").addEventListener("click", async () => {
  const v = $("cantidad").value.trim();
  const n = Number(v);
  if (v === "" || !isFinite(n) || n < 0) {
    toast("Ingresa una cantidad válida (0 o más)");
    return;
  }
  const conteo = {
    id: editandoId || nuevoId(),
    codigo: productoElegido.codigo,
    producto: productoElegido.producto,
    ubicacion,
    cantidad: n,
    timestamp: new Date().toISOString()
  };
  await dbPut(conteo);
  $("panel-conteo").classList.add("oculto");
  $("buscador").value = "";
  pintarLista();
  productoElegido = null; editandoId = null;
  toast("✅ Conteo guardado (pendiente de sincronizar)");
  await pintarPendientes();
});

// ---------- Pendientes ----------
async function pintarPendientes() {
  const todos = (await dbTodos()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const ul = $("lista-pendientes");
  ul.innerHTML = "";
  $("badge-pendientes").textContent = todos.length;
  $("badge-pendientes").classList.toggle("cero", todos.length === 0);
  if (!todos.length) {
    ul.innerHTML = '<li class="lista-vacia">No hay conteos pendientes. 🎉</li>';
    return;
  }
  for (const c of todos) {
    const li = document.createElement("li");
    li.innerHTML =
      `<div class="lp-info"><b></b> — <span></span><small></small></div>` +
      `<div class="lp-acciones">` +
      `<button class="ed" aria-label="Editar">✏️</button>` +
      `<button class="bo" aria-label="Borrar">🗑️</button></div>`;
    li.querySelector("b").textContent = c.producto;
    li.querySelector("span").textContent = `${c.cantidad}`;
    li.querySelector("small").textContent =
      `${nombreUbicacion(c.ubicacion)} · ${horaLocal(c.timestamp)} · cód. ${c.codigo}`;
    li.querySelector(".ed").addEventListener("click", () => {
      ubicacion = c.ubicacion;
      localStorage.setItem("ubicacion", ubicacion);
      pintarUbicacion();
      elegirProducto(
        { codigo: c.codigo, producto: c.producto, unidad: "" },
        c.cantidad, c.id
      );
    });
    li.querySelector(".bo").addEventListener("click", async () => {
      if (confirm(`¿Borrar el conteo de "${c.producto}" (${c.cantidad})?`)) {
        await dbDelete(c.id);
        await pintarPendientes();
      }
    });
    ul.appendChild(li);
  }
}

// ---------- Sincronización ----------
async function sincronizar() {
  const msg = $("msg-sync");
  msg.className = "msg";
  const url = localStorage.getItem("relayUrl") || "";
  const token = localStorage.getItem("token") || "";
  if (!url || !token) {
    msg.textContent = "⚠️ Configura la URL del relay y el token en Ajustes (⚙️).";
    msg.classList.add("error");
    return;
  }
  const pendientes = await dbTodos();
  if (!pendientes.length) {
    msg.textContent = "No hay conteos pendientes por enviar.";
    msg.classList.add("ok");
    return;
  }
  if (!navigator.onLine) {
    msg.textContent = "📴 Sin conexión. Los conteos siguen guardados en el celular; " +
      "vuelve a intentar cuando tengas internet.";
    msg.classList.add("error");
    return;
  }
  $("btn-sync").disabled = true;
  msg.textContent = `Enviando ${pendientes.length} conteo(s)...`;
  try {
    // text/plain evita el preflight CORS (Apps Script no responde OPTIONS)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token, conteos: pendientes })
    });
    const data = await resp.json().catch(() => null);
    if (resp.ok && data && data.ok) {
      for (const c of pendientes) await dbDelete(c.id);
      await pintarPendientes();
      msg.textContent = `✅ ${pendientes.length} conteo(s) enviados. ` +
        "Corre la sincronización en la laptop para pasarlos al Excel.";
      msg.classList.add("ok");
    } else {
      const detalle = data && data.error ? data.error : `HTTP ${resp.status}`;
      msg.textContent = `❌ El relay respondió con error (${detalle}). ` +
        "Revisa la URL y el token en Ajustes. Los conteos siguen guardados aquí.";
      msg.classList.add("error");
    }
  } catch (err) {
    msg.textContent = "📴 No se pudo conectar (¿sin internet?). " +
      "Los conteos se guardaron localmente y no se pierde nada.";
    msg.classList.add("error");
  } finally {
    $("btn-sync").disabled = false;
  }
}
$("btn-sync").addEventListener("click", sincronizar);

// ---------- Ajustes ----------
$("btn-ajustes").addEventListener("click", () => {
  $("cfg-url").value = localStorage.getItem("relayUrl") || "";
  $("cfg-token").value = localStorage.getItem("token") || "";
  $("msg-ajustes").textContent = "";
  $("vista-principal").classList.add("oculto");
  $("vista-ajustes").classList.remove("oculto");
});
$("btn-ajustes-volver").addEventListener("click", () => {
  $("vista-ajustes").classList.add("oculto");
  $("vista-principal").classList.remove("oculto");
});
$("btn-ajustes-guardar").addEventListener("click", () => {
  const url = $("cfg-url").value.trim();
  const token = $("cfg-token").value.trim();
  const m = $("msg-ajustes");
  if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    m.textContent = "⚠️ La URL no parece de Google Apps Script (debe empezar con https://script.google.com/...).";
    m.className = "msg error";
    return;
  }
  localStorage.setItem("relayUrl", url);
  localStorage.setItem("token", token);
  m.textContent = "✅ Ajustes guardados.";
  m.className = "msg ok";
});

// ---------- Estado de red ----------
function pintarRed() {
  const p = $("estado-red");
  if (navigator.onLine) {
    p.className = "pill pill-verde";
    p.title = "Con conexión";
  } else {
    p.className = "pill pill-red";
    p.title = "Sin conexión (los conteos se guardan igual)";
  }
}
window.addEventListener("online", pintarRed);
window.addEventListener("offline", pintarRed);

// ---------- Arranque ----------
async function iniciar() {
  pintarRed();
  pintarUbicacion();
  await abrirDB();
  try {
    const r = await fetch("catalogo.json");
    catalogo = await r.json();
  } catch (e) {
    toast("No se pudo cargar el catálogo de productos", 4000);
    catalogo = [];
  }
  pintarLista();
  await pintarPendientes();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}
iniciar();
