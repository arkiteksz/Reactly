const socket = io();
const $ = id => document.getElementById(id);

// ---- Avatarlar ----
// Kendi resimlerini public/images/avatars/ içine avatar0.png ... avatar7.png olarak koy.
// Resim yoksa otomatik olarak renkli yedek avatar çizilir.
const AVATAR_COUNT = 8;
const FALLBACK = ['#ffb3b3', '#ffee9e', '#b3f2ff', '#b8f5a6', '#e2b8ff', '#ffd1a3', '#a3c4ff', '#ffa3d6'];
const FACES = ['😎', '🤪', '😏', '🥸', '🤠', '😜', '🧐', '🤓'];

function avatarEl(i) {
  const img = new Image();
  img.alt = '';
  img.src = `images/avatars/avatar${i}.png`;
  img.onerror = () => {
    const d = document.createElement('div');
    d.style.cssText = `width:100%;height:100%;display:grid;place-items:center;font-size:56px;background:${FALLBACK[i]}`;
    d.textContent = FACES[i];
    img.replaceWith(d);
  };
  return img;
}
function setAvatar(target, i) { target.replaceChildren(avatarEl(i)); }

let avatar = Number(localStorage.getItem('avatar')) || Math.floor(Math.random() * AVATAR_COUNT);
setAvatar($('avatarBtn'), avatar);
$('avatarBtn').onclick = () => {
  avatar = (avatar + 1) % AVATAR_COUNT;
  localStorage.setItem('avatar', avatar);
  setAvatar($('avatarBtn'), avatar);
};

$('nameInput').value = localStorage.getItem('name') || '';

// ---- Lobi ----
let selected = null;
const say = t => { $('msg').textContent = t; };

function renderRooms(list) {
  const ul = $('roomList');
  ul.replaceChildren();
  if (selected && !list.some(r => r.id === selected)) selected = null;
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Henüz oda yok. İlk odayı sen kur!';
    ul.append(li);
  }
  for (const r of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'room-item';
    b.disabled = r.count >= r.max || r.started;
    b.setAttribute('aria-pressed', r.id === selected);
    const n = document.createElement('span'); n.textContent = r.name;
    const c = document.createElement('span'); c.textContent = r.started ? 'Oyunda' : `${r.count}/${r.max}`;
    b.append(n, c);
    b.onclick = () => { selected = r.id; renderRooms(list); };
    li.append(b);
    ul.append(li);
  }
  $('joinBtn').disabled = !selected;
  window._rooms = list;
}

function profile() {
  const name = $('nameInput').value.trim();
  if (!name) { say('Önce bir isim yaz.'); $('nameInput').focus(); return false; }
  localStorage.setItem('name', name);
  socket.emit('profile', { name, avatar });
  return true;
}

$('createBtn').onclick = () => {
  if (!profile()) return;
  const roomName = prompt('Oda adı:', `${$('nameInput').value.trim()} odası`);
  if (roomName === null) return;
  socket.emit('room:create', { roomName });
};
$('joinBtn').onclick = () => {
  if (selected && profile()) socket.emit('room:join', { id: selected });
};

socket.on('rooms', renderRooms);
socket.on('error:msg', t => { say(t); $('roomMsg').textContent = t; });

// ---- Oda içi ----
const ROUND_OPTIONS = [3, 5, 7, 10];

function show(id) {
  for (const s of ['lobby', 'room', 'game', 'board']) $(s).hidden = s !== id;
}

function showRoom(state) {
  show('room');
  $('roomTitle').textContent = state.name.toUpperCase();
  const isHost = state.hostId === socket.id;

  const ul = $('playerList');
  ul.replaceChildren();
  for (const p of state.players) {
    const li = document.createElement('li');
    li.className = 'player';
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, p.avatar);
    const nm = document.createElement('span'); nm.textContent = p.name;
    li.append(av, nm);
    if (p.id === state.hostId) { const k = document.createElement('span'); k.className = 'crown'; k.textContent = '👑'; li.append(k); }
    ul.append(li);
  }

  const picker = $('roundPicker');
  picker.replaceChildren();
  for (const n of ROUND_OPTIONS) {
    const b = document.createElement('button');
    b.className = 'round-btn';
    b.textContent = n;
    b.disabled = !isHost;
    b.setAttribute('aria-pressed', n === state.rounds);
    b.onclick = () => socket.emit('room:settings', { rounds: n });
    picker.append(b);
  }

  const start = $('startBtn');
  start.hidden = !isHost;
  start.disabled = state.players.length < 2;
  $('roomMsg').textContent = !isHost
    ? 'Oyunu odanın kurucusu başlatır.'
    : state.players.length < 2 ? 'En az 2 oyuncu lazım.' : '';
}

// ---- Oyun ----
let lastRoom = null;
let hand = [], pickedIdx = null, played = false, tick = null, progress = { played: 0, total: 0 };

function cardEl(n) {
  const img = new Image();
  img.className = 'card-img';
  img.alt = '';
  img.src = `images/cards/card${n}.png`;
  img.onerror = () => {
    const d = document.createElement('div');
    d.className = 'card-img';
    d.textContent = `#${n}`;
    img.replaceWith(d);
  };
  return img;
}

function renderHand() {
  const ul = $('hand');
  ul.replaceChildren();
  hand.forEach((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    b.disabled = played;
    b.setAttribute('aria-pressed', i === pickedIdx);
    b.append(cardEl(c));
    b.onclick = () => { pickedIdx = i; renderHand(); };
    li.append(b);
    ul.append(li);
  });
  $('playBtn').disabled = played || pickedIdx === null;
}

function countdown(sec, label) {
  clearInterval(tick);
  let left = sec;
  const upd = () => { $('timer').textContent = `${label}${left} sn`; };
  upd();
  tick = setInterval(() => { left = Math.max(0, left - 1); upd(); if (!left) clearInterval(tick); }, 1000);
}

function updateStatus() {
  $('status').textContent = played
    ? `Kartın atıldı. Bekleniyor: ${progress.played}/${progress.total}`
    : `Bir kart seç ve at. Atanlar: ${progress.played}/${progress.total}`;
}

socket.on('room:joined', s => { lastRoom = s; showRoom(s); });
socket.on('room:update', s => { lastRoom = s; if (!$('room').hidden) showRoom(s); });

socket.on('game:started', () => {
  show('game');
  hand = []; pickedIdx = null; played = false;
  $('chatLog').replaceChildren();
  $('reveal').hidden = true;
  renderHand();
});
socket.on('game:hand', ({ cards }) => { hand = cards; pickedIdx = null; renderHand(); });

socket.on('round:start', ({ round, total, prompt, seconds }) => {
  played = false; pickedIdx = null;
  progress = { played: 0, total: lastRoom ? lastRoom.players.length : 0 };
  $('roundLabel').textContent = `TUR ${round}/${total}`;
  $('promptText').textContent = prompt;
  $('reveal').hidden = true;
  countdown(seconds, '');
  updateStatus();
  renderHand();
});
socket.on('round:progress', p => { progress = p; updateStatus(); });
socket.on('card:ok', ({ card }) => {
  const i = hand.indexOf(card);
  if (i !== -1) hand.splice(i, 1);
  played = true; pickedIdx = null;
  updateStatus();
  renderHand();
});
let emojis = [];
const revealItem = id => $('reveal').querySelector(`[data-id="${id}"]`);

socket.on('round:reveal', ({ plays, emojis: em, seconds }) => {
  played = true;
  emojis = em;
  renderHand();
  const ul = $('reveal');
  ul.replaceChildren();
  for (const p of plays) {
    const li = document.createElement('li');
    li.className = 'reveal-item';
    li.dataset.id = p.id;
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, p.avatar);
    const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = p.name;
    const foot = document.createElement('div');
    if (p.id === socket.id) {
      foot.className = 'own-note';
      foot.textContent = 'Senin kartın';
    } else {
      foot.className = 'vote-row';
      em.forEach((x, i) => {
        const b = document.createElement('button');
        b.className = 'emoji-btn';
        b.textContent = x.e;
        b.title = `${x.points} puan`;
        b.setAttribute('aria-pressed', 'false');
        b.onclick = () => socket.emit('vote', { target: p.id, emoji: i });
        foot.append(b);
      });
    }
    li.append(av, nm, cardEl(p.card), foot);
    ul.append(li);
  }
  ul.hidden = false;
  countdown(seconds, 'Süre: ');
  $('status').textContent = 'Beğendiğin kartlara emoji bırak. Kendi kartına bırakamazsın.';
});

socket.on('vote:ok', ({ target, emoji }) => {
  const li = revealItem(target);
  if (!li) return;
  li.querySelectorAll('.emoji-btn').forEach((b, i) => b.setAttribute('aria-pressed', i === emoji));
});

socket.on('vote:progress', ({ done, total }) => {
  $('status').textContent = `Emojileri bırakan: ${done}/${total}. Kendi kartına bırakamazsın.`;
});

socket.on('round:scores', ({ results, seconds }) => {
  for (const r of results) {
    const li = revealItem(r.id);
    if (!li) continue;
    const old = li.lastElementChild;
    const box = document.createElement('div');
    box.className = 'tally';
    const line = document.createElement('div');
    line.className = 'tally-emojis';
    line.textContent = r.counts.map((n, i) => n ? `${emojis[i].e}×${n}` : '').filter(Boolean).join(' ') || 'Emoji yok';
    const gain = document.createElement('div');
    gain.className = 'gain';
    gain.textContent = `+${r.gained} puan`;
    const total = document.createElement('div');
    total.className = 'total';
    total.textContent = `Toplam: ${r.total}`;
    box.append(line, gain, total);
    old.replaceWith(box);
  }
  countdown(seconds, 'Sonraki tur: ');
  $('status').textContent = 'Tur puanları!';
});
function renderBoard(scores) {
  const rank = i => scores.findIndex(s => s.score === scores[i].score) + 1;
  const names = ['first', 'second', 'third'];
  const podium = $('podium');
  podium.replaceChildren();
  for (const i of [1, 0, 2].filter(i => i < scores.length)) {
    const p = scores[i];
    const li = document.createElement('li');
    li.className = 'step ' + names[i];
    const crown = document.createElement('div'); crown.className = 'crown'; crown.textContent = i === 0 ? '👑' : '';
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, p.avatar);
    const nm = document.createElement('div'); nm.className = 'sname'; nm.textContent = p.name;
    const sc = document.createElement('div'); sc.className = 'sscore'; sc.textContent = `${p.score} puan`;
    const block = document.createElement('div'); block.className = 'block'; block.textContent = rank(i);
    li.append(crown, av, nm, sc, block);
    podium.append(li);
  }
  const list = $('boardList');
  list.replaceChildren();
  scores.slice(3).forEach((p, k) => {
    const li = document.createElement('li');
    li.className = 'player';
    const rk = document.createElement('span'); rk.className = 'rank'; rk.textContent = rank(k + 3);
    const av = document.createElement('div'); av.className = 'avatar'; setAvatar(av, p.avatar);
    const nm = document.createElement('span'); nm.textContent = p.name;
    const sc = document.createElement('span'); sc.className = 'score'; sc.textContent = `${p.score} puan`;
    li.append(rk, av, nm, sc);
    list.append(li);
  });
  list.hidden = scores.length <= 3;
}

socket.on('game:over', ({ scores }) => {
  clearInterval(tick);
  renderBoard(scores);
  show('board');
});
socket.on('game:aborted', () => { clearInterval(tick); show('room'); });

$('playBtn').onclick = () => {
  if (pickedIdx !== null && !played) socket.emit('card:play', { card: hand[pickedIdx] });
};
$('boardBackBtn').onclick = () => { show('room'); if (lastRoom) showRoom(lastRoom); };

// ---- Sohbet ----
socket.on('chat:msg', ({ name, text }) => {
  const li = document.createElement('li');
  const b = document.createElement('strong'); b.textContent = name + ': ';
  li.append(b, document.createTextNode(text));
  const log = $('chatLog');
  log.append(li);
  log.scrollTop = log.scrollHeight;
});
$('chatInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const text = e.target.value.trim();
  if (text) socket.emit('chat:send', { text });
  e.target.value = '';
});

$('startBtn').onclick = () => socket.emit('game:start');
const leave = () => { clearInterval(tick); socket.emit('room:leave'); show('lobby'); selected = null; say(''); };
$('leaveBtn').onclick = leave;
$('gameLeaveBtn').onclick = leave;
$('boardLeaveBtn').onclick = leave;
