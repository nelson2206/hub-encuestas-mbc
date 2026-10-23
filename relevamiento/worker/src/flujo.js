// Flujo guiado del Supervisor (Gerente): cuatro pasos desde la revisión de sus procesos hasta la aprobación final.
//   1. Procesos     revisa el inventario de su alcance; crea procesos nuevos, elige otros ya cargados por MBC, o quita/suelta los que no le corresponden.
//   2. Delegación   cada proceso queda a cargo de al menos una persona.
//   3. Avance       todos los procesos respondidos (checklist completo).
//   4. Validación   MBC dejó todos sus procesos validados; el Gerente da la aprobación final.
//
// Reglas de seguridad (todas se deciden aquí, nunca en el navegador):
//  - Los pasos se confirman en orden y solo si la compuerta del paso se cumple en ese momento.
//  - Una confirmación vale mientras su compuerta siga cumpliéndose: si cambia lo que la sostenía (un proceso sin responsable, una
//    respuesta borrada), el paso deja de contar y el flujo vuelve a él.
//  - Cambiar algo de un paso anterior cuando ya hay pasos posteriores confirmados exige confirmación explícita (forzar) y los reinicia.
//  - Con la aprobación final dada nada se puede cambiar hasta que MBC la reabra.
// Solo el Supervisor tiene este flujo: el administrador del cliente conserva su panel.
import { HttpError, ahora, uid, txt, normal, mismaArea, log } from './comun.js';
import { ambitoSobre, enSecs, registrarAccion, alcanceDe, esIncorporado } from './ambito.js';
import { crearCobertura } from './cobertura.js';

export const NOMBRE_PASO = { 1: 'Procesos', 2: 'Delegación', 3: 'Avance', 4: 'Validación final' };
const COMPLETO = 5;   // paso_actual cuando la aprobación final ya está dada
const nombreProc = p => p.subproceso || p.proceso || p.macroproceso || '(sin nombre)';

export function soloSupervisor(actor) {
  if (actor.rol !== 'supervisor') throw new HttpError(403, 'Este flujo es solo del Gerente (Supervisor).');
}

// ---------------------------------------------------------------- lectura y cálculo
// Todo lo que hace falta para calcular el estado de cualquier Supervisor de la campaña, leído una sola vez.
async function cargarCampana(env, campId, bloques) {
  const q = sql => env.DB.prepare(sql).bind(campId).all().then(r => r.results);
  const [procs, revisiones, respuestas, precarga, asignaciones, pasos, aprobaciones] = await Promise.all([
    q('SELECT id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, fuera_alcance, quitado_por, validacion, validado_en FROM procesos WHERE campana_id=?'),
    q('SELECT r.encuestado_id, r.proceso_id, r.estado FROM revisiones r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?'),
    // El texto no se necesita, solo saber si hay: se evita traer lo que dijeron las personas.
    q("SELECT r.encuestado_id, r.proceso_id, r.pregunta, CASE WHEN length(trim(r.texto))>0 THEN 'x' ELSE '' END AS texto, r.sistemas, r.checklist FROM respuestas r JOIN encuestados e ON e.id=r.encuestado_id WHERE e.campana_id=?"),
    q('SELECT pc.proceso_id, pc.punto FROM precarga pc JOIN procesos p ON p.id=pc.proceso_id WHERE p.campana_id=?'),
    q('SELECT a.encuestado_id, a.proceso_id, a.origen FROM asignaciones a JOIN encuestados e ON e.id=a.encuestado_id WHERE e.campana_id=?'),
    q('SELECT supervisor_id, paso, confirmado_en FROM flujo_pasos WHERE campana_id=?'),
    q('SELECT * FROM aprobaciones WHERE campana_id=? AND activa=1')
  ]);
  const delegados = {};   // proceso -> personas que lo tienen a cargo (asignadas o que lo tomaron)
  asignaciones.forEach(a => { if (a.origen !== 'excluido') (delegados[a.proceso_id] = delegados[a.proceso_id] || new Set()).add(a.encuestado_id); });
  revisiones.forEach(r => { if (r.estado === 'vigente' || r.estado === 'cambio') (delegados[r.proceso_id] = delegados[r.proceso_id] || new Set()).add(r.encuestado_id); });
  return { procs, pasos, aprobaciones, delegados, cobertura: crearCobertura({ bloques, revisiones, respuestas, precarga }) };
}

// Estado del flujo de un Supervisor: pasos vigentes, paso actual, compuertas y procesos de su alcance.
function calcular(datos, sup) {
  const amb = ambitoSobre({ rol: 'supervisor', sup }, datos.procs);
  const propios = datos.procs.filter(p => amb.procs.has(p.id));
  const activos = propios.filter(p => !p.fuera_alcance);
  // Las gerencias del Gerente son las de su alcance por áreas: un proceso suelto de otra gerencia no lo hace responsable de ella.
  const gerencias = [...new Set(activos.filter(p => !esIncorporado(sup, p)).map(p => p.gerencia))].sort((a, c) => a.localeCompare(c, 'es'));
  const info = new Map(activos.map(p => [p.id, datos.cobertura(p.id)]));
  const faltan = lista => lista.map(nombreProc).slice(0, 50);

  const compuertas = {
    1: { ok: activos.length > 0, faltan: activos.length ? [] : ['Debe quedar al menos un proceso en tu alcance'] },
    2: { faltan: faltan(activos.filter(p => !(datos.delegados[p.id] || new Set()).size)) },
    3: { faltan: faltan(activos.filter(p => !['respondido', 'no_vigente'].includes(info.get(p.id).estado))) },
    4: { faltan: faltan(activos.filter(p => p.validacion !== 'validado')) }
  };
  [2, 3, 4].forEach(n => { compuertas[n].ok = compuertas[n].faltan.length === 0; });

  const confirmado = {};
  datos.pasos.filter(x => x.supervisor_id === sup.id).forEach(x => { confirmado[x.paso] = x.confirmado_en; });
  const vigentes = [];
  for (let n = 1; n <= 3 && confirmado[n] && compuertas[n].ok; n++) vigentes.push(n);   // una confirmación vale mientras su compuerta se cumpla

  const aprob = datos.aprobaciones.find(a => a.supervisor_id === sup.id) || null;
  const pasoActual = aprob ? COMPLETO : vigentes.length < 3 ? vigentes.length + 1 : 4;
  return {
    amb, activos, gerencias, compuertas, vigentes, confirmado, aprobacion: aprob, aprobada: !!aprob, paso_actual: pasoActual,
    procesos: propios.filter(p => !p.fuera_alcance || p.quitado_por).map(p => {
      const c = info.get(p.id);
      return { id: p.id, codigo: p.codigo, gerencia: p.gerencia, seccion: p.seccion, macroproceso: p.macroproceso, proceso: p.proceso, subproceso: p.subproceso,
        descripcion: p.descripcion || '', agregado: p.fuente === 'gerente', incorporado: esIncorporado(sup, p), quitado: !!p.fuera_alcance, delegados: (datos.delegados[p.id] || new Set()).size,
        estado: c ? c.estado : '', puntos: c ? c.puntos : 0, total: c ? c.total : 0, validacion: p.validacion || '', validado_en: p.validado_en || '' };
    })
  };
}

async function leer(env, actor, bloques) {
  const datos = await cargarCampana(env, actor.camp.id, bloques);
  return { datos, est: calcular(datos, actor.sup) };
}

// ---------------------------------------------------------------- consulta del Supervisor
export async function rutaFlujo(env, actor, bloques) {
  soloSupervisor(actor);
  const { est } = await leer(env, actor, bloques);
  return {
    ok: true, supervisor: { id: actor.sup.id, nombre: actor.sup.nombre }, perfil: actor.sup.perfil || 'gerente',
    paso_actual: est.paso_actual, vigentes: est.vigentes, confirmado: est.confirmado,
    compuertas: est.compuertas, aprobacion: est.aprobacion && { gerente: est.aprobacion.gerente, aprobado_en: est.aprobacion.aprobado_en, gerencias: JSON.parse(est.aprobacion.gerencias || '[]'), procesos: est.aprobacion.procesos },
    procesos: est.procesos
  };
}

// ---------------------------------------------------------------- guardia de cambios (también la usan /c/asignar y /c/personas)
// paso: el paso al que pertenece el cambio. severo: puede invalidar los pasos posteriores (quitar procesos, quitar responsables).
// Con la aprobación dada, nada cambia. Con pasos posteriores confirmados, un cambio severo pide confirmación y, si se fuerza, los reinicia.
export async function guardarCambio(env, actor, bloques, paso, forzar, severo) {
  if (actor.rol !== 'supervisor') return;
  const { est } = await leer(env, actor, bloques);
  if (est.aprobada) throw new HttpError(403, 'Ya diste tu aprobación final: no se puede cambiar nada. Si necesitas corregir algo, pídele al equipo consultor que la reabra.');
  const despues = est.vigentes.filter(n => n > paso);
  if (!severo || !despues.length) return;
  const nombres = despues.map(n => NOMBRE_PASO[n]).join(' y ');
  if (!forzar) {
    throw new HttpError(409, `Este cambio afecta pasos que ya confirmaste (${nombres}). Si continúas, tendrás que confirmarlos de nuevo.`,
      { requiere_confirmacion: true, se_reiniciaran: despues });
  }
  await env.DB.prepare('DELETE FROM flujo_pasos WHERE supervisor_id=? AND paso>?').bind(actor.sup.id, paso).run();
  await registrarAccion(env, actor.camp.id, actor, 'flujo_pasos_reiniciados', { desde: paso + 1, pasos: despues });
}

// ---------------------------------------------------------------- confirmar y retroceder
export async function rutaFlujoConfirmar(env, actor, b, bloques) {
  soloSupervisor(actor);
  const paso = Number(b.paso);
  if (![1, 2, 3, 4].includes(paso)) throw new HttpError(400, 'Paso inválido');
  const { est } = await leer(env, actor, bloques);
  if (est.aprobada) throw new HttpError(403, 'Tu aprobación final ya está dada.');
  if (paso === 4 && (actor.sup.perfil || 'gerente') !== 'gerente') throw new HttpError(403, 'La validación final la da el Gerente.');
  if (paso !== est.paso_actual) throw new HttpError(409, 'Los pasos se confirman en orden: ahora te corresponde el paso ' + est.paso_actual + '.');
  const gate = est.compuertas[paso];
  if (!gate.ok) throw new HttpError(409, paso === 1 ? gate.faltan[0] : 'Aún no puedes continuar: faltan ' + gate.faltan.length + ' proceso(s).', { faltan: gate.faltan });
  const t = ahora();
  if (paso < 4) {
    await env.DB.prepare('INSERT OR REPLACE INTO flujo_pasos (campana_id, supervisor_id, paso, confirmado_en) VALUES (?,?,?,?)').bind(actor.camp.id, actor.sup.id, paso, t).run();
    await env.DB.prepare('DELETE FROM flujo_pasos WHERE supervisor_id=? AND paso>?').bind(actor.sup.id, paso).run();
    await registrarAccion(env, actor.camp.id, actor, 'flujo_paso_confirmado', { paso, nombre: NOMBRE_PASO[paso] });
    log('flujo_paso', { campana: actor.camp.id, paso });
    return { ok: true, paso, paso_actual: paso + 1 };
  }
  if (b.confirmar_final !== true) throw new HttpError(400, 'La aprobación final requiere confirmar que entiendes que no se puede deshacer.');
  const gerencias = est.gerencias;
  await env.DB.prepare('INSERT INTO aprobaciones (id, campana_id, supervisor_id, gerente, gerencias, procesos, aprobado_en) VALUES (?,?,?,?,?,?,?)')
    .bind(uid(), actor.camp.id, actor.sup.id, actor.sup.nombre, JSON.stringify(gerencias), est.activos.length, t).run();
  await registrarAccion(env, actor.camp.id, actor, 'flujo_aprobacion_final', { gerencias, procesos: est.activos.length });
  log('flujo_aprobacion', { campana: actor.camp.id, procesos: est.activos.length });
  return { ok: true, paso: 4, paso_actual: COMPLETO };
}

// Retroceder = volver a editar el último paso confirmado (su confirmación se retira; los posteriores ya no estaban).
export async function rutaFlujoRetroceder(env, actor, bloques) {
  soloSupervisor(actor);
  const { est } = await leer(env, actor, bloques);
  if (est.aprobada) throw new HttpError(403, 'Tu aprobación final ya está dada: solo el equipo consultor puede reabrirla.');
  const ultimo = est.vigentes.length ? Math.max(...est.vigentes) : 0;
  if (!ultimo) throw new HttpError(409, 'Ya estás en el primer paso.');
  await env.DB.prepare('DELETE FROM flujo_pasos WHERE supervisor_id=? AND paso>=?').bind(actor.sup.id, ultimo).run();
  await registrarAccion(env, actor.camp.id, actor, 'flujo_retroceso', { a_paso: ultimo });
  return { ok: true, paso_actual: ultimo };
}

// ---------------------------------------------------------------- paso 1: agregar, quitar y restaurar procesos
export async function rutaFlujoProceso(env, actor, b, bloques) {
  soloSupervisor(actor);
  const accion = String(b.accion || '');
  if (!['agregar', 'incorporar', 'soltar', 'quitar', 'restaurar'].includes(accion)) throw new HttpError(400, 'Acción inválida');
  const { est } = await leer(env, actor, bloques);
  await guardarCambio(env, actor, bloques, 1, b.forzar === true, true);
  const camp = actor.camp, t = ahora();

  if (accion === 'agregar') {
    const f = { gerencia: txt(b.gerencia, 150), seccion: txt(b.seccion, 150), macroproceso: txt(b.macroproceso, 200),
      proceso: txt(b.proceso, 200), subproceso: txt(b.subproceso, 200), descripcion: txt(b.descripcion, 1500) };
    if (!f.proceso && !f.subproceso) throw new HttpError(400, 'Indica el nombre del proceso.');
    if (!f.gerencia || !f.seccion) throw new HttpError(400, 'Elige la sección del proceso.');
    if (!enSecs(est.amb, f.gerencia, f.seccion)) throw new HttpError(403, 'Esa sección no está dentro de tu alcance.');
    const nuevo = (f.subproceso || f.proceso).toLowerCase();
    if (est.procesos.some(p => mismaArea(p.seccion, f.seccion) && mismaArea(nombreProc(p), nuevo))) throw new HttpError(409, 'Ya existe un proceso con ese nombre en esa sección.');
    const id = uid();
    // fuente 'gerente': cuenta como parte del inventario (la encuesta lo muestra a la sección y la matriz lo incluye), a diferencia de 'nuevo'.
    await env.DB.prepare(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, descripcion, fuente, orden)
      VALUES (?,?,?,?,?,?,?,?,?,'gerente',6000)`).bind(id, camp.id, '', f.gerencia, f.seccion, f.macroproceso, f.proceso, f.subproceso, f.descripcion).run();
    await registrarAccion(env, camp.id, actor, 'proceso_agregado', { proceso_id: id, nombre: f.subproceso || f.proceso, seccion: f.seccion });
    return { ok: true, id };
  }

  if (accion === 'incorporar') return incorporar(env, actor, est, b);

  const p = est.procesos.find(x => x.id === txt(b.proceso_id, 60));
  if (!p) throw new HttpError(404, 'Proceso no encontrado en tu alcance');
  if (accion === 'soltar') {
    if (!p.incorporado) throw new HttpError(409, 'Ese proceso es de tu alcance: usa «Quitar» si ya no corresponde.');
    await guardarAlcance(env, actor, al => { al.procesos = al.procesos.filter(id => id !== p.id); });
    await registrarAccion(env, camp.id, actor, 'proceso_soltado', { proceso_id: p.id, nombre: nombreProc(p), seccion: p.seccion });
    return { ok: true, id: p.id };
  }
  if (accion === 'quitar') {
    if (p.incorporado) throw new HttpError(409, 'Ese proceso es de otra área: usa «Soltar» para dejar de gestionarlo.');
    if (p.quitado) throw new HttpError(409, 'Ese proceso ya está quitado.');
    if (p.validacion === 'validado') throw new HttpError(403, 'MBC ya validó ese proceso: pídele al equipo consultor que lo retire.');
    await env.DB.prepare("UPDATE procesos SET fuera_alcance=1, quitado_por=?, actualizado_en=? WHERE id=? AND campana_id=? AND fuera_alcance=0")
      .bind(actor.nombre, t, p.id, camp.id).run();
    await registrarAccion(env, camp.id, actor, 'proceso_quitado', { proceso_id: p.id, nombre: nombreProc(p), seccion: p.seccion });
  } else {
    if (!p.quitado) throw new HttpError(409, 'Ese proceso no está quitado.');
    await env.DB.prepare("UPDATE procesos SET fuera_alcance=0, quitado_por='', actualizado_en=? WHERE id=? AND campana_id=? AND quitado_por<>''")
      .bind(t, p.id, camp.id).run();
    await registrarAccion(env, camp.id, actor, 'proceso_restaurado', { proceso_id: p.id, nombre: nombreProc(p), seccion: p.seccion });
  }
  return { ok: true, id: p.id };
}

// Procesos ya cargados por MBC que no están en su alcance (de otras gerencias o secciones), para que los elija. No incluye los que MBC dejó
// fuera del levantamiento. Cada uno indica qué otros Gerentes ya lo gestionan.
export async function rutaFlujoCatalogo(env, actor, url, bloques) {
  soloSupervisor(actor);
  const { datos, est } = await leer(env, actor, bloques);
  const q = normal(url.searchParams.get('q') || '').split(' ').filter(Boolean);
  const otros = (await env.DB.prepare('SELECT id, nombre, alcance FROM supervisores WHERE campana_id=? AND activo=1 AND id<>?').bind(actor.camp.id, actor.sup.id).all()).results
    .map(s => ({ nombre: s.nombre, amb: ambitoSobre({ rol: 'supervisor', sup: s }, datos.procs) }));
  const lista = datos.procs.filter(p => !p.fuera_alcance && !est.amb.procs.has(p.id)).filter(p => {
    const t = normal([p.gerencia, p.seccion, p.macroproceso, p.proceso, p.subproceso, p.descripcion, p.codigo].join(' '));
    return q.every(w => t.includes(w));
  });
  return { ok: true, total: lista.length, procesos: lista.slice(0, 80).map(p => ({
    id: p.id, codigo: p.codigo, gerencia: p.gerencia, seccion: p.seccion, macroproceso: p.macroproceso, proceso: p.proceso, subproceso: p.subproceso,
    descripcion: p.descripcion || '', gestionado_por: otros.filter(o => o.amb.procs.has(p.id)).map(o => o.nombre) })) };
}

// Escribe un cambio en el alcance del Supervisor (siempre desde la fila actual, no desde la copia leída al entrar).
async function guardarAlcance(env, actor, cambiar) {
  const fila = await env.DB.prepare('SELECT alcance FROM supervisores WHERE id=?').bind(actor.sup.id).first();
  const al = alcanceDe(fila);
  cambiar(al);
  await env.DB.prepare('UPDATE supervisores SET alcance=? WHERE id=?')
    .bind(JSON.stringify({ todo: al.todo, gerencias: al.gerencias, secciones: al.secciones, procesos: [...new Set(al.procesos)] }), actor.sup.id).run();
}

async function incorporar(env, actor, est, b) {
  if (alcanceDe(actor.sup).todo) throw new HttpError(409, 'Ya tienes acceso a todos los procesos.');
  const ids = [...new Set((Array.isArray(b.proceso_ids) ? b.proceso_ids : []).map(x => txt(x, 60)).filter(Boolean))].slice(0, 100);
  if (!ids.length) throw new HttpError(400, 'Elige al menos un proceso.');
  const filas = [];
  for (let i = 0; i < ids.length; i += 30) {
    const tanda = ids.slice(i, i + 30);
    filas.push(...(await env.DB.prepare(`SELECT id, gerencia, seccion, subproceso, proceso, macroproceso, fuera_alcance FROM procesos WHERE campana_id=? AND id IN (${tanda.map(() => '?').join(',')})`)
      .bind(actor.camp.id, ...tanda).all()).results);
  }
  if (filas.length !== ids.length || filas.some(p => p.fuera_alcance)) throw new HttpError(404, 'Alguno de los procesos no está disponible.');
  const nuevos = filas.filter(p => !est.amb.procs.has(p.id));
  if (!nuevos.length) throw new HttpError(409, 'Esos procesos ya están en tu lista.');
  await guardarAlcance(env, actor, al => { al.procesos.push(...nuevos.map(p => p.id)); });
  await registrarAccion(env, actor.camp.id, actor, 'proceso_incorporado', { procesos: nuevos.length, nombres: nuevos.slice(0, 5).map(nombreProc) });
  return { ok: true, incorporados: nuevos.length };
}

// ---------------------------------------------------------------- consola de administración
// Resumen del flujo de cada Supervisor y de cada gerencia: sin iniciar, en curso o aprobada.
export async function rutaFlujoAdmin(env, camp, bloques) {
  const datos = await cargarCampana(env, camp.id, bloques);
  const sups = (await env.DB.prepare('SELECT id, nombre, alcance, activo FROM supervisores WHERE campana_id=? ORDER BY nombre').bind(camp.id).all()).results;
  const gerencias = {};
  const supervisores = sups.map(s => {
    const est = calcular(datos, s);
    const gers = est.gerencias;
    gers.forEach(g => { (gerencias[g] = gerencias[g] || []).push({ id: s.id, nombre: s.nombre, aprobada: est.aprobada, paso: est.paso_actual, aprobado_en: est.aprobacion ? est.aprobacion.aprobado_en : '' }); });
    return { id: s.id, nombre: s.nombre, activo: !!s.activo, paso_actual: est.paso_actual, vigentes: est.vigentes, aprobada: est.aprobada,
      aprobado_en: est.aprobacion ? est.aprobacion.aprobado_en : '', gerencias: gers, procesos: est.activos.length,
      validados: est.activos.filter(p => p.validacion === 'validado').length };
  });
  const porGerencia = {};
  Object.keys(gerencias).forEach(g => {
    const l = gerencias[g], todas = l.every(x => x.aprobada);
    porGerencia[g] = { estado: todas ? 'aprobada' : l.some(x => x.paso > 1) ? 'en_curso' : 'sin_iniciar', gerentes: l.map(x => x.nombre),
      aprobado_en: todas ? l.map(x => x.aprobado_en).sort().pop() : '' };
  });
  return { ok: true, supervisores, gerencias: porGerencia };
}

// Reabrir: la aprobación deja de valer y el Gerente puede corregir. Queda quién, cuándo y por qué.
export async function rutaFlujoReabrir(env, b) {
  const camp = await env.DB.prepare('SELECT id FROM campanas WHERE id=?').bind(txt(b.campana_id, 60)).first();
  if (!camp) throw new HttpError(404, 'Campaña no encontrada');
  const sup = await env.DB.prepare('SELECT id, nombre FROM supervisores WHERE id=? AND campana_id=?').bind(txt(b.supervisor_id, 60), camp.id).first();
  if (!sup) throw new HttpError(404, 'Supervisor no encontrado');
  const motivo = txt(b.motivo, 300), t = ahora();
  if (motivo.length < 5) throw new HttpError(400, 'Indica el motivo de la reapertura (al menos 5 caracteres).');
  const r = await env.DB.prepare("UPDATE aprobaciones SET activa=0, reabierta_en=?, reabierta_por=?, motivo=? WHERE supervisor_id=? AND activa=1")
    .bind(t, 'Consultor MBC', motivo, sup.id).run();
  if (!r.meta.changes) throw new HttpError(409, 'Ese Gerente no tiene una aprobación final vigente.');
  await registrarAccion(env, camp.id, { rol: 'admin', sup: null, nombre: 'Consultor MBC' }, 'flujo_reabierto', { gerente: sup.nombre, motivo });
  log('flujo_reabierto', { campana: camp.id });
  return { ok: true };
}
