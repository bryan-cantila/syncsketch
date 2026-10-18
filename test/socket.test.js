'use strict';
/* SyncSketch protocol tests — run against a live server instance.
   node --test test/socket.test.js */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { server, rooms } = require('../server');

const PORT = 18234;
let url;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMsg(ws) {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

function join(ws, room, name) {
  ws.send(JSON.stringify({ t: 'join', room, name }));
  return nextMsg(ws); // the init frame
}

const stroke = (color) => ({
  t: 'stroke', room: 'room-a',
  stroke: { color: color || '#FF6115', width: 7, points: [{ x: 1, y: 1 }, { x: 50, y: 50 }, { x: 90, y: 10 }] },
});

before(async () => {
  await new Promise((res) => server.listen(PORT, res));
  url = `ws://localhost:${PORT}`;
});

after(async () => {
  await new Promise((res) => server.close(res));
});

test('two clients in the same room: stroke from A arrives at B', async () => {
  const a = await connect();
  const b = await connect();
  const initA = await join(a, 'room-a', 'alice');
  const initB = await join(b, 'room-a', 'bob');

  assert.equal(initA.users.length, 1);
  assert.equal(initB.users.length, 2, 'B sees both users after joining');

  const gotB = nextMsg(b);
  a.send(JSON.stringify(stroke()));
  const msg = await gotB;

  assert.equal(msg.t, 'stroke');
  assert.equal(msg.stroke.color, '#FF6115');
  assert.equal(msg.stroke.points.length, 3);
  assert.ok(msg.from, 'stroke carries sender id');

  a.close(); b.close();
});

test('client in another room does NOT receive the stroke', async () => {
  const a = await connect();
  const c = await connect();
  await join(a, 'room-a2', 'alice');
  await join(c, 'room-other', 'carol');

  let received = false;
  c.on('message', () => { received = true; });

  a.send(JSON.stringify({ ...stroke(), room: 'room-a2' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received, false, 'other-room client got a stroke it should not see');

  a.close(); c.close();
});

test('clear broadcasts to everyone including the sender', async () => {
  const a = await connect();
  const b = await connect();
  await join(a, 'room-c', 'alice');
  await join(b, 'room-c', 'bob');
  await nextMsg(a); // consume the 'users' broadcast triggered by b joining

  const gotA = nextMsg(a);
  const gotB = nextMsg(b);
  a.send(JSON.stringify({ t: 'clear', room: 'room-c' }));

  const [mA, mB] = await Promise.all([gotA, gotB]);
  assert.equal(mA.t, 'clear');
  assert.equal(mB.t, 'clear');
  assert.equal(rooms.get('room-c').strokes.length, 0, 'server history wiped');

  a.close(); b.close();
});

test('late joiner receives full stroke history on init', async () => {
  const a = await connect();
  await join(a, 'room-h', 'alice');
  a.send(JSON.stringify({ ...stroke('#263BAA'), room: 'room-h' }));
  await new Promise((r) => setTimeout(r, 200));

  const b = await connect();
  const init = await join(b, 'room-h', 'bob');
  assert.equal(init.strokes.length, 1);
  assert.equal(init.strokes[0].color, '#263BAA');

  a.close(); b.close();
});

test('disconnect removes the user and broadcasts the updated list', async () => {
  const a = await connect();
  const b = await connect();
  await join(a, 'room-d', 'alice');
  await join(b, 'room-d', 'bob');

  const updated = nextMsg(b);
  a.close(); // alice leaves

  const msg = await updated;
  assert.equal(msg.t, 'users');
  assert.equal(msg.users.length, 1);
  assert.equal(msg.users[0].name, 'bob');

  b.close();
});

test('malformed frames are ignored, server stays up', async () => {
  const a = await connect();
  await join(a, 'room-m', 'alice');
  a.send('this is not json {{{');
  a.send(JSON.stringify({ t: 'stroke', room: 'room-m', stroke: { color: 'nope', width: 999, points: [] } }));
  a.send(JSON.stringify({ t: 'nonsense' }));
  await new Promise((r) => setTimeout(r, 200));

  // server still responsive: a valid stroke goes through
  const b = await connect();
  const initB = await join(b, 'room-m', 'bob');
  const gotB = nextMsg(b);
  a.send(JSON.stringify({ ...stroke(), room: 'room-m' }));
  const msg = await gotB;
  assert.equal(msg.t, 'stroke');
  assert.equal(initB.users.length, 2);

  a.close(); b.close();
});
