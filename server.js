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
const CARD_COUNT = 37;      // public/images/cards/card0.png ... card36.png
const PICK_SECONDS = 30;    // kart seçme süresi
const VOTE_SECONDS = 15;    // kartlar açıldıktan sonra emoji bırakma süresi
const RESULT_SECONDS = 6;   // tur puanlarının gösterilme süresi
// Emojiler ve puanları. İstersen değiştir (sıra: en düşükten en yükseğe).
const EMOJIS = [
  { e: '🙂', points: 1 },
  { e: '😂', points: 2 },
  { e: '🤣', points: 3 }
];

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
  r.game = { round: 0, hands: dealHands(r), plays: new Map(), phase: 'idle', timer: null, prompts: shuffle(PROMPTS),
    scores: new Map([...r.players.keys()].map(id => [id, 0])), votes: new Map(), revealed: [], revealedPlays: [] };
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
  g.phase = 'vote';
  clearTimeout(g.timer);
  g.votes = new Map();
  g.revealedPlays = [...g.plays.entries()].map(([id, card]) => ({ id, ...r.players.get(id), card }));
  g.revealed = g.revealedPlays.map(p => p.id);
  io.to(r.id).emit('round:reveal', { plays: g.revealedPlays, emojis: EMOJIS, seconds: VOTE_SECONDS });
  g.timer = setTimeout(() => endVote(r), VOTE_SECONDS * 1000);
}

function votesComplete(r) {
  const g = r.game;
  return [...r.players.keys()].every(id => {
    const need = g.revealed.filter(t => t !== id).length;
    const v = g.votes.get(id);
    return (v ? v.size : 0) >= need;
  });
}

function checkVotesDone(r) {
  const g = r.game;
  if (g && g.phase === 'vote' && votesComplete(r)) endVote(r);
}

function castVote(r, voter, target, emoji) {
  const g = r.game;
  if (!g || g.phase !== 'vote' || !r.players.has(voter)) return;
  if (target === voter || !g.revealed.includes(target) || !EMOJIS[emoji]) return;
  if (!g.votes.has(voter)) g.votes.set(voter, new Map());
  g.votes.get(voter).set(target, emoji);
  io.to(voter).emit('vote:ok', { target, emoji });
  const done = [...r.players.keys()].filter(id => {
    const need = g.revealed.filter(t => t !== id).length;
    const v = g.votes.get(id);
    return (v ? v.size : 0) >= need;
  }).length;
  io.to(r.id).emit('vote:progress', { done, total: r.players.size });
  checkVotesDone(r);
}

function endVote(r) {
  const g = r.game;
  if (!g || g.phase !== 'vote') return;
  g.phase = 'result';
  clearTimeout(g.timer);
  const counts = new Map(g.revealed.map(id => [id, EMOJIS.map(() => 0)]));
  for (const [voter, votes] of g.votes) {
    for (const [target, emoji] of votes) {
      if (target !== voter && counts.has(target)) counts.get(target)[emoji]++;
    }
  }
  const results = g.revealedPlays.map(p => {
    const c = counts.get(p.id);
    const gained = c.reduce((sum, n, i) => sum + n * EMOJIS[i].points, 0);
    const total = (g.scores.get(p.id) || 0) + gained;
    g.scores.set(p.id, total);
    return { ...p, counts: c, gained, total };
  });
  io.to(r.id).emit('round:scores', { results, seconds: RESULT_SECONDS });
  g.timer = setTimeout(() => nextRound(r), RESULT_SECONDS * 1000);
}

function endGame(r) {
  let scores = [];
  if (r.game) {
    clearTimeout(r.game.timer);
    scores = [...r.players.entries()]
      .map(([id, p]) => ({ id, ...p, score: r.game.scores.get(id) || 0 }))
      .sort((a, b) => b.score - a.score);
  }
  r.game = null;
  r.started = false;
  io.to(r.id).emit('game:over', { scores });
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
    r.game.votes.delete(socket.id);
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
    checkVotesDone(r);
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

  socket.on('vote', ({ target, emoji }) => {
    const r = rooms.get(socket.data.roomId);
    if (r) castVote(r, socket.id, String(target), parseInt(emoji));
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
