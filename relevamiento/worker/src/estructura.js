// Esqueleto de la campaña: Área > Gerencia > Sección, cargado desde la hoja «Gerencias» del Excel (o creado al vincular filas).
// Permite definir la estructura sin procesos y que las cargas siguientes (personas, procesos, matriz) se vinculen a ella:
// los nombres se normalizan (mayúsculas, tildes, espacios) y se agrupan bajo el nombre del esqueleto.
// Una campaña sin filas en `estructura` funciona como siempre (gerencias y secciones salen de sus procesos).
import { normal, txt } from './comun.js';

const clave = (g, s) => normal(g) + '|' + normal(s);
const porNombre = (a, b) => a.localeCompare(b, 'es');

export async function leerEstructura(env, campId) {
  return (await env.DB.prepare('SELECT clave, area, gerencia, seccion, orden FROM estructura WHERE campana_id=? ORDER BY orden, gerencia, seccion').bind(campId).all()).results;
}

// Prepara el esqueleto de una carga. `existentes`: filas ya guardadas (vacío en modo reemplazar). `hoja`: filas de la hoja Gerencias.
// Si no hay ni existentes ni hoja, el esqueleto no está activo y `vincular` devuelve los nombres tal como llegan.
export function prepararEstructura(existentes, hoja) {
  const filas = new Map(), gerAreas = {};   // clave -> fila · gerencia normalizada -> área
  let sig = existentes.reduce((m, f) => Math.max(m, f.orden + 1), 0);
  const nuevas = new Set(), cambiadas = new Set(), avisos = [];
  const sinVincular = {};                   // "gerencia|sección" -> {gerencia, seccion, procesos, personas}
  existentes.forEach(f => { filas.set(f.clave, { ...f }); if (f.area && !gerAreas[normal(f.gerencia)]) gerAreas[normal(f.gerencia)] = f.area; });

  const gerencia = g => { const f = [...filas.values()].find(x => normal(x.gerencia) === normal(g)); return f ? f.gerencia : g; };
  const agregar = (g, s, area) => {
    const k = clave(g, s);
    if (filas.has(k)) return filas.get(k);
    const f = { clave: k, area: '', gerencia: gerencia(g), seccion: s, orden: sig++ };
    filas.set(k, f); nuevas.add(k);
    return f;
  };

  const aplicadas = [];
  (hoja || []).forEach(x => {
    const g = txt(x.gerencia, 150), s = txt(x.seccion, 150), area = txt(x.area, 150);
    if (!g) return;
    agregar(g, s);
    if (area) {
      const previa = gerAreas[normal(g)];
      if (previa && normal(previa) !== normal(area) && aplicadas.includes(normal(g))) avisos.push('«' + g + '» aparece en dos áreas distintas (' + previa + ' y ' + area + '): se usó «' + area + '».');
      gerAreas[normal(g)] = area; aplicadas.push(normal(g));
    }
  });
  const activo = () => filas.size > 0;
  // El área es de la gerencia: se copia a todas sus filas.
  const unificar = () => filas.forEach(f => { const a = gerAreas[normal(f.gerencia)] || ''; if (f.area !== a) { f.area = a; cambiadas.add(f.clave); } });
  unificar();

  // Devuelve [gerencia, sección] según el esqueleto. Con `relleno`, una sección vacía o desconocida se completa si la gerencia tiene una sola.
  function vincular(g, s, tipo, relleno) {
    if (!activo()) return [g, s];
    const deLaGerencia = [...filas.values()].filter(f => normal(f.gerencia) === normal(g));
    const conSeccion = deLaGerencia.filter(f => normal(f.seccion));
    const exacta = deLaGerencia.find(f => normal(f.seccion) === normal(s) && normal(s));
    if (exacta) {
      // Una sección creada hace un momento por otra fila de esta misma carga sigue sin estar en el esqueleto original: se sigue contando.
      if (sinVincular[exacta.clave]) sinVincular[exacta.clave][tipo]++;
      return [exacta.gerencia, exacta.seccion];
    }
    if (relleno && conSeccion.length === 1) return [conSeccion[0].gerencia, conSeccion[0].seccion];
    if (!normal(s)) return [gerencia(g), s];   // sin sección no se puede crear una fila: la carga la rechaza como siempre
    const f = agregar(g, s);
    unificar();
    const k = clave(g, s), r = sinVincular[k] = sinVincular[k] || { gerencia: f.gerencia, seccion: f.seccion, procesos: 0, personas: 0 };
    r[tipo]++;
    return [f.gerencia, f.seccion];
  }

  return {
    activo, vincular,
    resultado: () => ({ total: filas.size, nuevas: nuevas.size, avisos, sin_vincular: Object.values(sinVincular) }),
    // Sentencias para guardar el resultado: inserta las filas nuevas y actualiza el área de las que cambiaron.
    sentencias: (env, campId) => [...filas.values()].flatMap(f => {
      if (nuevas.has(f.clave)) return [env.DB.prepare('INSERT OR IGNORE INTO estructura (campana_id, clave, area, gerencia, seccion, orden) VALUES (?,?,?,?,?,?)').bind(campId, f.clave, f.area, f.gerencia, f.seccion, f.orden)];
      if (cambiadas.has(f.clave)) return [env.DB.prepare('UPDATE estructura SET area=? WHERE campana_id=? AND clave=?').bind(f.area, campId, f.clave)];
      return [];
    })
  };
}

// Si la campaña ya tiene esqueleto, una gerencia/sección nueva (proceso creado a mano, movimiento del constructor) se agrega a él.
export async function asegurarEstructura(env, campId, g, s) {
  if (!normal(g) || !normal(s)) return;
  const filas = await leerEstructura(env, campId);
  if (!filas.length || filas.some(f => f.clave === clave(g, s))) return;
  const hermana = filas.find(f => normal(f.gerencia) === normal(g));
  await env.DB.prepare('INSERT OR IGNORE INTO estructura (campana_id, clave, area, gerencia, seccion, orden) VALUES (?,?,?,?,?,?)')
    .bind(campId, clave(g, s), hermana ? hermana.area : '', hermana ? hermana.gerencia : txt(g, 150), txt(s, 150), filas.reduce((m, f) => Math.max(m, f.orden + 1), 0)).run();
}

// Gerencias y secciones del esqueleto en el formato de areasDeCampana ([{gerencia, secciones[]}]), solo las que tienen al menos una sección.
export function areasDeEstructura(filas) {
  const m = {};
  filas.filter(f => normal(f.seccion)).forEach(f => { (m[f.gerencia] = m[f.gerencia] || new Set()).add(f.seccion); });
  return Object.keys(m).sort(porNombre).map(g => ({ gerencia: g, secciones: [...m[g]].sort(porNombre) }));
}
