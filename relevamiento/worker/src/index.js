/* ============================================================
 * Voz MBC · Relevamiento de procesos — API (Cloudflare Worker)
 *
 * Por qué existe: el modo "relevamiento" de Voz trata información de clientes
 * (procesos, sistemas, tipos de datos personales). Por eso NO usa el backend de
 * las encuestas de Voz (Apps Script + Gemini): todo queda en esta cuenta de
 * Cloudflare, separado por campaña y borrable al cierre del proyecto.
 *
 *   - Transcripción: Workers AI (Whisper). El audio se procesa en memoria y se
 *     descarta; solo se guarda el texto que el encuestado revisa.
 *   - Estructuración: Claude (SDK de Anthropic) convierte las respuestas en una
 *     fila del inventario, marcando cada campo como dicho / inferido / vacío.
 *   - Base: D1 (ver schema.sql y migracion-002.sql).
 *
 * Dos formas de entrar a la encuesta:
 *   - Enlace personal (?k=TOKEN): personas cargadas desde el Excel, con su sección.
 *   - Enlace abierto (?c=CODIGO): cualquiera busca su proceso en el inventario,
 *     lo elige, se identifica y recibe su propio enlace personal.
 *
 * Rutas del enlace abierto (sin token, con el código público de la campaña):
 *   GET  /r/abierta?c=           nombre de la campaña y áreas para el registro
 *   GET  /r/buscar?c=&q=&g=      buscador de procesos y de personas del inventario anterior (también acepta ?k= en lugar de ?c=)
 *   POST /r/registro             {c, nombre, correo, gerencia, seccion, cargo, procesos[]} -> {k}
 * Rutas del encuestado (autenticadas con su token personal, ?k= o campo k):
 *   GET  /r/sesion?k=            datos para pintar la encuesta
 *   POST /r/elegir               {k, proceso_id | proceso_ids[]}   (uno o varios, de cualquier gerencia)
 *   POST /r/soltar               {k, proceso_id}   (quita el proceso de su lista y sus respuestas)
 *   POST /r/revision             {k, proceso_id, estado, comentario}
 *   POST /r/proceso              {k, macroproceso, proceso, subproceso, descripcion}
 *   POST /r/respuesta            {k, proceso_id, pregunta, texto, sistemas[]}
 *   POST /r/verificar            {k, proceso_id, pregunta}   (la IA marca el checklist del bloque)
 *   POST /r/punto                {k, proceso_id, pregunta, punto, estado}   (la persona marca "lo mencioné" / "no aplica")
 *   POST /r/transcribir?k=       cuerpo: audio WAV (bytes) -> {texto}
 *   POST /r/imagen?k=&proceso_id=&pregunta=   cuerpo: imagen JPEG/PNG/WEBP (bytes) -> {texto}   (la IA la lee; no se guarda)
 *   POST /r/enviar               {k}
 * Rutas de la consola (cabecera x-admin-code):
 *   GET  /a/campanas
 *   POST /a/campana              {nombre, cliente, glosario}
 *   POST /a/campana/glosario     {campana_id, glosario}
 *   POST /a/enlace               {campana_id, abierta?, regenerar?, dominio?}
 *   POST /a/importar             {campana_id, modo, upsert?, encuestados[], procesos[] (con matriz opcional; con upsert se actualiza por id o código), sistemas[]}
 *   GET  /a/campana?id=          volcado completo de la campaña
 *   POST /a/proceso              {campana_id, id?, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion}
 *   POST /a/proceso/borrar       {proceso_id}   (solo si nadie lo respondió)
 *   POST /a/campana/logo         {campana_id, logo}   (data URI; vacío lo quita)
 *   POST /a/campana/ia           {campana_id, ia_auto}   (la tarea programada completa la matriz con la IA)
 *   POST /a/asignar              {encuestado_id, agregar[], quitar[]}   (lista de procesos de una persona)
 *   POST /a/asignar-por-inventario {campana_id}   (asigna por el nombre en el inventario anterior)
 *   POST /a/matriz               {proceso_id, matriz?, validacion?, validado_por?}   (fila de la matriz y check de validación)
 *   POST /a/validacion           {campana_id, proceso_ids[], validacion, validado_por}   (validación en bloque)
 *   POST /a/encuestado/borrar    {encuestado_id | encuestado_ids[], forzar?}   (con respuestas, solo con forzar)
 *   POST /a/respuesta/borrar     {encuestado_id, proceso_id | proceso_ids[]}   (borra sus respuestas en esos procesos; la persona se queda)
 *   POST /a/estructurar          {proceso_id}
 *   POST /a/borrar-campana       {campana_id, confirmar}   (confirmar = nombre exacto)
 *   GET  /health
 * Tarea programada (cada 15 minutos, wrangler.toml): la IA estructura los procesos con respuestas nuevas y completa la matriz.
 *
 * La matriz (procesos.matriz, JSON) replica las columnas del inventario del cliente y agrega las del contrato;
 * procesos.validacion guarda el check: '' (sin tocar), 'actualizado' o 'validado'.
 *
 * Secretos (npx wrangler secret put ...): ADMIN_CODE, INTERNAL_CODE (IA vía processiq-api)
 * y, opcional, ANTHROPIC_API_KEY (IA directa).
 * Registro: Workers Logs (observability en wrangler.toml). Nunca se registran tokens completos,
 * nombres, correos ni respuestas.
 * ============================================================ */

import Anthropic from '@anthropic-ai/sdk';

// Modelo de IA y esfuerzo por tarea: se cambian en wrangler.toml [vars] sin tocar el código (por defecto, Claude Sonnet 5.5).
// estructurar = completar la matriz; revision = checklist de cada bloque; imagen = leer imágenes (con el modelo de revisión).
const IA_POR_DEFECTO = { estructurar: ['claude-sonnet-5-5', 'medium'], revision: ['claude-sonnet-5-5', 'low'], imagen: ['claude-sonnet-5-5', 'low'] };
function iaDe(env, tarea) {
  const v = { estructurar: [env.IA_MODELO_ESTRUCTURAR, env.IA_ESFUERZO_ESTRUCTURAR], revision: [env.IA_MODELO_REVISION, env.IA_ESFUERZO_REVISION],
    imagen: [env.IA_MODELO_REVISION, env.IA_ESFUERZO_IMAGEN] }[tarea];
  const d = IA_POR_DEFECTO[tarea];
  return { modelo: String(v[0] || d[0]).trim(), esfuerzo: String(v[1] || d[1]).trim() };
}
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const MAX_AUDIO = 8 * 1024 * 1024;       // por tramo; el navegador corta en tramos de 2 min
const MAX_IMAGEN = 6 * 1024 * 1024;      // el navegador la reduce antes (máx. 1600 px, JPEG)
const MAX_TEXTO = 12000;
// Encuesta por bloques: cada bloque se responde con una grabación y trae el checklist de lo que la matriz necesita.
// Después de cada respuesta, la IA marca qué puntos se cubrieron y pide solo lo que falta. Un punto que no existe
// en el área (p. ej. no hay indicadores) se marca "no aplica": así ningún dato queda vacío sin explicación.
// Tercer elemento de cada punto: 1 = puede no existir en un proceso y la persona puede marcarlo "no aplica" a mano.
// Objetivo, inicio y fin, pasos, frecuencia e interacción existen siempre: esos solo se cumplen contándolos.
// Los puntos siguen los campos de la matriz que definió TDP (2026-10-06), más las aprobaciones externas que pidió.
const BLOQUES = [
  { id: 'b1', t: 'El proceso: objetivo, alcance y de quién depende',
    g: 'Cuéntanos para qué existe el proceso, qué lo inicia y dónde termina, sus pasos principales y cada cuánto se ejecuta. Si para completarlo esperan la aprobación de otra área, de la casa matriz o de una entidad, dinos de quién (cargo), de qué área y en qué paso.',
    puntos: [
      ['objetivo', 'Para qué existe el proceso (su objetivo)'],
      ['inicio_fin', 'Qué lo inicia y dónde termina'],
      ['actividades', 'Los pasos principales, en orden'],
      ['frecuencia', 'Cada cuánto se ejecuta (y qué volumen maneja)'],
      ['aprobaciones', 'Si dependen de aprobaciones de otras áreas: de quién, de qué área y en qué paso', 1]
    ] },
  { id: 'b2', t: 'Sistemas, interacción y terceros', sistemas: true,
    g: 'Cuéntanos qué ERP, aplicativos o plataformas digitales usan y para qué, si el trabajo es digital, presencial o ambos, y con qué terceros se relacionan (proveedores, concesionarios, clientes, funcionarios públicos u otros) y con qué fin.',
    puntos: [
      ['sistemas', 'Qué ERP, aplicativos o plataformas digitales usan (su nombre)', 1],
      ['uso_sistemas', 'Para qué los usan o con qué fin interactúan', 1],
      ['interaccion', 'Si la interacción es digital, presencial o ambas'],
      ['terceros', 'Con qué terceros se relacionan (proveedores, concesionarios, clientes, funcionarios públicos u otros)', 1],
      ['finalidad_terceros', 'Para qué se relacionan con esos terceros o qué información les comparten', 1]
    ] },
  { id: 'b3', t: 'Datos personales, normas, estándares e indicadores',
    g: 'Cuéntanos si manejan datos de personas (de quiénes, qué datos y para qué), qué normas legales peruanas lo regulan, qué estándares aplican (corporativo de TDP, global de TMC u otros como NTP o ISO), si el proceso está documentado y, si existen, con qué indicadores lo miden.',
    puntos: [
      ['datos_personales', 'Si manejan datos de personas: de quiénes y qué datos', 1],
      ['finalidad_dp', 'Para qué usan esos datos personales', 1],
      ['normativa', 'Qué normas legales peruanas lo regulan', 1],
      ['estandares', 'Qué estándares aplican: corporativo TDP, global TMC u otros (NTP, ISO)', 1],
      ['documentacion', 'Si está documentado (procedimiento, instructivo, flujo)', 1],
      ['kpis', 'Con qué indicadores lo miden (opcional)', 1]
    ] }
];
// q1..q6: formato anterior (6 preguntas), que se sigue aceptando y mostrando en la consola.
const PREGUNTAS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', ...BLOQUES.map(b => b.id)];
const ESTADOS_REVISION = ['vigente', 'cambio', 'no_participo', 'no_existe'];
const PULSE_INGEST = 'https://pulse.mbc-latam.com/api/ai-usage';

// ---------------------------------------------------------------- utilidades
const ahora = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function tokenNuevo() {
  // 20 caracteres sin ambiguos (sin 0/O, 1/l/I): se puede dictar por teléfono si hace falta.
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, x => abc[x % abc.length]).join('');
}

function cors(req, env) {
  const origen = req.headers.get('Origin') || '';
  const lista = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (lista.includes(origen)) {
    h['Access-Control-Allow-Origin'] = origen;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type, x-admin-code';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(obj, status, h) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, h || {})
  });
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Comparación en tiempo constante: el tiempo de respuesta no delata cuántos caracteres acertó.
function igualSeguro(a, b) {
  const te = new TextEncoder();
  const x = te.encode(a || ''), y = te.encode(b || '');
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

async function cuerpo(req) {
  try { return await req.json(); } catch (e) { throw new HttpError(400, 'Cuerpo JSON inválido'); }
}

// Minúsculas, sin tildes y sin espacios repetidos: "Importación" y "importacion" son lo mismo.
const normal = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'al', 'para', 'por', 'con', 'un', 'una', 'o']);
// Gerencia y sección se comparan sin mayúsculas ni tildes: "Control interno" y "Control Interno" son la misma área.
const mismaArea = (a, b) => normal(a) === normal(b);

// Registro estructurado para Workers Logs. Solo datos operativos: nunca tokens completos, nombres,
// correos ni texto de respuestas.
function log(evento, datos) {
  try { console.log(JSON.stringify(Object.assign({ evento }, datos || {}))); } catch (e) { /* el registro nunca rompe la respuesta */ }
}
const mascara = k => (k ? String(k).slice(0, 4) + '…' : '');

// Columnas de la matriz de procesos. La consola muestra las de la matriz que definió TDP (2026-10-06) y las aprobaciones
// externas; las demás son del formato anterior y se siguen aceptando para no perder lo que ya está cargado.
const MATRIZ_CLAVES = ['division', 'gerencia', 'seccion', 'participantes', 'niv0', 'macroproceso', 'niv1', 'proceso', 'niv2', 'subproceso',
  'alcance', 'objetivo', 'documentacion', 'normativa', 'crit_normativa', 'riesgos', 'crit_riesgo', 'datos_personales', 'detalle_dp',
  'terceros', 'crit_tercero', 'tecnologia', 'estandar_tdp', 'priorizacion', 'sancion', 'dueno', 'areas', 'actividades', 'kpis',
  'frecuencia', 'uso_tecnologia', 'sistemas_dp', 'automatizacion', 'cod_riesgo', 'categoria_mapa', 'proceso_mapa', 'comentarios',
  'codigo_2021', 'division_2021', 'gerencia_2021', 'seccion_2021', 'mapeo_org', 'origen',
  'interaccion', 'finalidad_terceros', 'finalidad_dp', 'estandar_tmc', 'otros_estandares',
  'aprob_externa', 'aprob_area', 'aprob_responsable', 'aprob_momento'];
const VALIDACIONES = ['', 'actualizado', 'validado'];

function limpiarMatriz(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  MATRIZ_CLAVES.forEach(k => {
    const v = m[k] == null ? '' : String(m[k]).trim();
    if (v) out[k] = v.slice(0, 4000);
  });
  return out;
}

function leerMatriz(s) {
  try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}

// Nombre de persona (inventario anterior, uno por línea) en el que aparecen todas las palabras buscadas al inicio de una palabra.
function personaQueCoincide(personas, terms) {
  if (!personas) return '';
  for (const linea of String(personas).split('\n')) {
    const n = normal(linea);
    if (n && terms.every(t => n.startsWith(t) || n.includes(' ' + t))) return linea.trim();
  }
  return '';
}

// Dos nombres son la misma persona si las palabras del más corto (al menos dos) están todas en el otro:
// "Yulissa Llaves" y "Yulissa Llaves Reyes" coinciden; un solo nombre de pila no basta.
const tokensNombre = s => normal(s).split(' ').filter(t => t.length > 1 && !VACIAS.has(t));
function mismoNombre(a, b) {
  const x = tokensNombre(a), y = tokensNombre(b);
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  return corto.length >= 2 && corto.every(t => largo.includes(t));
}

// Buscador del inventario: cada palabra escrita debe aparecer en el proceso (nombre, ruta, código, área o
// descripción) o en el nombre de una persona que participa en él. Pesa más si aparece en el nombre del proceso
// y si es de la gerencia preferida.
function buscarProcesos(procs, q, gerenciaPreferida) {
  const nq = normal(q);
  let terms = nq.split(' ').filter(Boolean);
  if (terms.length > 1) terms = terms.filter(t => !VACIAS.has(t));
  if (!terms.length) return [];
  const gp = normal(gerenciaPreferida);
  const buscaPersona = terms.join('').length >= 3;
  const out = [];
  for (const p of procs) {
    const nombre = normal(p.subproceso || p.proceso || p.macroproceso);
    const ruta = normal(p.proceso + ' ' + p.macroproceso);
    const resto = normal([p.codigo, p.seccion, p.gerencia, p.descripcion].join(' '));
    const persona = buscaPersona ? personaQueCoincide(p.personas, terms) : '';
    let score = 0, ok = true;
    for (const t of terms) {
      if (nombre.startsWith(t) || nombre.includes(' ' + t)) score += 6;
      else if (nombre.includes(t)) score += 4;
      else if (ruta.includes(t)) score += 2;
      else if (resto.includes(t)) score += 1;
      else { ok = false; break; }
    }
    if (!ok && persona) { ok = true; score = 3 * terms.length; }
    if (!ok) continue;
    if (p.codigo && normal(p.codigo) === nq) score += 20;
    if (gp && normal(p.gerencia) === gp) score += 3;
    out.push({ p, score, persona });
  }
  out.sort((a, b) => b.score - a.score || normal(a.p.subproceso || a.p.proceso).localeCompare(normal(b.p.subproceso || b.p.proceso)));
  return out;
}

// Datos de un proceso que puede ver un encuestado (nunca quién lo respondió).
function publico(p) {
  return { id: p.id, codigo: p.codigo, gerencia: p.gerencia, seccion: p.seccion, macroproceso: p.macroproceso,
    proceso: p.proceso, subproceso: p.subproceso, descripcion: p.descripcion, nuevo: p.fuente === 'nuevo' };
}

// ---------------------------------------------------------------- encuestado
async function encuestadoPorToken(env, k) {
  if (!k || k.length < 12) throw new HttpError(401, 'Enlace inválido');
  const e = await env.DB.prepare('SELECT * FROM encuestados WHERE token = ?').bind(k).first();
  if (!e) throw new HttpError(401, 'Enlace inválido o vencido');
  return e;
}

async function marcarEnCurso(env, e) {
  if (e.estado === 'pendiente') {
    await env.DB.prepare("UPDATE encuestados SET estado='en_curso', actualizado=? WHERE id=?").bind(ahora(), e.id).run();
  } else {
    await env.DB.prepare('UPDATE encuestados SET actualizado=? WHERE id=?').bind(ahora(), e.id).run();
  }
}

// Un encuestado puede responder los procesos de su sección, los que eligió con el buscador y los que agregó.
async function procesoPermitido(env, e, procesoId) {
  const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=? AND campana_id=?').bind(procesoId, e.campana_id).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  if ((mismaArea(p.gerencia, e.gerencia) && mismaArea(p.seccion, e.seccion)) || p.creado_por === e.id) return p;
  const a = await env.DB.prepare('SELECT 1 AS x FROM asignaciones WHERE encuestado_id=? AND proceso_id=?').bind(e.id, p.id).first();
  if (!a) throw new HttpError(403, 'Primero elige este proceso en el paso 1');
  return p;
}

async function rutaSesion(env, url) {
  const e = await encuestadoPorToken(env, url.searchParams.get('k'));
  const [camp, procs, asig, revs, resps, sis] = await Promise.all([
    env.DB.prepare('SELECT nombre, cliente, logo FROM campanas WHERE id=?').bind(e.campana_id).first(),
    env.DB.prepare(`SELECT id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, creado_por, orden
      FROM procesos WHERE campana_id=?`).bind(e.campana_id).all(),
    env.DB.prepare('SELECT proceso_id, origen FROM asignaciones WHERE encuestado_id=?').bind(e.id).all(),
    env.DB.prepare('SELECT proceso_id, estado, comentario FROM revisiones WHERE encuestado_id=?').bind(e.id).all(),
    env.DB.prepare('SELECT proceso_id, pregunta, texto, sistemas, checklist FROM respuestas WHERE encuestado_id=?').bind(e.id).all(),
    env.DB.prepare('SELECT nombre, tipo FROM sistemas WHERE campana_id=? ORDER BY nombre').bind(e.campana_id).all()
  ]);
  const elegidos = new Set(asig.results.map(a => a.proceso_id));
  // Procesos que el equipo le asignó o que le corresponden por su nombre en el inventario anterior.
  const asignadoPor = {};
  asig.results.forEach(a => { if (a.origen && a.origen !== 'encuestado') asignadoPor[a.proceso_id] = a.origen; });
  // Su sección (sin los nuevos que agregó otra persona), lo que eligió con el buscador y lo que agregó.
  // La sección se compara normalizada: una diferencia de mayúsculas o tildes en la carga no deja a nadie sin procesos.
  const enSeccion = p => p.fuente !== 'nuevo' && mismaArea(p.gerencia, e.gerencia) && mismaArea(p.seccion, e.seccion);
  const orden = (a, b) => (a.orden - b.orden) || normal(a.macroproceso).localeCompare(normal(b.macroproceso))
    || normal(a.proceso).localeCompare(normal(b.proceso)) || normal(a.subproceso).localeCompare(normal(b.subproceso));
  const procesos = procs.results.filter(p => enSeccion(p) || p.creado_por === e.id || elegidos.has(p.id)).sort(orden)
    .map(p => Object.assign(publico(p), {
      enSeccion: enSeccion(p),
      propio: p.fuente === 'nuevo' && p.creado_por === e.id,
      elegido: elegidos.has(p.id),
      asignado: asignadoPor[p.id] || ''
    }));
  log('sesion', { campana: e.campana_id, origen: e.origen, estado: e.estado, procesos: procesos.length, k: mascara(e.token) });
  const revisiones = {};
  revs.results.forEach(r => { revisiones[r.proceso_id] = { estado: r.estado, comentario: r.comentario }; });
  const respuestas = {};
  resps.results.forEach(r => {
    (respuestas[r.proceso_id] = respuestas[r.proceso_id] || {})[r.pregunta] = {
      texto: r.texto, sistemas: JSON.parse(r.sistemas || '[]'), checklist: leerMatriz(r.checklist)
    };
  });
  return {
    ok: true,
    campana: camp,
    encuestado: { nombre: e.nombre, gerencia: e.gerencia, seccion: e.seccion, rol: e.rol, estado: e.estado, origen: e.origen },
    procesos, revisiones, respuestas,
    sistemas: sis.results,
    bloques: BLOQUES
  };
}

async function rutaRevision(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoPermitido(env, e, b.proceso_id);
  if (!ESTADOS_REVISION.includes(b.estado)) throw new HttpError(400, 'Estado inválido');
  await env.DB.prepare(`INSERT INTO revisiones (encuestado_id, proceso_id, estado, comentario, actualizado) VALUES (?,?,?,?,?)
    ON CONFLICT(encuestado_id, proceso_id) DO UPDATE SET estado=excluded.estado, comentario=excluded.comentario, actualizado=excluded.actualizado`)
    .bind(e.id, p.id, b.estado, txt(b.comentario, 1500), ahora()).run();
  await marcarEnCurso(env, e);
  return { ok: true };
}

async function rutaProcesoNuevo(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const nombre = txt(b.proceso, 200);
  if (!nombre) throw new HttpError(400, 'Indica el nombre del proceso');
  const id = uid();
  await env.DB.prepare(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, creado_por, orden)
    VALUES (?,?,?,?,?,?,?,?,?,'nuevo',?,9999)`)
    .bind(id, e.campana_id, '', e.gerencia, e.seccion, txt(b.macroproceso, 200), nombre, txt(b.subproceso, 200), txt(b.descripcion, 1500), e.id).run();
  await env.DB.prepare(`INSERT INTO revisiones (encuestado_id, proceso_id, estado, comentario, actualizado) VALUES (?,?,'vigente','',?)`)
    .bind(e.id, id, ahora()).run();
  await marcarEnCurso(env, e);
  return { ok: true, proceso: { id, codigo: '', gerencia: e.gerencia, seccion: e.seccion, macroproceso: txt(b.macroproceso, 200), proceso: nombre,
    subproceso: txt(b.subproceso, 200), descripcion: txt(b.descripcion, 1500), nuevo: true, enSeccion: false, propio: true, elegido: false } };
}

// Asigna procesos a una persona. Por tandas de 30: límite de parámetros de D1. La primera asignación manda (no se
// sobrescribe el origen). Si la persona los eligió quedan como "participo"; si los asignó el equipo o su nombre en el
// inventario anterior, la persona confirma su relación con cada uno.
async function asignarProcesos(env, e, ids, origen) {
  const t = ahora(), procesos = [];
  for (let i = 0; i < ids.length; i += 30) {
    const tanda = ids.slice(i, i + 30);
    const r = await env.DB.prepare(`SELECT * FROM procesos WHERE campana_id=? AND id IN (${tanda.map(() => '?').join(',')})`)
      .bind(e.campana_id, ...tanda).all();
    procesos.push(...r.results);
  }
  const st = [];
  procesos.forEach(p => {
    st.push(env.DB.prepare('INSERT OR IGNORE INTO asignaciones (encuestado_id, proceso_id, creado, origen) VALUES (?,?,?,?)')
      .bind(e.id, p.id, t, origen));
    if (origen !== 'encuestado') return;
    // Si antes dijo "no participo" o "ya no se hace", elegirlo lo vuelve a activar.
    st.push(env.DB.prepare(`INSERT INTO revisiones (encuestado_id, proceso_id, estado, comentario, actualizado) VALUES (?,?,'vigente','',?)
      ON CONFLICT(encuestado_id, proceso_id) DO UPDATE SET
        estado=CASE WHEN revisiones.estado IN ('vigente','cambio') THEN revisiones.estado ELSE 'vigente' END, actualizado=excluded.actualizado`)
      .bind(e.id, p.id, t));
  });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return procesos;
}

// Elegir uno o varios procesos del inventario (de cualquier gerencia): quedan en su lista y listos para responder.
async function rutaElegir(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const ids = [...new Set((Array.isArray(b.proceso_ids) ? b.proceso_ids : [b.proceso_id]).map(x => txt(x, 60)).filter(Boolean))].slice(0, 60);
  if (!ids.length) throw new HttpError(400, 'No se indicó el proceso');
  const procesos = await asignarProcesos(env, e, ids, 'encuestado');
  if (!procesos.length) throw new HttpError(404, 'Proceso no encontrado');
  await marcarEnCurso(env, e);
  const vista = p => Object.assign(publico(p), {
    enSeccion: mismaArea(p.gerencia, e.gerencia) && mismaArea(p.seccion, e.seccion) && p.fuente !== 'nuevo',
    propio: p.fuente === 'nuevo' && p.creado_por === e.id,
    elegido: true
  });
  return { ok: true, proceso: vista(procesos[0]), procesos: procesos.map(vista) };
}

// Quitar un proceso de su lista: borra solo lo de esta persona. Un proceso nuevo que nadie
// más eligió ni respondió desaparece; si alguien más lo usa, se conserva para esa persona.
async function rutaSoltar(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoPermitido(env, e, b.proceso_id);
  const otros = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM asignaciones WHERE proceso_id=? AND encuestado_id<>?) +
      (SELECT COUNT(*) FROM revisiones WHERE proceso_id=? AND encuestado_id<>?) +
      (SELECT COUNT(*) FROM respuestas WHERE proceso_id=? AND encuestado_id<>?) AS n`)
    .bind(p.id, e.id, p.id, e.id, p.id, e.id).first();
  const st = [
    env.DB.prepare('DELETE FROM asignaciones WHERE encuestado_id=? AND proceso_id=?').bind(e.id, p.id),
    env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id=? AND proceso_id=?').bind(e.id, p.id),
    env.DB.prepare('DELETE FROM respuestas WHERE encuestado_id=? AND proceso_id=?').bind(e.id, p.id)
  ];
  if (p.fuente === 'nuevo' && p.creado_por === e.id && !otros.n) {
    st.push(env.DB.prepare('DELETE FROM estructurado WHERE proceso_id=?').bind(p.id));
    st.push(env.DB.prepare('DELETE FROM procesos WHERE id=?').bind(p.id));
  }
  await env.DB.batch(st);
  return { ok: true };
}

async function rutaRespuesta(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoPermitido(env, e, b.proceso_id);
  if (!PREGUNTAS.includes(b.pregunta)) throw new HttpError(400, 'Pregunta inválida');
  const sistemas = Array.isArray(b.sistemas) ? b.sistemas.map(s => txt(s, 120)).filter(Boolean).slice(0, 60) : [];
  await env.DB.prepare(`INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, sistemas, actualizado) VALUES (?,?,?,?,?,?)
    ON CONFLICT(encuestado_id, proceso_id, pregunta) DO UPDATE SET texto=excluded.texto, sistemas=excluded.sistemas, actualizado=excluded.actualizado`)
    .bind(e.id, p.id, b.pregunta, txt(b.texto, MAX_TEXTO), JSON.stringify(sistemas), ahora()).run();
  // Sistemas que la IA detectó y la persona desmarcó: no se vuelven a marcar solos (se guardan en el checklist).
  if (Array.isArray(b.sis_rechazados)) {
    const r = await env.DB.prepare('SELECT checklist FROM respuestas WHERE encuestado_id=? AND proceso_id=? AND pregunta=?').bind(e.id, p.id, b.pregunta).first();
    const c = leerMatriz(r && r.checklist);
    c._sistemas_rechazados = b.sis_rechazados.map(s => txt(s, 120)).filter(Boolean).slice(0, 60);
    await env.DB.prepare('UPDATE respuestas SET checklist=? WHERE encuestado_id=? AND proceso_id=? AND pregunta=?').bind(JSON.stringify(c), e.id, p.id, b.pregunta).run();
  }
  await marcarEnCurso(env, e);
  return { ok: true };
}

// Pista para Whisper: primero el glosario y luego los sistemas (sin el detalle entre paréntesis), sin repetir y
// cortada entre términos. Whisper admite unos 224 tokens de pista: con una más larga, Workers AI falla con
// "3030: Failed to decode audio file" aunque el audio esté bien (pasó con los 26 sistemas de TDP, ~600 caracteres).
const MAX_PISTA = 350;
function pistaWhisper(glosario, sistemas) {
  const terminos = [];
  String(glosario || '').split(/[,;\n]/).concat(sistemas.map(s => String(s).replace(/\s*\([^)]*\)/g, '')))
    .map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .forEach(t => { if (!terminos.some(p => normal(p) === normal(t))) terminos.push(t); });
  let out = '';
  terminos.forEach(t => { const sig = out ? out + ', ' + t : t; if (sig.length <= MAX_PISTA) out = sig; });
  return out;
}

async function rutaTranscribir(env, req, url) {
  const e = await encuestadoPorToken(env, url.searchParams.get('k'));
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'Audio vacío');
  if (buf.byteLength > MAX_AUDIO) throw new HttpError(413, 'Tramo de audio demasiado grande');
  const camp = await env.DB.prepare('SELECT glosario FROM campanas WHERE id=?').bind(e.campana_id).first();
  const sis = await env.DB.prepare('SELECT nombre FROM sistemas WHERE campana_id=? LIMIT 40').bind(e.campana_id).all();
  // El glosario orienta a Whisper con siglas y nombres propios que suele escribir mal.
  const pista = pistaWhisper(camp && camp.glosario, sis.results.map(s => s.nombre));
  const audio = aBase64(buf);
  const whisper = p => env.AI.run(WHISPER, { audio, language: 'es', vad_filter: true, initial_prompt: p || undefined });
  // Workers AI a veces responde "3030: Failed to decode audio file" con audio válido: el mismo archivo falla y al
  // repetirlo funciona (pruebas del 2026-09-30, ~1 de cada 3 llamadas). Se reintenta con pausa, alternando con y
  // sin pista por si la pista fuera la causa (sin pista solo se pierde la ayuda con siglas y nombres).
  const intentos = [pista, '', pista, '', ''];
  let r = null, ultimo = null;
  for (let i = 0; i < intentos.length && !r; i++) {
    if (i) await new Promise(ok => setTimeout(ok, 400 * i));
    try {
      r = await whisper(intentos[i]);
    } catch (err) {
      ultimo = err;
      log('whisper_reintento', { campana: e.campana_id, intento: i + 1, pista: intentos[i].length, bytes: buf.byteLength,
        error: String((err && err.message) || err).slice(0, 160) });
    }
  }
  if (!r) {
    console.error('whisper', ultimo && ultimo.message);
    throw new HttpError(502, 'No se pudo transcribir el audio. Inténtalo de nuevo o escribe tu respuesta.');
  }
  return { ok: true, texto: String(r.text || '').trim() };
}

async function rutaEnviar(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  await env.DB.prepare("UPDATE encuestados SET estado='enviado', actualizado=? WHERE id=?").bind(ahora(), e.id).run();
  log('enviado', { campana: e.campana_id, k: mascara(e.token) });
  return { ok: true };
}

// ---------------------------------------------------------------- enlace abierto
async function campanaAbierta(env, c) {
  if (!c || c.length < 8) throw new HttpError(404, 'Este enlace no es válido.');
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE codigo_publico=?').bind(c).first();
  if (!camp || !camp.abierta) throw new HttpError(404, 'Este enlace no está activo. Pide el enlace vigente al equipo consultor.');
  return camp;
}

// Gerencias y secciones para el registro: las del inventario y las de las personas cargadas
// (no las que escribieron otros al registrarse, para no propagar errores de tipeo).
async function areasDeCampana(env, campId) {
  const r = await env.DB.prepare(`SELECT gerencia, seccion FROM procesos WHERE campana_id=? AND fuente<>'nuevo'
    UNION SELECT gerencia, seccion FROM encuestados WHERE campana_id=? AND origen='carga'`).bind(campId, campId).all();
  const m = {};
  r.results.forEach(x => { (m[x.gerencia] = m[x.gerencia] || new Set()).add(x.seccion); });
  const orden = (a, b) => a.localeCompare(b, 'es');
  return Object.keys(m).sort(orden).map(g => ({ gerencia: g, secciones: Array.from(m[g]).sort(orden) }));
}

async function rutaAbierta(env, url) {
  const camp = await campanaAbierta(env, url.searchParams.get('c'));
  log('abierta', { campana: camp.id, g: !!url.searchParams.get('g') });
  return { ok: true, campana: { nombre: camp.nombre, cliente: camp.cliente, logo: camp.logo || '' }, dominio: camp.dominio || '', areas: await areasDeCampana(env, camp.id) };
}

async function rutaBuscar(env, url) {
  const q = txt(url.searchParams.get('q'), 120);
  let campId, preferida = txt(url.searchParams.get('g'), 150);
  const elegidos = new Set();
  if (url.searchParams.get('k')) {
    const e = await encuestadoPorToken(env, url.searchParams.get('k'));
    campId = e.campana_id;
    preferida = preferida || e.gerencia;
    const a = await env.DB.prepare(`SELECT proceso_id FROM revisiones WHERE encuestado_id=? AND estado IN ('vigente','cambio')`).bind(e.id).all();
    a.results.forEach(x => elegidos.add(x.proceso_id));
  } else {
    campId = (await campanaAbierta(env, url.searchParams.get('c'))).id;
  }
  // Mínimo 2 letras y máximo 15 resultados: el buscador ayuda a encontrar, no a descargar el inventario.
  if (normal(q).length < 2) return { ok: true, total: 0, resultados: [], personas: [] };
  const procs = await env.DB.prepare(`SELECT id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, personas
    FROM procesos WHERE campana_id=?`).bind(campId).all();
  const r = buscarProcesos(procs.results, q, preferida);
  // Quien escribe su nombre ve todos los procesos donde figura en el inventario anterior y puede elegirlos de una vez.
  const grupos = {};
  r.forEach(x => {
    if (!x.persona) return;
    const g = grupos[normal(x.persona)] = grupos[normal(x.persona)] || { nombre: x.persona, procesos: [] };
    g.procesos.push(x.p);
  });
  const personas = Object.values(grupos).sort((a, b) => b.procesos.length - a.procesos.length).slice(0, 5)
    .map(g => ({ nombre: g.nombre, total: g.procesos.length,
      procesos: g.procesos.slice(0, 60).map(p => Object.assign(publico(p), { elegido: elegidos.has(p.id) })) }));
  return { ok: true, total: r.length, personas,
    resultados: r.slice(0, 15).map(x => Object.assign(publico(x.p), { elegido: elegidos.has(x.p.id), persona: x.persona || '' })) };
}

async function rutaRegistro(env, b) {
  const camp = await campanaAbierta(env, b.c);
  const nombre = txt(b.nombre, 150), correo = txt(b.correo, 150).toLowerCase();
  const gerencia = txt(b.gerencia, 150), seccion = txt(b.seccion, 150);
  if (nombre.length < 3) throw new HttpError(400, 'Escribe tu nombre y apellido.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new HttpError(400, 'Escribe un correo válido.');
  const dominio = (camp.dominio || '').trim().toLowerCase().replace(/^@/, '');
  if (dominio && !correo.endsWith('@' + dominio)) throw new HttpError(400, 'Usa tu correo corporativo (@' + dominio + ').');
  if (!gerencia || !seccion) throw new HttpError(400, 'Indica tu gerencia y tu sección.');
  // Un correo, un registro: si ya existe, no se le entrega el enlace de otra persona.
  const ya = await env.DB.prepare('SELECT id FROM encuestados WHERE campana_id=? AND lower(correo)=?').bind(camp.id, correo).first();
  if (ya) throw new HttpError(409, 'Ese correo ya está registrado en esta encuesta. Entra con tu enlace personal (el que guardaste o te llegó por correo) o pide al equipo consultor que te lo reenvíe.');

  const ids = [...new Set(Array.isArray(b.procesos) ? b.procesos.map(x => txt(x, 60)).filter(Boolean) : [])].slice(0, 60);
  const id = uid(), token = tokenNuevo(), t = ahora();
  await env.DB.prepare(`INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, rol, estado, actualizado, origen)
    VALUES (?,?,?,?,?,?,?,?,?,?,'abierto')`).bind(id, camp.id, token, nombre, correo, gerencia, seccion, txt(b.cargo, 80), ids.length ? 'en_curso' : 'pendiente', t).run();
  const e = { id, campana_id: camp.id };
  const elegidos = ids.length ? await asignarProcesos(env, e, ids, 'encuestado') : [];
  // Procesos donde figura con su nombre en el inventario anterior: quedan en su lista para que confirme su relación.
  const conNombre = await env.DB.prepare(`SELECT id, personas FROM procesos WHERE campana_id=? AND personas<>''`).bind(camp.id).all();
  const yaElegidos = new Set(elegidos.map(p => p.id));
  const suyos = conNombre.results.filter(p => !yaElegidos.has(p.id) && p.personas.split('\n').some(l => mismoNombre(l, nombre))).map(p => p.id).slice(0, 60);
  if (suyos.length) await asignarProcesos(env, e, suyos, 'inventario');
  log('registro', { campana: camp.id, procesos: elegidos.length, inventario: suyos.length, dominio: !!camp.dominio });
  return { ok: true, k: token, nombre };
}

// ---------------------------------------------------------------- consola
function exigirAdmin(req, env) {
  const codigo = (env.ADMIN_CODE || '').trim();
  if (!codigo) throw new HttpError(500, 'Falta configurar ADMIN_CODE en el Worker');
  if (!igualSeguro(req.headers.get('x-admin-code') || '', codigo)) throw new HttpError(401, 'Código de administración incorrecto');
}

async function rutaCampanas(env) {
  const r = await env.DB.prepare(`SELECT c.id, c.nombre, c.cliente, c.creada,
      (SELECT COUNT(*) FROM encuestados e WHERE e.campana_id=c.id) AS encuestados,
      (SELECT COUNT(*) FROM procesos p WHERE p.campana_id=c.id) AS procesos
    FROM campanas c ORDER BY c.creada DESC`).all();
  return { ok: true, campanas: r.results };
}

async function rutaCampanaNueva(env, b) {
  const nombre = txt(b.nombre, 150), cliente = txt(b.cliente, 150);
  if (!nombre || !cliente) throw new HttpError(400, 'Nombre y cliente son obligatorios');
  const id = uid();
  await env.DB.prepare('INSERT INTO campanas (id, nombre, cliente, glosario, creada) VALUES (?,?,?,?,?)')
    .bind(id, nombre, cliente, txt(b.glosario, 800), ahora()).run();
  return { ok: true, id };
}

async function rutaGlosario(env, b) {
  await env.DB.prepare('UPDATE campanas SET glosario=? WHERE id=?').bind(txt(b.glosario, 800), b.campana_id).run();
  return { ok: true };
}

// Activa, desactiva o renueva el enlace abierto. Renovar invalida el enlace anterior.
async function rutaEnlace(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const codigo = (!camp.codigo_publico || b.regenerar) ? tokenNuevo().slice(0, 12) : camp.codigo_publico;
  const abierta = b.abierta === undefined ? camp.abierta : (b.abierta ? 1 : 0);
  const dominio = b.dominio === undefined ? camp.dominio : txt(b.dominio, 80).toLowerCase().replace(/^@/, '');
  await env.DB.prepare('UPDATE campanas SET codigo_publico=?, abierta=?, dominio=? WHERE id=?').bind(codigo, abierta, dominio, camp.id).run();
  return { ok: true, codigo_publico: codigo, abierta, dominio };
}

async function rutaImportar(env, b) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const enc = Array.isArray(b.encuestados) ? b.encuestados : [];
  const pro = Array.isArray(b.procesos) ? b.procesos : [];
  const sis = Array.isArray(b.sistemas) ? b.sistemas : [];
  if (enc.length > 500 || pro.length > 3000 || sis.length > 1000) throw new HttpError(413, 'Demasiadas filas en una sola carga');
  const st = [];
  if (b.modo === 'reemplazar') {
    // Reemplazar solo se permite antes de que haya respuestas: nunca se pierde lo que ya contaron.
    const ya = await env.DB.prepare(`SELECT COUNT(*) AS n FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?`).bind(camp.id).first();
    if (ya.n > 0) throw new HttpError(409, 'La campaña ya tiene respuestas: usa el modo "agregar" para no perderlas');
    st.push(env.DB.prepare('DELETE FROM asignaciones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM encuestados WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM estructurado WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM procesos WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM sistemas WHERE campana_id=?').bind(camp.id));
  }
  const agregar = b.modo !== 'reemplazar';
  const t = ahora();

  // Áreas de referencia: las del inventario ya cargado (si se agrega) y las de esta carga. Las personas se
  // escriben con la misma gerencia y sección que los procesos: así cada una ve los procesos de su sección.
  const areas = {};
  const registrarArea = (g, s) => {
    if (!normal(g)) return;
    const a = areas[normal(g)] = areas[normal(g)] || { nombre: g, secciones: {} };
    if (normal(s) && !a.secciones[normal(s)]) a.secciones[normal(s)] = s;
  };
  if (agregar) {
    const ya = await env.DB.prepare(`SELECT gerencia, seccion FROM procesos WHERE campana_id=? AND fuente<>'nuevo' GROUP BY gerencia, seccion`).bind(camp.id).all();
    ya.results.forEach(x => registrarArea(x.gerencia, x.seccion));
  }
  pro.forEach(x => registrarArea(txt(x.gerencia, 150), txt(x.seccion, 150)));
  // Si la sección escrita no existe y la gerencia tiene una sola sección, se usa esa (p. ej. "CI" -> "Control Interno").
  const canonica = (g, s) => {
    const a = areas[normal(g)];
    if (!a) return [g, s];
    const secs = Object.keys(a.secciones);
    return [a.nombre, a.secciones[normal(s)] || (secs.length === 1 ? a.secciones[secs[0]] : s)];
  };

  // Personas: una por correo. Si el correo ya existe en la campaña se actualiza su área y rol y conserva su enlace.
  const porCorreo = {};
  if (agregar) {
    const ya = await env.DB.prepare(`SELECT id, lower(correo) AS correo FROM encuestados WHERE campana_id=? AND correo<>''`).bind(camp.id).all();
    ya.results.forEach(x => { porCorreo[x.correo] = x.id; });
  }
  let nE = 0, nEAct = 0, nP = 0, nPAct = 0, nS = 0;
  const vistos = new Set();
  enc.forEach(x => {
    const nombre = txt(x.nombre, 150), correo = txt(x.correo, 150).toLowerCase();
    const [gerencia, seccion] = canonica(txt(x.gerencia, 150), txt(x.seccion, 150));
    if (!nombre || !gerencia || !seccion) return;
    if (correo) {
      if (vistos.has(correo)) return;   // repetido dentro del mismo archivo
      vistos.add(correo);
      if (porCorreo[correo]) {
        st.push(env.DB.prepare('UPDATE encuestados SET nombre=?, gerencia=?, seccion=?, rol=? WHERE id=?')
          .bind(nombre, gerencia, seccion, txt(x.rol, 60), porCorreo[correo]));
        nEAct++;
        return;
      }
    }
    st.push(env.DB.prepare('INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, rol) VALUES (?,?,?,?,?,?,?,?)')
      .bind(uid(), camp.id, tokenNuevo(), nombre, correo, gerencia, seccion, txt(x.rol, 60)));
    nE++;
  });

  // Procesos: con upsert (carga de la matriz), una fila con el id de un proceso de la campaña (columna oculta del Excel)
  // o con un código que ya existe se actualiza en vez de duplicarse.
  // La matriz se combina (json_patch): las columnas que trae el archivo se actualizan y las que no trae se conservan.
  const porCodigo = {}, porId = {}, actual = {};
  if (b.upsert && agregar) {
    const ya = await env.DB.prepare('SELECT id, codigo, matriz, matriz_ia FROM procesos WHERE campana_id=?').bind(camp.id).all();
    ya.results.forEach(x => { porId[x.id] = x.id; actual[x.id] = x; if (normal(x.codigo)) porCodigo[normal(x.codigo)] = x.id; });
  }
  pro.forEach((x, i) => {
    const gerencia = txt(x.gerencia, 150), seccion = txt(x.seccion, 150);
    const nombre = txt(x.proceso, 200) || txt(x.subproceso, 200);
    if (!gerencia || !seccion || !nombre) return;
    const matriz = limpiarMatriz(x.matriz);
    const val = VALIDACIONES.includes(x.validacion) ? x.validacion : null;
    // Nombres del inventario anterior (columna PARTICIPANTES): alimentan el buscador por persona.
    const personas = txt(x.personas || matriz.participantes || '', 4000);
    const id = porId[txt(x.id, 60)] || (normal(x.codigo) && porCodigo[normal(x.codigo)]);
    if (id) {
      // Un campo que el archivo cambia deja de ser de la IA: lo escribió el equipo.
      const mPrev = leerMatriz((actual[id] || {}).matriz), iaPrev = leerMatriz((actual[id] || {}).matriz_ia);
      Object.keys(matriz).forEach(k => { if (matriz[k] !== String(mPrev[k] || '')) delete iaPrev[k]; });
      st.push(env.DB.prepare(`UPDATE procesos SET gerencia=?, seccion=?, macroproceso=?, proceso=?, subproceso=?,
          descripcion=CASE WHEN ?<>'' THEN ? ELSE descripcion END, personas=CASE WHEN ?<>'' THEN ? ELSE personas END,
          matriz=CASE WHEN ?<>'{}' THEN json_patch(matriz, ?) ELSE matriz END, matriz_ia=?,
          validacion=COALESCE(?, validacion), validado_por=CASE WHEN ?='validado' THEN ? ELSE validado_por END,
          validado_en=CASE WHEN ?='validado' THEN ? ELSE validado_en END, actualizado_en=? WHERE id=?`)
        .bind(gerencia, seccion, txt(x.macroproceso, 200), txt(x.proceso, 200), txt(x.subproceso, 200),
          txt(x.descripcion, 1500), txt(x.descripcion, 1500), personas, personas, JSON.stringify(matriz), JSON.stringify(matriz), JSON.stringify(iaPrev),
          val, val, txt(x.validado_por, 150), val, t, t, id));
      nPAct++;
      return;
    }
    st.push(env.DB.prepare(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, orden,
        matriz, validacion, validado_por, validado_en, personas) VALUES (?,?,?,?,?,?,?,?,?,'inventario',?,?,?,?,?,?)`)
      .bind(uid(), camp.id, txt(x.codigo, 60), gerencia, seccion, txt(x.macroproceso, 200), txt(x.proceso, 200), txt(x.subproceso, 200),
        txt(x.descripcion, 1500), i, JSON.stringify(matriz), val || '', val === 'validado' ? txt(x.validado_por, 150) : '', val === 'validado' ? t : null, personas));
    nP++;
  });

  // Sistemas: sin repetir nombres ya cargados.
  const sisYa = new Set();
  if (agregar) (await env.DB.prepare('SELECT nombre FROM sistemas WHERE campana_id=?').bind(camp.id).all()).results.forEach(x => sisYa.add(normal(x.nombre)));
  sis.forEach(x => {
    const nombre = txt(x.nombre, 120);
    if (!nombre || sisYa.has(normal(nombre))) return;
    sisYa.add(normal(nombre));
    st.push(env.DB.prepare('INSERT INTO sistemas (id, campana_id, nombre, tipo) VALUES (?,?,?,?)').bind(uid(), camp.id, nombre, txt(x.tipo, 80)));
    nS++;
  });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  log('importar', { campana: camp.id, modo: b.modo, upsert: !!b.upsert, nE, nEAct, nP, nPAct, nS });
  return { ok: true, encuestados: nE, encuestados_actualizados: nEAct, procesos: nP, procesos_actualizados: nPAct, sistemas: nS };
}

async function rutaCampana(env, url) {
  const id = url.searchParams.get('id');
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const q = s => env.DB.prepare(s).bind(id).all().then(r => r.results);
  const [encuestados, procesos, revisiones, respuestas, asignaciones, sistemas, estructurado] = await Promise.all([
    q('SELECT id, token, nombre, correo, gerencia, seccion, rol, estado, actualizado, origen FROM encuestados WHERE campana_id=? ORDER BY gerencia, seccion, nombre'),
    q('SELECT * FROM procesos WHERE campana_id=? ORDER BY gerencia, seccion, orden, macroproceso, proceso, subproceso'),
    q('SELECT r.* FROM revisiones r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    q('SELECT r.* FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    q('SELECT a.* FROM asignaciones a JOIN encuestados e ON e.id=a.encuestado_id WHERE e.campana_id=?'),
    q('SELECT nombre, tipo FROM sistemas WHERE campana_id=? ORDER BY nombre'),
    q('SELECT proceso_id, datos, modelo, generado FROM estructurado WHERE campana_id=?')
  ]);
  estructurado.forEach(x => { x.datos = JSON.parse(x.datos); });
  respuestas.forEach(x => { x.sistemas = JSON.parse(x.sistemas || '[]'); x.checklist = leerMatriz(x.checklist); });
  procesos.forEach(x => { x.matriz = leerMatriz(x.matriz); x.matriz_ia = leerMatriz(x.matriz_ia); });
  return { ok: true, campana: camp, encuestados, procesos, revisiones, respuestas, asignaciones, sistemas, estructurado, bloques: BLOQUES, estandares_base: ESTANDARES_BASE };
}

// Alta o edición de un proceso desde el mapa de la consola.
async function rutaProcesoAdmin(env, b) {
  const f = {
    codigo: txt(b.codigo, 60), gerencia: txt(b.gerencia, 150), seccion: txt(b.seccion, 150),
    macroproceso: txt(b.macroproceso, 200), proceso: txt(b.proceso, 200), subproceso: txt(b.subproceso, 200), descripcion: txt(b.descripcion, 1500)
  };
  if (!f.gerencia || !f.seccion) throw new HttpError(400, 'Gerencia y sección son obligatorias');
  if (!f.proceso && !f.subproceso) throw new HttpError(400, 'Indica el proceso o el subproceso');
  if (b.id) {
    const p = await env.DB.prepare('SELECT id FROM procesos WHERE id=?').bind(b.id).first();
    if (!p) throw new HttpError(404, 'Proceso no encontrado');
    await env.DB.prepare(`UPDATE procesos SET codigo=?, gerencia=?, seccion=?, macroproceso=?, proceso=?, subproceso=?, descripcion=? WHERE id=?`)
      .bind(f.codigo, f.gerencia, f.seccion, f.macroproceso, f.proceso, f.subproceso, f.descripcion, b.id).run();
    return { ok: true, id: b.id };
  }
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const id = uid();
  await env.DB.prepare(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, orden)
    VALUES (?,?,?,?,?,?,?,?,?,'consultor',5000)`)
    .bind(id, camp.id, f.codigo, f.gerencia, f.seccion, f.macroproceso, f.proceso, f.subproceso, f.descripcion).run();
  return { ok: true, id };
}

// Borrar un proceso del mapa: solo si nadie lo respondió (lo respondido se discute en la validación).
async function rutaProcesoBorrar(env, b) {
  const p = await env.DB.prepare('SELECT id FROM procesos WHERE id=?').bind(b.proceso_id).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM respuestas WHERE proceso_id=? AND (trim(texto)<>'' OR sistemas<>'[]')`).bind(p.id).first();
  if (n.n) throw new HttpError(409, 'Este proceso ya tiene respuestas y no se puede borrar. Edítalo o resuélvelo en la reunión de validación.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM asignaciones WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM revisiones WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM respuestas WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM estructurado WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM procesos WHERE id=?').bind(p.id)
  ]);
  return { ok: true };
}

// Fila de la matriz de un proceso: guarda los campos editados y el check de validación.
// Un campo enviado vacío se borra. Editar una fila sin tocar el check la deja como "actualizado".
async function rutaMatriz(env, b) {
  const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=?').bind(b.proceso_id).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  const m = leerMatriz(p.matriz), ia = leerMatriz(p.matriz_ia);
  const edita = b.matriz && typeof b.matriz === 'object';
  if (edita) {
    MATRIZ_CLAVES.forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(b.matriz, k)) return;
      const v = String(b.matriz[k] == null ? '' : b.matriz[k]).trim().slice(0, 4000);
      if (v !== String(m[k] || '')) delete ia[k];   // lo que cambia el equipo deja de ser de la IA
      if (v) m[k] = v; else delete m[k];
    });
  }
  let validacion = p.validacion || '', validadoPor = p.validado_por || '', validadoEn = p.validado_en || null;
  if (b.validacion !== undefined) {
    if (!VALIDACIONES.includes(b.validacion)) throw new HttpError(400, 'Estado de validación inválido');
    validacion = b.validacion;
    if (validacion === 'validado') { validadoPor = txt(b.validado_por, 150) || validadoPor; validadoEn = ahora(); }
    else { validadoPor = ''; validadoEn = null; }
  } else if (edita && !validacion) {
    validacion = 'actualizado';
  }
  // La encuesta y el mapa usan la misma identificación que la matriz.
  const f = {
    codigo: txt(m.niv2 || p.codigo, 60), gerencia: txt(m.gerencia || p.gerencia, 150), seccion: txt(m.seccion || p.seccion, 150),
    macroproceso: txt(m.macroproceso || p.macroproceso, 200), proceso: txt(m.proceso || p.proceso, 200), subproceso: txt(m.subproceso || p.subproceso, 200)
  };
  const t = ahora();
  await env.DB.prepare(`UPDATE procesos SET matriz=?, matriz_ia=?, validacion=?, validado_por=?, validado_en=?, actualizado_en=?,
      codigo=?, gerencia=?, seccion=?, macroproceso=?, proceso=?, subproceso=? WHERE id=?`)
    .bind(JSON.stringify(m), JSON.stringify(ia), validacion, validadoPor, validadoEn, t, f.codigo, f.gerencia, f.seccion, f.macroproceso, f.proceso, f.subproceso, p.id).run();
  log('matriz', { campana: p.campana_id, proceso: p.id, validacion, campos: edita ? Object.keys(b.matriz).length : 0 });
  return { ok: true, proceso: Object.assign({}, p, f, { matriz: m, matriz_ia: ia, validacion, validado_por: validadoPor, validado_en: validadoEn, actualizado_en: t }) };
}

// Validación en bloque (p. ej. la gerencia da conformidad a todo su inventario en la reunión de cierre).
async function rutaValidacion(env, b) {
  const ids = Array.isArray(b.proceso_ids) ? b.proceso_ids.map(x => txt(x, 60)).filter(Boolean).slice(0, 1000) : [];
  if (!ids.length) throw new HttpError(400, 'No se indicaron procesos');
  if (!VALIDACIONES.includes(b.validacion)) throw new HttpError(400, 'Estado de validación inválido');
  const t = ahora(), v = b.validacion, por = v === 'validado' ? txt(b.validado_por, 150) : '';
  const st = ids.map(id => env.DB.prepare('UPDATE procesos SET validacion=?, validado_por=?, validado_en=?, actualizado_en=? WHERE id=? AND campana_id=?')
    .bind(v, por, v === 'validado' ? t : null, t, id, b.campana_id));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  log('validacion', { campana: b.campana_id, validacion: v, procesos: ids.length });
  return { ok: true, procesos: ids.length, validado_en: v === 'validado' ? t : null, validado_por: por };
}

// Borrar contactos (encuestados) de una campaña: uno o varios (hasta 30 por llamada, por el límite de
// parámetros de D1). Quien ya respondió solo se borra con forzar=true y sus respuestas se borran con él.
// Los procesos que agregó se borran si nadie más los usa; si otra persona los usa, se conservan sin autor.
const MAX_BORRAR = 30;
async function rutaEncuestadoBorrar(env, b) {
  const ids = [...new Set((Array.isArray(b.encuestado_ids) ? b.encuestado_ids : [b.encuestado_id]).map(x => txt(x, 60)).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'No se indicaron personas');
  if (ids.length > MAX_BORRAR) throw new HttpError(413, 'Borra como máximo ' + MAX_BORRAR + ' personas por vez');
  const ph = ids.map(() => '?').join(',');
  const enc = (await env.DB.prepare(`SELECT id, campana_id FROM encuestados WHERE id IN (${ph})`).bind(...ids).all()).results;
  if (!enc.length) throw new HttpError(404, 'Persona no encontrada');
  const conResp = (await env.DB.prepare(`SELECT COUNT(DISTINCT encuestado_id) AS n FROM respuestas
      WHERE encuestado_id IN (${ph}) AND (trim(texto)<>'' OR sistemas<>'[]')`).bind(...ids).first()).n;
  if (conResp && !b.forzar) {
    throw new HttpError(409, conResp === 1 ? 'Esta persona ya respondió: confirma que también quieres borrar sus respuestas.'
      : conResp + ' de estas personas ya respondieron: confirma que también quieres borrar sus respuestas.');
  }
  const st = [];
  const propios = (await env.DB.prepare(`SELECT id FROM procesos WHERE creado_por IN (${ph})`).bind(...ids).all()).results;
  for (const p of propios) {
    const otros = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM asignaciones WHERE proceso_id=? AND encuestado_id NOT IN (${ph})) +
        (SELECT COUNT(*) FROM revisiones WHERE proceso_id=? AND encuestado_id NOT IN (${ph})) +
        (SELECT COUNT(*) FROM respuestas WHERE proceso_id=? AND encuestado_id NOT IN (${ph})) AS n`)
      .bind(p.id, ...ids, p.id, ...ids, p.id, ...ids).first();
    if (otros.n) {
      st.push(env.DB.prepare('UPDATE procesos SET creado_por=NULL WHERE id=?').bind(p.id));
    } else {
      st.push(env.DB.prepare('DELETE FROM estructurado WHERE proceso_id=?').bind(p.id));
      st.push(env.DB.prepare('DELETE FROM procesos WHERE id=?').bind(p.id));
    }
  }
  st.push(env.DB.prepare(`DELETE FROM asignaciones WHERE encuestado_id IN (${ph})`).bind(...ids));
  st.push(env.DB.prepare(`DELETE FROM revisiones WHERE encuestado_id IN (${ph})`).bind(...ids));
  st.push(env.DB.prepare(`DELETE FROM respuestas WHERE encuestado_id IN (${ph})`).bind(...ids));
  st.push(env.DB.prepare(`DELETE FROM encuestados WHERE id IN (${ph})`).bind(...ids));
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  log('encuestados_borrados', { campana: enc[0].campana_id, personas: enc.length, con_respuestas: conResp, forzado: !!b.forzar });
  return { ok: true, borrados: enc.length, con_respuestas: conResp };
}

// Borrar las respuestas de una persona en uno o varios procesos, sin borrar a la persona ni sus otras respuestas.
// Se borran sus bloques y su marca de relación con el proceso: el proceso sigue en su lista (vuelve a «por marcar»)
// y puede volver a responderlo con su mismo enlace. El análisis de la IA de esos procesos se borra porque incluía
// lo que esta persona dijo; se regenera desde la consola con lo que queda.
async function rutaRespuestaBorrar(env, b) {
  const e = await env.DB.prepare('SELECT id, campana_id, estado FROM encuestados WHERE id=?').bind(txt(b.encuestado_id, 60)).first();
  if (!e) throw new HttpError(404, 'Persona no encontrada');
  const ids = [...new Set((Array.isArray(b.proceso_ids) ? b.proceso_ids : [b.proceso_id]).map(x => txt(x, 60)).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'No se indicaron procesos');
  if (ids.length > MAX_BORRAR) throw new HttpError(413, 'Borra como máximo ' + MAX_BORRAR + ' procesos por vez');
  const ph = ids.map(() => '?').join(',');
  const procs = (await env.DB.prepare(`SELECT id FROM procesos WHERE campana_id=? AND id IN (${ph})`).bind(e.campana_id, ...ids).all()).results.map(p => p.id);
  if (!procs.length) throw new HttpError(404, 'Proceso no encontrado');
  const pp = procs.map(() => '?').join(',');
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM respuestas WHERE encuestado_id=? AND proceso_id IN (${pp})`).bind(e.id, ...procs),
    env.DB.prepare(`DELETE FROM revisiones WHERE encuestado_id=? AND proceso_id IN (${pp})`).bind(e.id, ...procs),
    env.DB.prepare(`DELETE FROM estructurado WHERE proceso_id IN (${pp})`).bind(...procs)
  ]);
  // Si ya no le queda nada respondido, vuelve a «sin empezar»; si le queda algo y había terminado, pasa a «en curso».
  const queda = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM respuestas WHERE encuestado_id=?) + (SELECT COUNT(*) FROM revisiones WHERE encuestado_id=?) AS n`).bind(e.id, e.id).first();
  const estado = queda.n ? (e.estado === 'enviado' ? 'en_curso' : e.estado) : 'pendiente';
  if (estado !== e.estado) await env.DB.prepare('UPDATE encuestados SET estado=? WHERE id=?').bind(estado, e.id).run();
  const bloques = (res[0].meta && res[0].meta.changes) || 0, analisis = (res[2].meta && res[2].meta.changes) || 0;
  log('respuestas_borradas', { campana: e.campana_id, procesos: procs.length, bloques, analisis_ia: analisis });
  return { ok: true, procesos: procs.length, bloques, analisis_ia: analisis, estado };
}

async function rutaBorrarCampana(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  if (b.confirmar !== camp.nombre) throw new HttpError(400, 'Para borrar, escribe el nombre exacto de la campaña');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM respuestas WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id),
    env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id),
    env.DB.prepare('DELETE FROM asignaciones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id),
    env.DB.prepare('DELETE FROM estructurado WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM procesos WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM sistemas WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM encuestados WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM campanas WHERE id=?').bind(camp.id)
  ]);
  log('campana_borrada', { campana: camp.id });
  return { ok: true };
}

// ---------------------------------------------------------------- estructuración con Claude
// Campos de la matriz que la IA llena a partir de las respuestas (los de identificación vienen del catálogo).
// Son los que definió TDP (2026-10-06), con las mismas claves que la matriz de la consola, más las aprobaciones externas.
const CAMPOS = [
  ['objetivo', 'Objetivo del subproceso'],
  ['alcance', 'Actividades principales (alcance): qué lo inicia, los pasos principales en secuencia (3 a 8, numerados) y dónde termina'],
  ['frecuencia', 'Frecuencia de ejecución (y volumen aproximado si lo dijeron)'],
  ['documentacion', 'Documentación del subproceso: procedimientos, instructivos, flujos o formatos que lo describen'],
  ['tecnologia', 'ERP, aplicativos y plataformas digitales, con su nombre exacto (incluye portales y Excel)'],
  ['interaccion', 'Interacción: "Digital", "Presencial" o "Digital y presencial"'],
  ['uso_tecnologia', 'Finalidad de interacción: para qué se usa cada sistema o se interactúa con cada tercero (formato "Sistema o tercero: finalidad")'],
  ['terceros', 'Terceros involucrados (proveedores, concesionarios, clientes, funcionarios públicos, otros)'],
  ['finalidad_terceros', 'Finalidad del tratamiento con tercero: para qué se relaciona el proceso con cada tercero o qué información le comparte'],
  ['datos_personales', 'Si trata datos personales: "Sí" o "No"'],
  ['detalle_dp', 'Tipo/detalle de datos personales: de quiénes (clientes, trabajadores, proveedores u otros) y qué datos (identificación, contacto, financieros, sensibles u otros)'],
  ['finalidad_dp', 'Finalidad del tratamiento de datos personales: para qué se usan'],
  ['normativa', 'Normativa legal peruana que regula el proceso, solo si el área la mencionó'],
  ['estandar_tdp', 'Estándar corporativo TDP: política, procedimiento o estándar interno de la empresa que aplica (cuál)'],
  ['estandar_tmc', 'Estándar global TMC: estándar o lineamiento global de Toyota Motor Corporation que aplica (cuál)'],
  ['otros_estandares', 'Otros estándares nacionales o internacionales (NTP, ISO u otros)'],
  ['kpis', 'Indicadores o KPIs existentes'],
  ['aprob_externa', 'Si para completar el proceso dependen de aprobaciones externas a la sección dueña: "Sí" o "No"'],
  ['aprob_area', 'De dónde: gerencia, sección o entidad que aprueba (una línea por aprobación)'],
  ['aprob_responsable', 'De quién: cargo de quien aprueba (una línea por aprobación, en el mismo orden)'],
  ['aprob_momento', 'Cuándo: en qué paso o momento del proceso se espera esa aprobación (una línea por aprobación, en el mismo orden)']
];

// Los campos van como LISTA de ítems con un solo esquema: un objeto con 20 o más propiedades
// anidadas supera el tamaño de gramática que admite la API ("compiled grammar is too large").
// normalizarSalida() la convierte después en {campo: {valor, estado, evidencia}}.
const SALIDA_SCHEMA = {
  type: 'object',
  properties: {
    campos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          campo: { type: 'string', enum: CAMPOS.map(([k]) => k) },
          valor: { type: 'string' },
          estado: { type: 'string', enum: ['dicho', 'inferido', 'vacio'] },
          evidencia: { type: 'string' }
        },
        required: ['campo', 'valor', 'estado', 'evidencia'],
        additionalProperties: false
      }
    },
    vigencia: { type: 'string', enum: ['vigente', 'cambio', 'no_existe', 'contradictorio', 'sin_revision'] },
    contradicciones: { type: 'array', items: { type: 'string' } },
    preguntas_validacion: { type: 'array', items: { type: 'string' } },
    resumen: { type: 'string' }
  },
  required: ['campos', 'vigencia', 'contradicciones', 'preguntas_validacion', 'resumen'],
  additionalProperties: false
};

// Glosario de estándares base; cada campaña lo puede editar en la consola (campanas.estandares). Vacío = este.
const ESTANDARES_BASE = 'TPS (Toyota Production System); Toyota Way; Jidoka; JIT (Just in Time); Kaizen; TMC Global Standards; ISO 9001; ISO 14001; ISO 27001; ISO 45001; NTP; Ley 29733 (protección de datos personales)';
const estandaresDe = camp => String((camp && camp.estandares) || '').trim() || ESTANDARES_BASE;
// Reglas para clasificar los estándares que menciona la persona: las usan la revisión del bloque 3, la estructuración y la prueba.
const REGLAS_ESTANDARES = `Clasificación de estándares:
- TDP (corporativo): políticas, procedimientos, instructivos, manuales o códigos internos de la empresa del cliente, incluidos los códigos con prefijo MO-, SO-, GO- o GE- (por ejemplo «el procedimiento SO-GCM-P-010»), el código de ética y el reglamento interno.
- TMC (global): lo que viene de Toyota Motor Corporation: Toyota Way, TPS (Toyota Production System), Jidoka, JIT (Just in Time), Kaizen, TMC Global Standards y las políticas o lineamientos globales de la casa matriz.
- Otros: normas técnicas y de certificación externas: NTP, ISO (9001, 14001, 27001, 45001…), OHSAS, COSO, PCI y similares. Las leyes y reglamentos peruanos no van aquí: van en normativa.
- Si el nombre dicho coincide con un término del GLOSARIO DE ESTÁNDARES de la campaña, escríbelo como figura en el glosario; corrige los errores de transcripción («toyota uay» es Toyota Way, «iso nueve mil uno» es ISO 9001, «te pe es» es TPS). Si no está en el glosario, escríbelo como lo dijo, con su código o número si lo dio.
- Solo cuenta lo que la persona nombra o cita con claridad: «seguimos estándares de calidad» sin decir cuáles no sirve. Exige la cita: en la evidencia pon sus palabras.
- Cada estándar va en una sola categoría; varios en la misma categoría se separan con «; ».`;

const SISTEMA_PROMPT = `Eres un consultor senior de procesos que arma el inventario corporativo de procesos de un cliente.
Recibes la ficha de un proceso (tal como estaba en el inventario anterior, o como la agregó un colaborador o el equipo consultor) y las respuestas que dieron por voz o por escrito una o más personas que participan en él: el líder o un usuario de soporte de la sección dueña, o personas de otras áreas que intervienen. Las respuestas son transcripciones: pueden tener muletillas, errores de reconocimiento de voz y desorden.

Tu trabajo es llenar una fila del inventario. Para cada campo:
- estado "dicho": el dato aparece explícito en las respuestas. En "evidencia" pon una cita breve (máx. 20 palabras) de la respuesta que lo sustenta.
- estado "inferido": no se dijo, pero se deduce con razonable seguridad del contexto o del catálogo de sistemas. En "evidencia" explica en una frase de dónde lo deduces. Estos campos se validarán en la reunión.
- estado "vacio": no hay información suficiente. "valor" y "evidencia" quedan como cadena vacía. No inventes.

Reglas:
- Escribe en español neutro, conciso y profesional, listo para un entregable al cliente.
- Nunca incluyas nombres de personas ni datos personales concretos (DNI, teléfonos, nombres de clientes): usa cargos y categorías.
- Para sistemas, usa el nombre exacto del catálogo cuando coincida; si mencionan una herramienta que no está en el catálogo, inclúyela igual y dilo en la evidencia.
- "uso_tecnologia" (finalidad de interacción) responde a una observación de auditoría del cliente: el inventario anterior no decía para qué se usaba cada sistema. Sé específico por sistema o tercero; si no lo dijeron, déjalo vacío.
- Aprobaciones externas: si para completar el proceso esperan la aprobación de alguien fuera de la sección dueña (otra área de la empresa, la casa matriz o una entidad), "aprob_externa" es "Sí" y cada aprobación va en una línea, en el mismo orden, en "aprob_area" (de dónde), "aprob_responsable" (de quién, por cargo) y "aprob_momento" (en qué paso). Si dijeron que no dependen de nadie, "aprob_externa" es "No" y los otros tres quedan vacíos.
- Si la persona dijo que algo no existe en su proceso (no hay terceros, no manejan datos personales, no hay indicadores), escribe "No aplica" con estado "dicho".
- Si hay una ficha del inventario anterior, compárala con lo que contaron: lo que cambió va en "contradicciones".
- Estándares ("estandar_tdp", "estandar_tmc", "otros_estandares") y "normativa": ${REGLAS_ESTANDARES}
- "vigencia": resume lo que dijeron sobre si el proceso sigue vigente. Quien marcó "existe, pero no participa" confirma que existe. Usa "contradictorio" si difieren y "sin_revision" si nadie lo marcó.
- "contradicciones": diferencias entre lo que dijeron las distintas personas, o entre la ficha anterior y lo que contaron ahora.
- "preguntas_validacion": 3 a 6 preguntas concretas para cerrar en la reunión los campos inferidos, vacíos o contradictorios. Nada genérico.
- "resumen": 2 o 3 frases que describan el proceso tal como opera hoy.`;

const VIGENCIA_TEXTO = {
  vigente: 'participa y el proceso sigue igual', cambio: 'participa, pero el proceso cambió',
  no_participo: 'el proceso existe, pero no participa', no_existe: 'el proceso ya no se hace'
};
const ORIGEN_TEXTO = { nuevo: 'agregado por un colaborador en la encuesta', consultor: 'agregado por el equipo consultor' };

function textoParaClaude(camp, p, encuestados, revisiones, respuestas, sistemas) {
  const PREG = { q1: 'Objetivo, inicio y fin', q2: 'Actividades y participantes', q3: 'Sistemas y manualidad',
    q4: 'Terceros', q5: 'Datos personales', q6: 'Indicadores, normas y frecuencia',
    b1: 'Bloque 1 · Objetivo, alcance, frecuencia y aprobaciones externas', b2: 'Bloque 2 · Sistemas, interacción y terceros',
    b3: 'Bloque 3 · Datos personales, normas, estándares, documentación e indicadores' };
  const lineas = [];
  lineas.push(`CLIENTE: ${camp.cliente}`);
  lineas.push(`PROCESO (ficha de partida):`);
  lineas.push(`- Código: ${p.codigo || '(sin código)'}`);
  lineas.push(`- Gerencia / sección dueña: ${p.gerencia} / ${p.seccion}`);
  lineas.push(`- Macroproceso: ${p.macroproceso || '-'} | Proceso: ${p.proceso || '-'} | Subproceso: ${p.subproceso || '-'}`);
  lineas.push(`- Origen: ${ORIGEN_TEXTO[p.fuente] || 'inventario anterior'}`);
  const m = leerMatriz(p.matriz);
  const previos = [['Objetivo', m.objetivo], ['Alcance', m.alcance], ['Tecnología', m.tecnologia], ['Terceros', m.terceros],
    ['Datos personales', [m.datos_personales, m.detalle_dp].filter(Boolean).join(': ')], ['Normativa', m.normativa],
    ['Documentación', m.documentacion], ['Estándar corporativo TDP', m.estandar_tdp]].filter(x => x[1]);
  if (previos.length) {
    lineas.push('- Ficha del inventario anterior:');
    previos.forEach(([k, v]) => lineas.push(`  · ${k}: ${String(v).replace(/\s+/g, ' ')}`));
  } else if (p.descripcion) {
    lineas.push(`- Descripción previa: ${p.descripcion}`);
  }
  lineas.push('');
  lineas.push(`CATÁLOGO DE SISTEMAS DEL CLIENTE: ${sistemas.map(s => s.nombre + (s.tipo ? ' (' + s.tipo + ')' : '')).join('; ') || '(no cargado)'}`);
  lineas.push(`GLOSARIO DE ESTÁNDARES DE LA CAMPAÑA: ${estandaresDe(camp)}`);
  lineas.push('');
  encuestados.forEach(e => {
    const rev = revisiones.find(r => r.encuestado_id === e.id);
    const resp = respuestas.filter(r => r.encuestado_id === e.id);
    if (!rev && !resp.length) return;
    const area = e.gerencia + ' / ' + e.seccion + (e.gerencia === p.gerencia && e.seccion === p.seccion ? ' (sección dueña)' : ' (otra área)');
    lineas.push(`=== COLABORADOR (cargo o rol: ${e.rol || 'no indicado'} · área: ${area}) ===`);
    if (rev) lineas.push(`Vigencia marcada: ${VIGENCIA_TEXTO[rev.estado] || rev.estado}${rev.comentario ? ' — comentario: ' + rev.comentario : ''}`);
    resp.sort((a, b) => a.pregunta.localeCompare(b.pregunta)).forEach(r => {
      const sis = JSON.parse(r.sistemas || '[]');
      const ck = leerMatriz(r.checklist);
      const nap = Object.keys(PUNTO_TXT).filter(k => ck[k] && ck[k].estado === 'no_aplica').map(k => PUNTO_TXT[k]);
      lineas.push(`[${PREG[r.pregunta] || r.pregunta}] ${r.texto || '(sin texto)'}${sis.length ? ' | Sistemas marcados: ' + sis.join(', ') : ''}` +
        (nap.length ? ' | Indicó que no aplica: ' + nap.join('; ') : ''));
    });
    lineas.push('');
  });
  lineas.push('Campos a llenar (devuelve un ítem por cada uno, en este orden, sin omitir ninguno):');
  CAMPOS.forEach(([k, d]) => lineas.push(`- ${k}: ${d}`));
  return lineas.join('\n');
}

// Lista de campos -> {campo: {valor, estado, evidencia}}; un campo omitido queda como vacío.
function normalizarSalida(s) {
  const campos = {};
  (s.campos || []).forEach(c => { if (c && c.campo) campos[c.campo] = { valor: c.valor || '', estado: c.estado || 'vacio', evidencia: c.evidencia || '' }; });
  CAMPOS.forEach(([k]) => { if (!campos[k]) campos[k] = { valor: '', estado: 'vacio', evidencia: '' }; });
  return Object.assign({}, s, { campos });
}

// Cada llamada a la IA: gasto a Pulse y una línea en Workers Logs con tokens y tiempo (para comparar modelos).
function registrarIA(ctx, tarea, msg, cfg, t0) {
  const u = msg.usage || {};
  const uso = { tarea, modelo: msg.model || cfg.modelo, esfuerzo: cfg.esfuerzo, entrada: u.input_tokens || 0, salida: u.output_tokens || 0, ms: Date.now() - t0 };
  log('ia', uso);
  ctx.waitUntil(registrarGasto(u, uso.modelo));
  return uso;
}

async function registrarGasto(uso, modelo) {
  if (!uso) return;
  try {
    await fetch(PULSE_INGEST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'voz-relevamiento', provider: 'anthropic', model: modelo,
        inputTokens: uso.input_tokens || 0, outputTokens: uso.output_tokens || 0 })
    });
  } catch (e) { /* el registro de gasto nunca debe afectar al usuario */ }
}

// Cliente de Anthropic. Con ANTHROPIC_API_KEY propia llama directo; si no, pasa por el
// intermediario de ProcessIQ (service binding PROCESSIQ), que guarda la clave central:
// así este Worker nunca necesita conocerla.
function clienteClaude(env) {
  const clave = (env.ANTHROPIC_API_KEY || '').trim();
  if (clave) return new Anthropic({ apiKey: clave });
  const interno = (env.INTERNAL_CODE || '').trim();
  if (!env.PROCESSIQ || !interno) throw new HttpError(500, 'La IA no está configurada en el Worker');
  return new Anthropic({
    apiKey: 'via-processiq',   // el intermediario pone la clave real
    baseURL: 'https://processiq-api',
    defaultHeaders: { 'x-internal-code': interno },
    fetch: (url, init) => env.PROCESSIQ.fetch(new Request(url, init))
  });
}

async function rutaEstructurar(env, b, ctx) { return estructurarProceso(env, b.proceso_id, ctx, 'consola'); }

// La IA lee todo lo que contaron del proceso (voz transcrita, texto y lo que leyó de las imágenes), arma el análisis
// y completa la matriz. La usa la consola ("Estructurar con IA") y la tarea programada.
async function estructurarProceso(env, procesoId, ctx, origen) {
  const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=?').bind(procesoId).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(p.campana_id).first();
  const [enc, revs, resps, sis] = await Promise.all([
    // Todas las personas que revisaron o respondieron este proceso, sean o no de la sección dueña.
    env.DB.prepare(`SELECT id, rol, gerencia, seccion FROM encuestados WHERE id IN
      (SELECT encuestado_id FROM revisiones WHERE proceso_id=? UNION SELECT encuestado_id FROM respuestas WHERE proceso_id=?)`).bind(p.id, p.id).all(),
    env.DB.prepare('SELECT * FROM revisiones WHERE proceso_id=?').bind(p.id).all(),
    env.DB.prepare('SELECT * FROM respuestas WHERE proceso_id=?').bind(p.id).all(),
    env.DB.prepare('SELECT nombre, tipo FROM sistemas WHERE campana_id=?').bind(p.campana_id).all()
  ]);
  if (!resps.results.some(r => (r.texto || '').trim())) throw new HttpError(409, 'Este proceso todavía no tiene respuestas');

  const client = clienteClaude(env), cfg = iaDe(env, 'estructurar'), t0 = Date.now();
  let msg;
  try {
    msg = await client.beta.messages.stream({
      model: cfg.modelo,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: cfg.esfuerzo, format: { type: 'json_schema', schema: SALIDA_SCHEMA } },
      system: SISTEMA_PROMPT,
      messages: [{ role: 'user', content: textoParaClaude(camp, p, enc.results, revs.results, resps.results, sis.results) }]
    }).finalMessage();
  } catch (err) {
    console.error('claude', err && err.message);
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Límite de uso de la IA alcanzado: espera un minuto y reintenta');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, 'La IA devolvió un error (' + (err.status || 'sin código') + '): ' + err.message);
    throw new HttpError(502, 'No se pudo contactar a la IA');
  }
  const uso = registrarIA(ctx, 'estructurar', msg, cfg, t0);
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'La IA no pudo procesar este proceso. Revisa las respuestas manualmente.');
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, 'La respuesta de la IA quedó incompleta. Reintenta.');
  const bloque = msg.content.find(c => c.type === 'text');
  let datos;
  try { datos = normalizarSalida(JSON.parse(bloque ? bloque.text : '')); } catch (e) { throw new HttpError(502, 'La IA devolvió un formato inesperado. Reintenta.'); }
  const generado = ahora();
  await env.DB.prepare(`INSERT INTO estructurado (proceso_id, campana_id, datos, modelo, generado) VALUES (?,?,?,?,?)
    ON CONFLICT(proceso_id) DO UPDATE SET datos=excluded.datos, modelo=excluded.modelo, generado=excluded.generado`)
    .bind(p.id, p.campana_id, JSON.stringify(datos), msg.model || cfg.modelo, generado).run();
  const c = await completarMatriz(env, p, datos);
  log('estructurado', { campana: p.campana_id, proceso: p.id, origen, completados: c.n });
  return { ok: true, proceso_id: p.id, datos, modelo: msg.model || cfg.modelo, generado, completados: c.n, uso,
    proceso: { id: p.id, matriz: c.matriz, matriz_ia: c.matriz_ia } };
}

// ---------------------------------------------------------------- la IA completa la matriz
// Con lo que estructuró la IA se completa la fila: se llenan los campos vacíos y se actualizan los que la IA misma
// llenó antes (procesos.matriz_ia los registra). Solo se escribe lo que la persona DIJO (estado "dicho"): lo que la IA
// deduce queda como sugerencia en la ficha. Nunca se pisa un dato del inventario anterior ni uno que escribió el
// equipo, y una fila validada no se toca.
const APROB_CAMPOS = ['aprob_area', 'aprob_responsable', 'aprob_momento'];
async function completarMatriz(env, p, datos) {
  const m = leerMatriz(p.matriz), ia = leerMatriz(p.matriz_ia);
  if (p.validacion === 'validado') return { n: 0, matriz: m, matriz_ia: ia };
  const c = (datos && datos.campos) || {}, t = ahora();
  const libre = k => !String(m[k] || '').trim() || !!ia[k];   // vacío, o lo llenó la IA y nadie lo editó
  const valor = k => { const x = c[k]; return x && x.estado !== 'vacio' ? String(x.valor || '').trim().slice(0, 4000) : ''; };
  const dicho = k => c[k] && c[k].estado === 'dicho' && !!valor(k);
  let n = 0;
  const poner = (k, v, estado) => { if (m[k] === v) return; m[k] = v; ia[k] = { estado, en: t }; n++; };
  CAMPOS.forEach(([k]) => {
    if (APROB_CAMPOS.includes(k) || !MATRIZ_CLAVES.includes(k)) return;
    if (dicho(k) && libre(k)) poner(k, valor(k), 'dicho');
  });
  // Aprobaciones: las tres columnas van juntas, una línea por aprobación y en el mismo orden («—» si falta un dato).
  // Se escriben cuando la persona dijo de dónde depende; cada columna guarda si fue dicha o deducida.
  if (dicho('aprob_area') && APROB_CAMPOS.every(libre)) {
    const cols = APROB_CAMPOS.map(k => valor(k).split('\n').map(x => x.trim()));
    const filas = Math.max(...cols.map(x => (x.some(Boolean) ? x.length : 0)));
    if (filas) APROB_CAMPOS.forEach((k, i) => poner(k, Array.from({ length: filas }, (_, j) => cols[i][j] || '—').join('\n'),
      valor(k) ? c[k].estado : 'inferido'));
  }
  if (n) await env.DB.prepare('UPDATE procesos SET matriz=?, matriz_ia=?, actualizado_en=? WHERE id=?')
    .bind(JSON.stringify(m), JSON.stringify(ia), t, p.id).run();
  return { n, matriz: m, matriz_ia: ia };
}

// Tarea programada (cada 15 minutos): la IA estructura los procesos con respuestas nuevas y completa la matriz.
// Espera 10 minutos sin cambios (la persona puede seguir respondiendo) y hace como máximo 6 por pasada (~1 min cada
// uno, dentro de los 15 minutos que Cloudflare da a una tarea programada). Un proceso que falla no se reintenta hasta
// que llegue una respuesta nueva. Solo en campañas con ia_auto = 1 y nunca en filas validadas.
const AUTO_ESPERA_MIN = 10, AUTO_MAX = 6;
async function completarPendientes(env, ctx) {
  const hasta = new Date(Date.now() - AUTO_ESPERA_MIN * 60000).toISOString();
  const pend = (await env.DB.prepare(`SELECT p.id, MAX(r.actualizado) AS ultima, MAX(e.generado) AS generado,
        json_extract(p.matriz_ia, '$._fallo') AS fallo
      FROM procesos p
      JOIN campanas c ON c.id = p.campana_id AND c.ia_auto = 1
      JOIN respuestas r ON r.proceso_id = p.id AND trim(r.texto) <> ''
      LEFT JOIN estructurado e ON e.proceso_id = p.id
      WHERE p.validacion <> 'validado'
      GROUP BY p.id
      HAVING ultima <= ? AND (generado IS NULL OR ultima > generado) AND (fallo IS NULL OR ultima > fallo)
      ORDER BY ultima LIMIT ?`).bind(hasta, AUTO_MAX).all()).results;
  let ok = 0;
  for (const x of pend) {
    try { await estructurarProceso(env, x.id, ctx, 'automatico'); ok++; }
    catch (err) {
      log('auto_error', { proceso: x.id, error: String((err && err.message) || err).slice(0, 200) });
      await env.DB.prepare(`UPDATE procesos SET matriz_ia=json_set(matriz_ia, '$._fallo', ?) WHERE id=?`).bind(ahora(), x.id).run();
    }
  }
  if (pend.length) log('auto', { pendientes: pend.length, estructurados: ok });
}

async function rutaEstandares(env, b) {
  const r = await env.DB.prepare('UPDATE campanas SET estandares=? WHERE id=?').bind(txt(b.estandares, 1500), b.campana_id).run();
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'Campaña no encontrada');
  return { ok: true };
}

// Prueba de la clasificación de estándares: recibe una frase y devuelve lo que la IA pondría en cada categoría. Usa las mismas
// reglas y el mismo glosario que la revisión y la estructuración; la corre worker/test/estandares.mjs --real.
const ESTANDARES_SCHEMA = {
  type: 'object',
  properties: { tdp: { type: 'array', items: { type: 'string' } }, tmc: { type: 'array', items: { type: 'string' } },
    otros: { type: 'array', items: { type: 'string' } }, normativa: { type: 'array', items: { type: 'string' } } },
  required: ['tdp', 'tmc', 'otros', 'normativa'],
  additionalProperties: false
};
async function rutaEstandaresProbar(env, b, ctx) {
  const camp = await env.DB.prepare('SELECT estandares FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const frase = txt(b.frase, 1500);
  if (!frase) throw new HttpError(400, 'Falta la frase');
  const cfg = iaDe(env, 'revision'), t0 = Date.now();
  const msg = await clienteClaude(env).beta.messages.stream({
    model: cfg.modelo,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: cfg.esfuerzo, format: { type: 'json_schema', schema: ESTANDARES_SCHEMA } },
    system: `Lees lo que una persona contó sobre cómo funciona un proceso de trabajo (transcripción de voz) y extraes los estándares y normas que nombra.
${REGLAS_ESTANDARES}
Devuelve cuatro listas: "tdp", "tmc", "otros" y "normativa" (leyes y reglamentos peruanos que nombra). Lista vacía si no nombra ninguno de esa categoría.`,
    messages: [{ role: 'user', content: 'GLOSARIO DE ESTÁNDARES DE LA CAMPAÑA: ' + estandaresDe(camp) + '\n\nRESPUESTA:\n' + frase }]
  }).finalMessage();
  registrarIA(ctx, 'revision', msg, cfg, t0);
  let s = {};
  try { s = JSON.parse((msg.content.find(c => c.type === 'text') || {}).text || '{}'); } catch (x) { throw new HttpError(502, 'Formato inesperado de la IA'); }
  return { ok: true, tdp: s.tdp || [], tmc: s.tmc || [], otros: s.otros || [], normativa: s.normativa || [] };
}

async function rutaCampanaIA(env, b) {
  const v = b.ia_auto ? 1 : 0;
  const r = await env.DB.prepare('UPDATE campanas SET ia_auto=? WHERE id=?').bind(v, b.campana_id).run();
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'Campaña no encontrada');
  log('ia_auto', { campana: b.campana_id, ia_auto: v });
  return { ok: true, ia_auto: v };
}

// ---------------------------------------------------------------- checklist por bloque, logo y asignaciones
const PUNTO_TXT = {};
BLOQUES.forEach(b => b.puntos.forEach(([k, t]) => { PUNTO_TXT[k] = t; }));
const ESTADOS_PUNTO = ['cubierto', 'falta', 'no_aplica'];
// Huella del texto revisado: si no cambió, no se vuelve a llamar a la IA.
const huella = async s => aBase64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).slice(0, 24);

function schemaVerificar(bloque) {
  return {
    type: 'object',
    properties: {
      puntos: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', enum: bloque.puntos.map(x => x[0]) },
        estado: { type: 'string', enum: ESTADOS_PUNTO },
        evidencia: { type: 'string' }
      }, required: ['id', 'estado', 'evidencia'], additionalProperties: false } },
      sugerencia: { type: 'string' },
      sistemas: { type: 'array', items: { type: 'string' } }
    },
    required: ['puntos', 'sugerencia', 'sistemas'],
    additionalProperties: false
  };
}

const VERIFICAR_PROMPT = `Revisas la respuesta de un colaborador a un bloque de una encuesta de relevamiento de procesos. La respuesta suele ser una transcripción de voz: puede tener muletillas y errores de reconocimiento.
Para cada punto del checklist decide:
- "cubierto": la respuesta da información concreta sobre ese punto, aunque sea breve. En "evidencia" cita hasta 12 palabras de la respuesta.
- "no_aplica": la persona dijo claramente que eso no existe en su proceso ("no trabajamos con terceros", "no tenemos indicadores", "no manejamos datos de personas"). Cuenta como respondido. Los puntos que dependen de él también son "no_aplica" (si no manejan datos de personas, tampoco hay finalidad de su tratamiento; si no se relacionan con terceros, tampoco hay finalidad con terceros). Si dijeron que no dependen de la aprobación de nadie fuera de su área, las aprobaciones son "no_aplica". En "evidencia" cita la frase.
- "falta": no lo mencionó, o lo dijo tan vago que no sirve para un inventario de procesos ("usamos varios sistemas" sin nombrarlos). "evidencia" queda vacía.
Los sistemas marcados en la lista cuentan para el punto de qué sistemas usan, pero no para qué se usa cada uno.
"sugerencia": una sola frase amable, en segunda persona (tú), que pida solo lo que falta, con un ejemplo corto si ayuda. Si no falta nada, cadena vacía.
"sistemas": los sistemas, aplicaciones o herramientas informáticas que la respuesta dice que se usan en el proceso (un ERP, un Excel, un aplicativo del área, el correo, un portal). Solo los que se nombran o se identifican con claridad en la respuesta: no incluyas equipos físicos, no deduzcas por el tipo de proceso y no repitas. Si el nombre dicho coincide con uno del CATÁLOGO de la campaña, escribe el nombre EXACTO del catálogo (corrige los errores de transcripción: «es a pe» es SAP); si no está en el catálogo, escríbelo corto, tal como lo dijo. Si no menciona ninguno, lista vacía.
Estándares: el punto de estándares es "cubierto" cuando la persona nombra al menos un estándar, política, procedimiento o norma concreta (de TDP, de TMC u otros), o dice claramente que no aplica ninguno; es "falta" si solo habla de estándares o normas en general sin nombrar ninguno.
${REGLAS_ESTANDARES}
No inventes información ni opines sobre el proceso.`;

// Une los sistemas que la IA detectó en el texto con los que la persona marcó. Los que la persona desmarcó después de una
// detección (_sistemas_rechazados) no se vuelven a marcar. Los que no están en el catálogo se agregan a la campaña como «detectado».
const nombreBase = s => normal(String(s).replace(/\s*\([^)]*\)/g, ''));
async function unirSistemas(env, e, p, bloque, previo, actuales, crudos, catalogo) {
  const rechazados = new Set((Array.isArray(previo._sistemas_rechazados) ? previo._sistemas_rechazados : []).map(normal));
  const enCatalogo = d => catalogo.find(n => normal(n) === normal(d)) || catalogo.find(n => nombreBase(n) === nombreBase(d)) || '';
  const detectados = [], nuevos = [], vistos = new Set();
  (Array.isArray(crudos) ? crudos : []).slice(0, 15).forEach(c => {
    const d = txt(c, 120); if (!d) return;
    const cat = enCatalogo(d), nombre = cat || d, k = normal(nombre);
    if (!k || vistos.has(k)) return;
    vistos.add(k);
    detectados.push(nombre);
    if (!cat && !rechazados.has(k)) nuevos.push(nombre);
  });
  const final = actuales.slice();
  detectados.forEach(n => { if (!rechazados.has(normal(n)) && !final.some(x => normal(x) === normal(n))) final.push(n); });
  if (nuevos.length) await env.DB.batch(nuevos.map(n => env.DB.prepare("INSERT INTO sistemas (id, campana_id, nombre, tipo) VALUES (?,?,?,'detectado')").bind(uid(), e.campana_id, n)));
  if (final.length !== actuales.length) await env.DB.prepare('UPDATE respuestas SET sistemas=? WHERE encuestado_id=? AND proceso_id=? AND pregunta=?')
    .bind(JSON.stringify(final.slice(0, 60)), e.id, p.id, bloque.id).run();
  return { final: final.slice(0, 60), detectados, nuevos };
}

async function guardarChecklist(env, e, p, bloqueId, c) {
  await env.DB.prepare(`INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, sistemas, checklist, actualizado) VALUES (?,?,?,'','[]',?,?)
    ON CONFLICT(encuestado_id, proceso_id, pregunta) DO UPDATE SET checklist=excluded.checklist`)
    .bind(e.id, p.id, bloqueId, JSON.stringify(c), ahora()).run();
}

// La IA marca qué puntos del bloque cubrió la respuesta y sugiere qué falta. Lo que la persona marcó a mano se respeta.
async function rutaVerificar(env, b, ctx) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoPermitido(env, e, b.proceso_id);
  const bloque = BLOQUES.find(x => x.id === b.pregunta);
  if (!bloque) throw new HttpError(400, 'Bloque inválido');
  const r = await env.DB.prepare('SELECT texto, sistemas, checklist FROM respuestas WHERE encuestado_id=? AND proceso_id=? AND pregunta=?')
    .bind(e.id, p.id, bloque.id).first();
  const previo = leerMatriz(r && r.checklist);
  const texto = String((r && r.texto) || '').trim();
  let sistemas = [];
  try { sistemas = JSON.parse((r && r.sistemas) || '[]'); } catch (x) { /* sin sistemas */ }
  // La huella incluye los puntos del bloque: si cambia el checklist, la respuesta se vuelve a revisar.
  const firmaDe = lista => huella(texto + '|' + lista.join(',') + '|' + bloque.puntos.map(x => x[0]).join(','));
  const firma = await firmaDe(sistemas);
  if (previo._huella === firma) return { ok: true, checklist: previo, sistemas, sistemas_nuevos: [] };
  const nuevo = { _huella: firma, _sugerencia: '' };
  if (previo._sistemas_rechazados) nuevo._sistemas_rechazados = previo._sistemas_rechazados;
  if (previo._sistemas_ia) nuevo._sistemas_ia = previo._sistemas_ia;
  let nuevosSis = [];
  const manual = id => previo[id] && previo[id].fuente === 'persona';
  let sistemasFinal = sistemas;
  if (!texto && !sistemas.length) {
    bloque.puntos.forEach(([id]) => { nuevo[id] = manual(id) ? previo[id] : { estado: 'falta', fuente: 'ia', evidencia: '' }; });
  } else {
    let msg;
    const cfg = iaDe(env, 'revision'), t0 = Date.now();
    // Solo el bloque con la lista de sistemas lleva el catálogo: ahí se detectan los sistemas que menciona la persona.
    const catalogo = bloque.sistemas ? (await env.DB.prepare('SELECT nombre FROM sistemas WHERE campana_id=? ORDER BY nombre LIMIT 300').bind(e.campana_id).all()).results.map(x => x.nombre) : [];
    const glosarioEst = bloque.puntos.some(x => x[0] === 'estandares') ? estandaresDe(await env.DB.prepare('SELECT estandares FROM campanas WHERE id=?').bind(e.campana_id).first()) : '';
    try {
      msg = await clienteClaude(env).beta.messages.stream({
        model: cfg.modelo,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: cfg.esfuerzo, format: { type: 'json_schema', schema: schemaVerificar(bloque) } },
        system: VERIFICAR_PROMPT,
        messages: [{ role: 'user', content: [
          `PROCESO: ${p.subproceso || p.proceso || p.macroproceso}`,
          `BLOQUE: ${bloque.t}`,
          'CHECKLIST:', ...bloque.puntos.map(([id, t]) => `- ${id}: ${t}`),
          '', 'RESPUESTA:', texto || '(sin texto)',
          sistemas.length ? '\nSISTEMAS MARCADOS EN LA LISTA: ' + sistemas.join(', ') : '',
          glosarioEst ? '\nGLOSARIO DE ESTÁNDARES DE LA CAMPAÑA: ' + glosarioEst : '',
          bloque.sistemas ? '\nCATÁLOGO DE SISTEMAS DE LA CAMPAÑA: ' + (catalogo.length ? catalogo.join('; ') : '(vacío)') : '(Este bloque no detecta sistemas: devuelve "sistemas" vacío.)'
        ].join('\n') }]
      }).finalMessage();
    } catch (err) {
      log('verificar_error', { campana: e.campana_id, bloque: bloque.id, error: String((err && err.message) || err).slice(0, 200) });
      throw new HttpError(502, 'No pudimos revisar tu respuesta en este momento. Ya quedó guardada: marca a mano los puntos que mencionaste.');
    }
    registrarIA(ctx, 'revision', msg, cfg, t0);
    let s = {};
    try { s = JSON.parse((msg.content.find(c => c.type === 'text') || {}).text || '{}'); }
    catch (x) { throw new HttpError(502, 'La revisión automática devolvió un formato inesperado. Reintenta.'); }
    const porId = {};
    (s.puntos || []).forEach(x => { if (x && x.id) porId[x.id] = x; });
    bloque.puntos.forEach(([id]) => {
      if (manual(id)) { nuevo[id] = previo[id]; return; }
      const x = porId[id] || {};
      nuevo[id] = { estado: ESTADOS_PUNTO.includes(x.estado) ? x.estado : 'falta', fuente: 'ia', evidencia: txt(x.evidencia, 200) };
    });
    nuevo._sugerencia = txt(s.sugerencia, 400);
    if (bloque.sistemas) {
      const u = await unirSistemas(env, e, p, bloque, previo, sistemas, s.sistemas, catalogo);
      sistemasFinal = u.final; nuevosSis = u.nuevos;
      nuevo._sistemas_ia = [...new Set([...(previo._sistemas_ia || []), ...u.detectados])].slice(0, 60);
      // La huella se calcula con la lista ya unida: la siguiente revisión no se repite por los sistemas recién marcados.
      nuevo._huella = await firmaDe(sistemasFinal);
    }
  }
  await guardarChecklist(env, e, p, bloque.id, nuevo);
  log('verificar', { campana: e.campana_id, bloque: bloque.id, faltan: bloque.puntos.filter(([id]) => nuevo[id].estado === 'falta').length,
    sis_detectados: sistemasFinal.length - sistemas.length, sis_nuevos: nuevosSis.length });
  return { ok: true, checklist: nuevo, sistemas: sistemasFinal, sistemas_nuevos: nuevosSis };
}

// Imagen subida en un bloque (un flujo, un procedimiento, un formato, una pantalla, una pizarra): la IA la lee y
// devuelve en texto lo útil para el bloque. La imagen no se guarda; el texto se agrega a la respuesta y la persona lo revisa.
const IMAGEN_SCHEMA = {
  type: 'object',
  properties: { relevante: { type: 'boolean' }, texto: { type: 'string' }, motivo: { type: 'string' } },
  required: ['relevante', 'texto', 'motivo'],
  additionalProperties: false
};
const IMAGEN_PROMPT = `Recibes una imagen que un colaborador subió al responder un bloque de una encuesta de relevamiento de procesos: puede ser un diagrama de flujo, un procedimiento, un formato, una pantalla de un sistema, un correo o una pizarra.
Extrae solo la información útil para ese bloque y su checklist: pasos, áreas y cargos que participan, aprobaciones (de quién, de qué área y en qué paso), sistemas y para qué se usan, terceros, datos personales que se manejan, normas, estándares, documentos, frecuencias e indicadores que se vean.
Escribe en español, en texto corrido y breve (máximo 200 palabras), como si el colaborador lo contara. No inventes lo que no se ve.
Nunca copies datos personales concretos (nombres de personas, DNI, teléfonos, correos, direcciones, montos de clientes): usa cargos y categorías.
Si la imagen no tiene información de un proceso de trabajo, "relevante" es false, "texto" queda vacío y en "motivo" dices en una frase qué se ve.`;

async function rutaImagen(env, req, url, ctx) {
  const e = await encuestadoPorToken(env, url.searchParams.get('k'));
  const p = await procesoPermitido(env, e, url.searchParams.get('proceso_id'));
  const bloque = BLOQUES.find(x => x.id === url.searchParams.get('pregunta'));
  if (!bloque) throw new HttpError(400, 'Bloque inválido');
  const tipo = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(tipo)) throw new HttpError(415, 'Sube una imagen JPG, PNG o WEBP');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'Imagen vacía');
  if (buf.byteLength > MAX_IMAGEN) throw new HttpError(413, 'La imagen pesa demasiado (máximo 6 MB)');
  let msg;
  const cfg = iaDe(env, 'imagen'), t0 = Date.now();
  try {
    msg = await clienteClaude(env).beta.messages.stream({
      model: cfg.modelo,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: cfg.esfuerzo, format: { type: 'json_schema', schema: IMAGEN_SCHEMA } },
      system: IMAGEN_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: tipo, data: aBase64(buf) } },
        { type: 'text', text: [`PROCESO: ${p.subproceso || p.proceso || p.macroproceso}`, `BLOQUE: ${bloque.t}`,
          'CHECKLIST:', ...bloque.puntos.map(([, t]) => '- ' + t)].join('\n') }
      ] }]
    }).finalMessage();
  } catch (err) {
    log('imagen_error', { campana: e.campana_id, bloque: bloque.id, error: String((err && err.message) || err).slice(0, 200) });
    throw new HttpError(502, 'No pudimos leer la imagen en este momento. Intenta de nuevo en un minuto o cuéntalo con tu voz.');
  }
  registrarIA(ctx, 'imagen', msg, cfg, t0);
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'No pudimos procesar esa imagen. Cuéntalo con tu voz o por escrito.');
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, 'La lectura de la imagen quedó incompleta. Reintenta.');
  let s = {};
  try { s = JSON.parse((msg.content.find(c => c.type === 'text') || {}).text || '{}'); }
  catch (x) { throw new HttpError(502, 'La lectura de la imagen devolvió un formato inesperado. Reintenta.'); }
  log('imagen', { campana: e.campana_id, bloque: bloque.id, relevante: !!s.relevante, bytes: buf.byteLength });
  return { ok: true, texto: s.relevante ? txt(s.texto, 3000) : '', motivo: s.relevante ? '' : txt(s.motivo, 300) };
}

// La persona marca un punto como "lo mencioné" (cubierto) o "no aplica"; estado vacío deshace su marca.
async function rutaPunto(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoPermitido(env, e, b.proceso_id);
  const bloque = BLOQUES.find(x => x.id === b.pregunta);
  if (!bloque || !bloque.puntos.some(x => x[0] === b.punto)) throw new HttpError(400, 'Punto inválido');
  if (!['cubierto', 'no_aplica', ''].includes(b.estado)) throw new HttpError(400, 'Estado inválido');
  if (b.estado === 'no_aplica' && !bloque.puntos.find(x => x[0] === b.punto)[2]) throw new HttpError(400, 'Este punto existe en todo proceso: cuéntalo en tu respuesta.');
  const r = await env.DB.prepare('SELECT checklist FROM respuestas WHERE encuestado_id=? AND proceso_id=? AND pregunta=?').bind(e.id, p.id, bloque.id).first();
  const c = leerMatriz(r && r.checklist);
  if (b.estado) c[b.punto] = { estado: b.estado, fuente: 'persona', evidencia: '' };
  else { delete c[b.punto]; delete c._huella; }   // sin huella, la próxima revisión vuelve a mirar el punto
  await guardarChecklist(env, e, p, bloque.id, c);
  await marcarEnCurso(env, e);
  return { ok: true, checklist: c };
}

// Logo del cliente que se muestra en la encuesta (junto a la marca MBC). Vacío lo quita.
async function rutaLogo(env, b) {
  const logo = String(b.logo || '');
  if (logo && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new HttpError(400, 'El logo debe ser una imagen PNG, JPG, WEBP o SVG');
  if (logo.length > 420000) throw new HttpError(413, 'El logo pesa demasiado (máximo 300 KB)');   // 300 KB en base64
  const r = await env.DB.prepare('UPDATE campanas SET logo=? WHERE id=?').bind(logo, b.campana_id).run();
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'Campaña no encontrada');
  log('logo', { campana: b.campana_id, bytes: logo.length });
  return { ok: true };
}

// Lista de procesos de una persona, armada por el equipo consultor. Quitar solo aplica a procesos que aún no respondió.
async function rutaAsignar(env, b) {
  const e = await env.DB.prepare('SELECT * FROM encuestados WHERE id=?').bind(b.encuestado_id).first();
  if (!e) throw new HttpError(404, 'Persona no encontrada');
  const lista = a => [...new Set((Array.isArray(a) ? a : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 300);
  const agregar = lista(b.agregar), quitar = lista(b.quitar);
  const agregados = agregar.length ? (await asignarProcesos(env, e, agregar, 'consultor')).length : 0;
  let quitados = 0, conRespuesta = 0;
  if (quitar.length) {
    const resp = await env.DB.prepare(`SELECT DISTINCT proceso_id FROM respuestas WHERE encuestado_id=? AND (trim(texto)<>'' OR sistemas<>'[]')`).bind(e.id).all();
    const respondidos = new Set(resp.results.map(x => x.proceso_id));
    const st = [];
    quitar.forEach(pid => {
      if (respondidos.has(pid)) { conRespuesta++; return; }
      st.push(env.DB.prepare('DELETE FROM asignaciones WHERE encuestado_id=? AND proceso_id=?').bind(e.id, pid));
      st.push(env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id=? AND proceso_id=?').bind(e.id, pid));
      st.push(env.DB.prepare('DELETE FROM respuestas WHERE encuestado_id=? AND proceso_id=?').bind(e.id, pid));
      quitados++;
    });
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  }
  log('asignar', { campana: e.campana_id, agregados, quitados, con_respuesta: conRespuesta });
  return { ok: true, agregados, quitados, con_respuesta: conRespuesta };
}

// Asigna a cada persona cargada los procesos donde figura con su nombre en el inventario anterior.
async function rutaAsignarInventario(env, b) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const [procs, enc] = await Promise.all([
    env.DB.prepare(`SELECT id, personas FROM procesos WHERE campana_id=? AND personas<>''`).bind(camp.id).all(),
    env.DB.prepare('SELECT id, nombre FROM encuestados WHERE campana_id=?').bind(camp.id).all()
  ]);
  const t = ahora(), st = [];
  let personas = 0;
  enc.results.forEach(e => {
    const suyos = procs.results.filter(p => p.personas.split('\n').some(l => mismoNombre(l, e.nombre)));
    if (!suyos.length) return;
    personas++;
    suyos.forEach(p => st.push(env.DB.prepare('INSERT OR IGNORE INTO asignaciones (encuestado_id, proceso_id, creado, origen) VALUES (?,?,?,?)')
      .bind(e.id, p.id, t, 'inventario')));
  });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  log('asignar_inventario', { campana: camp.id, personas, vinculos: st.length });
  return { ok: true, personas, vinculos: st.length, total_personas: enc.results.length };
}

// ---------------------------------------------------------------- router
export default {
  // Tarea programada (wrangler.toml [triggers]): la IA completa la matriz con las respuestas nuevas.
  async scheduled(event, env, ctx) {
    await completarPendientes(env, ctx);
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const h = cors(req, env);
    const ruta = req.method + ' ' + url.pathname;
    if (req.method === 'OPTIONS') {
      if (!h['Access-Control-Allow-Origin']) log('cors_rechazado', { ruta, origen: req.headers.get('Origin') || '' });
      return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h });
    }
    try {
      if (ruta === 'GET /health') {
        const ia = (env.ANTHROPIC_API_KEY || '').trim() ? 'clave propia' : (env.PROCESSIQ && (env.INTERNAL_CODE || '').trim() ? 'via processiq-api' : 'sin configurar');
        const modelos = { estructurar: iaDe(env, 'estructurar'), revision: iaDe(env, 'revision'), imagen: iaDe(env, 'imagen') };
        return json({ ok: true, servicio: 'voz-relevamiento-api', ia, modelos, admin: !!(env.ADMIN_CODE || '').trim() }, 200, h);
      }
      if (!h['Access-Control-Allow-Origin']) throw new HttpError(403, 'Origen no permitido');

      if (ruta === 'GET /r/sesion') return json(await rutaSesion(env, url), 200, h);
      if (ruta === 'GET /r/abierta') return json(await rutaAbierta(env, url), 200, h);
      if (ruta === 'GET /r/buscar') return json(await rutaBuscar(env, url), 200, h);
      if (ruta === 'POST /r/transcribir') return json(await rutaTranscribir(env, req, url), 200, h);
      if (ruta === 'POST /r/imagen') return json(await rutaImagen(env, req, url, ctx), 200, h);
      if (url.pathname.startsWith('/r/') && req.method === 'POST') {
        const b = await cuerpo(req);
        if (url.pathname === '/r/registro') return json(await rutaRegistro(env, b), 200, h);
        if (url.pathname === '/r/elegir') return json(await rutaElegir(env, b), 200, h);
        if (url.pathname === '/r/soltar') return json(await rutaSoltar(env, b), 200, h);
        if (url.pathname === '/r/revision') return json(await rutaRevision(env, b), 200, h);
        if (url.pathname === '/r/proceso') return json(await rutaProcesoNuevo(env, b), 200, h);
        if (url.pathname === '/r/respuesta') return json(await rutaRespuesta(env, b), 200, h);
        if (url.pathname === '/r/verificar') return json(await rutaVerificar(env, b, ctx), 200, h);
        if (url.pathname === '/r/punto') return json(await rutaPunto(env, b), 200, h);
        if (url.pathname === '/r/enviar') return json(await rutaEnviar(env, b), 200, h);
      }

      if (url.pathname.startsWith('/a/')) {
        exigirAdmin(req, env);
        if (ruta === 'GET /a/campanas') return json(await rutaCampanas(env), 200, h);
        if (ruta === 'GET /a/campana') return json(await rutaCampana(env, url), 200, h);
        if (req.method === 'POST') {
          const b = await cuerpo(req);
          if (url.pathname === '/a/campana') return json(await rutaCampanaNueva(env, b), 200, h);
          if (url.pathname === '/a/campana/glosario') return json(await rutaGlosario(env, b), 200, h);
          if (url.pathname === '/a/campana/logo') return json(await rutaLogo(env, b), 200, h);
          if (url.pathname === '/a/campana/ia') return json(await rutaCampanaIA(env, b), 200, h);
          if (url.pathname === '/a/campana/estandares') return json(await rutaEstandares(env, b), 200, h);
          if (url.pathname === '/a/estandares/probar') return json(await rutaEstandaresProbar(env, b, ctx), 200, h);
          if (url.pathname === '/a/asignar') return json(await rutaAsignar(env, b), 200, h);
          if (url.pathname === '/a/asignar-por-inventario') return json(await rutaAsignarInventario(env, b), 200, h);
          if (url.pathname === '/a/enlace') return json(await rutaEnlace(env, b), 200, h);
          if (url.pathname === '/a/importar') return json(await rutaImportar(env, b), 200, h);
          if (url.pathname === '/a/proceso') return json(await rutaProcesoAdmin(env, b), 200, h);
          if (url.pathname === '/a/proceso/borrar') return json(await rutaProcesoBorrar(env, b), 200, h);
          if (url.pathname === '/a/matriz') return json(await rutaMatriz(env, b), 200, h);
          if (url.pathname === '/a/validacion') return json(await rutaValidacion(env, b), 200, h);
          if (url.pathname === '/a/encuestado/borrar') return json(await rutaEncuestadoBorrar(env, b), 200, h);
          if (url.pathname === '/a/respuesta/borrar') return json(await rutaRespuestaBorrar(env, b), 200, h);
          if (url.pathname === '/a/estructurar') return json(await rutaEstructurar(env, b, ctx), 200, h);
          if (url.pathname === '/a/borrar-campana') return json(await rutaBorrarCampana(env, b), 200, h);
        }
      }
      throw new HttpError(404, 'Ruta no encontrada');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error(err);
      // Cada rechazo queda en Workers Logs con lo necesario para diagnosticar (sin datos personales):
      // así se ve si un enlace llega con token inválido, desde un origen no permitido o con una campaña cerrada.
      log('error', { ruta, status, error: err instanceof HttpError ? err.message : String(err && err.message || err),
        origen: req.headers.get('Origin') || '', k: mascara(url.searchParams.get('k')), c: mascara(url.searchParams.get('c')) });
      return json({ ok: false, error: err instanceof HttpError ? err.message : 'Error interno' }, status, h);
    }
  }
};
