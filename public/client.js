'use strict';

// ---------------------------------------------------------------------------
// Room + identity
// ---------------------------------------------------------------------------

function roomFromUrl() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,12})/);
  return m ? m[1].toUpperCase() : null;
}

function newRoomCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

let roomCode = roomFromUrl();
if (!roomCode) {
  roomCode = newRoomCode();
  history.replaceState(null, '', `/r/${roomCode}`);
}

const els = {
  join: document.getElementById('join'),
  joinSub: document.getElementById('join-sub'),
  nameInput: document.getElementById('name-input'),
  joinBtn: document.getElementById('join-btn'),
  board: document.getElementById('board'),
  boardWrap: document.getElementById('board-wrap'),
  cursors: document.getElementById('cursors'),
  players: document.getElementById('players'),
  status: document.getElementById('status'),
  minesLeft: document.getElementById('mines-left'),
  difficulty: document.getElementById('difficulty'),
  restart: document.getElementById('restart'),
  invite: document.getElementById('invite'),
};

els.joinSub.textContent = `Room ${roomCode} — clear the board together.`;
els.nameInput.value = localStorage.getItem('ms-name') || '';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let ws = null;
let myId = null;
let state = null;
let joined = false;
const cursorTags = new Map(); // playerId -> element

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    if (joined) sendJoin(); // rejoin after a reconnect
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'welcome') {
      myId = msg.id;
    } else if (msg.t === 'state') {
      state = msg;
      render();
    } else if (msg.t === 'cursor') {
      moveCursor(msg.id, msg.fx, msg.fy);
    } else if (msg.t === 'left') {
      const tag = cursorTags.get(msg.id);
      if (tag) tag.remove();
      cursorTags.delete(msg.id);
    }
  };

  ws.onclose = () => {
    myId = null;
    setTimeout(connect, 1000);
  };
}

function sendJoin() {
  ws.send(JSON.stringify({ t: 'join', room: roomCode, name: els.nameInput.value.trim() || 'anon' }));
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

connect();

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

function join() {
  const name = els.nameInput.value.trim();
  if (!name) {
    els.nameInput.focus();
    return;
  }
  localStorage.setItem('ms-name', name);
  joined = true;
  els.join.classList.add('hidden');
  if (ws.readyState === WebSocket.OPEN) sendJoin();
}

els.joinBtn.addEventListener('click', join);
els.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let cellEls = [];
let builtFor = '';

function buildGrid() {
  const key = `${state.w}x${state.h}`;
  if (builtFor === key) return;
  builtFor = key;
  els.board.style.gridTemplateColumns = `repeat(${state.w}, 30px)`;
  els.board.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < state.w * state.h; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = i;
    els.board.appendChild(cell);
    cellEls.push(cell);
  }
}

function playerById(id) {
  return state.players.find((p) => p.id === id);
}

function render() {
  buildGrid();

  const over = state.status === 'won' || state.status === 'lost';
  const revealed = new Map(state.cells.map(([i, n, by]) => [i, { n, by }]));
  const flags = new Map(state.flags);
  const mines = new Set(state.minesLeft);

  for (let i = 0; i < cellEls.length; i++) {
    const cell = cellEls[i];
    cell.className = 'cell';
    cell.style.removeProperty('--tint');
    cell.textContent = '';

    const r = revealed.get(i);
    if (r) {
      cell.classList.add('open');
      if (r.n === -1) {
        cell.classList.add('mine', 'exploded');
        cell.textContent = '💥';
      } else {
        if (r.n > 0) {
          cell.textContent = r.n;
          cell.classList.add(`n${r.n}`);
        }
        const p = playerById(r.by);
        if (p) {
          cell.classList.add('tinted');
          cell.style.setProperty('--tint', p.color + '14');
        }
      }
    } else if (flags.has(i)) {
      cell.classList.add('flag');
      cell.textContent = '🚩';
      const p = playerById(flags.get(i));
      if (p) cell.style.boxShadow = `inset 0 0 0 2px ${p.color}55`;
    } else if (over && mines.has(i)) {
      cell.classList.add('mine');
      cell.textContent = '💣';
    }
    if (!flags.has(i)) cell.style.boxShadow = '';
  }

  // Header info
  els.minesLeft.textContent = `💣 ${state.mineCount - state.flags.length}`;
  els.difficulty.value = state.difficulty;

  // Players
  els.players.innerHTML = '';
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const chip = document.createElement('span');
    chip.className = 'player-chip' + (p.id === myId ? ' me' : '');
    chip.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''} <span class="score">${p.score}</span>`;
    els.players.appendChild(chip);
  }

  // Status line
  els.status.className = '';
  if (state.status === 'won') {
    els.status.classList.add('won');
    els.status.textContent = '🎉 Board cleared! Hit "New game" for another round.';
  } else if (state.status === 'lost') {
    els.status.classList.add('lost');
    const culprit = revealed.get(state.exploded);
    const p = culprit && playerById(culprit.by);
    els.status.textContent = `💥 ${p ? p.name : 'Someone'} hit a mine. Hit "New game" to try again.`;
  } else if (state.players.length === 1) {
    els.status.textContent = 'Waiting for friends — copy the invite link and send it over.';
  } else {
    els.status.textContent = `${state.players.length} players sweeping.`;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

els.board.addEventListener('click', (e) => {
  const i = cellIndex(e);
  if (i === null) return;
  const revealed = state && state.cells.some(([ci]) => ci === i);
  send({ t: revealed ? 'chord' : 'reveal', i });
});

els.board.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const i = cellIndex(e);
  if (i !== null) send({ t: 'flag', i });
});

// Long-press to flag on touch devices
let pressTimer = null;
els.board.addEventListener('touchstart', (e) => {
  const i = cellIndex(e);
  if (i === null) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    send({ t: 'flag', i });
  }, 450);
});
els.board.addEventListener('touchend', () => clearTimeout(pressTimer));
els.board.addEventListener('touchmove', () => clearTimeout(pressTimer));

function cellIndex(e) {
  const target = (e.touches ? document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY) : e.target);
  if (!target || !target.classList || !target.classList.contains('cell')) return null;
  return +target.dataset.i;
}

els.restart.addEventListener('click', () => send({ t: 'restart', difficulty: els.difficulty.value }));
els.difficulty.addEventListener('change', () => send({ t: 'restart', difficulty: els.difficulty.value }));

els.invite.addEventListener('click', async () => {
  const url = `${location.origin}/r/${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    prompt('Copy this link:', url);
  }
  els.invite.textContent = '✅ Link copied';
  els.invite.classList.add('copied');
  setTimeout(() => {
    els.invite.textContent = '🔗 Copy invite link';
    els.invite.classList.remove('copied');
  }, 1500);
});

// ---------------------------------------------------------------------------
// Live cursors
// ---------------------------------------------------------------------------

let lastCursorSent = 0;
els.boardWrap.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastCursorSent < 60) return;
  lastCursorSent = now;
  const rect = els.board.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  send({ t: 'cursor', fx, fy });
});

function moveCursor(id, fx, fy) {
  if (id === myId || !state) return;
  let tag = cursorTags.get(id);
  if (!tag) {
    tag = document.createElement('div');
    tag.className = 'cursor-tag';
    els.cursors.appendChild(tag);
    cursorTags.set(id, tag);
  }
  const p = playerById(id);
  tag.textContent = p ? p.name : '?';
  tag.style.background = p ? p.color : '#666';
  tag.style.left = `${fx * 100}%`;
  tag.style.top = `${fy * 100}%`;
}
