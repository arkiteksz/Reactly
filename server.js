const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PROMPTS = require('./prompts');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const AVATAR_COUNT = 8;
const MAX_PLAYERS = 8;
const CARD_COUNT = 37;      // public/images/cards/card0.png ... card29.png
const PICK_SECONDS = 30;    // kart seçme süresi
const REVEAL_SECONDS = 8;   // kartlar açıldıktan sonra bekleme (aşama 4'te emoji süresi olacak)

const rooms = new Map();
let nextRoomId = 1;

const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const shuffle = a => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

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

// ---------- Oyun akışı ----------
function dealHands(r) {
  const need = r.players.size * r.rounds;
  let pool = [];
  while (pool.length < need) pool = pool.concat(shuffle([...Array(CARD_COUNT).keys()]));
  const hands = new Map();
  let k = 0;
  for (const id of r.players.keys()) {
    hands.set(id, pool.slice(k, k + r.rounds));
    k += r.rounds;
  }
  return hands;
}

function startGame(r) {
  r.game = { round: 0, hands: dealHands(r), plays: new Map(), phase: 'idle', timer: null, prompts: shuffle(PROMPTS) };
  for (const [id, cards] of r.game.hands) io.to(id).emit('game:hand', { cards });
  nextRound(r);
}

function nextRound(r) {
  const g = r.game;
  if (!g) return;
  if (g.round >= r.rounds) return endGame(r);
  g.round++;
  g.plays = new Map();
  g.phase = 'pick';
  g.prompt = g.prompts[(g.round - 1) % g.prompts.length];
  io.to(r.id).emit('round:start', { round: g.round, total: r.rounds, prompt: g.prompt, seconds: PICK_SECONDS });
  g.timer = setTimeout(() => autoPlay(r), PICK_SECONDS * 1000);
}

function playCard(r, id, card) {
  const g = r.game;
  const hand = g.hands.get(id);
  const i = hand ? hand.indexOf(card) : -1;
  if (i === -1) return;
  hand.splice(i, 1);
  g.plays.set(id, card);
  io.to(id).emit('card:ok', { card });
  io.to(r.id).emit('round:progress', { played: g.plays.size, total: r.players.size });
  checkAllPlayed(r);
}

function checkAllPlayed(r) {
  const g = r.game;
  if (g && g.phase === 'pick' && g.plays.size >= r.players.size) reveal(r);
}

function autoPlay(r) {
  const g = r.game;
  if (!g || g.phase !== 'pick') return;
  for (const id of [...r.players.keys()]) {
    if (g.plays.has(id)) continue;
    const hand = g.hands.get(id) || [];
    if (hand.length) playCard(r, id, hand[Math.floor(Math.random() * hand.length)]);
  }
  if (g.phase === 'pick') reveal(r);
}

function reveal(r) {
  const g = r.game;
  g.phase = 'reveal';
  clearTimeout(g.timer);
  const plays = [...g.plays.entries()].map(([id, card]) => ({ id, ...r.players.get(id), card }));
  io.to(r.id).emit('round:reveal', { plays, seconds: REVEAL_SECONDS });
  g.timer = setTimeout(() => nextRound(r), REVEAL_SECONDS * 1000);
}

function endGame(r) {
  if (r.game) clearTimeout(r.game.timer);
  r.game = null;
  r.started = false;
  io.to(r.id).emit('game:over');
  io.to(r.id).emit('room:update', roomState(r));
  broadcastRooms();
}

function leaveRoom(socket) {
  const r = rooms.get(socket.data.roomId);
  if (!r) return;
  r.players.delete(socket.id);
  socket.leave(r.id);
  socket.data.roomId = null;
  if (r.game) {
    r.game.hands.delete(socket.id);
    r.game.plays.delete(socket.id);
  }
  if (r.players.size === 0) {
    if (r.game) clearTimeout(r.game.timer);
    rooms.delete(r.id);
  } else {
    if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
    if (r.game && r.players.size < 2) {
      clearTimeout(r.game.timer);
      r.game = null;
      r.started = false;
      io.to(r.id).emit('game:aborted');
    }
    io.to(r.id).emit('room:update', roomState(r));
    checkAllPlayed(r);
  }
  broadcastRooms();
}

// ---------- Bağlantılar ----------
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
    const r = { id, name: clean(roomName, 20) || `${socket.data.name} odası`, hostId: socket.id, rounds: 5, started: false, game: null, players: new Map() };
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
    startGame(r);
  });

  socket.on('card:play', ({ card }) => {
    const r = rooms.get(socket.data.roomId);
    const g = r && r.game;
    if (!g || g.phase !== 'pick' || g.plays.has(socket.id)) return;
    playCard(r, socket.id, parseInt(card));
  });

  socket.on('chat:send', ({ text }) => {
    const r = rooms.get(socket.data.roomId);
    const t = clean(text, 200);
    if (!r || !t) return;
    io.to(r.id).emit('chat:msg', { name: socket.data.name, text: t });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Reactly çalışıyor: http://localhost:' + PORT));
