// Prueba de integración de los perfiles por persona (responsable / supervisor / gerente) que asigna el consultor.
//   node test/perfiles.mjs                  → contra http://127.0.0.1:8787 (npm run dev) con ADMIN_CODE de worker/.dev.vars
//   node test/perfiles.mjs --api URL        → otro Worker (usar solo uno de pruebas: crea una campaña y la borra al terminar)
// Crea su propia campaña ficticia, recorre los perfiles y la borra. No toca datos de otras campañas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787';
const ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)'); process.exit(2); }

async function http(metodo, ruta, { cuerpo, cab } = {}) {
  const r = await fetch(API + ruta, { method: metodo, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  return Object.assign({ status: r.status }, j);
}
const admin = (m, r, c) => http(m, r, { cuerpo: c, cab: { 'x-admin-code': ADMIN } });
const conClave = clave => (m, r, c) => http(m, r, { cuerpo: c, cab: { 'x-client-code': clave } });
let bien = 0, mal = 0;
const ok = (c, t, extra) => { if (c) { bien++; console.log('  ok   ' + t); } else { mal++; console.log('  FALLA ' + t, extra === undefined ? '' : JSON.stringify(extra)); } };

const sufijo = Math.random().toString(36).slice(2, 8), NOMBRE = 'Prueba perfiles ' + sufijo;
const camp = await admin('POST', '/a/campana', { nombre: NOMBRE, cliente: 'Cliente Prueba' });
const cid = camp.id;
try {
  const G = 'Operaciones', S = 'Planta';
  await admin('POST', '/a/importar', { campana_id: cid, modo: 'agregar', encuestados: [], procesos: [
    { gerencia: G, seccion: S, proceso: 'Proceso uno' }, { gerencia: G, seccion: 'Taller', proceso: 'Proceso dos' } ] });
  await admin('POST', '/a/encuestado', { campana_id: cid, personas: [
    { nombre: 'Ana Gerente', correo: 'ana@x.com', gerencia: G, seccion: S }, { nombre: 'Luis Supervisor', correo: 'luis@x.com', gerencia: G, seccion: S },
    { nombre: 'Pedro Sinarea', correo: 'pedro@x.com', gerencia: 'Inexistente', seccion: 'Nada' } ] });
  let d = await admin('GET', '/a/campana?id=' + cid);
  const ana = d.encuestados.find(e => e.nombre === 'Ana Gerente'), luis = d.encuestados.find(e => e.nombre === 'Luis Supervisor'), pedro = d.encuestados.find(e => e.nombre === 'Pedro Sinarea');
  ok(d.encuestados.every(e => e.perfil === 'responsable'), 'todos empiezan como responsables');

  console.log('Asignar perfiles');
  const sinCodigo = await http('POST', '/a/persona/perfil', { cuerpo: { campana_id: cid, encuestado_id: ana.id, perfil: 'gerente' } });
  ok(sinCodigo.status === 401, 'sin código de administración no se asigna', sinCodigo.status);
  let r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: ana.id, perfil: 'gerente' });
  ok(r.ok && r.perfil === 'gerente' && r.clave && r.clave.length >= 8, 'se asigna Gerente y se entrega una clave', r);
  const claveAna = r.clave;
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: luis.id, perfil: 'supervisor' });
  ok(r.ok && r.perfil === 'supervisor' && r.clave, 'se asigna Supervisor y se entrega una clave', r);
  const claveLuis = r.clave;
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: pedro.id, perfil: 'gerente' });
  ok(r.status === 400 && /No hay procesos/.test(r.error || ''), 'si su gerencia no existe en el mapa se explica y no se crea', r);
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: ana.id, perfil: 'otro' });
  ok(r.status === 400, 'un perfil desconocido se rechaza');
  d = await admin('GET', '/a/campana?id=' + cid);
  ok(d.encuestados.find(e => e.id === ana.id).perfil === 'gerente' && d.encuestados.find(e => e.id === luis.id).perfil === 'supervisor' && d.encuestados.find(e => e.id === pedro.id).perfil === 'responsable', 'la consola ve el perfil de cada persona');

  console.log('Lo que puede hacer cada perfil');
  await admin('POST', '/a/campana/cliente', { campana_id: cid, accion: 'definir', codigo: 'ClienteDePrueba26' });
  const ger = conClave(claveAna), sup = conClave(claveLuis);
  const fa = await ger('GET', '/c/flujo'), fl = await sup('GET', '/c/flujo');
  ok(fa.ok && fa.perfil === 'gerente' && fl.ok && fl.perfil === 'supervisor', 'cada uno entra con su clave y el flujo informa su perfil', [fa.perfil, fl.perfil]);
  ok(fa.procesos.length === 2, 'el Gerente ve toda su gerencia (2 procesos)', fa.procesos && fa.procesos.length);
  ok(fl.procesos.length === 1, 'el Supervisor ve solo su sección (1 proceso)', fl.procesos && fl.procesos.length);
  const cf = await sup('POST', '/c/flujo/confirmar', { paso: 4 });
  ok(cf.status === 403 && /Gerente/.test(cf.error || ''), 'el Supervisor no puede dar la validación final', cf);

  console.log('Clave nueva y quitar el perfil');
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: luis.id, perfil: 'supervisor', regenerar: true });
  ok(r.ok && r.clave && r.clave !== claveLuis, 'una clave nueva reemplaza a la anterior', r);
  ok((await sup('GET', '/c/flujo')).status === 401, 'la clave anterior deja de servir');
  ok((await conClave(r.clave)('GET', '/c/flujo')).ok, 'la clave nueva entra');
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: luis.id, perfil: 'responsable' });
  ok(r.ok && !r.clave, 'se quita el perfil');
  r = await admin('POST', '/a/persona/perfil', { campana_id: cid, encuestado_id: luis.id, perfil: 'supervisor' });
  ok(r.ok && !r.clave, 'volver a darle el perfil reactiva su acceso sin cambiar la clave');
  const tr = await admin('GET', '/a/campana/trazabilidad?id=' + cid);
  ok((tr.acciones || []).some(a => a.accion === 'perfil_asignado') && (tr.acciones || []).some(a => a.accion === 'perfil_quitado'), 'las asignaciones quedan en la trazabilidad');
} finally {
  await admin('POST', '/a/borrar-campana', { campana_id: cid, confirmar: NOMBRE });
}
console.log('\n' + bien + ' de ' + (bien + mal) + ' comprobaciones correctas');
process.exit(mal ? 1 : 0);
