/* Consola de administración: qué gerencias ya dieron su validación final (flujo guiado del Gerente).
 * Lo consulta admin.html al abrir una campaña. Muestra una insignia por gerencia (mapa y matriz), un indicador en el resumen
 * y, en «Acceso del cliente», el paso de cada Gerente con el botón para reabrir una aprobación.
 */
(function(){
  'use strict';
  var X = null;     // {api, esc, fecha, alCambiar}
  var D = null;     // {supervisores, gerencias} del Worker
  var NOMBRE_PASO = {1: 'Procesos', 2: 'Delegación', 3: 'Avance', 4: 'Validación final', 5: 'Completo'};

  function iniciar(opciones){ X = opciones; D = null; }
  function cargar(campanaId){
    return X.api('/a/campana/flujo?id=' + encodeURIComponent(campanaId)).then(function(j){ D = j; return j; }).catch(function(){ D = null; });
  }

  // Insignia corta junto al nombre de la gerencia: solo aprobada o en curso; sin gerente asignado no se muestra nada.
  function chip(gerencia){
    var g = D && D.gerencias[gerencia]; if (!g) return '';
    if (g.estado === 'aprobada') return '<span class="chip c-ok" title="' + X.esc('Validación final del gerente: ' + g.gerentes.join(', ') + ' · ' + X.fecha(g.aprobado_en)) + '">✓ Validada por el gerente</span>';
    if (g.estado === 'en_curso') return '<span class="chip c-inf" title="El gerente está avanzando por los pasos">Gerente en curso</span>';
    return '';
  }
  // Una línea con la insignia de cada gerencia que tiene gerente (para la matriz). Con una gerencia filtrada, solo esa.
  function barra(filtro){
    if (!D) return '';
    var gs = Object.keys(D.gerencias).filter(function(g){ return !filtro || g === filtro; }).sort(function(a, b){ return a.localeCompare(b, 'es'); });
    var h = gs.map(function(g){ var c = chip(g); return c ? '<span><b>' + X.esc(g) + '</b> ' + c + '</span>' : ''; }).filter(Boolean).join(' ');
    return h ? '<span class="muted">Validación del gerente:</span> ' + h : '';
  }
  function resumen(){
    if (!D) return null;
    var gs = Object.keys(D.gerencias), n = gs.filter(function(g){ return D.gerencias[g].estado === 'aprobada'; }).length;
    return gs.length ? [n + ' de ' + gs.length, 'gerencias con validación final'] : null;
  }

  function tabla(el){
    if (!el) return;
    if (!D || !D.supervisores.length){ el.innerHTML = ''; return; }
    el.innerHTML = '<h3 style="font-size:14px;margin-top:22px">Validación final de los gerentes</h3>' +
      '<p class="muted">Cada Gerente (Supervisor) avanza por cuatro pasos. Al dar su validación final queda cerrado; aquí puedes reabrirlo si hace falta corregir algo.</p>' +
      '<div class="tblwrap"><table><thead><tr><th scope="col">Gerente</th><th scope="col">Gerencias</th><th scope="col">Paso</th><th scope="col">Procesos validados</th><th scope="col">Estado</th><th scope="col"></th></tr></thead><tbody>' +
      D.supervisores.map(function(s){
        var est = s.aprobada ? '<span class="chip c-ok">✓ Validación final · ' + X.esc(X.fecha(s.aprobado_en)) + '</span>' : '<span class="chip c-mut">En curso</span>';
        return '<tr><td><b>' + X.esc(s.nombre) + '</b>' + (s.activo ? '' : ' <span class="chip c-mut">Desactivado</span>') + '</td><td>' + X.esc(s.gerencias.join(', ') || '—') + '</td>' +
          '<td>' + X.esc(NOMBRE_PASO[s.paso_actual] || '') + (s.paso_actual < 5 ? ' (' + s.paso_actual + ' de 4)' : '') + '</td><td class="num">' + s.validados + ' de ' + s.procesos + '</td><td>' + est + '</td>' +
          '<td>' + (s.aprobada ? '<button type="button" class="btn btn-ghost btn-xs" data-reabrir="' + X.esc(s.id) + '">Reabrir</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="muted" id="msgFlujoAdm" role="status"></p>';
    el.onclick = function(ev){
      var b = ev.target.closest('[data-reabrir]'); if (!b) return;
      var s = D.supervisores.filter(function(x){ return x.id === b.dataset.reabrir; })[0];
      var motivo = window.prompt('Reabrir la validación final de «' + s.nombre + '». El Gerente podrá corregir y volver a validar. Indica el motivo (queda registrado):', '');
      if (motivo === null) return;
      b.disabled = true;
      X.api('/a/flujo/reabrir', {campana_id: X.campanaId(), supervisor_id: s.id, motivo: motivo}).then(function(){ return cargar(X.campanaId()); })
        .then(function(){ tabla(el); X.alCambiar(); document.getElementById('msgFlujoAdm').textContent = 'Reabierta. El Gerente vuelve al paso 4.'; })
        .catch(function(err){ b.disabled = false; document.getElementById('msgFlujoAdm').textContent = err.message; });
    };
  }

  window.FlujoAdmin = {iniciar: iniciar, cargar: cargar, chip: chip, barra: barra, resumen: resumen, tabla: tabla};
})();
