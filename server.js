'use strict';

/**
 * SyncSketch — real-time collaborative whiteboard server.
 * Express serves the static frontend; `ws` handles the real-time protocol.
 * Rooms live in server memory (demo scope — see README for the Redis scale path).
 * Created by devuvo (https://www.devuvo.com)
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8124;
const MAX_FRAME_BYTES = 64 * 1024;          // hard cap per message
const MAX_POINTS_PER_STROKE = 500;          // sanity cap on a single stroke
const MAX_STROKES_PER_ROOM = 500;           // history cap per room
const PING_INTERVAL_MS = 30000;             // heartbeat cadence
const PONG_TIMEOUT_MS = 45000;              // drop clients that miss pongs
const MAX_ROOM_CODE_LEN = 24;
const MAX_NAME_LEN = 32;

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
// rooms: Map<roomCode, { strokes: Stroke[], users: Map<clientId, {name, color}> }>
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { strokes: [], users: new Map() };
    rooms.set(code, room);
  }
  return room;
}

function publicUsers(room) {
  return [...room.users.entries()].map(([id, u]) => ({ id, name: u.name, color: u.color }));
}

// ---------------------------------------------------------------------------
// Validation (never trust a frame)
// ---------------------------------------------------------------------------
const ROOM_RE = /^[A-Za-z0-9_-]{1,24}$/;
const NAME_RE = /^[^\n\r\t]{1,32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isValidRoom(code) {
  return typeof code === 'string' && ROOM_RE.test(code);
}

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name.trim());
}

function isValidStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return false;
  if (!COLOR_RE.test(stroke.color || '')) return false;
  if (typeof stroke.width !== 'number' || stroke.width < 1 || stroke.width > 50) return false;
  if (!Array.isArray(stroke.points)) return false;
  if (stroke.points.length < 2 || stroke.points.length > MAX_POINTS_PER_STROKE) return false;
  for (const p of stroke.points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* drop */ }
  }
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const [id, client] of room.clients || []) {
    if (id === exceptId) continue;
    if (client.ws.readyState === client.ws.OPEN) {
      try { client.ws.send(data); } catch (_) { /* drop */ }
    }
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

let clientSeq = 0;
const USER_COLORS = ['#FF6115', '#263BAA', '#0B7A3E', '#B23BC9', '#C22E2E', '#0E7C86', '#8A5A00'];

wss.on('connection', (ws) => {
  const clientId = 'u' + (++clientSeq).toString(36) + Date.now().toString(36);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let roomCode = null;
  let userName = null;
  let userColor = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      if (raw.length > MAX_FRAME_BYTES) return;
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'join': {
        if (!isValidRoom(msg.room) || !isValidName(msg.name)) return;
        // leave previous room, if any
        leaveRoom();
        roomCode = msg.room;
        userName = msg.name.trim();
        userColor = USER_COLORS[clientSeq % USER_COLORS.length];
        const room = getRoom(roomCode);
        if (!room.clients) room.clients = new Map();
        room.clients.set(clientId, { ws, name: userName, color: userColor });
        room.users.set(clientId, { name: userName, color: userColor });
        send(ws, { t: 'init', strokes: room.strokes, users: publicUsers(room), you: clientId });
        broadcast(room, { t: 'users', users: publicUsers(room) }, clientId);
        break;
      }

      case 'stroke': {
        if (!roomCode || !isValidStroke(msg.stroke)) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const stroke = {
          color: msg.stroke.color,
          width: msg.stroke.width,
          points: msg.stroke.points,
          eraser: msg.stroke.eraser === true,
          from: clientId,
          at: Date.now(),
        };
        room.strokes.push(stroke);
        if (room.strokes.length > MAX_STROKES_PER_ROOM) {
          room.strokes.splice(0, room.strokes.length - MAX_STROKES_PER_ROOM);
        }
        broadcast(room, { t: 'stroke', stroke, from: clientId }, clientId);
        break;
      }

      case 'clear': {
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        room.strokes = [];
        broadcast(room, { t: 'clear', by: clientId }, null); // include sender
        break;
      }

      case 'cursor': {
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const x = msg.x, y = msg.y;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        broadcast(room, { t: 'cursor', from: clientId, name: userName, color: userColor, x, y }, clientId);
        break;
      }

      default:
        break; // unknown frame types are ignored
    }
  });

  function leaveRoom() {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (room) {
      if (room.clients) room.clients.delete(clientId);
      room.users.delete(clientId);
      broadcast(room, { t: 'users', users: publicUsers(room) }, null);
      if (room.users.size === 0) rooms.delete(roomCode); // tidy up empty rooms
    }
    roomCode = null;
  }

  ws.on('close', leaveRoom);
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

// Heartbeat: drop dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, PING_INTERVAL_MS);
heartbeat.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SyncSketch listening on http://localhost:${PORT} — Created by devuvo`);
  });
}

module.exports = { server, wss, rooms, isValidRoom, isValidName, isValidStroke };
