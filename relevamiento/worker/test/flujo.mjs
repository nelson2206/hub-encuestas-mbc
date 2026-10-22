// Prueba de integración del flujo guiado del Supervisor (pasos, compuertas, advertencias, aprobación y reapertura).
//   node test/flujo.mjs                     → contra http://127.0.0.1:8787 (npm run dev) con ADMIN_CODE de worker/.dev.vars
//   node test/flujo.mjs --api URL           → otro Worker (usar solo uno de pruebas: crea una campaña y la borra al terminar)
// Crea su propia campaña de prueba, recorre el flujo y la borra. No toca datos de otras campañas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787';
const ORIGEN = arg('--origen') || 'http://localhost:8080';
function codigoAdmin() {
  if (process.env.ADMIN_CODE) return process.env.ADMIN_CODE;
  try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; }
}
const ADMIN = codigoAdmin();
if (!ADMIN) { console.error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)'); process.exit(2); }

async function http(metodo, ruta, { cuerpo, cab } = {}) {
  const r = await fetch(API + ruta, { method: metodo, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  return Object.assign({ status: r.status }, j);
}
const admin = (m, r, c) => http(m, r, { cuerpo: c, cab: { 'x-admin-code': ADMIN } });
const cliente = clave => (m, r, c) => http(m, r, { cuerpo: c, cab: { 'x-client-code': clave } });

let fallas = 0, n = 0;
function ok(cond, texto, extra) {
  n++;
  if (cond) console.log('  ok   ' + texto);
  else { fallas++; console.log('  FALLA ' + texto + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

const sufijo = Date.now().toString(36);
const G = 'Gerencia Prueba ' + sufijo, S = 'Seccion A', S2 = 'Seccion B', GAJENA = 'Gerencia Ajena ' + sufijo;
const CLAVE_CLIENTE = 'Cliente' + sufijo + '9x';

console.log('Preparando campaña de prueba…');
const camp = await admin('POST', '/a/campana', { nombre: 'Prueba flujo ' + sufijo, cliente: 'Cliente Prueba' });
const cid = camp.id;
try {
  const proc = async (g, s, nombre) => (await admin('POST', '/a/proceso', { campana_id: cid, gerencia: g, seccion: s, proceso: nombre, descripcion: 'Descripción de ' + nombre })).id;
  const p1 = await proc(G, S, 'Proceso uno'), p2 = await proc(G, S, 'Proceso dos'), pAjeno = await proc(GAJENA, 'Otra', 'Proceso ajeno');
  await admin('POST', '/a/campana/cliente', { campana_id: cid, accion: 'definir', codigo: CLAVE_CLIENTE });
  const dueno = cliente(CLAVE_CLIENTE);
  const sup = await dueno('POST', '/c/supervisores', { accion: 'crear', nombre: 'Gerente de Prueba', alcance: { gerencias: [G] } });
  const gerente = cliente(sup.clave);
  const alta = await admin('POST', '/a/encuestado', { campana_id: cid, personas: [{ nombre: 'Persona Responsable', gerencia: G, seccion: S }] });
  const pid = alta.nuevos[0].id;
  const detalle = await admin('GET', '/a/campana?id=' + cid);
  const token = detalle.encuestados.find(e => e.id === pid).token;

  console.log('Acceso');
  ok((await dueno('GET', '/c/flujo')).status === 403, 'el administrador del cliente no tiene el flujo');
  let f = await gerente('GET', '/c/flujo');
  ok(f.ok && f.paso_actual === 1, 'el Gerente empieza en el paso 1', f.paso_actual);
  ok(f.procesos.length === 2 && !f.procesos.some(p => p.id === pAjeno), 'solo ve los procesos de su alcance', f.procesos && f.procesos.length);
  ok(f.procesos.every(p => p.descripcion.startsWith('Descripción')), 'recibe la descripción de cada proceso');
  ok(!JSON.stringify(f).includes('matriz'), 'no recibe la matriz');

  console.log('Paso 1 · procesos');
  ok((await gerente('POST', '/c/flujo/confirmar', { paso: 2 })).status === 409, 'no se puede saltar al paso 2');
  const fuera = await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: GAJENA, seccion: 'Otra', proceso: 'Intruso' });
  ok(fuera.status === 403, 'no agrega procesos fuera de su alcance', fuera.status);
  const dup = await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: G, seccion: S, proceso: 'proceso UNO' });
  ok(dup.status === 409, 'no agrega un duplicado', dup.status);
  const nuevo = await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: G, seccion: S, proceso: 'Proceso tres', descripcion: 'Agregado por el Gerente' });
  ok(nuevo.ok, 'agrega un proceso nuevo', nuevo);
  f = await gerente('GET', '/c/flujo');
  ok(f.procesos.length === 3 && f.procesos.find(p => p.id === nuevo.id).agregado, 'el proceso nuevo aparece marcado como agregado');
  const enMatriz = (await admin('GET', '/a/campana?id=' + cid)).procesos.find(p => p.id === nuevo.id);
  ok(enMatriz && enMatriz.fuente === 'gerente' && !enMatriz.fuera_alcance, 'el proceso nuevo entra al inventario final (consola)', enMatriz && enMatriz.fuente);
  const quitado = await gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: nuevo.id });
  ok(quitado.ok, 'quita el proceso');
  f = await gerente('GET', '/c/flujo');
  ok(f.procesos.find(p => p.id === nuevo.id).quitado && f.compuertas[2].faltan.length === 2, 'un proceso quitado deja de contar');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'restaurar', proceso_id: nuevo.id })).ok, 'lo restaura');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: nuevo.id })).ok, 'lo vuelve a quitar');
  console.log('Paso 1 · elegir procesos ya cargados por MBC');
  let cat = await gerente('GET', '/c/flujo/catalogo');
  ok(cat.ok && cat.procesos.some(p => p.id === pAjeno) && !cat.procesos.some(p => p.id === p1), 'el catálogo ofrece procesos de otras gerencias y no los propios', cat.procesos && cat.procesos.length);
  ok((await gerente('GET', '/c/flujo/catalogo?q=intruso')).procesos.length === 0 && (await gerente('GET', '/c/flujo/catalogo?q=PROCESO ajeno')).procesos.length === 1, 'el buscador filtra sin importar mayúsculas');
  ok((await dueno('GET', '/c/flujo/catalogo')).status === 403, 'el catálogo es solo del Gerente');
  const inc = await gerente('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [pAjeno] });
  ok(inc.ok && inc.incorporados === 1, 'incorpora un proceso del inventario', inc);
  f = await gerente('GET', '/c/flujo');
  ok(f.procesos.find(p => p.id === pAjeno) && f.procesos.find(p => p.id === pAjeno).incorporado, 'aparece en su lista marcado como incorporado');
  cat = await gerente('GET', '/c/flujo/catalogo');
  ok(!cat.procesos.some(p => p.id === pAjeno), 'ya no se ofrece en el catálogo');
  ok((await admin('GET', '/a/campana?id=' + cid)).procesos.find(p => p.id === pAjeno).fuera_alcance === 0, 'el inventario no cambia: el proceso sigue vigente para todos');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [pAjeno] })).status === 409, 'no se incorpora dos veces');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: pAjeno })).status === 409, 'un proceso incorporado no se «quita» del inventario');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'soltar', proceso_id: p1 })).status === 409, 'un proceso propio no se «suelta»');
  ok(!Object.keys((await admin('GET', '/a/campana/flujo?id=' + cid)).gerencias).includes(GAJENA), 'la consola no lo toma como gerencia del Gerente');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'soltar', proceso_id: pAjeno })).ok, 'lo suelta');
  f = await gerente('GET', '/c/flujo');
  ok(!f.procesos.some(p => p.id === pAjeno), 'deja de estar en su lista');
  ok((await admin('GET', '/a/campana?id=' + cid)).procesos.find(p => p.id === pAjeno).fuera_alcance === 0, 'y sigue vigente en el inventario');
  ok((await gerente('POST', '/c/flujo/confirmar', { paso: 1 })).ok, 'confirma el paso 1');

  console.log('Paso 2 · delegación');
  const sinDelegar = await gerente('POST', '/c/flujo/confirmar', { paso: 2 });
  ok(sinDelegar.status === 409 && sinDelegar.faltan.length === 2, 'no continúa con procesos sin responsable', sinDelegar);
  ok((await gerente('POST', '/c/asignar', { encuestado_id: pid, agregar: [p1, p2] })).ok, 'delega los procesos a una persona');
  ok((await gerente('POST', '/c/flujo/confirmar', { paso: 2 })).ok, 'confirma el paso 2');

  console.log('Paso 3 · avance');
  const sinResp = await gerente('POST', '/c/flujo/confirmar', { paso: 3 });
  ok(sinResp.status === 409 && sinResp.faltan.length === 2, 'no continúa con procesos sin responder', sinResp);
  const sesion = await http('GET', '/r/sesion?k=' + token);
  const puntos = sesion.bloques.flatMap(b => b.puntos.map(x => ({ bloque: b.id, punto: x[0] })));
  for (const pr of [p1, p2]) for (const x of puntos) await http('POST', '/r/punto', { cuerpo: { k: token, proceso_id: pr, pregunta: x.bloque, punto: x.punto, estado: 'cubierto' } });
  f = await gerente('GET', '/c/flujo');
  ok(f.procesos.filter(p => p.estado === 'respondido').length === 2, 'los procesos con checklist completo cuentan como respondidos', f.procesos.map(p => p.estado));
  ok((await gerente('POST', '/c/flujo/confirmar', { paso: 3 })).ok, 'confirma el paso 3');
  f = await gerente('GET', '/c/flujo');
  ok(f.paso_actual === 4, 'queda en el paso 4', f.paso_actual);

  console.log('Advertencia al cambiar pasos anteriores');
  const sinForzar = await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: G, seccion: S, proceso: 'Proceso cuatro' });
  ok(sinForzar.status === 409 && sinForzar.requiere_confirmacion && sinForzar.se_reiniciaran.join() === '2,3', 'avisa antes de reiniciar los pasos 2 y 3', sinForzar);
  f = await gerente('GET', '/c/flujo');
  ok(f.paso_actual === 4 && f.procesos.length === 3, 'sin confirmar, no cambia nada', f.paso_actual);
  const forzado = await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: G, seccion: S, proceso: 'Proceso cuatro', forzar: true });
  ok(forzado.ok, 'con confirmación aplica el cambio');
  f = await gerente('GET', '/c/flujo');
  ok(f.paso_actual === 2, 'y reinicia los pasos siguientes: vuelve al paso 2', f.paso_actual);
  const quitar4 = await gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: forzado.id });
  ok(quitar4.ok, 'quita el proceso agregado (sin pasos posteriores no hay advertencia)');
  const retro = await gerente('POST', '/c/flujo/retroceder', {});
  ok(retro.ok && retro.paso_actual === 1, 'retroceder vuelve a editar el último paso confirmado', retro);
  ok((await gerente('POST', '/c/flujo/confirmar', { paso: 1 })).ok && (await gerente('POST', '/c/flujo/confirmar', { paso: 2 })).ok && (await gerente('POST', '/c/flujo/confirmar', { paso: 3 })).ok, 'vuelve a confirmar 1, 2 y 3');

  console.log('Paso 4 · aprobación final');
  const sinValidar = await gerente('POST', '/c/flujo/confirmar', { paso: 4, confirmar_final: true });
  ok(sinValidar.status === 409 && sinValidar.faltan.length === 2, 'no aprueba mientras MBC no haya validado todo', sinValidar);
  for (const pr of [p1, p2]) await admin('POST', '/a/matriz', { proceso_id: pr, validacion: 'validado', validado_por: 'Consultor' });
  const sinAviso = await gerente('POST', '/c/flujo/confirmar', { paso: 4 });
  ok(sinAviso.status === 400, 'exige confirmar que no se puede deshacer', sinAviso.status);
  const aprobado = await gerente('POST', '/c/flujo/confirmar', { paso: 4, confirmar_final: true });
  ok(aprobado.ok && aprobado.paso_actual === 5, 'da la aprobación final', aprobado);

  console.log('Aprobación dada: todo congelado');
  ok((await gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: G, seccion: S, proceso: 'Tarde' })).status === 403, 'no agrega procesos');
  ok((await gerente('POST', '/c/asignar', { encuestado_id: pid, desasignar: [p1] })).status === 403, 'no quita responsables');
  ok((await gerente('POST', '/c/flujo/retroceder', {})).status === 403, 'no retrocede');

  console.log('Consola de administración');
  let a = await admin('GET', '/a/campana/flujo?id=' + cid);
  ok(a.gerencias[G] && a.gerencias[G].estado === 'aprobada', 'la gerencia figura como aprobada', a.gerencias);
  ok((await admin('POST', '/a/flujo/reabrir', { campana_id: cid, supervisor_id: sup.id, motivo: 'no' })).status === 400, 'reabrir exige un motivo');
  ok((await admin('POST', '/a/flujo/reabrir', { campana_id: cid, supervisor_id: sup.id, motivo: 'Se corrige un proceso' })).ok, 'MBC reabre la aprobación');
  a = await admin('GET', '/a/campana/flujo?id=' + cid);
  ok(a.gerencias[G].estado === 'en_curso', 'la gerencia deja de figurar como aprobada', a.gerencias[G]);
  f = await gerente('GET', '/c/flujo');
  ok(f.paso_actual === 4 && !f.aprobacion, 'el Gerente vuelve al paso 4');
  ok((await admin('POST', '/a/flujo/reabrir', { campana_id: cid, supervisor_id: sup.id, motivo: 'otra vez sin aprobar' })).status === 409, 'no se reabre dos veces');
  ok((await http('GET', '/a/campana/flujo?id=' + cid)).status === 401, 'sin código de administración no se consulta');
} finally {
  await admin('POST', '/a/borrar-campana', { campana_id: cid, confirmar: 'Prueba flujo ' + sufijo });
}
console.log('\n' + (n - fallas) + ' de ' + n + ' comprobaciones correctas' + (fallas ? ' · ' + fallas + ' con falla' : ''));
process.exit(fallas ? 1 : 0);
