const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const AVATAR_COUNT = 8;
const MAX_PLAYERS = 8;
const rooms = new Map(); // id -> { id, name, hostId, players: Map(socketId -> {name, avatar}) }
let nextRoomId = 1;

const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);

function roomList() {
  return [...rooms.values()].map(r => ({
    id: r.id, name: r.name, count: r.players.size, max: MAX_PLAYERS, started: r.started
  }));
}
function roomState(r) {
  return {
    id: r.id, name: r.name, hostId: r.hostId, rounds: r.rounds, started: r.started,
    players: [...r.players.entries()].map(([id, p]) => ({ id, ...p }))
  };
}
const broadcastRooms = () => io.emit('rooms', roomList());

function leaveRoom(socket) {
  const r = rooms.get(socket.data.roomId);
  if (!r) return;
  r.players.delete(socket.id);
  socket.leave(r.id);
  socket.data.roomId = null;
  if (r.players.size === 0) rooms.delete(r.id);
  else {
    if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
    io.to(r.id).emit('room:update', roomState(r));
  }
  broadcastRooms();
}

io.on('connection', socket => {
  socket.emit('rooms', roomList());

  socket.on('profile', ({ name, avatar }) => {
    socket.data.name = clean(name, 14) || 'Oyuncu';
    socket.data.avatar = Math.min(Math.max(parseInt(avatar) || 0, 0), AVATAR_COUNT - 1);
  });

  const enter = (r, socket) => {
    r.players.set(socket.id, { name: socket.data.name, avatar: socket.data.avatar });
    socket.join(r.id);
    socket.data.roomId = r.id;
    socket.emit('room:joined', roomState(r));
    io.to(r.id).emit('room:update', roomState(r));
    broadcastRooms();
  };

  socket.on('room:create', ({ roomName }) => {
    if (!socket.data.name || socket.data.roomId) return;
    const id = 'r' + nextRoomId++;
    const r = { id, name: clean(roomName, 20) || `${socket.data.name} odası`, hostId: socket.id, rounds: 5, started: false, players: new Map() };
    rooms.set(id, r);
    enter(r, socket);
  });

  socket.on('room:join', ({ id }) => {
    const r = rooms.get(id);
    if (!socket.data.name || socket.data.roomId || !r) return socket.emit('error:msg', 'Oda bulunamadı.');
    if (r.players.size >= MAX_PLAYERS) return socket.emit('error:msg', 'Oda dolu.');
    if (r.started) return socket.emit('error:msg', 'Oyun başlamış.');
    enter(r, socket);
  });

  socket.on('room:settings', ({ rounds }) => {
    const r = rooms.get(socket.data.roomId);
    if (!r || r.hostId !== socket.id || r.started) return;
    const n = parseInt(rounds);
    if (![3, 5, 7, 10].includes(n)) return;
    r.rounds = n;
    io.to(r.id).emit('room:update', roomState(r));
  });

  socket.on('game:start', () => {
    const r = rooms.get(socket.data.roomId);
    if (!r || r.hostId !== socket.id || r.started) return;
    if (r.players.size < 2) return socket.emit('error:msg', 'Başlamak için en az 2 oyuncu lazım.');
    r.started = true;
    io.to(r.id).emit('room:update', roomState(r));
    io.to(r.id).emit('game:started', { rounds: r.rounds });
    broadcastRooms();
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Reactly çalışıyor: http://localhost:' + PORT));
