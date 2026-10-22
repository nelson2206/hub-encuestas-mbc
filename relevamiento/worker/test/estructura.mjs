// Prueba de la hoja «Gerencias» (esqueleto Área > Gerencia > Sección) en la carga del Excel.
//   node test/estructura.mjs          → contra http://127.0.0.1:8787 (npm run dev); crea una campaña temporal y la borra
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787', ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE'); process.exit(2); }
const http = async (m, r, c) => { const x = await fetch(API + r, { method: m, headers: { origin: ORIGEN, 'content-type': 'application/json', 'x-admin-code': ADMIN }, body: c ? JSON.stringify(c) : undefined }); return Object.assign({ status: x.status }, await x.json().catch(() => ({}))); };
let fallas = 0, n = 0;
const ok = (c, t, extra) => { n++; if (c) console.log('  ok   ' + t); else { fallas++; console.log('  FALLA ' + t + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); } };

const suf = Date.now().toString(36), NOMBRE = 'Estructura ' + suf;
const cid = (await http('POST', '/a/campana', { nombre: NOMBRE, cliente: 'C' })).id;
const detalle = async () => http('GET', '/a/campana?id=' + cid);
const importar = c => http('POST', '/a/importar', Object.assign({ campana_id: cid, modo: 'agregar' }, c));
try {
  console.log('Solo el esqueleto (sin procesos)');
  let r = await importar({ estructura: [
    { area: 'Operaciones', gerencia: 'Logística', seccion: 'Importaciones' }, { area: 'Operaciones', gerencia: 'Logística', seccion: 'Almacenes' },
    { area: 'Soporte', gerencia: 'Finanzas', seccion: 'Tesorería' }, { area: '', gerencia: 'Legal', seccion: '' }, { area: 'x', gerencia: '', seccion: 'sin gerencia' }] });
  ok(r.ok && r.estructura && r.estructura.total === 4 && r.estructura.nuevas === 4, 'carga 4 filas válidas (descarta la que no trae gerencia)', r.estructura);
  let d = await detalle();
  ok(d.estructura.length === 4 && d.procesos.length === 0, 'el esqueleto queda guardado sin procesos', d.estructura.length);
  ok(d.estructura.filter(f => f.gerencia === 'Logística').every(f => f.area === 'Operaciones'), 'el área se asocia a la gerencia');

  console.log('Vinculación de personas y procesos (otra escritura, otras mayúsculas y tildes)');
  r = await importar({
    encuestados: [{ nombre: 'Ana Pérez', correo: 'ana@x.com', gerencia: 'LOGISTICA', seccion: 'importaciones' }, { nombre: 'Luis Rojas', correo: 'luis@x.com', gerencia: 'Finanzas', seccion: '' }],
    procesos: [
      { codigo: 'L1', gerencia: 'logistica', seccion: 'IMPORTACIONES', macroproceso: 'M', proceso: 'Importación de vehículos' },
      { codigo: 'L2', gerencia: 'Logística', seccion: 'Transporte', macroproceso: 'M', proceso: 'Gestión de flota' },
      { codigo: 'F1', gerencia: 'Finanzas', seccion: 'tesoreria', macroproceso: 'M', proceso: 'Pagos' }] });
  ok(r.ok && r.procesos === 3 && r.encuestados === 2, 'se cargan 3 procesos y 2 personas', r);
  d = await detalle();
  const p = c => d.procesos.find(x => x.codigo === c);
  ok(p('L1').gerencia === 'Logística' && p('L1').seccion === 'Importaciones', 'el proceso toma los nombres del esqueleto', [p('L1').gerencia, p('L1').seccion]);
  ok(p('F1').seccion === 'Tesorería', 'sin importar tildes ni mayúsculas');
  const ana = d.encuestados.find(e => e.nombre === 'Ana Pérez'), luis = d.encuestados.find(e => e.nombre === 'Luis Rojas');
  ok(ana.gerencia === 'Logística' && ana.seccion === 'Importaciones', 'la persona queda en su sección del esqueleto');
  ok(luis.seccion === 'Tesorería', 'una persona sin sección va a la única sección de su gerencia');
  ok(r.estructura.sin_vincular.length === 1 && r.estructura.sin_vincular[0].seccion === 'Transporte' && r.estructura.sin_vincular[0].procesos === 1, 'lo que no estaba en el esqueleto se informa', r.estructura.sin_vincular);
  ok(d.estructura.some(f => f.gerencia === 'Logística' && f.seccion === 'Transporte' && f.area === 'Operaciones'), 'y se agrega al esqueleto con el área de su gerencia');
  ok(d.estructura.length === 5, 'sin duplicar filas', d.estructura.length);

  console.log('Nueva carga del esqueleto');
  r = await importar({ estructura: [{ area: 'Servicios', gerencia: 'finanzas', seccion: 'Tesorería' }, { area: 'Servicios', gerencia: 'Comercial', seccion: 'Ventas' }] });
  ok(r.ok && r.estructura.nuevas === 1, 'agrega lo nuevo y no duplica lo existente', r.estructura);
  d = await detalle();
  ok(d.estructura.filter(f => f.gerencia === 'Finanzas').every(f => f.area === 'Servicios'), 'actualiza el área de una gerencia existente');
  ok(d.estructura.length === 6, 'seis filas en total', d.estructura.length);
  r = await importar({ estructura: [{ area: 'A', gerencia: 'Doble', seccion: 'S1' }, { area: 'B', gerencia: 'Doble', seccion: 'S2' }] });
  ok(r.estructura.avisos.length === 1, 'avisa si una gerencia aparece en dos áreas', r.estructura.avisos);

  console.log('Otras partes de la consola respetan el esqueleto');
  const mover = await http('POST', '/a/proceso/mover', { campana_id: cid, proceso_ids: [p('F1').id], gerencia: 'Legal', seccion: 'Contratos' });
  ok(mover.ok && (await detalle()).estructura.some(f => f.gerencia === 'Legal' && f.seccion === 'Contratos'), 'mover un proceso a una sección nueva la agrega al esqueleto', mover);
  const manual = await http('POST', '/a/proceso', { campana_id: cid, gerencia: 'Comercial', seccion: 'Postventa', proceso: 'Reclamos' });
  ok(manual.ok && (await detalle()).estructura.some(f => f.gerencia === 'Comercial' && f.seccion === 'Postventa' && f.area === 'Servicios'), 'un proceso creado a mano agrega su sección con el área de la gerencia');

  console.log('Reemplazar');
  r = await importar({ modo: 'reemplazar', estructura: [{ area: 'Única', gerencia: 'Solo', seccion: 'Una' }] });
  d = await detalle();
  ok(r.ok && d.estructura.length === 1 && d.estructura[0].gerencia === 'Solo' && d.procesos.length === 0, 'reemplazar también reemplaza el esqueleto', d.estructura.length);
  r = await importar({ modo: 'reemplazar', procesos: [{ gerencia: 'Otra', seccion: 'S', proceso: 'P' }] });
  d = await detalle();
  ok(r.ok && r.estructura === null && d.estructura.length === 0 && d.procesos.length === 1, 'reemplazar sin hoja Gerencias deja la campaña sin esqueleto, como antes', r.estructura);

  console.log('Campaña sin esqueleto: todo como siempre');
  r = await importar({ procesos: [{ gerencia: 'Libre', seccion: 'Sec', proceso: 'Otro' }], encuestados: [{ nombre: 'Pepe Lopez', correo: 'p@x.com', gerencia: 'Libre', seccion: 'Sec' }] });
  d = await detalle();
  ok(r.ok && r.estructura === null && d.estructura.length === 0, 'sin hoja Gerencias no se crea esqueleto ni avisos', r.estructura);
} finally {
  await http('POST', '/a/borrar-campana', { campana_id: cid, confirmar: NOMBRE });
}
console.log('\n' + (n - fallas) + ' de ' + n + ' comprobaciones correctas' + (fallas ? ' · ' + fallas + ' con falla' : ''));
process.exit(fallas ? 1 : 0);
