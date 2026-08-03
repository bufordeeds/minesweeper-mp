import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 3456;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname === '/' || pathname.startsWith('/r/')) pathname = '/index.html';
  const file = normalize(join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---------------------------------------------------------------------------
// Game logic
// ---------------------------------------------------------------------------

const DIFFICULTIES = {
  beginner: { w: 9, h: 9, mines: 10 },
  intermediate: { w: 16, h: 16, mines: 40 },
  expert: { w: 30, h: 16, mines: 99 },
};

const COLORS = ['#e6494f', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];

const rooms = new Map(); // code -> Room

function newGame(difficulty) {
  const { w, h, mines } = DIFFICULTIES[difficulty] || DIFFICULTIES.intermediate;
  return {
    difficulty,
    w,
    h,
    mineCount: mines,
    mines: null, // Set of indices, placed on first reveal so it's always safe
    counts: null, // adjacency counts per cell
    revealed: new Map(), // index -> playerId
    flags: new Map(), // index -> playerId
    status: 'waiting', // waiting | playing | won | lost
    exploded: -1,
  };
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, game: newGame('intermediate'), clients: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function neighbors(game, i) {
  const x = i % game.w;
  const y = Math.floor(i / game.w);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < game.w && ny >= 0 && ny < game.h) out.push(ny * game.w + nx);
    }
  }
  return out;
}

function placeMines(game, safeIndex) {
  const total = game.w * game.h;
  const forbidden = new Set([safeIndex, ...neighbors(game, safeIndex)]);
  const candidates = [];
  for (let i = 0; i < total; i++) if (!forbidden.has(i)) candidates.push(i);
  // If the board is too dense to keep the whole 3x3 safe, only protect the clicked cell
  if (candidates.length < game.mineCount) {
    candidates.length = 0;
    for (let i = 0; i < total; i++) if (i !== safeIndex) candidates.push(i);
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  game.mines = new Set(candidates.slice(0, game.mineCount));
  game.counts = new Array(total).fill(0);
  for (const m of game.mines) {
    for (const n of neighbors(game, m)) game.counts[n]++;
  }
}

function reveal(room, i, player) {
  const game = room.game;
  if (game.status === 'won' || game.status === 'lost') return false;
  if (i < 0 || i >= game.w * game.h) return false;
  if (game.revealed.has(i) || game.flags.has(i)) return false;

  if (!game.mines) {
    placeMines(game, i);
    game.status = 'playing';
  }

  if (game.mines.has(i)) {
    game.revealed.set(i, player.id);
    game.status = 'lost';
    game.exploded = i;
    return true;
  }

  // Flood fill from i; zero-count cells auto-expand
  const stack = [i];
  while (stack.length) {
    const c = stack.pop();
    if (game.revealed.has(c) || game.mines.has(c)) continue;
    game.revealed.set(c, player.id);
    player.score++;
    if (game.counts[c] === 0) {
      for (const n of neighbors(game, c)) {
        if (!game.revealed.has(n) && !game.flags.has(n)) stack.push(n);
      }
    }
  }

  if (game.revealed.size === game.w * game.h - game.mineCount) game.status = 'won';
  return true;
}

function chord(room, i, player) {
  const game = room.game;
  if (game.status !== 'playing') return false;
  if (!game.revealed.has(i) || game.counts[i] === 0) return false;
  const around = neighbors(game, i);
  const flagged = around.filter((n) => game.flags.has(n)).length;
  if (flagged !== game.counts[i]) return false;
  let changed = false;
  for (const n of around) {
    if (!game.flags.has(n) && !game.revealed.has(n)) {
      if (reveal(room, n, player)) changed = true;
      if (game.status === 'lost') break;
    }
  }
  return changed;
}

function toggleFlag(room, i, player) {
  const game = room.game;
  if (game.status === 'won' || game.status === 'lost') return false;
  if (i < 0 || i >= game.w * game.h) return false;
  if (game.revealed.has(i)) return false;
  if (game.flags.has(i)) game.flags.delete(i);
  else game.flags.set(i, player.id);
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket wiring
// ---------------------------------------------------------------------------

function statePayload(room) {
  const game = room.game;
  const over = game.status === 'won' || game.status === 'lost';
  return {
    t: 'state',
    room: room.code,
    difficulty: game.difficulty,
    w: game.w,
    h: game.h,
    mineCount: game.mineCount,
    status: game.status,
    exploded: game.exploded,
    cells: [...game.revealed].map(([i, by]) => [i, game.mines?.has(i) ? -1 : game.counts[i], by]),
    flags: [...game.flags].map(([i, by]) => [i, by]),
    minesLeft: over && game.status === 'lost' && game.mines ? [...game.mines] : [],
    players: [...room.clients].map((ws) => {
      const p = ws.player;
      return { id: p.id, name: p.name, color: p.color, score: p.score };
    }),
  };
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  for (const ws of room.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function pickColor(room) {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const ws of room.clients) used.set(ws.player.color, (used.get(ws.player.color) || 0) + 1);
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (!code) return;
      const room = getRoom(code);
      ws.room = room;
      ws.player = {
        id: randomUUID().slice(0, 8),
        name: String(msg.name || 'anon').slice(0, 20) || 'anon',
        color: pickColor(room),
        score: 0,
      };
      room.clients.add(ws);
      ws.send(JSON.stringify({ t: 'welcome', id: ws.player.id }));
      broadcast(room, statePayload(room));
      return;
    }

    const room = ws.room;
    if (!room || !ws.player) return;

    switch (msg.t) {
      case 'reveal':
        if (reveal(room, msg.i | 0, ws.player)) broadcast(room, statePayload(room));
        break;
      case 'chord':
        if (chord(room, msg.i | 0, ws.player)) broadcast(room, statePayload(room));
        break;
      case 'flag':
        if (toggleFlag(room, msg.i | 0, ws.player)) broadcast(room, statePayload(room));
        break;
      case 'restart': {
        const difficulty = DIFFICULTIES[msg.difficulty] ? msg.difficulty : room.game.difficulty;
        room.game = newGame(difficulty);
        for (const client of room.clients) client.player.score = 0;
        broadcast(room, statePayload(room));
        break;
      }
      case 'cursor':
        // Lightweight relay to everyone else; not part of game state
        for (const other of room.clients) {
          if (other !== ws && other.readyState === other.OPEN) {
            other.send(
              JSON.stringify({ t: 'cursor', id: ws.player.id, fx: +msg.fx || 0, fy: +msg.fy || 0 })
            );
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    if (ws.player) broadcast(room, { t: 'left', id: ws.player.id });
    if (room.clients.size === 0) rooms.delete(room.code);
    else broadcast(room, statePayload(room));
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`minesweeper-mp listening on http://localhost:${PORT}`);
});
