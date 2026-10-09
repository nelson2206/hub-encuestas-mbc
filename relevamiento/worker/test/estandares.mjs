// Prueba de la clasificación de estándares (TDP / TMC / otros / normativa).
//   node test/estandares.mjs            → valida el archivo de casos y el comparador (sin IA)
//   node test/estandares.mjs --real     → llama a la IA con cada frase y compara (meta: 9 de 10)
// Opciones: --api URL (por defecto http://127.0.0.1:8787) y --campana ID (por defecto la primera campaña).
// El código de administración sale de ADMIN_CODE o de worker/.dev.vars. La IA no corre en local (sin binding a ProcessIQ):
// para la prueba real, apunta --api al Worker publicado y --campana a la campaña PRUEBA (nunca a datos del cliente).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const casos = JSON.parse(readFileSync(join(aqui, 'estandares.json'), 'utf8'));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const real = process.argv.includes('--real');
const CATS = ['tdp', 'tmc', 'otros', 'normativa'];
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const coincide = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

// Un caso pasa si, en cada categoría, todo lo esperado aparece y no hay nada de más.
export function comparar(esperado, obtenido) {
  const fallas = [];
  CATS.forEach(c => {
    const e = esperado[c] || [], o = obtenido[c] || [];
    e.forEach(x => { if (!o.some(y => coincide(x, y))) fallas.push(`falta en ${c}: ${x}`); });
    o.forEach(y => { if (!e.some(x => coincide(x, y))) fallas.push(`sobra en ${c}: ${y}`); });
  });
  return fallas;
}

// Autoprueba del comparador y de los casos (sin red).
if (casos.length !== 10) throw new Error('El archivo debe tener 10 casos');
casos.forEach((c, i) => {
  if (!c.frase || CATS.some(k => !Array.isArray(c[k]))) throw new Error(`Caso ${i + 1} incompleto`);
  if (comparar(c, c).length) throw new Error(`Caso ${i + 1}: el comparador falla con la respuesta perfecta`);
});
if (!comparar(casos[0], { tdp: [], tmc: [], otros: [], normativa: [] }).length) throw new Error('El comparador no detecta faltantes');
console.log(`Casos válidos: ${casos.length}. Comparador OK.`);
if (!real) process.exit(0);

let codigo = process.env.ADMIN_CODE || '';
if (!codigo) { try { codigo = (readFileSync(join(aqui, '..', '.dev.vars'), 'utf8').match(/^ADMIN_CODE=(.*)$/m) || [])[1] || ''; } catch { /* sin archivo */ } }
codigo = codigo.trim();
if (!codigo) throw new Error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)');
const api = (arg('--api') || 'http://127.0.0.1:8787').replace(/\/$/, '');
const cab = { 'x-admin-code': codigo, 'content-type': 'application/json', Origin: arg('--origin') || 'http://localhost:8766' };
let campana = arg('--campana');
if (!campana) {
  const j = await (await fetch(api + '/a/campanas', { headers: cab })).json();
  campana = j.campanas && j.campanas[0] && j.campanas[0].id;
}
if (!campana) throw new Error('No hay campaña para la prueba');

let ok = 0;
for (const [i, c] of casos.entries()) {
  const r = await fetch(api + '/a/estandares/probar', { method: 'POST', headers: cab, body: JSON.stringify({ campana_id: campana, frase: c.frase }) });
  const j = await r.json();
  if (!j.ok) { console.log(`${i + 1}. ERROR ${r.status}: ${j.error}`); continue; }
  const fallas = comparar(c, j);
  if (!fallas.length) ok++;
  console.log(`${i + 1}. ${fallas.length ? 'FALLA' : 'ok   '} ${c.frase}${fallas.length ? '\n      ' + fallas.join('\n      ') + '\n      obtuvo: ' + JSON.stringify(CATS.reduce((a, k) => (a[k] = j[k], a), {})) : ''}`);
}
console.log(`\nAciertos: ${ok} de ${casos.length} (meta: 9)`);
process.exit(ok >= 9 ? 0 : 1);
