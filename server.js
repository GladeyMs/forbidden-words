'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const DEFAULT_WORDS = require('./words.json');

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;
const MAX_CUSTOM_WORDS = 100;
const TIME_OPTIONS = [3, 5, 7]; // นาที ให้หัวห้องเลือก
const DEFAULT_TIME = 5;
const LATE_POINTS = 1; // ทายถูกในช่วงทายสุดท้ายหลังหมดเวลา ได้คะแนนคงที่
const MAX_GUESS_LEN = 30;
const HOST_GRACE_MS = 20 * 1000; // รอให้หัวห้องรีเฟรช/กลับมาก่อนโอนสิทธิ์
const ROOM_IDLE_MS = 10 * 60 * 1000; // ห้องที่ไม่มีใครออนไลน์จะถูกลบ
const RATE_WINDOW_MS = 5000;
const RATE_MAX_MSGS = 30;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ไม่มี I, O, 0, 1

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanWords(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const word = cleanText(String(item), 30);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= MAX_CUSTOM_WORDS) break;
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// msPerMinute ปรับได้เฉพาะตอนเทสต์ (ให้เวลาเดินเร็ว)
function createGameServer({ msPerMinute = 60 * 1000 } = {}) {
  const rooms = new Map();

  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // มุมมองเฉพาะของแต่ละคน: คำของตัวเองจะไม่ถูกส่งไปจนกว่าจะทายถูกหรือเฉลย
  // นี่คือจุดบังคับกฎของเกมฝั่ง server (ห้ามเชื่อ client)
  function viewFor(room, me) {
    const revealed = room.phase === 'revealed';
    const isHost = me.id === room.hostId;
    return {
      t: 'state',
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      you: me.id,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      round: room.round,
      timeLimit: room.timeLimit,
      timeOptions: TIME_OPTIONS,
      // เวลาที่เหลือคิดจากนาฬิกาเซิร์ฟเวอร์ ส่งเป็นมิลลิวินาทีที่เหลือ (ไม่พึ่งนาฬิกาเครื่องผู้เล่น)
      remainingMs: room.phase === 'playing' && room.endsAt ? Math.max(0, room.endsAt - Date.now()) : null,
      endReason: room.phase === 'revealed' || room.phase === 'final' ? room.endReason : null,
      customCount: room.custom.length,
      customWords: isHost ? room.custom : undefined,
      players: room.players.map((p) => {
        let word = null;
        if (room.phase !== 'lobby') {
          word = p.id === me.id && !p.done && !revealed ? null : p.word;
        }
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          done: p.done,
          word,
          score: p.score,
          roundPoints: p.done ? p.roundPoints : 0,
          late: p.late,
          guess: room.phase === 'final' || revealed ? p.guess : null,
        };
      }),
    };
  }

  function broadcast(room) {
    for (const p of room.players) {
      if (p.ws) send(p.ws, viewFor(room, p));
    }
  }

  function scheduleIdleCleanup(room) {
    clearTimeout(room.idleTimer);
    if (room.players.some((p) => p.connected)) return;
    room.idleTimer = setTimeout(() => destroyRoom(room), ROOM_IDLE_MS);
    room.idleTimer.unref?.();
  }

  function destroyRoom(room) {
    clearTimeout(room.idleTimer);
    clearTimeout(room.hostTimer);
    clearTimeout(room.roundTimer);
    rooms.delete(room.code);
  }

  function transferHost(room) {
    const next = room.players.find((p) => p.connected && p.id !== room.hostId) ||
      room.players.find((p) => p.connected);
    if (next) {
      room.hostId = next.id;
      broadcast(room);
    }
  }

  function removePlayer(room, player) {
    room.players = room.players.filter((p) => p.id !== player.id);
    if (room.players.length === 0) {
      destroyRoom(room);
      return;
    }
    if (room.hostId === player.id) {
      clearTimeout(room.hostTimer);
      room.hostId = room.players.find((p) => p.connected)?.id || room.players[0].id;
    }
    if (room.phase === 'playing' || room.phase === 'final') recalc(room);
    maybeAutoReveal(room);
    broadcast(room);
    scheduleIdleCleanup(room);
  }

  function startRoundTimer(room) {
    clearTimeout(room.roundTimer);
    const ms = room.timeLimit * msPerMinute;
    room.endsAt = Date.now() + ms;
    room.roundTimer = setTimeout(() => {
      if (room.phase !== 'playing') return;
      enterFinal(room, 'timeout');
      broadcast(room);
    }, ms);
    room.roundTimer.unref?.();
  }

  function endRound(room, reason) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
    room.endsAt = null;
    room.phase = 'revealed';
    room.endReason = reason;
  }

  // ช่วงทายสุดท้าย: คนที่ยังไม่ถูกตัดสินว่าทายถูกพิมพ์ทายคำของตัวเอง หัวห้องเป็นคนตัดสิน
  function enterFinal(room, reason) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
    room.endsAt = null;
    if (room.players.length > 0 && room.players.every((p) => p.done)) {
      endRound(room, 'all-done');
      return;
    }
    room.phase = 'final';
    room.endReason = reason;
  }

  // คะแนนคำนวณใหม่จากลำดับที่หัวห้องกด ทุกครั้ง (กดยกเลิก/คนออกกลางรอบ อันดับจึงถูกต้องเสมอ)
  function recalc(room) {
    room.order = room.order.filter((id) => room.players.some((p) => p.id === id && p.done && !p.late));
    for (const p of room.players) {
      let pts = 0;
      if (p.done && p.late) pts = LATE_POINTS;
      else if (p.done) pts = Math.max(1, room.roundSize - room.order.indexOf(p.id));
      p.roundPoints = pts;
      p.score = p.baseScore + pts;
    }
  }

  function maybeAutoReveal(room) {
    if ((room.phase === 'playing' || room.phase === 'final') &&
        room.players.length > 0 && room.players.every((p) => p.done)) {
      endRound(room, 'all-done');
    }
  }

  function attach(room, player, ws) {
    if (player.ws && player.ws !== ws) {
      player.ws.ctx = null;
      player.ws.close(4000, 'replaced');
    }
    player.ws = ws;
    player.connected = true;
    ws.ctx = { room, player };
    clearTimeout(room.idleTimer);
    if (player.id === room.hostId) clearTimeout(room.hostTimer);
    send(ws, { t: 'joined', code: room.code, token: player.token, you: player.id, name: player.name });
    broadcast(room);
  }

  function fail(ws, msg, fatal = false) {
    send(ws, { t: 'error', msg, fatal });
  }

  function newPlayer(name) {
    return {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomUUID(),
      name,
      ws: null,
      connected: false,
      word: null,
      done: false,
      score: 0,
      baseScore: 0,
      roundPoints: 0,
      late: false,
      guess: null,
    };
  }

  function handleCreate(ws, msg) {
    if (ws.ctx) return fail(ws, 'คุณอยู่ในห้องแล้ว');
    const name = cleanText(msg.name, 20);
    if (!name) return fail(ws, 'กรุณาใส่ชื่อ');
    const room = {
      code: newCode(),
      phase: 'lobby',
      hostId: null,
      players: [],
      custom: [],
      round: 0,
      order: [],
      roundSize: 0,
      timeLimit: DEFAULT_TIME,
      endsAt: null,
      endReason: null,
      roundTimer: null,
      idleTimer: null,
      hostTimer: null,
    };
    const player = newPlayer(name);
    room.players.push(player);
    room.hostId = player.id;
    rooms.set(room.code, room);
    attach(room, player, ws);
  }

  function handleJoin(ws, msg) {
    if (ws.ctx) return fail(ws, 'คุณอยู่ในห้องแล้ว');
    const code = cleanText(msg.code, 8).toUpperCase();
    const room = rooms.get(code);
    if (!room) return fail(ws, 'ไม่พบห้องนี้ (อาจถูกปิดไปแล้ว)', true);

    // กลับเข้าห้องเดิมด้วย token
    if (typeof msg.token === 'string') {
      const existing = room.players.find((p) => p.token === msg.token);
      if (existing) return attach(room, existing, ws);
    }

    const name = cleanText(msg.name, 20);
    if (!name) return fail(ws, 'กรุณาใส่ชื่อ');
    if (room.phase !== 'lobby') return fail(ws, 'เกมกำลังเล่นอยู่ รอรอบหน้านะ');
    if (room.players.length >= MAX_PLAYERS) return fail(ws, `ห้องเต็มแล้ว (สูงสุด ${MAX_PLAYERS} คน)`);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return fail(ws, 'ชื่อนี้มีคนใช้แล้ว');
    }
    const player = newPlayer(name);
    room.players.push(player);
    attach(room, player, ws);
  }

  function handleStart(room, player) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'lobby') return fail(player.ws, 'เกมเริ่มไปแล้ว');
    if (room.players.length < MIN_PLAYERS) {
      return fail(player.ws, `ต้องมีผู้เล่นอย่างน้อย ${MIN_PLAYERS} คน`);
    }
    const pool = room.custom.length >= room.players.length
      ? room.custom
      : Array.from(new Set([...DEFAULT_WORDS, ...room.custom]));
    const picked = shuffle(pool).slice(0, room.players.length);
    room.players.forEach((p, i) => {
      p.word = picked[i];
      p.done = false;
      p.late = false;
      p.guess = null;
      p.baseScore = p.score;
      p.roundPoints = 0;
    });
    room.round += 1;
    room.order = [];
    room.roundSize = room.players.length;
    room.phase = 'playing';
    room.endReason = null;
    startRoundTimer(room);
    broadcast(room);
  }

  // หัวห้องเป็นคนตัดสินว่าใครทายถูก (กดที่คนนั้น = คำนั้นเป็นของคนนั้น) ผู้เล่นกดเองไม่ได้
  function handleMark(room, player, msg) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'playing' && room.phase !== 'final') return undefined;
    const target = room.players.find((p) => p.id === msg.id);
    if (!target || typeof msg.correct !== 'boolean') return undefined;
    if (msg.correct && !target.done) {
      target.done = true;
      target.late = room.phase === 'final';
      if (!target.late) room.order.push(target.id);
    } else if (!msg.correct && target.done) {
      target.done = false;
      target.late = false;
    } else {
      return undefined;
    }
    recalc(room);
    maybeAutoReveal(room);
    broadcast(room);
    return undefined;
  }

  // ช่วงทายสุดท้าย: ทายคำของตัวเอง (ส่งซ้ำเพื่อแก้ได้จนกว่าจะเฉลย)
  function handleGuess(room, player, msg) {
    if (room.phase !== 'final') return fail(player.ws, 'ทายสุดท้ายได้เมื่อหมดเวลาเท่านั้น');
    if (player.done) return undefined;
    const text = cleanText(msg.text, MAX_GUESS_LEN);
    if (!text) return fail(player.ws, 'พิมพ์คำทายก่อน');
    player.guess = text;
    broadcast(room);
    return undefined;
  }

  // หัวห้องจบรอบเอง -> เข้าช่วงทายสุดท้าย (ถ้าทุกคนถูกตัดสินแล้วก็เฉลยเลย)
  function handleFinish(room, player) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'playing') return;
    enterFinal(room, 'host');
    broadcast(room);
  }

  function handleReveal(room, player) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'playing' && room.phase !== 'final') return;
    endRound(room, room.phase === 'final' ? room.endReason : 'host');
    broadcast(room);
  }

  function handleAgain(room, player) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase === 'lobby') return;
    // ยกเลิกรอบกลางคัน: คืนคะแนนของรอบที่ไม่จบ
    if (room.phase === 'playing' || room.phase === 'final') room.players.forEach((p) => { p.score = p.baseScore; });
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
    room.endsAt = null;
    room.endReason = null;
    room.phase = 'lobby';
    room.players.forEach((p) => {
      p.word = null;
      p.done = false;
      p.late = false;
      p.guess = null;
      p.roundPoints = 0;
    });
    room.order = [];
    broadcast(room);
  }

  function handleResetScores(room, player) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'lobby') return fail(player.ws, 'รีเซ็ตคะแนนได้เฉพาะก่อนเริ่มเกม');
    room.players.forEach((p) => {
      p.score = 0;
      p.baseScore = 0;
      p.roundPoints = 0;
    });
    room.round = 0;
    broadcast(room);
  }

  function handleWords(room, player, msg) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'lobby') return fail(player.ws, 'แก้คำได้เฉพาะก่อนเริ่มเกม');
    room.custom = cleanWords(msg.list);
    broadcast(room);
  }

  function handleTime(room, player, msg) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    if (room.phase !== 'lobby') return fail(player.ws, 'ตั้งเวลาได้เฉพาะก่อนเริ่มเกม');
    if (!TIME_OPTIONS.includes(msg.minutes)) return fail(player.ws, 'เลือกได้เฉพาะ 3, 5 หรือ 7 นาที');
    room.timeLimit = msg.minutes;
    broadcast(room);
  }

  function handleKick(room, player, msg) {
    if (player.id !== room.hostId) return fail(player.ws, 'เฉพาะหัวห้องเท่านั้น');
    const target = room.players.find((p) => p.id === msg.id);
    if (!target || target.id === player.id) return;
    const tws = target.ws;
    removePlayer(room, target);
    if (tws) {
      tws.ctx = null;
      send(tws, { t: 'kicked' });
      tws.close(4001, 'kicked');
    }
  }

  function handleLeave(ws, room, player) {
    ws.ctx = null;
    send(ws, { t: 'left' });
    player.ws = null;
    player.connected = false;
    removePlayer(room, player);
  }

  wss.on('connection', (ws) => {
    ws.ctx = null;
    ws.rate = { start: Date.now(), count: 0 };

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - ws.rate.start > RATE_WINDOW_MS) ws.rate = { start: now, count: 0 };
      if (++ws.rate.count > RATE_MAX_MSGS) return fail(ws, 'ส่งข้อความถี่เกินไป');

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return fail(ws, 'ข้อมูลไม่ถูกต้อง');
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      if (msg.t === 'create') return handleCreate(ws, msg);
      if (msg.t === 'join') return handleJoin(ws, msg);

      if (!ws.ctx) return fail(ws, 'ยังไม่ได้เข้าห้อง', true);
      const { room, player } = ws.ctx;
      switch (msg.t) {
        case 'start': return handleStart(room, player);
        case 'mark': return handleMark(room, player, msg);
        case 'guess': return handleGuess(room, player, msg);
        case 'finish': return handleFinish(room, player);
        case 'reveal': return handleReveal(room, player);
        case 'again': return handleAgain(room, player);
        case 'words': return handleWords(room, player, msg);
        case 'time': return handleTime(room, player, msg);
        case 'resetscores': return handleResetScores(room, player);
        case 'kick': return handleKick(room, player, msg);
        case 'leave': return handleLeave(ws, room, player);
        default: return undefined;
      }
    });

    ws.on('close', () => {
      const ctx = ws.ctx;
      if (!ctx) return;
      const { room, player } = ctx;
      if (player.ws !== ws) return;
      player.ws = null;
      player.connected = false;
      if (player.id === room.hostId) {
        clearTimeout(room.hostTimer);
        room.hostTimer = setTimeout(() => {
          const host = room.players.find((p) => p.id === room.hostId);
          if (host && !host.connected) transferHost(room);
        }, HOST_GRACE_MS);
        room.hostTimer.unref?.();
      }
      broadcast(room);
      scheduleIdleCleanup(room);
    });

    ws.on('error', () => {});
  });

  function close() {
    for (const room of rooms.values()) {
      clearTimeout(room.idleTimer);
      clearTimeout(room.hostTimer);
      clearTimeout(room.roundTimer);
    }
    for (const client of wss.clients) client.terminate();
    wss.close();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, close, rooms };
}

module.exports = { createGameServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createGameServer();
  server.listen(port, '0.0.0.0', () => console.log(`forbidden-words listening on :${port}`));
}
