/* Flujo guiado del Gerente (Supervisor) en el panel del cliente: cuatro pasos, como un registro web.
 *   1 Procesos · 2 Delegación · 3 Avance · 4 Validación final
 * Las reglas (orden, compuertas, advertencias, aprobación) las decide el Worker (flujo.js); aquí solo se pintan y se piden.
 * Se carga desde admin.html y recibe lo que necesita de la consola (api, datos, diálogos) en FlujoGerente.montar().
 */
(function(){
  'use strict';
  var PASOS = [
    {n: 1, t: 'Procesos', d: '¿Estos son tus procesos?'},
    {n: 2, t: 'Delegación', d: 'Asigna quién los llena'},
    {n: 3, t: 'Avance', d: 'Que todos respondan'},
    {n: 4, t: 'Validación final', d: 'Tu visto bueno'}
  ];
  var ESTILO = '' +
    '.fg-pasos{display:flex;gap:0;margin:6px 0 18px;padding:0;list-style:none}' +
    '.fg-paso{flex:1;min-width:0;position:relative;text-align:center;padding:0 4px}' +
    '.fg-paso::before{content:"";position:absolute;top:17px;left:-50%;width:100%;height:3px;background:var(--line);z-index:0}' +
    '.fg-paso:first-child::before{display:none}' +
    '.fg-paso.hecho::before,.fg-paso.actual::before{background:var(--ok)}' +
    '.fg-paso button{appearance:none;background:none;border:0;font:inherit;cursor:pointer;display:block;width:100%;padding:0;color:inherit}' +
    '.fg-paso button[disabled]{cursor:default}' +
    '.fg-num{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;border:2.5px solid var(--field-line);background:var(--card);color:var(--muted);font-family:Montserrat,sans-serif;font-weight:800;font-size:15px}' +
    '.fg-paso.hecho .fg-num{background:var(--ok);border-color:var(--ok);color:#fff}' +
    '.fg-paso.actual .fg-num{border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}' +
    '.fg-paso.vista .fg-num{outline:3px solid var(--navy);outline-offset:2px}' +
    '.fg-et{display:block;margin-top:6px;font-family:Montserrat,sans-serif;font-weight:700;font-size:12.5px;color:var(--heading)}' +
    '.fg-sub{display:block;font-size:11.5px;color:var(--muted)}' +
    '@media (max-width:640px){.fg-sub{display:none}.fg-et{font-size:11px}}' +
    '.fg-sec{border:1px solid var(--line);border-radius:12px;margin:10px 0;background:var(--card);overflow:hidden}' +
    '.fg-sec>h3{font-size:14px;padding:10px 14px;background:var(--panel);display:flex;gap:10px;align-items:center;flex-wrap:wrap}' +
    '.fg-fila{display:flex;gap:10px 14px;align-items:flex-start;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--line)}' +
    '.fg-fila .fg-nom{flex:1 1 260px;min-width:0}' +
    '.fg-fila .fg-nom b{font-family:Montserrat,sans-serif;font-size:13.5px}' +
    '.fg-fila .fg-nom p{margin:2px 0 0}' +
    '.fg-fila .fg-der{flex:0 1 240px;min-width:150px}' +
    '.fg-quitado{opacity:.65}' +
    '.fg-pie{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);margin:18px -20px -18px;padding:12px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-radius:0 0 14px 14px}' +
    '.fg-pie .fg-espacio{flex:1}' +
    '.fg-falta{margin:10px 0}' +
    '.fg-falta ul{margin:6px 0 0;padding-left:20px;max-height:140px;overflow:auto}' +
    '.fg-fin{border:2px solid var(--ok);background:var(--ok-bg);color:var(--ok);border-radius:12px;padding:14px 16px;margin:0 0 14px}' +
    '.fg-fin b{font-family:Montserrat,sans-serif}';

  var X = null;        // lo que entrega la consola (ver montar)
  var F = null;        // último estado del flujo que dio el Worker
  var VISTA = 0;       // paso que se está mirando (puede ser uno ya confirmado)
  var OCUPADO = false;

  function esc(s){ return X.esc(s); }
  function nombreProc(p){ return p.subproceso || p.proceso || p.macroproceso || '(sin nombre)'; }
  function plural(n, uno, varios){ return n + ' ' + (n === 1 ? uno : varios); }
  function pct(a, b){ return b ? Math.round(100 * a / b) : 0; }
  function barra(a, b, texto){
    return '<span class="pbar grande" role="img" aria-label="' + esc(texto || (pct(a, b) + '%')) + '"><i style="width:' + pct(a, b) + '%"></i></span>';
  }
  function activos(){ return F.procesos.filter(function(p){ return !p.quitado; }); }
  function porSeccion(lista){
    var m = {}, orden = [];
    lista.forEach(function(p){
      var k = p.gerencia + '\u0001' + p.seccion;
      if (!m[k]){ m[k] = {gerencia: p.gerencia, seccion: p.seccion, procs: []}; orden.push(k); }
      m[k].procs.push(p);
    });
    return orden.sort(function(a, b){ return a.localeCompare(b, 'es'); }).map(function(k){ return m[k]; });
  }

  // ---------------------------------------------------------------- confirmaciones (un diálogo propio, no el del navegador)
  function confirmar(titulo, texto, boton, peligro){
    return new Promise(function(res){
      var d = document.getElementById('fgConf');
      if (!d){
        d = document.createElement('dialog'); d.id = 'fgConf';
        d.setAttribute('aria-labelledby', 'fgConfT');
        d.style.cssText = 'max-width:460px;width:calc(100% - 32px);border:1px solid var(--line);border-radius:14px;padding:0;background:var(--card);color:var(--ink)';
        document.body.appendChild(d);
      }
      d.innerHTML = '<div style="padding:18px 20px"><h2 id="fgConfT" style="font-size:17px">' + esc(titulo) + '</h2>' +
        '<p style="margin:10px 0 0">' + esc(texto).replace(/\n/g, '<br>') + '</p>' +
        '<div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn btn-ghost" data-r="no">Volver</button>' +
        '<button type="button" class="btn' + (peligro ? '' : ' btn-navy') + '" data-r="si">' + esc(boton || 'Continuar') + '</button></div></div>';
      var fin = function(v){ d.onclick = null; d.oncancel = null; if (d.open) d.close(); res(v); };
      d.onclick = function(e){ var b = e.target.closest && e.target.closest('[data-r]'); if (b) fin(b.dataset.r === 'si'); };
      d.oncancel = function(e){ e.preventDefault(); fin(false); };
      if (!d.open) d.showModal();
      var cancelar = d.querySelector('[data-r=no]'); if (cancelar) cancelar.focus();
    });
  }

  // ---------------------------------------------------------------- carga y pintura
  function cargar(){
    return X.get('/c/flujo').then(function(j){
      var antes = F;
      F = j;
      // Si el Worker reinició pasos o el flujo avanzó, la vista sigue al paso actual; si no, se queda donde estaba.
      if (!VISTA || VISTA > F.paso_actual || (antes && antes.paso_actual !== F.paso_actual && VISTA === antes.paso_actual)) VISTA = Math.min(F.paso_actual, 4);
      pintar();
    });
  }
  function refrescar(){ if (X && X.raiz && !X.raiz.classList.contains('hidden')) return cargar().catch(function(e){ aviso(e.message, true); }); return Promise.resolve(); }

  function aviso(t, mal){
    var a = X.raiz.querySelector('#fgAviso'); if (!a) return;
    a.textContent = t || ''; a.classList.toggle('hidden', !t); a.classList.toggle('ok', !mal); a.classList.toggle('warn', !!mal);
    if (t && mal) a.scrollIntoView({block: 'nearest'});
  }

  function pintar(){
    var h = '<div id="fgAviso" class="msg hidden" role="status" aria-live="polite" style="margin-bottom:12px"></div>';
    if (F.aprobacion) h += '<div class="fg-fin" role="status"><b>Validación final dada</b> · ' + esc(X.fecha(F.aprobacion.aprobado_en)) + ' · ' + plural(F.aprobacion.procesos, 'proceso aprobado', 'procesos aprobados') +
      '<br><span class="muted" style="color:inherit">Tus procesos quedaron cerrados. Si necesitas corregir algo, pídele al equipo consultor que reabra tu aprobación.</span></div>';
    h += '<ol class="fg-pasos" aria-label="Pasos del flujo">' + PASOS.map(function(p){
      var hecho = F.paso_actual > p.n, actual = F.paso_actual === p.n, bloqueado = F.paso_actual < p.n;
      return '<li class="fg-paso ' + (hecho ? 'hecho' : actual ? 'actual' : 'bloq') + (VISTA === p.n ? ' vista' : '') + '"' + (VISTA === p.n ? ' aria-current="step"' : '') + '>' +
        '<button type="button" data-paso="' + p.n + '"' + (bloqueado ? ' disabled' : '') + '><span class="fg-num">' + (hecho ? '✓' : p.n) + '</span>' +
        '<span class="fg-et">' + esc(p.t) + '</span><span class="fg-sub">' + esc(p.d) + '</span></button></li>';
    }).join('') + '</ol>';
    h += '<div id="fgCuerpo"></div>';
    X.raiz.innerHTML = h;
    X.raiz.querySelector('.fg-pasos').onclick = function(e){
      var b = e.target.closest('button[data-paso]'); if (!b || b.disabled) return;
      VISTA = Number(b.dataset.paso); pintar(); window.scrollTo(0, Math.max(0, X.raiz.getBoundingClientRect().top + window.scrollY - 12));
    };
    var cuerpo = X.raiz.querySelector('#fgCuerpo');
    [null, paso1, paso2, paso3, paso4][VISTA](cuerpo);
  }

  // Barra inferior de cada paso: volver y confirmar (con la lista de lo que falta si todavía no se puede).
  function pie(c, paso, textoBoton){
    var puede = F.compuertas[paso].ok, esActual = F.paso_actual === paso, aprobada = !!F.aprobacion;
    var h = '';
    if (esActual && !puede && F.compuertas[paso].faltan.length){
      var lista = F.compuertas[paso].faltan;
      h += '<div class="fg-falta msg warn"><b>' + (paso === 1 ? 'Para continuar:' : 'Para continuar faltan ' + plural(lista.length, 'proceso', 'procesos') + ':') + '</b><ul>' +
        lista.slice(0, 30).map(function(x){ return '<li>' + esc(x) + '</li>'; }).join('') + (lista.length > 30 ? '<li>…y ' + (lista.length - 30) + ' más</li>' : '') + '</ul></div>';
    }
    h += '<div class="fg-pie">' + (paso > 1 ? '<button type="button" class="btn btn-ghost" data-fg="atras">← Volver al paso ' + (paso - 1) + '</button>' : '') + '<span class="fg-espacio"></span>';
    if (aprobada) h += '<span class="muted">Flujo cerrado</span>';
    else if (esActual) h += '<button type="button" class="btn" data-fg="confirmar"' + (puede ? '' : ' disabled') + '>' + esc(textoBoton) + '</button>';
    else h += '<button type="button" class="btn btn-navy" data-fg="adelante">Ir al paso actual (' + F.paso_actual + ') →</button>';
    h += '</div>';
    c.insertAdjacentHTML('beforeend', h);
  }

  function enlazarPie(c, paso, textoConfirmacion, tituloConfirmacion, final){
    var atras = c.querySelector('[data-fg=atras]'), conf = c.querySelector('[data-fg=confirmar]'), adel = c.querySelector('[data-fg=adelante]');
    if (atras) atras.onclick = function(){ VISTA = paso - 1; pintar(); };
    if (adel) adel.onclick = function(){ VISTA = Math.min(F.paso_actual, 4); pintar(); };
    if (conf) conf.onclick = function(){
      if (OCUPADO) return;
      confirmar(tituloConfirmacion, textoConfirmacion, final ? 'Dar mi validación final' : 'Sí, continuar', !!final).then(function(si){
        if (!si) return;
        OCUPADO = true; conf.disabled = true;
        var cuerpo = {paso: paso}; if (final) cuerpo.confirmar_final = true;
        return X.post('/c/flujo/confirmar', cuerpo).then(function(){ VISTA = Math.min(paso + 1, 4); return X.recargar(); })
          .then(function(){ aviso(final ? 'Listo: tu validación final quedó registrada.' : 'Paso ' + paso + ' confirmado.'); })
          .catch(function(err){ aviso(err.message, true); return cargar(); })
          .then(function(){ OCUPADO = false; });
      });
    };
  }

  // ---------------------------------------------------------------- paso 1: procesos
  function paso1(c){
    var vivos = activos(), quitados = F.procesos.filter(function(p){ return p.quitado; }), editable = !F.aprobacion;
    var h = '<h2 style="font-size:17px;margin:0 0 4px">¿Estos son tus procesos?</h2>' +
      '<p class="muted" style="margin-top:0">Revisa la lista de tus secciones. Si falta alguno, <b>elígelo del inventario</b> que ya cargó MBC o <b>créalo</b>; si ya no corresponde, <b>quítalo</b>. Lo que crees pasa a formar parte del inventario final.</p>' +
      (editable ? '<div class="row" style="margin:8px 0"><button type="button" class="btn btn-navy" data-fg="catalogo">+ Elegir del inventario</button><button type="button" class="btn btn-ghost" data-fg="nuevo">+ Crear un proceso nuevo</button></div>' : '') +
      '<p class="muted" style="margin:4px 0 0"><b>' + plural(vivos.length, 'proceso', 'procesos') + '</b> en ' + plural(porSeccion(vivos).length, 'sección', 'secciones') + '</p>';
    h += porSeccion(vivos).map(function(s){
      return '<section class="fg-sec" aria-label="' + esc(s.seccion) + '"><h3>' + esc(s.seccion) + ' <span class="muted">' + esc(s.gerencia) + ' · ' + plural(s.procs.length, 'proceso', 'procesos') + '</span></h3>' +
        s.procs.map(function(p){
          return '<div class="fg-fila"><div class="fg-nom"><b>' + esc(nombreProc(p)) + '</b>' + (p.agregado ? ' <span class="chip c-acc">Agregado por ti</span>' : '') + (p.incorporado ? ' <span class="chip c-inf">Del inventario · ' + esc(p.gerencia) + '</span>' : '') +
            (p.proceso && p.subproceso ? '<p class="muted">' + esc(p.proceso) + '</p>' : '') +
            '<p class="muted">' + (p.descripcion ? esc(p.descripcion) : '<i>Sin descripción</i>') + '</p></div>' +
            '<div class="fg-der">' + (editable ? '<button type="button" class="btn btn-ghost btn-xs" data-fg="' + (p.incorporado ? 'soltar' : 'quitar') + '" data-id="' + esc(p.id) + '">' + (p.incorporado ? 'Soltar' : 'Quitar') + '</button>' : '') + '</div></div>';
        }).join('') + '</section>';
    }).join('');
    if (quitados.length){
      h += '<details style="margin-top:14px"><summary class="muted" style="cursor:pointer">' + plural(quitados.length, 'proceso quitado', 'procesos quitados') + ' por ti</summary>' +
        quitados.map(function(p){
          return '<div class="fg-fila fg-quitado"><div class="fg-nom"><b>' + esc(nombreProc(p)) + '</b> <span class="muted">' + esc(p.seccion) + '</span></div>' +
            '<div class="fg-der">' + (editable ? '<button type="button" class="btn btn-ghost btn-xs" data-fg="restaurar" data-id="' + esc(p.id) + '">Restaurar</button>' : '') + '</div></div>';
        }).join('') + '</details>';
    }
    c.innerHTML = h;
    pie(c, 1, 'Confirmar mis procesos y continuar');
    enlazarPie(c, 1, 'Pasarás a delegar estos procesos. Podrás volver a este paso para hacer cambios.', '¿Estás seguro de continuar?');
    var nuevo = c.querySelector('[data-fg=nuevo]'); if (nuevo) nuevo.onclick = dialogoProceso;
    var cat = c.querySelector('[data-fg=catalogo]'); if (cat) cat.onclick = dialogoCatalogo;
    Array.prototype.forEach.call(c.querySelectorAll('[data-fg=quitar],[data-fg=restaurar],[data-fg=soltar]'), function(b){
      b.onclick = function(){
        var accion = b.dataset.fg, p = F.procesos.filter(function(x){ return x.id === b.dataset.id; })[0];
        var hacer = function(){
          b.disabled = true;
          return X.post('/c/flujo/proceso', {accion: accion, proceso_id: b.dataset.id}).then(function(){ return X.recargar(); })
            .then(function(){ aviso(accion === 'quitar' ? 'Proceso quitado. Puedes restaurarlo mientras no des tu validación final.' : accion === 'soltar' ? 'Proceso soltado: ya no es tuyo y sigue en el inventario.' : 'Proceso restaurado.'); })
            .catch(function(err){ b.disabled = false; aviso(err.message, true); });
        };
        if (accion === 'restaurar') return hacer();
        if (accion === 'soltar') return confirmar('¿Soltar este proceso?', '«' + nombreProc(p) + '» seguirá en el inventario de ' + p.gerencia + ', pero dejará de estar en tu lista. Podrás elegirlo de nuevo.', 'Soltar', true).then(function(si){ if (si) hacer(); });
        confirmar('¿Quitar este proceso?', '«' + nombreProc(p) + '» dejará de formar parte del inventario y de la encuesta. Podrás restaurarlo después.', 'Quitar', true).then(function(si){ if (si) hacer(); });
      };
    });
  }

  // Procesos que MBC ya cargó y no están en la lista del Gerente: se buscan y se eligen (no se copian: se incorporan a su lista).
  function dialogoCatalogo(){
    var d = document.getElementById('dlg'), temporizador = null, ELEGIDOS = {};
    X.abrirDlg('Elegir del inventario', 'Procesos ya cargados por MBC que aún no están en tu lista',
      '<label for="fgBus">Buscar por nombre, gerencia, sección o descripción</label><input type="search" id="fgBus" autocomplete="off" placeholder="Escribe para buscar…">' +
      '<p class="muted" id="fgCuenta" role="status" style="margin:8px 0 4px"></p>' +
      '<div id="fgRes" role="group" aria-label="Procesos del inventario" style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px 10px"></div>' +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn" id="fgInc" disabled>Agregar a mi lista</button><span class="muted" id="fgMsg" role="status"></span></div>');
    var res = document.getElementById('fgRes'), cuenta = document.getElementById('fgCuenta'), inc = document.getElementById('fgInc');
    function marcados(){ return Object.keys(ELEGIDOS); }
    function actualizar(){ var n = marcados().length; inc.disabled = !n; inc.textContent = n ? 'Agregar ' + plural(n, 'proceso', 'procesos') + ' a mi lista' : 'Agregar a mi lista'; }
    function buscar(){
      cuenta.textContent = 'Buscando…';
      X.get('/c/flujo/catalogo?q=' + encodeURIComponent(document.getElementById('fgBus').value.trim())).then(function(j){
        cuenta.textContent = j.total ? (j.total > j.procesos.length ? 'Mostrando ' + j.procesos.length + ' de ' + j.total + ': afina la búsqueda para ver el resto.' : plural(j.total, 'proceso disponible', 'procesos disponibles') + '.')
          : 'No hay procesos que coincidan.';
        res.innerHTML = j.procesos.map(function(p){
          return '<label style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line);font-weight:500"><input type="checkbox" style="width:auto;margin-top:4px" value="' + esc(p.id) + '"' + (ELEGIDOS[p.id] ? ' checked' : '') + '>' +
            '<span><b>' + esc(nombreProc(p)) + '</b><br><span class="muted">' + esc(p.gerencia) + ' · ' + esc(p.seccion) + '</span>' +
            (p.descripcion ? '<br><span class="muted">' + esc(p.descripcion) + '</span>' : '') +
            (p.gestionado_por.length ? '<br><span class="chip c-warn">También lo gestiona ' + esc(p.gestionado_por.join(', ')) + '</span>' : '') + '</span></label>';
        }).join('');
      }).catch(function(err){ cuenta.textContent = err.message; });
    }
    res.onchange = function(e){ var i = e.target; if (i.type !== 'checkbox') return; if (i.checked) ELEGIDOS[i.value] = 1; else delete ELEGIDOS[i.value]; actualizar(); };
    document.getElementById('fgBus').oninput = function(){ clearTimeout(temporizador); temporizador = setTimeout(buscar, 250); };
    inc.onclick = function(){
      inc.disabled = true; document.getElementById('fgMsg').textContent = 'Guardando…';
      X.post('/c/flujo/proceso', {accion: 'incorporar', proceso_ids: marcados()})
        .then(function(j){ if (d.open) d.close(); return X.recargar().then(function(){ aviso(plural(j.incorporados, 'proceso agregado', 'procesos agregados') + ' a tu lista. Siguen siendo parte del inventario de su gerencia.'); }); })
        .catch(function(err){ inc.disabled = false; document.getElementById('fgMsg').textContent = err.message; });
    };
    buscar();
  }

  function dialogoProceso(){
    var secs = porSeccion(activos().concat(F.procesos.filter(function(p){ return p.quitado; })));
    var d = document.getElementById('dlg');
    X.abrirDlg('Agregar un proceso', 'Pasará a formar parte del inventario final',
      '<label for="fgSec">Sección</label><select id="fgSec">' + secs.map(function(s, i){ return '<option value="' + i + '">' + esc(s.seccion) + ' · ' + esc(s.gerencia) + '</option>'; }).join('') + '</select>' +
      '<label for="fgNom">Nombre del proceso</label><input type="text" id="fgNom" maxlength="200" autocomplete="off" placeholder="Por ejemplo: Conciliación de pagos">' +
      '<label for="fgDes">Descripción (qué hace y para qué)</label><textarea id="fgDes" rows="4" maxlength="1500"></textarea>' +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn" id="fgOk">Agregar</button><span class="muted" id="fgMsg" role="status"></span></div>');
    document.getElementById('fgOk').onclick = function(){
      var b = this, s = secs[Number(document.getElementById('fgSec').value)], nombre = document.getElementById('fgNom').value.trim();
      if (nombre.length < 3){ document.getElementById('fgMsg').textContent = 'Escribe el nombre del proceso.'; return; }
      b.disabled = true; document.getElementById('fgMsg').textContent = 'Guardando…';
      X.post('/c/flujo/proceso', {accion: 'agregar', gerencia: s.gerencia, seccion: s.seccion, proceso: nombre, descripcion: document.getElementById('fgDes').value.trim()})
        .then(function(){ if (d.open) d.close(); return X.recargar(); }).then(function(){ aviso('Proceso agregado.'); })
        .catch(function(err){ b.disabled = false; document.getElementById('fgMsg').textContent = err.message; });
    };
  }

  // ---------------------------------------------------------------- paso 2: delegación
  function nombresDe(pid){
    var D = X.datos(), por = {};
    D.encuestados.forEach(function(e){ por[e.id] = e.nombre; });
    return (D.asignaciones || []).filter(function(a){ return a.proceso_id === pid && a.origen !== 'excluido'; }).map(function(a){ return por[a.encuestado_id]; }).filter(Boolean);
  }
  function paso2(c){
    var vivos = activos(), sin = vivos.filter(function(p){ return !p.delegados; }).length, editable = !F.aprobacion;
    var h = '<h2 style="font-size:17px;margin:0 0 4px">Delega quién llena cada proceso</h2>' +
      '<p class="muted" style="margin-top:0">Asigna procesos a una o más personas, ya cargadas o nuevas: uno por uno, o <b>varias secciones y procesos a varias personas a la vez</b>. Cada persona recibirá su enlace para responder.</p>' +
      (editable ? '<div class="row" style="margin:8px 0"><button type="button" class="btn btn-navy" data-fg="bloque">Asignar en bloque</button></div>' : '') +
      '<p class="muted" style="margin:4px 0 0"><b>' + (vivos.length - sin) + ' de ' + plural(vivos.length, 'proceso', 'procesos') + '</b> con responsable</p>' + barra(vivos.length - sin, vivos.length);
    h += porSeccion(vivos).map(function(s){
      return '<section class="fg-sec" aria-label="' + esc(s.seccion) + '"><h3>' + esc(s.seccion) + ' <span class="muted">' + esc(s.gerencia) + '</span>' +
        (editable ? '<span style="flex:1"></span><button type="button" class="btn btn-ghost btn-xs" data-fg="dsec" data-k="' + esc(s.gerencia + '\u0001' + s.seccion) + '">Asignar sección</button><button type="button" class="btn btn-ghost btn-xs" data-fg="persona" data-g="' + esc(s.gerencia) + '" data-s="' + esc(s.seccion) + '">+ Agregar persona</button>' : '') + '</h3>' +
        s.procs.map(function(p){
          var nom = nombresDe(p.id);
          return '<div class="fg-fila"><div class="fg-nom"><b>' + esc(nombreProc(p)) + '</b>' + (p.descripcion ? '<p class="muted">' + esc(p.descripcion) + '</p>' : '') + '</div>' +
            '<div class="fg-der">' + (nom.length ? '<span class="chip c-ok">' + plural(nom.length, 'persona', 'personas') + '</span><p class="muted" style="margin:3px 0 0">' + esc(nom.slice(0, 4).join(', ')) + (nom.length > 4 ? '…' : '') + '</p>'
              : '<span class="chip c-warn">Sin responsable</span>') + '</div>' +
            '<div>' + (editable ? '<button type="button" class="btn btn-ghost btn-xs" data-fg="asignar" data-id="' + esc(p.id) + '">' + (nom.length ? 'Cambiar' : 'Asignar') + '</button>' : '') + '</div></div>';
        }).join('') + '</section>';
    }).join('');
    c.innerHTML = h;
    pie(c, 2, 'Confirmar delegación y continuar');
    enlazarPie(c, 2, 'Pasarás a seguir el avance de las respuestas. Podrás volver a este paso para delegar más.', '¿Estás seguro de continuar?');
    Array.prototype.forEach.call(c.querySelectorAll('[data-fg=asignar]'), function(b){ b.onclick = function(){ X.asignarProceso(b.dataset.id); }; });
    Array.prototype.forEach.call(c.querySelectorAll('[data-fg=persona]'), function(b){ b.onclick = function(){ X.agregarPersona(b.dataset.g, b.dataset.s); }; });
    var bl = c.querySelector('[data-fg=bloque]'); if (bl) bl.onclick = function(){ dialogoBloque(null); };
    Array.prototype.forEach.call(c.querySelectorAll('[data-fg=dsec]'), function(b){ b.onclick = function(){ dialogoBloque(b.dataset.k); }; });
  }

  // Asignación en bloque: se eligen secciones y/o procesos, y personas existentes y/o nuevas; cada persona recibe todos los procesos elegidos.
  // Usa las mismas rutas de siempre (/c/personas para las nuevas y /c/asignar por persona), así que valen las mismas reglas de alcance.
  function dialogoBloque(seccionInicial){
    var d = document.getElementById('dlg'), D = X.datos(), secs = porSeccion(activos());
    var clave = function(s){ return s.gerencia + '\u0001' + s.seccion; };
    var porPersona = {}; (D.asignaciones || []).forEach(function(a){ if (a.origen !== 'excluido') porPersona[a.encuestado_id] = (porPersona[a.encuestado_id] || 0) + 1; });
    var gente = D.encuestados.slice().sort(function(a, b){ return a.nombre.localeCompare(b.nombre, 'es'); });
    X.abrirDlg('Asignar en bloque', 'Elige qué se asigna y a quién: cada persona recibirá todo lo elegido',
      '<h3 style="font-size:14px;margin:0 0 4px">1. Qué asignar</h3>' +
      '<label for="dgBus">Buscar proceso</label><input type="search" id="dgBus" autocomplete="off" placeholder="Escribe para filtrar…">' +
      '<div id="dgProcs" style="max-height:30vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px 10px;margin-top:6px">' + secs.map(function(s){
        return '<div class="dg-sec" data-k="' + esc(clave(s)) + '"><label style="display:flex;gap:8px;align-items:center;font-weight:700;margin:8px 0 2px"><input type="checkbox" class="dg-s" style="width:auto"> ' + esc(s.seccion) +
          ' <span class="muted" style="font-weight:500">' + plural(s.procs.length, 'proceso', 'procesos') + '</span></label><div style="margin-left:24px">' + s.procs.map(function(p){
            return '<label class="dg-p" data-t="' + esc(String(nombreProc(p) + ' ' + s.seccion).toLowerCase()) + '" style="display:flex;gap:8px;align-items:flex-start;font-weight:500;padding:2px 0"><input type="checkbox" class="dg-pi" value="' + esc(p.id) + '" style="width:auto;margin-top:3px"> <span>' + esc(nombreProc(p)) +
              (p.delegados ? ' <span class="chip c-ok">' + plural(p.delegados, 'persona', 'personas') + '</span>' : ' <span class="chip c-warn">Sin responsable</span>') + '</span></label>';
          }).join('') + '</div></div>';
      }).join('') + '</div>' +
      '<h3 style="font-size:14px;margin:16px 0 4px">2. A quién</h3>' +
      '<div id="dgPers" role="group" aria-label="Personas" style="max-height:24vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px 10px">' + (gente.length ? gente.map(function(e){
        return '<label style="display:flex;gap:8px;align-items:flex-start;font-weight:500;padding:3px 0"><input type="checkbox" class="dg-e" value="' + esc(e.id) + '" style="width:auto;margin-top:3px"> <span>' + esc(e.nombre) +
          ' <span class="muted">' + esc([e.rol, e.seccion].filter(Boolean).join(' · ')) + (porPersona[e.id] ? ' · ' + plural(porPersona[e.id], 'proceso', 'procesos') : '') + '</span></span></label>';
      }).join('') : '<p class="muted">Todavía no hay personas: agrégalas abajo.</p>') + '</div>' +
      '<label for="dgNuevas">Personas nuevas (opcional): una por línea, «Nombre, correo, cargo»</label><textarea id="dgNuevas" rows="3" placeholder="Ana Pérez, ana.perez@empresa.com, Jefa de la sección"></textarea>' +
      '<label for="dgSecN">Sección de las personas nuevas</label><select id="dgSecN">' + secs.map(function(s){ return '<option value="' + esc(clave(s)) + '">' + esc(s.seccion) + ' · ' + esc(s.gerencia) + '</option>'; }).join('') + '</select>' +
      '<p class="muted" id="dgResumen" role="status" style="margin:12px 0 0"></p>' +
      '<div class="row" style="margin-top:10px"><button type="button" class="btn" id="dgOk" disabled>Asignar</button><span class="muted" id="dgMsg" role="status"></span></div>');
    var q = function(s){ return d.querySelectorAll(s); }, todos = function(s){ return Array.prototype.slice.call(q(s)); };
    var nuevasPersonas = function(){
      var lista = [], mal = '', k = document.getElementById('dgSecN').value.split('\u0001');
      document.getElementById('dgNuevas').value.split('\n').forEach(function(l){
        l = l.trim(); if (!l) return;
        var partes = l.split(/[,;\t]/).map(function(x){ return x.trim(); }).filter(Boolean), correo = partes.filter(function(x){ return x.indexOf('@') >= 0; })[0] || '', resto = partes.filter(function(x){ return x !== correo; });
        if (!resto[0] || resto[0].length < 3){ mal = 'Revisa la línea «' + l + '»: falta el nombre.'; return; }
        lista.push({nombre: resto[0], correo: correo, rol: resto[1] || '', gerencia: k[0], seccion: k[1]});
      });
      return {lista: lista, mal: mal};
    };
    var elegidos = function(){ var m = {}; todos('.dg-pi:checked').forEach(function(i){ m[i.value] = 1; }); return Object.keys(m); };
    function resumen(){
      todos('.dg-sec').forEach(function(sec){   // la casilla de la sección refleja sus procesos (marcada, a medias o vacía)
        var hijos = todos('.dg-sec[data-k="' + sec.dataset.k.replace(/"/g, '\\"') + '"] .dg-pi'), n = hijos.filter(function(i){ return i.checked; }).length, c = sec.querySelector('.dg-s');
        c.checked = n === hijos.length && n > 0; c.indeterminate = n > 0 && n < hijos.length;
      });
      var np = elegidos().length, ne = todos('.dg-e:checked').length, nu = nuevasPersonas(), pers = ne + nu.lista.length;
      document.getElementById('dgResumen').textContent = nu.mal || (np && pers ? plural(np, 'proceso', 'procesos') + ' a ' + plural(pers, 'persona', 'personas') + ' (' + (np * pers) + ' asignaciones).' : 'Elige al menos un proceso y una persona.');
      document.getElementById('dgOk').disabled = !np || !pers || !!nu.mal;
    }
    d.querySelector('#dgProcs').addEventListener('change', function(e){
      if (e.target.classList.contains('dg-s')){ var sec = e.target.closest('.dg-sec'); todos('.dg-sec[data-k="' + sec.dataset.k.replace(/"/g, '\\"') + '"] .dg-pi').forEach(function(i){ if (!i.closest('.dg-p').hidden) i.checked = e.target.checked; }); }
      resumen();
    });
    document.getElementById('dgPers').addEventListener('change', resumen);
    document.getElementById('dgNuevas').addEventListener('input', resumen);
    document.getElementById('dgBus').addEventListener('input', function(){
      var t = this.value.trim().toLowerCase();
      todos('.dg-p').forEach(function(l){ l.hidden = !!t && l.dataset.t.indexOf(t) < 0; l.style.display = l.hidden ? 'none' : 'flex'; });
    });
    if (seccionInicial){   // «Asignar sección»: llega con esa sección marcada y la lista de personas nuevas apuntando a ella
      var sec0 = todos('.dg-sec').filter(function(s){ return s.dataset.k === seccionInicial; })[0];
      if (sec0){ todos('.dg-sec[data-k="' + seccionInicial.replace(/"/g, '\\"') + '"] .dg-pi').forEach(function(i){ i.checked = true; }); document.getElementById('dgSecN').value = seccionInicial; }
    }
    resumen();

    document.getElementById('dgOk').onclick = function(){
      var b = this, pids = elegidos(), nu = nuevasPersonas(), ids = todos('.dg-e:checked').map(function(i){ return i.value; }), entregas = [], msg = document.getElementById('dgMsg');
      b.disabled = true; msg.textContent = 'Asignando…';
      var ya = [];
      // Primero se crean las personas nuevas (si hay); después, a cada persona se le asignan todos los procesos elegidos.
      (nu.lista.length ? X.post('/c/personas', {personas: nu.lista}).then(function(j){ ids = ids.concat(j.nuevos); ya = j.existentes || []; }) : Promise.resolve()).then(function(){
        var cadena = Promise.resolve();
        ids.forEach(function(id){ cadena = cadena.then(function(){ return X.post('/c/asignar', {encuestado_id: id, agregar: pids}).then(function(r){ if (r.nuevos.length) entregas.push({eid: id, pids: r.nuevos}); }); }); });
        return cadena;
      }).then(function(){ return X.recargar(); }).then(function(){
        aviso('Asignación guardada: ' + plural(pids.length, 'proceso', 'procesos') + ' a ' + plural(ids.length, 'persona', 'personas') + '.' + (ya.length ? ' Ya existían y no se agregaron de nuevo: ' + ya.join(', ') + '.' : ''));
        if (entregas.length && X.correos) X.correos(entregas); else if (d.open) d.close();
      }).catch(function(err){ b.disabled = false; msg.textContent = err.message; X.recargar(); });
    };
  }

  // ---------------------------------------------------------------- paso 3: avance
  var ESTADO = {respondido: ['Respondido', 'c-ok'], en_curso: ['En curso', 'c-inf'], sin_cobertura: ['Sin respuestas', 'c-warn'], no_vigente: ['Ya no se hace', 'c-mut']};
  function paso3(c){
    var vivos = activos(), listos = vivos.filter(function(p){ return p.estado === 'respondido' || p.estado === 'no_vigente'; }).length;
    var h = '<h2 style="font-size:17px;margin:0 0 4px">Avance de tus procesos</h2>' +
      '<p class="muted" style="margin-top:0">Para continuar, <b>todos los procesos deben estar respondidos</b>. Aquí ves cuánto lleva cada uno, por sección y en toda tu gerencia.</p>' +
      '<div class="card" style="padding:12px 16px;margin:8px 0"><b>Toda tu gerencia</b><div style="font-size:26px;font-family:Montserrat,sans-serif;font-weight:800;color:var(--heading)">' + pct(listos, vivos.length) + '%</div>' +
      barra(listos, vivos.length, pct(listos, vivos.length) + '% de tus procesos respondidos') + '<div class="muted">' + listos + ' de ' + plural(vivos.length, 'proceso respondido', 'procesos respondidos') + '</div></div>';
    h += porSeccion(vivos).map(function(s){
      var ok = s.procs.filter(function(p){ return p.estado === 'respondido' || p.estado === 'no_vigente'; }).length;
      return '<section class="fg-sec" aria-label="' + esc(s.seccion) + '"><h3>' + esc(s.seccion) + ' <span class="chip ' + (ok === s.procs.length ? 'c-ok' : 'c-inf') + '">' + ok + ' de ' + s.procs.length + '</span></h3>' +
        '<div class="fg-fila" style="display:block">' + barra(ok, s.procs.length) + '</div>' +
        s.procs.map(function(p){
          var e = ESTADO[p.estado] || ESTADO.sin_cobertura, resp = nombresDe(p.id);
          return '<div class="fg-fila"><div class="fg-nom"><b>' + esc(nombreProc(p)) + '</b><p class="muted">' + (resp.length ? 'A cargo de ' + esc(resp.slice(0, 3).join(', ')) + (resp.length > 3 ? '…' : '') : 'Sin responsable') + '</p></div>' +
            '<div class="fg-der"><span class="chip ' + e[1] + '">' + e[0] + '</span>' + (p.total && p.estado !== 'no_vigente' ? barra(p.puntos, p.total, p.puntos + ' de ' + p.total + ' puntos') + '<span class="muted">' + p.puntos + ' de ' + p.total + ' puntos</span>' : '') + '</div></div>';
        }).join('') + '</section>';
    }).join('');
    c.innerHTML = h;
    pie(c, 3, 'Confirmar avance y continuar');
    enlazarPie(c, 3, 'Todos tus procesos están respondidos. Pasarás a la validación final, después de que el equipo consultor valide.', '¿Estás seguro de continuar?');
  }

  // ---------------------------------------------------------------- paso 4: validación final
  var VALIDACION = {validado: ['Validado por MBC', 'c-ok'], actualizado: ['En revisión de MBC', 'c-inf'], '': ['Pendiente de MBC', 'c-warn']};
  function paso4(c){
    var vivos = activos(), val = vivos.filter(function(p){ return p.validacion === 'validado'; }).length, aprobada = !!F.aprobacion;
    var h = '<h2 style="font-size:17px;margin:0 0 4px">Validación final</h2>' +
      '<p class="muted" style="margin-top:0">El equipo consultor valida cada proceso después de las entrevistas. Cuando todos estén validados podrás dar tu <b>validación final</b>.</p>' +
      '<div class="card" style="padding:12px 16px;margin:8px 0"><b>Procesos validados por MBC</b><div style="font-size:26px;font-family:Montserrat,sans-serif;font-weight:800;color:var(--heading)">' + pct(val, vivos.length) + '%</div>' +
      barra(val, vivos.length, pct(val, vivos.length) + '% validado') + '<div class="muted">' + val + ' de ' + plural(vivos.length, 'proceso', 'procesos') + '</div></div>';
    h += porSeccion(vivos).map(function(s){
      return '<section class="fg-sec" aria-label="' + esc(s.seccion) + '"><h3>' + esc(s.seccion) + ' <span class="muted">' + esc(s.gerencia) + '</span></h3>' + s.procs.map(function(p){
        var v = VALIDACION[p.validacion] || VALIDACION[''];
        return '<div class="fg-fila"><div class="fg-nom"><b>' + esc(nombreProc(p)) + '</b>' + (p.agregado ? ' <span class="chip c-acc">Agregado por ti</span>' : '') +
          '<p class="muted">' + (p.descripcion ? esc(p.descripcion) : '<i>Sin descripción</i>') + '</p></div>' +
          '<div class="fg-der"><span class="chip ' + v[1] + '">' + v[0] + '</span>' + (p.validado_en ? '<p class="muted" style="margin:3px 0 0">' + esc(X.fecha(p.validado_en)) + '</p>' : '') + '</div></div>';
      }).join('') + '</section>';
    }).join('');
    c.innerHTML = h;
    pie(c, 4, 'Validación final');
    enlazarPie(c, 4, 'Estás dando tu aprobación final sobre ' + plural(vivos.length, 'proceso', 'procesos') + '. Después NO podrás cambiar nada ni volver atrás: solo el equipo consultor puede reabrirla.', '¿Dar tu validación final?', true);
    if (!aprobada){ var b = c.querySelector('[data-fg=confirmar]'); if (b) b.classList.remove('btn-navy'); }
    if (F.perfil === 'supervisor'){ var bc = c.querySelector('[data-fg=confirmar]'); if (bc) bc.remove(); c.insertAdjacentHTML('beforeend', '<p class="msg info" role="note">La validación final la da el Gerente de tu área. Tú llegas hasta aquí: tus procesos, su delegación y su avance.</p>'); }
  }

  // ---------------------------------------------------------------- API pública
  function montar(opciones){
    X = opciones;
    if (!document.getElementById('fgEstilo')){
      var st = document.createElement('style'); st.id = 'fgEstilo'; st.textContent = ESTILO; document.head.appendChild(st);
    }
    F = null; VISTA = 0; OCUPADO = false;
    X.raiz.innerHTML = '<p class="muted" role="status">Cargando tus pasos…</p>';
    return cargar().catch(function(err){ X.raiz.innerHTML = '<p class="msg warn" role="alert">' + esc(err.message) + '</p>'; });
  }
  window.FlujoGerente = {montar: montar, refrescar: refrescar, confirmar: confirmar};
})();
