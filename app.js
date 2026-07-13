/* Inventario Alcy — lógica de la PWA (Fase 2).
   - Catálogo: catalogo.json (network-first con fallback a cache: el stock del
     dashboard se refresca cuando hay internet y sigue disponible offline).
   - Conteos pendientes: IndexedDB (sobreviven cierres de app y falta de internet).
   - Ajustes (URL del relay + token): localStorage.
   - Sync: POST al Web App de Google Apps Script. Se envía con
     Content-Type text/plain para evitar el preflight CORS que Apps Script
     no soporta (limitación real de GAS: no responde a OPTIONS).
   - Búsqueda por voz: Web Speech API (webkitSpeechRecognition). OJO: Chrome
     procesa el audio en la nube de Google => REQUIERE internet. Degrada con
     gracia (mensaje) si no hay soporte, permiso o conexión.
   - Dashboard: HTML/CSS puro (sin librerías), 100% offline con los datos del
     último catalogo.json cacheado. */

"use strict";

// ---------- Estado ----------
let catalogo = [];
let catalogoGenerado = null;   // fecha de generación del catalogo.json
let ubicacion = localStorage.getItem("ubicacion") || null;
let productoElegido = null;
let editandoId = null;         // si se está editando un pendiente existente
let filtroCategoria = "";      // "" = todas

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
// Normalización FONÉTICA del español: junta letras que suenan igual (o casi
// igual) para que la búsqueda por voz no falle cuando Google transcribe
// "bazo" en vez de "vaso" (b/v se pronuncian igual), "sapato" en vez de
// "zapato" (seseo: z/s/c suave suenan igual), o "yamada" en vez de "llamada"
// (yeísmo: ll/y suenan igual). Es solo sustitución de letras, sin IA ni red.
function normalizarFonetico(s) {
  return s
    .replace(/[bv]/g, "b")
    .replace(/c(?=[ei])/g, "s")
    .replace(/z/g, "s")
    .replace(/ll/g, "y");
}
// Distancia de edición (Levenshtein) con corte temprano en "max" para que
// sea rápida: si ya nos pasamos de "max" diferencias, deja de calcular.
// Sirve de red de seguridad para deslices de la transcripción de voz que la
// normalización fonética no cubre (una letra de más/menos, confusión d/t, etc.).
function distanciaEdicion(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let filaMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + costo);
      cur.push(v);
      if (v < filaMin) filaMin = v;
    }
    if (filaMin > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}
function toleranciaPorLargo(len) {
  if (len <= 3) return 0;   // palabras muy cortas: sin tolerancia (evita falsos positivos)
  if (len <= 6) return 1;
  return 2;
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

// ---------- Navegación entre vistas ----------
const VISTAS = ["vista-menu", "vista-conteo", "vista-dashboard", "vista-ajustes"];
let vistaActual = "vista-menu";
let vistaPrevia = "vista-menu"; // para volver desde Ajustes

function mostrarVista(id) {
  if (id !== "vista-ajustes") vistaPrevia = id;
  vistaActual = id;
  for (const v of VISTAS) $(v).classList.toggle("oculto", v !== id);
  window.scrollTo({ top: 0 });
  if (id === "vista-dashboard") pintarDashboard();
}
$("menu-contar").addEventListener("click", () => mostrarVista("vista-conteo"));
$("menu-dashboard").addEventListener("click", () => mostrarVista("vista-dashboard"));
document.querySelectorAll("[data-volver]").forEach((b) =>
  b.addEventListener("click", () => mostrarVista("vista-menu")));

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

// ---------- Buscador (texto + categoría) y lista de productos ----------
// Búsqueda por PALABRAS sin importar el orden: cada palabra escrita/dicha
// debe aparecer en código+nombre+tipo+fabricante+categoría.
// Tokens que empiezan con dígito exigen borde numérico: "5oz" NO matchea
// "5.5oz" ni "6.5oz", y "5" no matchea "50" ni "5.5".
function escaparRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function tokenARegex(t) {
  const pre = /^\d/.test(t) ? "(^|[^0-9.])" : "";
  const post = /^\d+$/.test(t) ? "(?=[^0-9.]|$)" : "";
  return new RegExp(pre + escaparRe(t) + post);
}
function coincide(p, tokens) {
  const pajar = normalizar(
    [p.codigo, p.producto, p.tipo, p.fabricante, p.categoria, p.unidad].join(" ")
  );
  // versión fonética del pajar, para tolerar b/v, s/z/c, ll/y (típico de
  // transcripciones de voz en español, ej. "bazo" cuando dijiste "vaso")
  const pajarFon = normalizarFonetico(pajar);
  const palabrasFon = pajarFon.split(/\s+/).filter(Boolean);
  return tokens.every((t) => {
    if (/^\d/.test(t)) {
      // tokens numéricos: SIN cambios, exactos (5oz no debe matchear 5.5oz)
      return tokenARegex(t).test(pajar);
    }
    const tFon = normalizarFonetico(t);
    if (pajarFon.includes(tFon)) return true;           // match fonético directo
    const tol = toleranciaPorLargo(tFon.length);
    if (tol === 0) return false;
    // red de seguridad: 1-2 letras de diferencia contra alguna palabra del producto
    return palabrasFon.some((w) => distanciaEdicion(tFon, w, tol) <= tol);
  });
}
function pintarLista() {
  const q = normalizar($("buscador").value.trim());
  const tokens = q ? q.split(/\s+/) : [];
  const ul = $("lista-productos");
  ul.innerHTML = "";
  let items = catalogo;
  if (filtroCategoria) items = items.filter((p) => p.categoria === filtroCategoria);
  if (tokens.length) items = items.filter((p) => coincide(p, tokens));
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
      [p.categoria || p.tipo, p.unidad, p.fabricante].filter(Boolean).join(" · ");
    li.querySelector(".lp-codigo").textContent = p.codigo;
    li.addEventListener("click", () => elegirProducto(p));
    ul.appendChild(li);
  }
}
$("buscador").addEventListener("input", pintarLista);

// Chips de categoría
document.querySelectorAll("#chips-categoria .chip").forEach((ch) => {
  ch.addEventListener("click", () => {
    filtroCategoria = ch.dataset.cat;
    document.querySelectorAll("#chips-categoria .chip").forEach((c) =>
      c.classList.toggle("activa", c === ch));
    pintarLista();
  });
});

// ---------- Búsqueda por voz (Web Speech API — requiere internet) ----------
// Chrome manda el audio a los servidores de Google: NO funciona offline.
// La búsqueda por texto sí sigue funcionando offline como siempre.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let reconocedor = null;
let escuchando = false;

// lo que la gente DICE -> lo que está ESCRITO en el catálogo
const VOZ_REEMPLAZOS = [
  [/\bonzas?\b/g, "oz"],
  [/\bn[uú]meros?\b/g, "#"],
  [/\bcero\b/g, "0"], [/\buna?o?\b/g, "1"], [/\bdos\b/g, "2"],
  [/\btres\b/g, "3"], [/\bcuatro\b/g, "4"], [/\bcinco\b/g, "5"],
  [/\bseis\b/g, "6"], [/\bsiete\b/g, "7"], [/\bocho\b/g, "8"],
  [/\bnueve\b/g, "9"], [/\bdiez\b/g, "10"], [/\bonce\b/g, "11"],
  [/\bdoce\b/g, "12"], [/\bveinte\b/g, "20"], [/\btreinta\b/g, "30"],
];
const VOZ_STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "un",
  "una", "unos", "unas", "y", "para", "por", "que", "quiero", "busca",
  "buscar", "punto", "el", "en"]);

function transcripcionABusqueda(txt) {
  let s = normalizar(txt);
  for (const [re, rep] of VOZ_REEMPLAZOS) s = s.replace(re, rep);
  return s.split(/\s+/).filter((t) => t && !VOZ_STOPWORDS.has(t)).join(" ");
}

function msgVoz(txt, esError) {
  const m = $("msg-voz");
  m.textContent = txt;
  m.className = "msg " + (esError ? "error" : "ok");
  clearTimeout(msgVoz._t);
  if (txt) msgVoz._t = setTimeout(() => { m.textContent = ""; }, 5000);
}

function pararVoz() {
  escuchando = false;
  $("btn-voz").classList.remove("escuchando");
  if (reconocedor) { try { reconocedor.abort(); } catch (e) {} }
}

$("btn-voz").addEventListener("click", () => {
  if (escuchando) { pararVoz(); msgVoz("", false); return; }
  if (!SpeechRec) {
    msgVoz("Tu navegador no soporta búsqueda por voz. Usa el buscador de texto.", true);
    return;
  }
  if (!navigator.onLine) {
    msgVoz("📴 Necesitas internet para buscar por voz. El buscador de texto sí funciona sin conexión.", true);
    return;
  }
  try {
    reconocedor = new SpeechRec();
    reconocedor.lang = "es-PE";
    reconocedor.interimResults = false;
    reconocedor.maxAlternatives = 1;
    reconocedor.onresult = (ev) => {
      const dicho = ev.results[0][0].transcript || "";
      const q = transcripcionABusqueda(dicho);
      $("buscador").value = q;
      pintarLista();
      msgVoz(`🎙️ Escuché: "${dicho}"`, false);
      pararVoz();
    };
    reconocedor.onerror = (ev) => {
      pararVoz();
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        msgVoz("🎙️ Sin permiso de micrófono. Actívalo en los permisos del navegador.", true);
      } else if (ev.error === "network") {
        msgVoz("📴 Necesitas internet para buscar por voz. El buscador de texto sí funciona sin conexión.", true);
      } else if (ev.error === "no-speech") {
        msgVoz("No se escuchó nada. Toca 🎙️ y habla cerca del micrófono.", true);
      } else if (ev.error !== "aborted") {
        msgVoz("No se pudo usar el micrófono (" + ev.error + "). Usa el buscador de texto.", true);
      }
    };
    reconocedor.onend = () => pararVoz();
    reconocedor.start();
    escuchando = true;
    $("btn-voz").classList.add("escuchando");
    msgVoz("🎙️ Escuchando... di el producto (ej. “vaso 5 onzas maranatha”)", false);
  } catch (e) {
    pararVoz();
    msgVoz("No se pudo iniciar la búsqueda por voz. Usa el buscador de texto.", true);
  }
});

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

// ---------- Dashboard (HTML/CSS puro, funciona offline) ----------
// Semáforo: 🔴 stock total = 0 · 🟡 stock <= punto de reorden · 🟢 saludable.
const CATEGORIAS = [
  { nombre: "Descartables", icono: "🥤" },
  { nombre: "Bolsas", icono: "🛍️" },
  { nombre: "Rollos", icono: "🧻" },
];
function numero(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }
function estadoProducto(p) {
  const stock = numero(p.stock_total);
  const rop = numero(p.punto_reorden);
  if (stock <= 0) return "rojo";
  if (rop > 0 && stock <= rop) return "amarillo";
  return "verde";
}
function filaProductoDash(p) {
  const stock = numero(p.stock_total);
  const ss = numero(p.stock_seguridad);
  const rop = numero(p.punto_reorden);
  const estado = estadoProducto(p);
  const maxRef = Math.max(stock, rop, ss, 1);
  const pct = (v) => Math.min(100, Math.round(v / maxRef * 100));

  const div = document.createElement("div");
  div.className = "dash-prod";
  div.innerHTML =
    `<div class="dp-cab">
       <span class="dp-semaforo"></span>
       <span class="dp-nombre"></span>
       <span class="dp-stock"></span>
     </div>
     <div class="dp-barra">
       <div class="dp-fill"></div>
       <div class="dp-marca dp-marca-ss" title="Stock de seguridad"></div>
       <div class="dp-marca dp-marca-rop" title="Punto de reorden"></div>
     </div>
     <div class="dp-detalle"></div>`;
  div.querySelector(".dp-semaforo").textContent =
    estado === "rojo" ? "🔴" : estado === "amarillo" ? "🟡" : "🟢";
  div.querySelector(".dp-nombre").textContent = p.producto;
  div.querySelector(".dp-stock").textContent =
    stock + (p.unidad ? " " + p.unidad : "");
  const fill = div.querySelector(".dp-fill");
  fill.style.width = pct(stock) + "%";
  fill.classList.add("f-" + estado);
  div.querySelector(".dp-marca-ss").style.left = pct(ss) + "%";
  div.querySelector(".dp-marca-rop").style.left = pct(rop) + "%";
  div.querySelector(".dp-detalle").textContent =
    `Puesto ${numero(p.stock_puesto)} · Almacén ${numero(p.stock_almacen)}` +
    ` · Reorden en ${rop} · Seguridad ${ss}` +
    (estado === "rojo" ? " · ¡SIN STOCK!" :
     estado === "amarillo" ? " · Pedir ya" : "");
  return div;
}
function pintarDashboard() {
  const cont = $("dashboard-contenido");
  cont.innerHTML = "";
  if (!catalogo.length) {
    cont.innerHTML = '<section class="card"><p class="nota">No hay catálogo cargado ' +
      "todavía. Abre la app con internet una vez para descargarlo.</p></section>";
    $("dashboard-pie").textContent = "";
    return;
  }
  const orden = { rojo: 0, amarillo: 1, verde: 2 };
  for (const cat of CATEGORIAS) {
    const prods = catalogo.filter((p) => p.categoria === cat.nombre)
      .sort((a, b) =>
        (orden[estadoProducto(a)] - orden[estadoProducto(b)]) ||
        a.producto.localeCompare(b.producto, "es"));
    if (!prods.length) continue;
    const n = { rojo: 0, amarillo: 0, verde: 0 };
    for (const p of prods) n[estadoProducto(p)]++;

    const det = document.createElement("details");
    det.className = "card dash-cat";
    det.open = n.rojo > 0 || n.amarillo > 0; // abrir donde hay alertas
    const sum = document.createElement("summary");
    sum.innerHTML =
      `<span class="dc-titulo"></span>
       <span class="dc-resumen">
         <span class="mini mini-rojo"></span>
         <span class="mini mini-amarillo"></span>
         <span class="mini mini-verde"></span>
       </span>`;
    sum.querySelector(".dc-titulo").textContent =
      `${cat.icono} ${cat.nombre} (${prods.length})`;
    sum.querySelector(".mini-rojo").textContent = "🔴 " + n.rojo;
    sum.querySelector(".mini-amarillo").textContent = "🟡 " + n.amarillo;
    sum.querySelector(".mini-verde").textContent = "🟢 " + n.verde;
    det.appendChild(sum);
    for (const p of prods) det.appendChild(filaProductoDash(p));
    cont.appendChild(det);
  }
  $("dashboard-pie").textContent = catalogoGenerado
    ? "Stock según el Excel al " + horaLocal(catalogoGenerado) +
      ". Se actualiza al sincronizar en la laptop y republicar la app."
    : "";
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
  mostrarVista("vista-ajustes");
});
$("btn-ajustes-volver").addEventListener("click", () => {
  mostrarVista(vistaPrevia || "vista-menu");
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
    const data = await r.json();
    // formato nuevo {generado, productos} o viejo [..] (compatibilidad)
    if (Array.isArray(data)) {
      catalogo = data;
    } else {
      catalogo = data.productos || [];
      catalogoGenerado = data.generado || null;
    }
  } catch (e) {
    toast("No se pudo cargar el catálogo de productos", 4000);
    catalogo = [];
  }
  pintarLista();
  // deep-links: index.html#dashboard o #contar abren esa vista directo
  if (location.hash === "#dashboard") mostrarVista("vista-dashboard");
  else if (location.hash === "#contar") mostrarVista("vista-conteo");
  else if (vistaActual === "vista-dashboard") pintarDashboard();
  await pintarPendientes();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}
iniciar();
