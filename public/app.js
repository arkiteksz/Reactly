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
    b.disabled = r.count >= r.max;
    b.setAttribute('aria-pressed', r.id === selected);
    const n = document.createElement('span'); n.textContent = r.name;
    const c = document.createElement('span'); c.textContent = `${r.count}/${r.max}`;
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
socket.on('error:msg', say);

// ---- Oda içi (şimdilik basit liste) ----
function showRoom(state) {
  $('lobby').hidden = true;
  $('room').hidden = false;
  $('roomTitle').textContent = state.name.toUpperCase();
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
}
socket.on('room:joined', showRoom);
socket.on('room:update', s => { if (!$('room').hidden) showRoom(s); });
$('leaveBtn').onclick = () => {
  socket.emit('room:leave');
  $('room').hidden = true;
  $('lobby').hidden = false;
  selected = null; say('');
};
