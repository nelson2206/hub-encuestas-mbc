// Cobertura de los procesos: cuándo un proceso cuenta como respondido. Es la misma regla que usa la consola
// (cobertura() en admin.html), llevada al servidor para que el flujo del Supervisor decida los bloqueos aquí
// y no en el navegador. Función pura: recibe filas ya leídas de D1 y no toca la base.
//
// Respondido: alguien completó el checklist de los 3 bloques, o entre todas las personas y los documentos del equipo
// cubren todos los puntos. En curso: alguien lo tomó o empezó a responder. No vigente: solo hay marcas de «ya no se hace».
// Sin cobertura: nadie lo tomó.

const PREG_ANTES = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];   // formato anterior (6 preguntas)

function leerJson(s, porDefecto) {
  try { const o = JSON.parse(s || ''); return o == null ? porDefecto : o; } catch (e) { return porDefecto; }
}
const puntoListo = (ck, id) => { const x = ck && ck[id]; return !!x && (x.estado === 'cubierto' || x.estado === 'no_aplica'); };
const tieneContenido = r => !!(String(r.texto || '').trim() || (r.sistemas && r.sistemas !== '[]'));

// bloques: BLOQUES del Worker · revisiones: {encuestado_id, proceso_id, estado}
// respuestas: {encuestado_id, proceso_id, pregunta, texto, sistemas, checklist} · precarga: {proceso_id, punto}
export function crearCobertura({ bloques, revisiones, respuestas, precarga }) {
  const puntos = bloques.flatMap(b => b.puntos.map(p => p[0]));
  const total = puntos.length, validos = new Set(puntos);
  const rev = {}, todas = {}, conTexto = {}, pre = {};
  revisiones.forEach(r => { (rev[r.proceso_id] = rev[r.proceso_id] || []).push(r); });
  respuestas.forEach(r => {
    const fila = { pregunta: r.pregunta, ck: leerJson(r.checklist, {}), contenido: tieneContenido(r) };
    const t = todas[r.proceso_id] = todas[r.proceso_id] || {};
    (t[r.encuestado_id] = t[r.encuestado_id] || []).push(fila);
    if (fila.contenido) (conTexto[r.proceso_id] = conTexto[r.proceso_id] || {})[r.encuestado_id] = 1;
  });
  precarga.forEach(x => { (pre[x.proceso_id] = pre[x.proceso_id] || {})[x.punto] = 1; });

  function avancePersona(pid, eid) {
    const filas = (todas[pid] || {})[eid] || [], por = {};
    filas.forEach(f => { por[f.pregunta] = f; });
    if (PREG_ANTES.every(q => por[q] && por[q].contenido)) return true;
    const adm = pre[pid] || {};
    let listos = 0;
    bloques.forEach(b => {
      const ck = (por[b.id] || {}).ck || {};
      b.puntos.forEach(pt => { if (adm[pt[0]] || puntoListo(ck, pt[0])) listos++; });
    });
    return total > 0 && listos === total;
  }

  // Puntos cubiertos entre todas las personas y el equipo, sin repetir.
  function puntosUnidos(pid) {
    const cub = new Set(Object.keys(pre[pid] || {}));
    Object.values(todas[pid] || {}).forEach(filas => filas.forEach(f => {
      Object.keys(f.ck).forEach(k => { if (validos.has(k) && f.ck[k] && (f.ck[k].estado === 'cubierto' || f.ck[k].estado === 'no_aplica')) cub.add(k); });
    }));
    return [...cub].filter(k => validos.has(k)).length;
  }

  return function cobertura(pid) {
    const revs = rev[pid] || [], personas = new Set();
    revs.forEach(r => { if (r.estado === 'vigente' || r.estado === 'cambio') personas.add(r.encuestado_id); });
    Object.keys(conTexto[pid] || {}).forEach(eid => personas.add(eid));
    const candidatos = new Set([...Object.keys(todas[pid] || {}), ...personas]);
    let completos = [...candidatos].filter(eid => avancePersona(pid, eid)).length;
    if (!completos && candidatos.size && total > 0 && puntosUnidos(pid) === total) completos = 1;
    const noExiste = revs.filter(r => r.estado === 'no_existe').length;
    const estado = completos ? 'respondido' : personas.size ? 'en_curso' : noExiste ? 'no_vigente' : 'sin_cobertura';
    return { estado, personas: personas.size, completos, puntos: Math.min(puntosUnidos(pid), total), total };
  };
}
