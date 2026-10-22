// Datos de demostración para probar el flujo del Gerente: una empresa FICTICIA ("Empresa Demo"), sin datos de ningún cliente.
//   node test/semilla-demo.mjs                  → contra http://127.0.0.1:8787 (npm run dev); borra y vuelve a crear la campaña de demo
//   node test/semilla-demo.mjs --api URL        → otro Worker (solo uno de pruebas)
//
// Deja tres Gerentes en etapas distintas para recorrer todo el flujo, y dos gerencias sin Gerente para probar «Elegir del inventario»:
//   Operaciones  → paso 1 (empieza desde cero; MBC ya asignó los procesos de Planta)
//   Finanzas     → paso 3 (ya confirmó procesos y delegación; respuestas a medias)
//   Comercial    → paso 4 (todo respondido y validado por MBC: listo para la validación final)
//   Recursos Humanos y Tecnología → sin Gerente (sus procesos se pueden elegir del inventario)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787', ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)'); process.exit(2); }

const NOMBRE = 'Demo flujo del Gerente', CLAVE_CLIENTE = 'DemoCliente2026';
const GERENTES = [
  { nombre: 'Gerente de Operaciones', clave: 'GerenteOps2026', gerencia: 'Operaciones' },
  { nombre: 'Gerente de Finanzas', clave: 'GerenteFin2026', gerencia: 'Finanzas' },
  { nombre: 'Gerente Comercial', clave: 'GerenteCom2026', gerencia: 'Comercial' }
];

// gerencia → sección → [macroproceso, proceso, descripción]
const INVENTARIO = {
  'Operaciones': {
    'Planta': [
      ['Producción', 'Programación de la producción', 'Define qué se produce, cuándo y en qué línea según la demanda y la disponibilidad de materiales.'],
      ['Producción', 'Registro de producción diaria', 'Captura las unidades producidas por turno y línea para medir cumplimiento del plan.'],
      ['Calidad', 'Control de calidad en línea', 'Inspección del producto durante la producción para detectar desvíos a tiempo.'],
      ['Calidad', 'Gestión de no conformidades', 'Registro, análisis de causa y cierre de los productos o procesos que no cumplen la especificación.']
    ],
    'Mantenimiento': [
      ['Mantenimiento', 'Mantenimiento preventivo', 'Plan periódico de revisión de equipos para evitar paradas imprevistas.'],
      ['Mantenimiento', 'Mantenimiento correctivo', 'Atención de fallas de equipos: diagnóstico, reparación y registro de la intervención.'],
      ['Abastecimiento técnico', 'Gestión de repuestos', 'Control de stock mínimo, solicitud y recepción de repuestos críticos.'],
      ['Mantenimiento', 'Calibración de equipos', 'Calibración periódica de instrumentos de medición con certificado vigente.']
    ],
    'Logística': [
      ['Abastecimiento', 'Recepción de materiales', 'Verifica cantidad y calidad de lo recibido contra la orden de compra y lo ingresa al almacén.'],
      ['Distribución', 'Despacho de producto terminado', 'Prepara, documenta y entrega los pedidos al transportista.'],
      ['Almacenes', 'Control de inventarios', 'Conteos cíclicos y conciliación del stock físico con el sistema.'],
      ['Distribución', 'Gestión de transportistas', 'Selección, programación y evaluación de los proveedores de transporte.']
    ]
  },
  'Finanzas': {
    'Tesorería': [
      ['Tesorería', 'Programación de pagos', 'Calendario semanal de pagos a proveedores según vencimientos y caja disponible.'],
      ['Tesorería', 'Conciliación bancaria', 'Compara los movimientos del banco con los registros contables y explica las diferencias.'],
      ['Cobranzas', 'Gestión de cobranzas', 'Seguimiento de facturas vencidas y gestión de cobro con los clientes.'],
      ['Tesorería', 'Flujo de caja proyectado', 'Proyección semanal de ingresos y egresos para anticipar necesidades de financiamiento.']
    ],
    'Contabilidad': [
      ['Cierre', 'Cierre contable mensual', 'Calendario de cierres, provisiones, conciliaciones y emisión de estados financieros.'],
      ['Cuentas por pagar', 'Registro de facturas de proveedores', 'Validación y contabilización de comprobantes recibidos de proveedores.'],
      ['Cuentas por pagar', 'Conciliación de cuentas por pagar', 'Concilia el saldo contable con los estados de cuenta de los proveedores.'],
      ['Impuestos', 'Declaración de impuestos mensual', 'Cálculo, revisión y presentación de las obligaciones tributarias del mes.']
    ],
    'Presupuestos': [
      ['Planeamiento', 'Elaboración del presupuesto anual', 'Consolida los presupuestos de cada área y los presenta para aprobación de la gerencia general.'],
      ['Planeamiento', 'Seguimiento presupuestal', 'Compara lo ejecutado contra lo presupuestado y reporta desviaciones mensuales.'],
      ['Planeamiento', 'Aprobación de gastos extraordinarios', 'Evalúa y aprueba gastos no presupuestados según el nivel de autorización.']
    ]
  },
  'Comercial': {
    'Ventas': [
      ['Ventas', 'Cotización a clientes', 'Prepara y envía cotizaciones con precios, plazos y condiciones vigentes.'],
      ['Ventas', 'Registro de pedidos', 'Ingreso del pedido del cliente al sistema y validación de stock y crédito.'],
      ['Ventas', 'Gestión de créditos a clientes', 'Evalúa y aprueba las líneas de crédito y revisa su uso.'],
      ['Ventas', 'Seguimiento de la cartera de clientes', 'Visitas, oportunidades y metas por cliente y ejecutivo comercial.']
    ],
    'Postventa': [
      ['Servicio al cliente', 'Atención de reclamos', 'Recepción, clasificación y respuesta de los reclamos de clientes dentro del plazo acordado.'],
      ['Servicio al cliente', 'Gestión de garantías', 'Evalúa y atiende las solicitudes de garantía de productos vendidos.'],
      ['Servicio al cliente', 'Encuesta de satisfacción', 'Aplica y analiza la encuesta de satisfacción posterior a la entrega.']
    ],
    'Marketing': [
      ['Marketing', 'Planificación de campañas', 'Define objetivos, públicos, canales y presupuesto de cada campaña.'],
      ['Marketing', 'Gestión de eventos', 'Organiza ferias y eventos con clientes: proveedores, logística y evaluación de resultados.']
    ]
  },
  'Recursos Humanos': {
    'Gestión de personal': [
      ['Talento', 'Reclutamiento y selección', 'Publica la vacante, evalúa candidatos y gestiona la contratación.'],
      ['Talento', 'Inducción de personal nuevo', 'Programa de bienvenida, accesos y capacitación inicial del colaborador.'],
      ['Compensaciones', 'Planilla de remuneraciones', 'Cálculo mensual de haberes, descuentos y aportes, y su pago.'],
      ['Desempeño', 'Evaluación de desempeño', 'Ciclo anual de objetivos, evaluación y retroalimentación.'],
      ['Desarrollo', 'Gestión de capacitaciones', 'Detecta necesidades, contrata y registra la asistencia y el costo de las capacitaciones.']
    ]
  },
  'Tecnología': {
    'Infraestructura y soporte': [
      ['Seguridad', 'Gestión de accesos y usuarios', 'Alta, modificación y baja de usuarios y permisos en los sistemas.'],
      ['Continuidad', 'Respaldo y recuperación de información', 'Copias de seguridad programadas y pruebas periódicas de restauración.'],
      ['Soporte', 'Atención de incidentes de TI', 'Mesa de ayuda: registro, priorización y solución de incidentes.'],
      ['Cambios', 'Gestión de cambios en sistemas', 'Solicitud, prueba, aprobación y puesta en producción de cambios.']
    ]
  }
};
const PERSONAS = [
  ['Carla Mendoza', 'Operaciones', 'Planta'], ['Luis Quispe', 'Operaciones', 'Mantenimiento'], ['Rosa Huamán', 'Operaciones', 'Logística'],
  ['Jorge Salas', 'Finanzas', 'Tesorería'], ['Patricia Ramos', 'Finanzas', 'Contabilidad'], ['Miguel Torres', 'Finanzas', 'Presupuestos'],
  ['Andrea Vargas', 'Comercial', 'Ventas'], ['Diego Paredes', 'Comercial', 'Postventa'], ['Lucía Rojas', 'Comercial', 'Marketing']
];

async function http(metodo, ruta, cuerpo, cab) {
  const r = await fetch(API + ruta, { method: metodo, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(metodo + ' ' + ruta + ' → ' + r.status + ' ' + (j.error || ''));
  return j;
}
const admin = (m, r, c) => http(m, r, c, { 'x-admin-code': ADMIN });
const como = clave => (m, r, c) => http(m, r, c, { 'x-client-code': clave });

console.log('Recreando la campaña «' + NOMBRE + '»…');
for (const c of (await admin('GET', '/a/campanas')).campanas.filter(x => x.nombre === NOMBRE)) await admin('POST', '/a/borrar-campana', { campana_id: c.id, confirmar: NOMBRE });
const cid = (await admin('POST', '/a/campana', { nombre: NOMBRE, cliente: 'Empresa Demo (ficticia)' })).id;

// Esqueleto (hoja «Gerencias»): áreas, gerencias y secciones; Legal queda sin procesos para ver una gerencia vacía en el mapa
const AREAS = { 'Operaciones': 'Operaciones e Industria', 'Comercial': 'Negocio', 'Finanzas': 'Soporte corporativo', 'Recursos Humanos': 'Soporte corporativo', 'Tecnología': 'Soporte corporativo', 'Legal': 'Soporte corporativo' };
const esqueleto = Object.entries(INVENTARIO).flatMap(([g, secs]) => Object.keys(secs).map(s => ({ area: AREAS[g], gerencia: g, seccion: s })))
  .concat([{ area: AREAS.Legal, gerencia: 'Legal', seccion: 'Contratos' }, { area: AREAS.Legal, gerencia: 'Legal', seccion: 'Cumplimiento' }]);
await admin('POST', '/a/importar', { campana_id: cid, modo: 'agregar', estructura: esqueleto });
console.log('  esqueleto: ' + esqueleto.length + ' secciones en ' + new Set(Object.values(AREAS)).size + ' áreas');

const ids = {};   // "gerencia|sección" → [id de proceso]
let n = 0;
for (const [g, secs] of Object.entries(INVENTARIO)) for (const [s, lista] of Object.entries(secs)) {
  ids[g + '|' + s] = [];
  let i = 0;
  for (const [macro, nombre, desc] of lista) {
    const r = await admin('POST', '/a/proceso', { campana_id: cid, gerencia: g, seccion: s, macroproceso: macro, proceso: nombre, descripcion: desc, codigo: g.slice(0, 3).toUpperCase() + '-' + s.slice(0, 3).toUpperCase() + '-' + String(++i).padStart(2, '0') });
    ids[g + '|' + s].push(r.id); n++;
  }
}
console.log('  ' + n + ' procesos en ' + Object.keys(INVENTARIO).length + ' gerencias');

await admin('POST', '/a/campana/cliente', { campana_id: cid, accion: 'definir', codigo: CLAVE_CLIENTE });
const dueno = como(CLAVE_CLIENTE);
const alta = await admin('POST', '/a/encuestado', { campana_id: cid, personas: PERSONAS.map(([nombre, gerencia, seccion]) => ({ nombre, gerencia, seccion })) });
const detalle = await admin('GET', '/a/campana?id=' + cid);
const persona = (g, s) => detalle.encuestados.find(e => e.gerencia === g && e.seccion === s);
for (const g of GERENTES) await dueno('POST', '/c/supervisores', { accion: 'crear', nombre: g.nombre, clave: g.clave, alcance: { gerencias: [g.gerencia] } });

// Checklist de un proceso a nombre de una persona: «cuantos» puntos de los 16 (todos si se omite)
const sesion = await http('GET', '/r/sesion?k=' + persona('Operaciones', 'Planta').token);
const PUNTOS = sesion.bloques.flatMap(b => b.puntos.map(x => [b.id, x[0]]));
async function responder(p, pid, cuantos) {
  for (const [b, pt] of PUNTOS.slice(0, cuantos == null ? PUNTOS.length : cuantos)) await http('POST', '/r/punto', { k: p.token, proceso_id: pid, pregunta: b, punto: pt, estado: 'cubierto' });
}
async function delegarTodo(clave, gerencia) {
  const gerente = como(clave);
  for (const s of Object.keys(INVENTARIO[gerencia])) await gerente('POST', '/c/asignar', { encuestado_id: persona(gerencia, s).id, agregar: ids[gerencia + '|' + s] });
  return gerente;
}

// Operaciones: MBC ya asignó los procesos de Planta; el Gerente empieza en el paso 1
await admin('POST', '/a/asignar', { encuestado_id: persona('Operaciones', 'Planta').id, agregar: ids['Operaciones|Planta'] });

// Finanzas: pasos 1 y 2 confirmados; responde a medias (6 completos, 2 a medias, el resto sin respuesta)
{
  const gf = await delegarTodo('GerenteFin2026', 'Finanzas');
  await gf('POST', '/c/flujo/confirmar', { paso: 1 }); await gf('POST', '/c/flujo/confirmar', { paso: 2 });
  const lista = Object.keys(INVENTARIO.Finanzas).flatMap(s => ids['Finanzas|' + s].map(pid => [persona('Finanzas', s), pid]));
  for (const [i, [p, pid]] of lista.entries()) { if (i < 6) await responder(p, pid); else if (i < 8) { await http('POST', '/r/revision', { k: p.token, proceso_id: pid, estado: 'vigente' }); await responder(p, pid, 6); } }
}

// Comercial: todo respondido y validado por MBC; confirmó los pasos 1 a 3 y queda listo para la validación final
{
  const gc = await delegarTodo('GerenteCom2026', 'Comercial');
  await gc('POST', '/c/flujo/confirmar', { paso: 1 }); await gc('POST', '/c/flujo/confirmar', { paso: 2 });
  for (const s of Object.keys(INVENTARIO.Comercial)) for (const pid of ids['Comercial|' + s]) await responder(persona('Comercial', s), pid);
  await gc('POST', '/c/flujo/confirmar', { paso: 3 });
  for (const s of Object.keys(INVENTARIO.Comercial)) for (const pid of ids['Comercial|' + s]) await admin('POST', '/a/matriz', { proceso_id: pid, validacion: 'validado', validado_por: 'Consultor MBC' });
}

const base = arg('--origen') || ORIGEN;
console.log('\nListo. Campaña «' + NOMBRE + '» (ficticia):');
console.log('  Consola (admin):     ' + base + '/admin.html   código: ' + ADMIN);
console.log('  Cliente:             ' + base + '/admin.html?cliente=1   clave: ' + CLAVE_CLIENTE);
GERENTES.forEach(g => console.log('  ' + g.nombre.padEnd(24) + base + '/admin.html?cliente=1   clave: ' + g.clave));
console.log('  Encuestados (ej.):   ' + base + '/index.html?k=' + persona('Operaciones', 'Planta').token + '   (Carla Mendoza)');
