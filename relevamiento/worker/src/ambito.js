// Ámbito de quien entra al panel del cliente (administrador del cliente o Supervisor) y registro de sus acciones.
// Lo comparten las rutas /c/* de index.js y el flujo del Supervisor (flujo.js).
import { ahora, uid, normal } from './comun.js';

export const claveArea = (g, sec) => normal(g) + '|' + normal(sec);

// Qué procesos y secciones caen dentro del alcance de quien entra, a partir de las filas {id, gerencia, seccion} de la campaña.
// El administrador del cliente: todo (secs = null). Un Supervisor: lo que dice su alcance.
export function ambitoSobre(actor, filas) {
  if (actor.rol !== 'supervisor') return { todo: true, procs: new Set(filas.map(p => p.id)), secs: null, filas };
  let al = {}; try { al = JSON.parse(actor.sup.alcance || '{}') || {}; } catch (e) { al = {}; }
  const gers = (al.gerencias || []).map(normal), secs = new Set((al.secciones || []).map(x => claveArea(x.g, x.s))), ids = new Set(al.procesos || []);
  const dentro = al.todo ? filas : filas.filter(p => ids.has(p.id) || gers.includes(normal(p.gerencia)) || secs.has(claveArea(p.gerencia, p.seccion)));
  return { todo: !!al.todo, procs: new Set(dentro.map(p => p.id)), secs: new Set(dentro.map(p => claveArea(p.gerencia, p.seccion))), filas: dentro };
}
export async function ambitoDe(env, actor) {
  const filas = (await env.DB.prepare('SELECT id, gerencia, seccion FROM procesos WHERE campana_id=?').bind(actor.camp.id).all()).results;
  return ambitoSobre(actor, filas);
}
export const enSecs = (amb, g, sec) => amb.secs === null || amb.secs.has(claveArea(g, sec));

export async function registrarAccion(env, campId, actor, accion, detalle) {
  await env.DB.prepare('INSERT INTO acciones (id, campana_id, actor_tipo, actor_id, actor_nombre, accion, detalle, creado) VALUES (?,?,?,?,?,?,?,?)')
    .bind(uid(), campId, actor.rol, actor.sup ? actor.sup.id : '', actor.nombre, accion, typeof detalle === 'string' ? detalle : JSON.stringify(detalle || {}), ahora()).run();
}

// Alcance de un Supervisor leído de su fila (JSON), y si un proceso está en él solo porque se incorporó a mano
// (su id está en alcance.procesos, pero su gerencia o sección no entran por el alcance de áreas).
export function alcanceDe(sup) {
  let al = {}; try { al = JSON.parse(sup.alcance || '{}') || {}; } catch (e) { al = {}; }
  return { todo: !!al.todo, gerencias: al.gerencias || [], secciones: al.secciones || [], procesos: al.procesos || [] };
}
export function esIncorporado(sup, p) {
  const al = alcanceDe(sup);
  if (al.todo || !al.procesos.includes(p.id)) return false;
  return !al.gerencias.some(g => normal(g) === normal(p.gerencia)) && !al.secciones.some(x => claveArea(x.g, x.s) === claveArea(p.gerencia, p.seccion));
}
