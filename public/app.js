'use strict';
/* SyncSketch board client — canvas drawing + WebSocket sync with backoff reconnect.
   Created by devuvo */

(function () {
  var params = new URLSearchParams(location.search);
  var ROOM = params.get('room') || 'lobby';
  var NAME = params.get('name') || 'guest';

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var cursorsEl = document.getElementById('cursors');
  var usersEl = document.getElementById('users');
  var statusEl = document.getElementById('status');
  var roomPill = document.getElementById('roomPill');

  roomPill.textContent = 'room: ' + ROOM;
  roomPill.addEventListener('click', function () {
    var link = location.origin + location.pathname + '?room=' + encodeURIComponent(ROOM);
    copyText(link);
    roomPill.textContent = 'copied!';
    setTimeout(function () { roomPill.textContent = 'room: ' + ROOM; }, 1200);
  });

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  // ------------------------------------------------------------------ canvas
  var strokes = [];          // all strokes on the board (local + remote)
  var drawing = false;
  var current = null;        // stroke being drawn locally
  var color = '#FF6115';
  var width = 7;
  var erasing = false;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  function fitCanvas() {
    var r = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width * dpr));
    canvas.height = Math.max(1, Math.floor(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    redraw();
  }

  function drawStroke(s) {
    if (!s.points || s.points.length < 2) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    // eraser strokes are drawn with destination-out so they knock out ink
    if (s.eraser) ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < strokes.length; i++) drawStroke(strokes[i]);
  }

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    var p = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    var p = pos(e);
    current = { color: erasing ? '#000000' : color, width: erasing ? width * 3 : width, points: [p], eraser: erasing };
    canvas.setPointerCapture && e.pointerId !== undefined && canvas.setPointerCapture(e.pointerId);
  }

  function moveDraw(e) {
    var p = pos(e);
    sendCursor(p.x, p.y);
    if (!drawing || !current) return;
    e.preventDefault();
    var last = current.points[current.points.length - 1];
    var dx = p.x - last.x, dy = p.y - last.y;
    if (dx * dx + dy * dy < 4) return; // skip near-duplicate points
    current.points.push(p);
    // live-preview just the new segment
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = current.color; ctx.lineWidth = current.width;
    if (current.eraser) ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.restore();
  }

  function endDraw() {
    if (!drawing) return;
    drawing = false;
    if (current && current.points.length >= 2) {
      var out = { color: current.color, width: current.width, points: current.points };
      if (current.eraser) {
        // eraser: apply locally only, then tell everyone to erase the same path
        strokes.push({ color: current.color, width: current.width, points: current.points, eraser: true });
        send({ t: 'stroke', room: ROOM, stroke: { color: '#000000', width: current.width, points: current.points, eraser: true } });
      } else {
        strokes.push(out);
        send({ t: 'stroke', room: ROOM, stroke: out });
      }
    }
    current = null;
  }

  canvas.addEventListener('pointerdown', startDraw);
  canvas.addEventListener('pointermove', moveDraw);
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  canvas.addEventListener('pointerleave', function () { if (drawing) endDraw(); });
  window.addEventListener('resize', fitCanvas);

  // ------------------------------------------------------------------ toolbar
  var COLORS = ['#FF6115', '#111111', '#263BAA', '#0B7A3E', '#B23BC9', '#C22E2E', '#0E7C86', '#FFFCF4'];
  var swatchesEl = document.getElementById('swatches');
  COLORS.forEach(function (c, i) {
    var b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', 'Color ' + c);
    b.addEventListener('click', function () {
      color = c; erasing = false;
      document.getElementById('eraser').classList.remove('on');
      var kids = swatchesEl.children;
      for (var k = 0; k < kids.length; k++) kids[k].classList.remove('on');
      b.classList.add('on');
    });
    swatchesEl.appendChild(b);
  });

  var widthsEl = document.getElementById('widths');
  widthsEl.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    width = parseInt(b.getAttribute('data-w'), 10);
    var kids = widthsEl.children;
    for (var k = 0; k < kids.length; k++) kids[k].classList.remove('on');
    b.classList.add('on');
  });

  document.getElementById('eraser').addEventListener('click', function () {
    erasing = !erasing;
    this.classList.toggle('on', erasing);
  });

  document.getElementById('clear').addEventListener('click', function () {
    if (confirm('Clear the board for everyone in this room?')) {
      strokes = [];
      redraw();
      send({ t: 'clear', room: ROOM });
    }
  });

  // ------------------------------------------------------------------ socket
  var ws = null;
  var backoff = 1000;
  var cursorThrottle = 0;
  var peerCursors = {}; // id -> {el, name, color, timer}
  var myId = null;

  function setStatus(txt, cls) {
    statusEl.textContent = txt;
    statusEl.className = 'status ' + (cls || '');
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // cursor positions are throttled to ~15/sec so we don't flood the room
  function sendCursor(x, y) {
    var now = Date.now();
    if (now - cursorThrottle < 66) return;
    cursorThrottle = now;
    send({ t: 'cursor', room: ROOM, x: Math.round(x), y: Math.round(y) });
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    setStatus('connecting…', 'warn');

    ws.onopen = function () {
      setStatus('live', 'ok');
      backoff = 1000;
      send({ t: 'join', room: ROOM, name: NAME });
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'init') {
        myId = msg.you;
        strokes = (msg.strokes || []).map(function (s) {
          return { color: s.color, width: s.width, points: s.points, eraser: !!s.eraser };
        });
        redraw();
        renderUsers(msg.users || []);
      } else if (msg.t === 'stroke') {
        var s = msg.stroke || {};
        strokes.push({ color: s.color, width: s.width, points: s.points, eraser: !!s.eraser });
        drawStroke({ color: s.color, width: s.width, points: s.points, eraser: !!s.eraser });
      } else if (msg.t === 'clear') {
        strokes = [];
        redraw();
      } else if (msg.t === 'users') {
        renderUsers(msg.users || []);
      } else if (msg.t === 'cursor') {
        if (msg.from === myId) return;
        showCursor(msg.from, msg.name, msg.color, msg.x, msg.y);
      }
    };

    ws.onclose = function () {
      setStatus('reconnecting…', 'warn');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000); // exponential backoff, capped
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function renderUsers(users) {
    usersEl.innerHTML = '';
    users.forEach(function (u) {
      var chip = document.createElement('span');
      chip.className = 'user-chip';
      chip.innerHTML = '<i style="background:' + esc(u.color) + '"></i>' + esc(u.name) + (u.id === myId ? ' (you)' : '');
      usersEl.appendChild(chip);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showCursor(id, name, color, x, y) {
    var c = peerCursors[id];
    if (!c) {
      var el = document.createElement('div');
      el.className = 'peer-cursor';
      el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 3 L19 12 L12 13 L9 20 Z" fill="' + esc(color || '#111') + '" stroke="#111" stroke-width="1.5"/></svg><span></span>';
      cursorsEl.appendChild(el);
      c = peerCursors[id] = { el: el, label: el.querySelector('span') };
    }
    c.label.textContent = name || '?';
    c.label.style.background = color || '#111';
    var wrap = canvas.parentElement.getBoundingClientRect();
    var host = cursorsEl.getBoundingClientRect();
    c.el.style.transform = 'translate(' + (x + wrap.left - host.left) + 'px,' + (y + wrap.top - host.top) + 'px)';
    clearTimeout(c.timer);
    c.timer = setTimeout(function () {
      if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
      delete peerCursors[id];
    }, 4000); // fade cursors that stop moving
  }

  fitCanvas();
  connect();
})();
