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
 *   - Base: D1 (ver schema.sql).
 *
 * Rutas del encuestado (autenticadas con su token personal, ?k= o campo k):
 *   GET  /r/sesion?k=            datos para pintar la encuesta
 *   POST /r/revision             {k, proceso_id, estado, comentario}
 *   POST /r/proceso              {k, macroproceso, proceso, subproceso, descripcion}
 *   POST /r/proceso/quitar       {k, proceso_id}   (solo procesos que él agregó)
 *   POST /r/respuesta            {k, proceso_id, pregunta, texto, sistemas[]}
 *   POST /r/transcribir?k=       cuerpo: audio WAV (bytes) -> {texto}
 *   POST /r/enviar               {k}
 * Rutas de la consola (cabecera x-admin-code):
 *   GET  /a/campanas
 *   POST /a/campana              {nombre, cliente, glosario}
 *   POST /a/campana/glosario     {campana_id, glosario}
 *   POST /a/importar             {campana_id, modo, encuestados[], procesos[], sistemas[]}
 *   GET  /a/campana?id=          volcado completo de la campaña
 *   POST /a/estructurar          {proceso_id}
 *   POST /a/borrar-campana       {campana_id, confirmar}   (confirmar = nombre exacto)
 *   GET  /health
 *
 * Secretos (npx wrangler secret put ...): ANTHROPIC_API_KEY, ADMIN_CODE.
 * ============================================================ */

import Anthropic from '@anthropic-ai/sdk';

const MODELO = 'claude-opus-5';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const MAX_AUDIO = 8 * 1024 * 1024;       // por tramo; el navegador corta en tramos de 2 min
const MAX_TEXTO = 12000;
const PREGUNTAS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
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

// El encuestado solo puede tocar procesos de su propia gerencia y sección.
async function procesoDeSuSeccion(env, e, procesoId) {
  const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=? AND campana_id=?').bind(procesoId, e.campana_id).first();
  if (!p || p.gerencia !== e.gerencia || p.seccion !== e.seccion) throw new HttpError(404, 'Proceso no encontrado');
  return p;
}

async function rutaSesion(env, url) {
  const e = await encuestadoPorToken(env, url.searchParams.get('k'));
  const [camp, procs, revs, resps, sis] = await Promise.all([
    env.DB.prepare('SELECT nombre, cliente FROM campanas WHERE id=?').bind(e.campana_id).first(),
    env.DB.prepare('SELECT id, codigo, macroproceso, proceso, subproceso, descripcion, fuente, creado_por FROM procesos WHERE campana_id=? AND gerencia=? AND seccion=? ORDER BY orden, macroproceso, proceso, subproceso')
      .bind(e.campana_id, e.gerencia, e.seccion).all(),
    env.DB.prepare('SELECT proceso_id, estado, comentario FROM revisiones WHERE encuestado_id=?').bind(e.id).all(),
    env.DB.prepare('SELECT proceso_id, pregunta, texto, sistemas FROM respuestas WHERE encuestado_id=?').bind(e.id).all(),
    env.DB.prepare('SELECT nombre, tipo FROM sistemas WHERE campana_id=? ORDER BY nombre').bind(e.campana_id).all()
  ]);
  const procesos = procs.results
    // Los nuevos agregados por OTRO encuestado de la sección no se le muestran: evita duplicar trabajo ajeno.
    .filter(p => p.fuente !== 'nuevo' || p.creado_por === e.id)
    .map(p => ({ id: p.id, codigo: p.codigo, macroproceso: p.macroproceso, proceso: p.proceso, subproceso: p.subproceso,
      descripcion: p.descripcion, nuevo: p.fuente === 'nuevo' }));
  const revisiones = {};
  revs.results.forEach(r => { revisiones[r.proceso_id] = { estado: r.estado, comentario: r.comentario }; });
  const respuestas = {};
  resps.results.forEach(r => {
    (respuestas[r.proceso_id] = respuestas[r.proceso_id] || {})[r.pregunta] = { texto: r.texto, sistemas: JSON.parse(r.sistemas || '[]') };
  });
  return {
    ok: true,
    campana: camp,
    encuestado: { nombre: e.nombre, gerencia: e.gerencia, seccion: e.seccion, rol: e.rol, estado: e.estado },
    procesos, revisiones, respuestas,
    sistemas: sis.results
  };
}

async function rutaRevision(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoDeSuSeccion(env, e, b.proceso_id);
  if (!['vigente', 'cambio', 'no_existe'].includes(b.estado)) throw new HttpError(400, 'Estado inválido');
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
  return { ok: true, proceso: { id, codigo: '', macroproceso: txt(b.macroproceso, 200), proceso: nombre, subproceso: txt(b.subproceso, 200), descripcion: txt(b.descripcion, 1500), nuevo: true } };
}

async function rutaProcesoQuitar(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoDeSuSeccion(env, e, b.proceso_id);
  if (p.fuente !== 'nuevo' || p.creado_por !== e.id) throw new HttpError(403, 'Solo puedes quitar procesos que tú agregaste');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM respuestas WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM revisiones WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM estructurado WHERE proceso_id=?').bind(p.id),
    env.DB.prepare('DELETE FROM procesos WHERE id=?').bind(p.id)
  ]);
  return { ok: true };
}

async function rutaRespuesta(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  const p = await procesoDeSuSeccion(env, e, b.proceso_id);
  if (!PREGUNTAS.includes(b.pregunta)) throw new HttpError(400, 'Pregunta inválida');
  const sistemas = Array.isArray(b.sistemas) ? b.sistemas.map(s => txt(s, 120)).filter(Boolean).slice(0, 60) : [];
  await env.DB.prepare(`INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, sistemas, actualizado) VALUES (?,?,?,?,?,?)
    ON CONFLICT(encuestado_id, proceso_id, pregunta) DO UPDATE SET texto=excluded.texto, sistemas=excluded.sistemas, actualizado=excluded.actualizado`)
    .bind(e.id, p.id, b.pregunta, txt(b.texto, MAX_TEXTO), JSON.stringify(sistemas), ahora()).run();
  await marcarEnCurso(env, e);
  return { ok: true };
}

async function rutaTranscribir(env, req, url) {
  const e = await encuestadoPorToken(env, url.searchParams.get('k'));
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, 'Audio vacío');
  if (buf.byteLength > MAX_AUDIO) throw new HttpError(413, 'Tramo de audio demasiado grande');
  const camp = await env.DB.prepare('SELECT glosario FROM campanas WHERE id=?').bind(e.campana_id).first();
  const sis = await env.DB.prepare('SELECT nombre FROM sistemas WHERE campana_id=? LIMIT 40').bind(e.campana_id).all();
  // El glosario orienta a Whisper con siglas y nombres propios que suele escribir mal.
  const pista = [camp && camp.glosario, sis.results.map(s => s.nombre).join(', ')].filter(Boolean).join('. ').slice(0, 800);
  let r;
  try {
    r = await env.AI.run(WHISPER, { audio: aBase64(buf), language: 'es', vad_filter: true, initial_prompt: pista || undefined });
  } catch (err) {
    console.error('whisper', err && err.message);
    throw new HttpError(502, 'No se pudo transcribir el audio. Inténtalo de nuevo o escribe tu respuesta.');
  }
  return { ok: true, texto: String((r && r.text) || '').trim() };
}

async function rutaEnviar(env, b) {
  const e = await encuestadoPorToken(env, b.k);
  await env.DB.prepare("UPDATE encuestados SET estado='enviado', actualizado=? WHERE id=?").bind(ahora(), e.id).run();
  return { ok: true };
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
    st.push(env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM encuestados WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM estructurado WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM procesos WHERE campana_id=?').bind(camp.id));
    st.push(env.DB.prepare('DELETE FROM sistemas WHERE campana_id=?').bind(camp.id));
  }
  let nE = 0, nP = 0, nS = 0;
  enc.forEach(x => {
    const nombre = txt(x.nombre, 150), gerencia = txt(x.gerencia, 150), seccion = txt(x.seccion, 150);
    if (!nombre || !gerencia || !seccion) return;
    st.push(env.DB.prepare('INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, rol) VALUES (?,?,?,?,?,?,?,?)')
      .bind(uid(), camp.id, tokenNuevo(), nombre, txt(x.correo, 150), gerencia, seccion, txt(x.rol, 60)));
    nE++;
  });
  pro.forEach((x, i) => {
    const gerencia = txt(x.gerencia, 150), seccion = txt(x.seccion, 150);
    const nombre = txt(x.proceso, 200) || txt(x.subproceso, 200);
    if (!gerencia || !seccion || !nombre) return;
    st.push(env.DB.prepare(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, orden)
      VALUES (?,?,?,?,?,?,?,?,?,'inventario',?)`)
      .bind(uid(), camp.id, txt(x.codigo, 60), gerencia, seccion, txt(x.macroproceso, 200), txt(x.proceso, 200), txt(x.subproceso, 200), txt(x.descripcion, 1500), i));
    nP++;
  });
  sis.forEach(x => {
    const nombre = txt(x.nombre, 120);
    if (!nombre) return;
    st.push(env.DB.prepare('INSERT INTO sistemas (id, campana_id, nombre, tipo) VALUES (?,?,?,?)').bind(uid(), camp.id, nombre, txt(x.tipo, 80)));
    nS++;
  });
  for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
  return { ok: true, encuestados: nE, procesos: nP, sistemas: nS };
}

async function rutaCampana(env, url) {
  const id = url.searchParams.get('id');
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const q = s => env.DB.prepare(s).bind(id).all().then(r => r.results);
  const [encuestados, procesos, revisiones, respuestas, sistemas, estructurado] = await Promise.all([
    q('SELECT id, token, nombre, correo, gerencia, seccion, rol, estado, actualizado FROM encuestados WHERE campana_id=? ORDER BY gerencia, seccion, nombre'),
    q('SELECT * FROM procesos WHERE campana_id=? ORDER BY gerencia, seccion, orden, macroproceso, proceso, subproceso'),
    q('SELECT r.* FROM revisiones r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    q('SELECT r.* FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    q('SELECT nombre, tipo FROM sistemas WHERE campana_id=? ORDER BY nombre'),
    q('SELECT proceso_id, datos, modelo, generado FROM estructurado WHERE campana_id=?')
  ]);
  estructurado.forEach(x => { x.datos = JSON.parse(x.datos); });
  respuestas.forEach(x => { x.sistemas = JSON.parse(x.sistemas || '[]'); });
  return { ok: true, campana: camp, encuestados, procesos, revisiones, respuestas, sistemas, estructurado };
}

async function rutaBorrarCampana(env, b) {
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(b.campana_id).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  if (b.confirmar !== camp.nombre) throw new HttpError(400, 'Para borrar, escribe el nombre exacto de la campaña');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM respuestas WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id),
    env.DB.prepare('DELETE FROM revisiones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=?)').bind(camp.id),
    env.DB.prepare('DELETE FROM estructurado WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM procesos WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM sistemas WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM encuestados WHERE campana_id=?').bind(camp.id),
    env.DB.prepare('DELETE FROM campanas WHERE id=?').bind(camp.id)
  ]);
  return { ok: true };
}

// ---------------------------------------------------------------- estructuración con Claude
// Campos del inventario que se derivan de las respuestas (los de identificación ya vienen del catálogo).
// Alineados con la pestaña "Estructura inventario" del data request.
const CAMPOS = [
  ['tipo_proceso', 'Tipo de proceso: estratégico, core o soporte'],
  ['dueno_proceso', 'Dueño del proceso end-to-end (cargo, no nombre de persona)'],
  ['areas_intervienen', 'Áreas internas que participan en el flujo'],
  ['objetivo', 'Objetivo del proceso'],
  ['actividades', 'Actividades principales en secuencia (3 a 8), numeradas'],
  ['inicio_fin', 'Evento que inicia el proceso y dónde termina (a qué área o tercero entrega)'],
  ['entradas_salidas', 'Entradas y salidas principales'],
  ['frecuencia_volumen', 'Frecuencia y volumen aproximado'],
  ['terceros', 'Terceros involucrados (proveedores, concesionarios, clientes, entidades)'],
  ['interaccion_terceros', 'Tipo de interacción con terceros (digital o presencial) y finalidad'],
  ['sistemas', 'Sistemas y herramientas con su nombre exacto (ERP, portales, Excel, aplicativos internos)'],
  ['nivel_automatizacion', 'Nivel de automatización: manual, semiautomático o automatizado'],
  ['actividades_manuales', 'Actividades manuales o con reproceso relevantes'],
  ['kpis', 'Indicadores con los que se mide el proceso'],
  ['regulacion', 'Normativa o política que regula el proceso, solo si el área la mencionó'],
  ['trata_datos_personales', 'Si trata datos personales: Sí / No'],
  ['titulares_datos', 'Titulares de los datos: clientes, trabajadores, proveedores u otros'],
  ['categoria_datos', 'Categoría de datos: identificación, contacto, financieros, sensibles, otros'],
  ['criticidad_preliminar', 'Criticidad preliminar Alta / Media / Baja con una frase de sustento']
];

// Los campos van como LISTA de ítems con un solo esquema: un objeto con 19 propiedades
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

const SISTEMA_PROMPT = `Eres un consultor senior de procesos que arma el inventario corporativo de procesos de un cliente.
Recibes la ficha de un proceso (tal como estaba en el inventario anterior o como lo agregó un colaborador) y las respuestas que dieron por voz o por escrito uno o más colaboradores de la sección (líder y usuario de soporte). Las respuestas son transcripciones: pueden tener muletillas, errores de reconocimiento de voz y desorden.

Tu trabajo es llenar una fila del inventario. Para cada campo:
- estado "dicho": el dato aparece explícito en las respuestas. En "evidencia" pon una cita breve (máx. 20 palabras) de la respuesta que lo sustenta.
- estado "inferido": no se dijo, pero se deduce con razonable seguridad del contexto o del catálogo de sistemas. En "evidencia" explica en una frase de dónde lo deduces. Estos campos se validarán en la reunión.
- estado "vacio": no hay información suficiente. "valor" y "evidencia" quedan como cadena vacía. No inventes.

Reglas:
- Escribe en español neutro, conciso y profesional, listo para un entregable al cliente.
- Nunca incluyas nombres de personas ni datos personales concretos (DNI, teléfonos, nombres de clientes): usa cargos y categorías.
- Para sistemas, usa el nombre exacto del catálogo cuando coincida; si mencionan una herramienta que no está en el catálogo, inclúyela igual y dilo en la evidencia.
- "criticidad_preliminar" siempre es "inferido" (salvo que lo digan) y es solo una propuesta para priorizar.
- "vigencia": resume lo que dijeron los colaboradores sobre si el proceso sigue vigente ("contradictorio" si difieren; "sin_revision" si nadie lo marcó).
- "contradicciones": diferencias entre lo que dijo el líder y el soporte, o entre la ficha anterior y lo que contaron ahora.
- "preguntas_validacion": 3 a 6 preguntas concretas para cerrar en la reunión los campos inferidos, vacíos o contradictorios. Nada genérico.
- "resumen": 2 o 3 frases que describan el proceso tal como opera hoy.`;

function textoParaClaude(camp, p, encuestados, revisiones, respuestas, sistemas) {
  const PREG = { q1: 'Objetivo, inicio y fin', q2: 'Actividades y participantes', q3: 'Sistemas y manualidad',
    q4: 'Terceros', q5: 'Datos personales', q6: 'Indicadores, normas y frecuencia' };
  const lineas = [];
  lineas.push(`CLIENTE: ${camp.cliente}`);
  lineas.push(`PROCESO (ficha de partida):`);
  lineas.push(`- Código: ${p.codigo || '(sin código)'}`);
  lineas.push(`- Gerencia / sección: ${p.gerencia} / ${p.seccion}`);
  lineas.push(`- Macroproceso: ${p.macroproceso || '-'} | Proceso: ${p.proceso || '-'} | Subproceso: ${p.subproceso || '-'}`);
  lineas.push(`- Origen: ${p.fuente === 'nuevo' ? 'agregado por un colaborador en la encuesta' : 'inventario anterior'}`);
  if (p.descripcion) lineas.push(`- Descripción previa: ${p.descripcion}`);
  lineas.push('');
  lineas.push(`CATÁLOGO DE SISTEMAS DEL CLIENTE: ${sistemas.map(s => s.nombre + (s.tipo ? ' (' + s.tipo + ')' : '')).join('; ') || '(no cargado)'}`);
  lineas.push('');
  encuestados.forEach(e => {
    const rev = revisiones.find(r => r.encuestado_id === e.id);
    const resp = respuestas.filter(r => r.encuestado_id === e.id);
    if (!rev && !resp.length) return;
    lineas.push(`=== COLABORADOR (rol: ${e.rol || 'no indicado'}) ===`);
    if (rev) lineas.push(`Vigencia marcada: ${rev.estado}${rev.comentario ? ' — comentario: ' + rev.comentario : ''}`);
    resp.sort((a, b) => a.pregunta.localeCompare(b.pregunta)).forEach(r => {
      const sis = JSON.parse(r.sistemas || '[]');
      lineas.push(`[${PREG[r.pregunta] || r.pregunta}] ${r.texto || '(sin texto)'}${sis.length ? ' | Sistemas marcados: ' + sis.join(', ') : ''}`);
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

async function registrarGasto(uso) {
  if (!uso) return;
  try {
    await fetch(PULSE_INGEST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'voz-relevamiento', provider: 'anthropic', model: MODELO,
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

async function rutaEstructurar(env, b, ctx) {
  const p = await env.DB.prepare('SELECT * FROM procesos WHERE id=?').bind(b.proceso_id).first();
  if (!p) throw new HttpError(404, 'Proceso no encontrado');
  const camp = await env.DB.prepare('SELECT * FROM campanas WHERE id=?').bind(p.campana_id).first();
  const [enc, revs, resps, sis] = await Promise.all([
    env.DB.prepare('SELECT id, rol FROM encuestados WHERE campana_id=? AND gerencia=? AND seccion=?').bind(p.campana_id, p.gerencia, p.seccion).all(),
    env.DB.prepare('SELECT * FROM revisiones WHERE proceso_id=?').bind(p.id).all(),
    env.DB.prepare('SELECT * FROM respuestas WHERE proceso_id=?').bind(p.id).all(),
    env.DB.prepare('SELECT nombre, tipo FROM sistemas WHERE campana_id=?').bind(p.campana_id).all()
  ]);
  if (!resps.results.some(r => (r.texto || '').trim())) throw new HttpError(409, 'Este proceso todavía no tiene respuestas');

  const client = clienteClaude(env);
  let msg;
  try {
    msg = await client.beta.messages.stream({
      model: MODELO,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SALIDA_SCHEMA } },
      system: SISTEMA_PROMPT,
      messages: [{ role: 'user', content: textoParaClaude(camp, p, enc.results, revs.results, resps.results, sis.results) }]
    }).finalMessage();
  } catch (err) {
    console.error('claude', err && err.message);
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Límite de uso de la IA alcanzado: espera un minuto y reintenta');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, 'La IA devolvió un error (' + (err.status || 'sin código') + '): ' + err.message);
    throw new HttpError(502, 'No se pudo contactar a la IA');
  }
  ctx.waitUntil(registrarGasto(msg.usage));
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'La IA no pudo procesar este proceso. Revisa las respuestas manualmente.');
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, 'La respuesta de la IA quedó incompleta. Reintenta.');
  const bloque = msg.content.find(c => c.type === 'text');
  let datos;
  try { datos = normalizarSalida(JSON.parse(bloque ? bloque.text : '')); } catch (e) { throw new HttpError(502, 'La IA devolvió un formato inesperado. Reintenta.'); }
  const generado = ahora();
  await env.DB.prepare(`INSERT INTO estructurado (proceso_id, campana_id, datos, modelo, generado) VALUES (?,?,?,?,?)
    ON CONFLICT(proceso_id) DO UPDATE SET datos=excluded.datos, modelo=excluded.modelo, generado=excluded.generado`)
    .bind(p.id, p.campana_id, JSON.stringify(datos), msg.model || MODELO, generado).run();
  return { ok: true, proceso_id: p.id, datos, modelo: msg.model || MODELO, generado };
}

// ---------------------------------------------------------------- router
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h });
    try {
      const ruta = req.method + ' ' + url.pathname;
      if (ruta === 'GET /health') {
        const ia = (env.ANTHROPIC_API_KEY || '').trim() ? 'clave propia' : (env.PROCESSIQ && (env.INTERNAL_CODE || '').trim() ? 'via processiq-api' : 'sin configurar');
        return json({ ok: true, servicio: 'voz-relevamiento-api', ia, admin: !!(env.ADMIN_CODE || '').trim() }, 200, h);
      }
      if (!h['Access-Control-Allow-Origin']) throw new HttpError(403, 'Origen no permitido');

      if (ruta === 'GET /r/sesion') return json(await rutaSesion(env, url), 200, h);
      if (ruta === 'POST /r/transcribir') return json(await rutaTranscribir(env, req, url), 200, h);
      if (url.pathname.startsWith('/r/') && req.method === 'POST') {
        const b = await cuerpo(req);
        if (url.pathname === '/r/revision') return json(await rutaRevision(env, b), 200, h);
        if (url.pathname === '/r/proceso') return json(await rutaProcesoNuevo(env, b), 200, h);
        if (url.pathname === '/r/proceso/quitar') return json(await rutaProcesoQuitar(env, b), 200, h);
        if (url.pathname === '/r/respuesta') return json(await rutaRespuesta(env, b), 200, h);
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
          if (url.pathname === '/a/importar') return json(await rutaImportar(env, b), 200, h);
          if (url.pathname === '/a/estructurar') return json(await rutaEstructurar(env, b, ctx), 200, h);
          if (url.pathname === '/a/borrar-campana') return json(await rutaBorrarCampana(env, b), 200, h);
        }
      }
      throw new HttpError(404, 'Ruta no encontrada');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error(err);
      return json({ ok: false, error: err instanceof HttpError ? err.message : 'Error interno' }, status, h);
    }
  }
};
