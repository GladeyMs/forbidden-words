'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createGameServer } = require('../server');

async function boot(opts) {
  const game = createGameServer(opts);
  await new Promise((r) => game.server.listen(0, '127.0.0.1', r));
  const port = game.server.address().port;
  return { game, url: `ws://127.0.0.1:${port}/ws` };
}

// client ที่เก็บทุกข้อความดิบที่ได้รับ เพื่อเช็กว่าไม่มีการรั่วของคำ
function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, raw: [], msgs: [], waiters: [] };
  ws.on('message', (d) => {
    const text = d.toString();
    c.raw.push(text);
    const m = JSON.parse(text);
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  c.opened = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred) =>
    new Promise((resolve) => {
      const found = c.msgs.find(pred);
      if (found) return resolve(found);
      c.waiters.push((m) => (pred(m) ? (resolve(m), true) : false));
      return undefined;
    });
  c.waitNew = (pred) => new Promise((resolve) => {
    c.waiters.push((m) => (pred(m) ? (resolve(m), true) : false));
  });
  c.last = (type) => [...c.msgs].reverse().find((m) => m.t === type);
  return c;
}

async function setup3(opts) {
  const { game, url } = await boot(opts);
  const host = client(url);
  await host.opened;
  host.send({ t: 'create', name: 'Alice' });
  const joined = await host.wait((m) => m.t === 'joined');
  const code = joined.code;

  const bob = client(url);
  const cara = client(url);
  await Promise.all([bob.opened, cara.opened]);
  bob.send({ t: 'join', code, name: 'Bob' });
  cara.send({ t: 'join', code: code.toLowerCase(), name: 'Cara' });
  await bob.wait((m) => m.t === 'joined');
  await cara.wait((m) => m.t === 'joined');
  await host.wait((m) => m.t === 'state' && m.players.length === 3);
  return { game, url, code, host, bob, cara };
}

const closeAll = (game, ...cs) => {
  cs.forEach((c) => c.ws.terminate());
  return game.close();
};

test('ไม่เห็นคำของตัวเอง แต่เห็นคำของคนอื่น', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  const [sa, sb, sc] = await Promise.all(
    [host, bob, cara].map((c) => c.wait((m) => m.t === 'state' && m.phase === 'playing')),
  );

  for (const [state, name] of [[sa, 'Alice'], [sb, 'Bob'], [sc, 'Cara']]) {
    const me = state.players.find((p) => p.id === state.you);
    assert.strictEqual(me.name, name);
    assert.strictEqual(me.word, null, `${name} ต้องไม่เห็นคำตัวเอง`);
    for (const p of state.players.filter((x) => x.id !== state.you)) {
      assert.ok(typeof p.word === 'string' && p.word.length > 0, `${name} ต้องเห็นคำของ ${p.name}`);
    }
  }

  // คำทุกคนไม่ซ้ำกัน และคำของตัวเองไม่เคยปรากฏในข้อความดิบที่ส่งให้ตัวเอง
  const wordOf = (state, name) => {
    // ดึงคำของ name จากมุมมองของคนอื่น
    return state.players.find((p) => p.name === name).word;
  };
  const aliceWord = wordOf(sb, 'Alice');
  const bobWord = wordOf(sa, 'Bob');
  const caraWord = wordOf(sa, 'Cara');
  assert.strictEqual(new Set([aliceWord, bobWord, caraWord]).size, 3);
  assert.strictEqual(wordOf(sc, 'Alice'), aliceWord);

  const playingRaw = (c) => c.raw.filter((r) => JSON.parse(r).phase === 'playing').join('\n');
  assert.ok(!playingRaw(host).includes(`"${aliceWord}"`), 'คำของ Alice รั่วไปหา Alice');
  assert.ok(!playingRaw(bob).includes(`"${bobWord}"`), 'คำของ Bob รั่วไปหา Bob');
  assert.ok(!playingRaw(cara).includes(`"${caraWord}"`), 'คำของ Cara รั่วไปหา Cara');
  await closeAll(game, host, bob, cara);
});

const me = (s) => s.players.find((p) => p.id === s.you);
// คืน {} ถ้ายังไม่มีผู้เล่นชื่อนี้ (wait() ค้นย้อนข้อความเก่าที่ห้องยังไม่ครบคนด้วย)
const byName = (s, n) => s.players.find((p) => p.name === n) || {};
const idOf = (c, n) => byName(c.last('state'), n).id;
const confirm = (c, n, correct = true) => c.send({ t: 'confirm', id: idOf(c, n), correct });
const claim = (c, n, on = true) => c.send({ t: 'claim', id: idOf(c, n), on });
const mark = confirm; // หัวห้องยืนยันผู้เล่นทั่วไป (ใช้กับการ์ดที่ไม่ใช่ของหัวห้อง)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// หัวห้อง (Alice) ทายถูก: Bob แจ้ง แล้ว Bob+Cara โหวตยืนยัน (ต้อง 2 จาก 2 คน)
async function hostGuessed(host, bob, cara) {
  claim(bob, 'Alice');
  await host.wait((m) => m.t === 'state' && byName(m, 'Alice').claimedBy?.length > 0);
  confirm(bob, 'Alice');
  confirm(cara, 'Alice');
  await host.wait((m) => m.t === 'state' && byName(m, 'Alice').done);
}

test('ผู้เล่นแจ้งว่าใครทายถูก หัวห้องเป็นคนยืนยัน: แจ้งแล้วยังไม่ได้คะแนนจนกว่าจะยืนยัน', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await bob.wait((m) => m.phase === 'playing');
  const bobId = idOf(bob, 'Bob');

  // Bob แจ้งว่าตัวเองทายถูก และ Cara แจ้งว่า Bob ทายถูก (คนอื่นเห็นคำจึงเป็นพยานได้)
  claim(bob, 'Bob');
  claim(cara, 'Bob');
  const pend = await host.wait((m) => m.t === 'state' && byName(m, 'Bob').claimedBy?.length === 2);
  assert.deepStrictEqual(byName(pend, 'Bob').claimedBy.sort(), [bobId, idOf(cara, 'Cara')].sort());
  assert.strictEqual(byName(pend, 'Bob').done, false);
  assert.strictEqual(byName(pend, 'Bob').score, 0, 'แค่แจ้ง ยังไม่ได้คะแนน');
  await sleep(60);
  assert.strictEqual(me(bob.last('state')).word, null, 'แจ้งเองแล้วก็ยังไม่เห็นคำตัวเองจนกว่าหัวห้องยืนยัน');

  // ผู้เล่นยืนยันเองไม่ได้
  bob.send({ t: 'confirm', id: bobId, correct: true });
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /หัวห้อง/);
  bob.send({ t: 'mark', id: bobId, correct: true }); // คำสั่งเก่า ไม่มีผล
  bob.send({ t: 'done' });
  await sleep(60);
  assert.strictEqual(byName(host.last('state'), 'Bob').done, false);

  confirm(host, 'Bob'); // หัวห้องยืนยัน
  const s = await bob.wait((m) => m.t === 'state' && me(m).done);
  assert.ok(me(s).word, 'ยืนยันแล้วต้องเห็นคำตัวเอง');
  assert.deepStrictEqual(byName(s, 'Bob').claimedBy, [], 'ยืนยันแล้วคำขอถูกล้าง');
  assert.strictEqual(byName(s, 'Bob').score, 3);
  assert.strictEqual(me(host.last('state')).word, null, 'หัวห้องที่ยังไม่ถูกตัดสินต้องไม่เห็นคำตัวเอง');

  host.send({ t: 'reveal' });
  const sr = await host.wait((m) => m.phase === 'revealed');
  assert.ok(sr.players.every((p) => typeof p.word === 'string'));
  await closeAll(game, host, bob, cara);
});

test('หัวห้องปฏิเสธคำขอ / ถอนคำขอ / ยืนยันเองได้แม้ไม่มีใครแจ้ง', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');

  claim(bob, 'Cara');
  await host.wait((m) => m.t === 'state' && byName(m, 'Cara').claimedBy?.length === 1);
  confirm(host, 'Cara', false); // ปฏิเสธ -> ล้างคำขอ ไม่ได้คะแนน
  const rej = await host.waitNew((m) => m.t === 'state');
  assert.deepStrictEqual(byName(rej, 'Cara').claimedBy, []);
  assert.strictEqual(byName(rej, 'Cara').done, false);

  claim(bob, 'Cara');
  await host.waitNew((m) => m.t === 'state' && byName(m, 'Cara').claimedBy.length === 1);
  claim(bob, 'Cara', false); // ถอนคำขอเอง
  const wd = await host.waitNew((m) => m.t === 'state');
  assert.deepStrictEqual(byName(wd, 'Cara').claimedBy, []);

  confirm(host, 'Cara'); // ไม่มีใครแจ้ง หัวห้องยืนยันเองได้
  const ok = await host.waitNew((m) => m.t === 'state' && byName(m, 'Cara').done);
  assert.strictEqual(byName(ok, 'Cara').score, 3);
  await closeAll(game, host, bob, cara);
});

test('หัวห้องทายถูก: ตัดสินตัวเองไม่ได้ ต้องเสียงข้างมากของผู้เล่นคนอื่น', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');

  confirm(host, 'Alice'); // หัวห้องยืนยันตัวเองไม่ได้
  assert.match((await host.waitNew((m) => m.t === 'error')).msg, /ตัวเอง/);
  confirm(bob, 'Alice'); // ยังไม่มีใครแจ้ง โหวตไม่ได้
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /แจ้ง/);

  claim(host, 'Alice'); // หัวห้องแจ้งเองได้
  const pend = await bob.wait((m) => m.t === 'state' && byName(m, 'Alice').claimedBy?.length === 1);
  assert.strictEqual(byName(pend, 'Alice').need, 2, '2 คนอื่น ต้องเกินครึ่ง = 2 เสียง');

  confirm(bob, 'Alice');
  const one = await host.wait((m) => m.t === 'state' && byName(m, 'Alice').votes?.confirm.length === 1);
  assert.strictEqual(byName(one, 'Alice').done, false, 'เสียงเดียวยังไม่พอ');
  confirm(bob, 'Alice', false); // ถอนโหวต
  await host.waitNew((m) => m.t === 'state' && byName(m, 'Alice').votes.confirm.length === 0);
  confirm(bob, 'Alice');
  confirm(cara, 'Alice');
  const done = await host.wait((m) => m.t === 'state' && byName(m, 'Alice').done);
  assert.strictEqual(byName(done, 'Alice').score, 3);
  assert.ok(me(done).word, 'ยืนยันแล้วหัวห้องเห็นคำตัวเอง');

  // ยกเลิกคะแนนของหัวห้องต้องเสียงข้างมากเหมือนกัน
  confirm(bob, 'Alice', false);
  await sleep(80);
  assert.strictEqual(byName(host.last('state'), 'Alice').done, true, 'ยกเลิกเสียงเดียวไม่พอ');
  confirm(cara, 'Alice', false);
  const undone = await host.waitNew((m) => m.t === 'state' && !byName(m, 'Alice').done);
  assert.strictEqual(byName(undone, 'Alice').score, 0);
  await closeAll(game, host, bob, cara);
});

test('ห้อง 2 คน: ผู้เล่นอีกคนเดียวตัดสินว่าหัวห้องทายถูก', async () => {
  const { game, url } = await boot();
  const a = client(url); await a.opened; a.send({ t: 'create', name: 'Alice' });
  const j = await a.wait((m) => m.t === 'joined');
  const b = client(url); await b.opened; b.send({ t: 'join', code: j.code, name: 'Bob' });
  await b.wait((m) => m.t === 'joined');
  await a.wait((m) => m.t === 'state' && m.players.length === 2);
  a.send({ t: 'start' });
  await b.wait((m) => m.phase === 'playing');
  claim(a, 'Alice');
  await b.wait((m) => m.t === 'state' && byName(m, 'Alice').claimedBy?.length === 1);
  assert.strictEqual(byName(b.last('state'), 'Alice').need, 1);
  confirm(b, 'Alice');
  const s = await a.wait((m) => m.t === 'state' && byName(m, 'Alice').done);
  assert.strictEqual(byName(s, 'Alice').score, 2);
  await closeAll(game, a, b);
});

test('เฉพาะหัวห้องเท่านั้นที่เริ่ม/เฉลย/เตะ/เปลี่ยนคำได้', async () => {
  const { game, host, bob, cara } = await setup3();
  bob.send({ t: 'start' });
  const err = await bob.wait((m) => m.t === 'error');
  assert.match(err.msg, /หัวห้อง/);
  assert.strictEqual(host.last('state').phase, 'lobby');

  bob.send({ t: 'words', list: ['x'] });
  bob.send({ t: 'kick', id: host.last('state').you });
  host.send({ t: 'start' });
  const s = await host.wait((m) => m.phase === 'playing');
  assert.strictEqual(s.players.length, 3, 'Bob เตะหัวห้องไม่ได้');
  bob.send({ t: 'reveal' });
  bob.send({ t: 'again' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(host.last('state').phase, 'playing', 'Bob เฉลย/รีเซ็ตไม่ได้');
  await closeAll(game, host, bob, cara);
});

test('คำที่หัวห้องใส่เองถูกใช้เมื่อมีพอ และเล่นรอบใหม่ได้', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'words', list: ['AAA', 'BBB', 'CCC', 'aaa', ' '] });
  const s0 = await host.wait((m) => m.t === 'state' && m.customCount === 3);
  assert.deepStrictEqual(s0.customWords, ['AAA', 'BBB', 'CCC']);
  assert.strictEqual(bob.last('state').customWords, undefined, 'คนอื่นไม่ต้องเห็นรายการคำ');

  host.send({ t: 'start' });
  const s = await bob.wait((m) => m.phase === 'playing');
  for (const p of s.players.filter((x) => x.id !== s.you)) {
    assert.ok(['AAA', 'BBB', 'CCC'].includes(p.word));
  }
  host.send({ t: 'reveal' });
  await host.wait((m) => m.phase === 'revealed');
  host.send({ t: 'again' });
  const lobby = await bob.waitNew((m) => m.t === 'state' && m.phase === 'lobby');
  assert.ok(lobby.players.every((p) => p.word === null && !p.done));
  await closeAll(game, host, bob, cara);
});

test('รีเฟรชแล้วกลับเข้าที่เดิมด้วย token ได้ และคนนอกเข้าระหว่างเล่นไม่ได้', async () => {
  const { game, url, code, host, bob, cara } = await setup3();
  const bobJoined = bob.last('joined');
  host.send({ t: 'start' });
  await bob.wait((m) => m.phase === 'playing');
  bob.ws.terminate();

  const bob2 = client(url);
  await bob2.opened;
  bob2.send({ t: 'join', code, token: bobJoined.token });
  const back = await bob2.wait((m) => m.t === 'joined');
  assert.strictEqual(back.you, bobJoined.you);
  const st = await bob2.wait((m) => m.t === 'state' && m.phase === 'playing');
  assert.strictEqual(st.players.find((p) => p.id === st.you).word, null);

  const late = client(url);
  await late.opened;
  late.send({ t: 'join', code, name: 'Late' });
  const err = await late.wait((m) => m.t === 'error');
  assert.match(err.msg, /กำลังเล่น/);

  // token ผิด ใช้เป็นคนใหม่ ซึ่งเข้าไม่ได้ระหว่างเล่น (ปลอม token เพื่อเห็นคำไม่ได้)
  const fake = client(url);
  await fake.opened;
  fake.send({ t: 'join', code, token: 'not-a-real-token', name: 'Eve' });
  const err2 = await fake.wait((m) => m.t === 'error');
  assert.match(err2.msg, /กำลังเล่น/);
  await closeAll(game, host, bob2, cara, late, fake);
});

test('ชื่อซ้ำ ห้องไม่มี และห้องเต็มถูกปฏิเสธ', async () => {
  const { game, url, code, host, bob, cara } = await setup3();
  const dup = client(url);
  await dup.opened;
  dup.send({ t: 'join', code, name: 'bob' });
  assert.match((await dup.wait((m) => m.t === 'error')).msg, /ชื่อ/);

  const none = client(url);
  await none.opened;
  none.send({ t: 'join', code: 'ZZZZ', name: 'X' });
  const e = await none.wait((m) => m.t === 'error');
  assert.strictEqual(e.fatal, true);

  const extras = [];
  for (let i = 0; i < 9; i++) {
    const c = client(url);
    await c.opened;
    c.send({ t: 'join', code, name: `P${i}` });
    await c.wait((m) => m.t === 'joined');
    extras.push(c);
  }
  const over = client(url);
  await over.opened;
  over.send({ t: 'join', code, name: 'Overflow' });
  assert.match((await over.wait((m) => m.t === 'error')).msg, /เต็ม/);
  await closeAll(game, host, bob, cara, dup, none, over, ...extras);
});

test('หัวห้องกดออก สิทธิ์โอนให้คนอื่น และ XSS ในชื่อเป็นแค่ข้อความ', async () => {
  const { game, url } = await boot();
  const a = client(url);
  await a.opened;
  a.send({ t: 'create', name: '<img src=x onerror=alert(1)>' });
  const j = await a.wait((m) => m.t === 'joined');
  const b = client(url);
  await b.opened;
  b.send({ t: 'join', code: j.code, name: 'Bee' });
  await b.wait((m) => m.t === 'joined');
  a.send({ t: 'leave' });
  const s = await b.wait((m) => m.t === 'state' && m.players.length === 1);
  assert.strictEqual(s.hostId, s.you);
  await closeAll(game, a, b);
});

test('หัวห้องตั้งเวลา 3/5/7 นาทีได้ คนอื่นตั้งไม่ได้ ค่าอื่นถูกปฏิเสธ', async () => {
  const { game, host, bob, cara } = await setup3();
  assert.strictEqual(host.last('state').timeLimit, 5, 'ค่าเริ่มต้น 5 นาที');
  assert.deepStrictEqual(host.last('state').timeOptions, [3, 5, 7]);

  host.send({ t: 'time', minutes: 7 });
  assert.strictEqual((await bob.wait((m) => m.t === 'state' && m.timeLimit === 7)).timeLimit, 7);
  host.send({ t: 'time', minutes: 3 });
  await cara.wait((m) => m.t === 'state' && m.timeLimit === 3);

  bob.send({ t: 'time', minutes: 5 });
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /หัวห้อง/);
  for (const bad of [4, 0, -3, 999, '5', null, 5.5, [5]]) {
    host.send({ t: 'time', minutes: bad });
    assert.match((await host.waitNew((m) => m.t === 'error')).msg, /3, 5 หรือ 7/);
  }
  assert.strictEqual(host.last('state').timeLimit, 3, 'ค่าที่ผิดต้องไม่เปลี่ยนเวลา');

  host.send({ t: 'start' });
  const playing = await host.wait((m) => m.t === 'state' && m.phase === 'playing');
  assert.ok(playing.remainingMs > 3 * 60 * 1000 - 5000 && playing.remainingMs <= 3 * 60 * 1000);
  host.send({ t: 'time', minutes: 7 });
  assert.match((await host.waitNew((m) => m.t === 'error')).msg, /ก่อนเริ่มเกม/);
  assert.strictEqual(host.last('state').timeLimit, 3);
  await closeAll(game, host, bob, cara);
});

test('หมดเวลาแล้วเข้าช่วงทายสุดท้าย (ยังไม่เฉลย) และรอบใหม่ได้เวลาใหม่เต็ม', async () => {
  const { game, host, bob, cara } = await setup3({ msPerMinute: 50 }); // 3 นาที = 150ms
  host.send({ t: 'time', minutes: 3 });
  await host.wait((m) => m.t === 'state' && m.timeLimit === 3);
  host.send({ t: 'start' });
  const s = await bob.wait((m) => m.t === 'state' && m.phase === 'playing');
  assert.ok(s.remainingMs > 0 && s.remainingMs <= 150);
  assert.strictEqual(me(s).word, null);

  const fin = await bob.wait((m) => m.t === 'state' && m.phase === 'final');
  assert.strictEqual(fin.endReason, 'timeout');
  assert.strictEqual(fin.remainingMs, null);
  assert.strictEqual(me(fin).word, null, 'ช่วงทายสุดท้ายยังต้องไม่เห็นคำตัวเอง');
  assert.ok(fin.players.filter((p) => p.id !== fin.you).every((p) => typeof p.word === 'string'));
  // คำของ Bob ต้องไม่รั่วไปหา Bob ในข้อความช่วงทายสุดท้ายเลย (ดูจากข้อความดิบ)
  const bobWord = byName(host.last('state'), 'Bob').word;
  assert.ok(bobWord, 'หัวห้องต้องเห็นคำของ Bob');
  const finalRaw = bob.raw.filter((r) => JSON.parse(r).phase === 'final').join('\n');
  assert.ok(!finalRaw.includes(`"${bobWord}"`), 'คำของ Bob รั่วไปหา Bob ช่วงทายสุดท้าย');

  host.send({ t: 'reveal' });
  const end = await bob.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(end.endReason, 'timeout');
  assert.ok(end.players.every((p) => typeof p.word === 'string'), 'เฉลยแล้วต้องเห็นทุกคำ');

  // รอบใหม่: ตัวจับเวลาเริ่มใหม่ ไม่โดนตัวเก่าตัดจบ
  host.send({ t: 'again' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'lobby');
  host.send({ t: 'start' });
  const s2 = await host.waitNew((m) => m.t === 'state' && m.phase === 'playing');
  assert.ok(s2.remainingMs > 100, 'รอบใหม่ต้องได้เวลาเต็ม');
  await closeAll(game, host, bob, cara);
});

test('เฉลยก่อนหมดเวลายกเลิกตัวจับเวลา และกลับล็อบบี้แล้วไม่ถูกตัวเก่ามารบกวน', async () => {
  const { game, host, bob, cara } = await setup3({ msPerMinute: 50 });
  host.send({ t: 'time', minutes: 3 });
  host.send({ t: 'start' });
  await host.wait((m) => m.t === 'state' && m.phase === 'playing');
  host.send({ t: 'reveal' });
  const rev = await host.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(rev.endReason, 'host');
  host.send({ t: 'again' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'lobby');

  const count = host.msgs.length;
  await new Promise((r) => setTimeout(r, 300)); // เลยเวลาเดิมไปแล้ว
  assert.strictEqual(host.msgs.length, count, 'ตัวจับเวลาเก่าต้องไม่ส่งอะไรหลังยกเลิก');
  assert.strictEqual(host.last('state').phase, 'lobby');
  await closeAll(game, host, bob, cara);
});

test('ถูกครบทุกคน (หัวห้องยืนยันสองคน + โหวตให้หัวห้อง): เฉลยด้วยเหตุผล all-done', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  for (const n of ['Bob', 'Cara']) {
    confirm(host, n);
    await host.wait((m) => m.t === 'state' && byName(m, n).done);
  }
  await hostGuessed(host, bob, cara);
  const end = await host.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(end.endReason, 'all-done');
  assert.deepStrictEqual([byName(end, 'Bob').score, byName(end, 'Cara').score, byName(end, 'Alice').score], [3, 2, 1]);
  await closeAll(game, host, bob, cara);
});

test('ยกเลิกการยืนยัน: อันดับและคะแนนคำนวณใหม่ถูกต้อง', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  confirm(host, 'Bob');
  confirm(host, 'Cara');
  let s = await host.wait((m) => m.t === 'state' && byName(m, 'Cara').done);
  assert.deepStrictEqual([byName(s, 'Bob').score, byName(s, 'Cara').score], [3, 2]);

  confirm(host, 'Bob', false); // กดผิด ยกเลิก -> Cara ขึ้นเป็นที่ 1
  s = await host.waitNew((m) => m.t === 'state');
  assert.strictEqual(byName(s, 'Bob').done, false);
  assert.deepStrictEqual([byName(s, 'Bob').score, byName(s, 'Cara').score], [0, 3]);
  await sleep(60);
  assert.strictEqual(me(bob.last('state')).word, null, 'ถูกยกเลิกแล้ว Bob ต้องกลับไปมองไม่เห็นคำตัวเอง');

  confirm(host, 'Bob'); // ยืนยันใหม่ -> Bob ได้ที่ 2
  s = await host.waitNew((m) => m.t === 'state');
  assert.deepStrictEqual([byName(s, 'Bob').score, byName(s, 'Cara').score], [2, 3]);
  await closeAll(game, host, bob, cara);
});

test('ผู้เล่นคนอื่นออกจากห้อง: จำนวนเสียงที่ต้องการลดลงและคำนวณใหม่', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  claim(host, 'Alice'); // หัวห้องแจ้งตัวเอง
  await bob.wait((m) => m.t === 'state' && byName(m, 'Alice').claimedBy?.length === 1);
  confirm(bob, 'Alice'); // 1 เสียง ยังไม่พอ (ต้อง 2)
  await host.wait((m) => m.t === 'state' && byName(m, 'Alice').votes?.confirm.length === 1);
  cara.send({ t: 'leave' }); // เหลือผู้เล่นคนอื่น 1 คน -> ต้องการ 1 เสียง และ Bob โหวตไว้แล้ว
  const s = await host.wait((m) => m.t === 'state' && m.players.length === 2 && byName(m, 'Alice').done);
  assert.strictEqual(byName(s, 'Alice').done, true);
  await closeAll(game, host, bob, cara);
});

test('ช่วงทายสุดท้าย: ทายคำตัวเอง ผู้เล่นแจ้ง หัวห้องยืนยัน ถูกได้ 1 คะแนนคงที่', async () => {
  const { game, host, bob, cara } = await setup3({ msPerMinute: 100 }); // 3 นาที = 300ms
  host.send({ t: 'time', minutes: 3 });
  host.send({ t: 'start' });
  await host.wait((m) => m.t === 'state' && m.phase === 'playing');

  bob.send({ t: 'guess', text: 'ช้าง' }); // ยังไม่หมดเวลา ทายสุดท้ายไม่ได้
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /หมดเวลา/);

  confirm(host, 'Cara'); // Cara ถูกยืนยันตอนยังเล่นอยู่: 3 คะแนน
  await host.wait((m) => m.t === 'state' && byName(m, 'Cara').done);
  const fin = await host.wait((m) => m.t === 'state' && m.phase === 'final');
  assert.strictEqual(byName(fin, 'Cara').score, 3);

  bob.send({ t: 'guess', text: '   ' });
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /พิมพ์/);
  bob.send({ t: 'guess', text: 'มังกร' });
  const seen = await cara.wait((m) => m.t === 'state' && byName(m, 'Bob').guess === 'มังกร');
  assert.strictEqual(byName(seen, 'Bob').late, false);
  assert.strictEqual(me(bob.last('state')).word, null, 'ทายแล้วก็ยังไม่เห็นคำตัวเองจนกว่าจะเฉลย');

  claim(cara, 'Bob'); // Cara เห็นคำของ Bob จึงแจ้งว่าคำทายถูก
  await host.wait((m) => m.t === 'state' && byName(m, 'Bob').claimedBy?.length === 1);
  cara.send({ t: 'confirm', id: byName(seen, 'Bob').id, correct: true }); // Cara ยืนยันเองไม่ได้
  assert.match((await cara.waitNew((m) => m.t === 'error')).msg, /หัวห้อง/);

  confirm(host, 'Bob');
  const afterBob = await host.wait((m) => m.t === 'state' && byName(m, 'Bob').done);
  assert.strictEqual(byName(afterBob, 'Bob').late, true);
  assert.strictEqual(byName(afterBob, 'Bob').score, 1);
  const bobSees = await bob.wait((m) => m.t === 'state' && m.phase === 'final' && me(m).done);
  assert.ok(me(bobSees).word, 'ถูกยืนยันแล้วต้องเห็นคำตัวเอง');

  await hostGuessed(host, bob, cara); // หัวห้องทายถูก (ช่วงทายสุดท้าย) -> 1 คะแนน แล้วเฉลยอัตโนมัติ
  const end = await host.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(byName(end, 'Alice').score, 1);
  assert.strictEqual(byName(end, 'Alice').late, true);
  assert.strictEqual(end.endReason, 'all-done');
  await closeAll(game, host, bob, cara);
});

test('หัวห้องจบรอบเอง: เข้าช่วงทายสุดท้าย (คนอื่นสั่งไม่ได้)', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  bob.send({ t: 'finish' });
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /หัวห้อง/);
  assert.strictEqual(host.last('state').phase, 'playing');

  host.send({ t: 'finish' });
  const fin = await host.wait((m) => m.t === 'state' && m.phase === 'final');
  assert.strictEqual(fin.endReason, 'host');
  host.send({ t: 'reveal' });
  const rev = await host.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(rev.endReason, 'host');
  await closeAll(game, host, bob, cara);
});

test('คะแนนสะสมข้ามรอบ และรอบที่ไม่ได้ยืนยันได้ 0', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  confirm(host, 'Bob');
  await host.wait((m) => m.t === 'state' && byName(m, 'Bob').done);
  host.send({ t: 'reveal' });
  const r1 = await host.wait((m) => m.t === 'state' && m.phase === 'revealed');
  assert.deepStrictEqual(r1.players.map((p) => p.score), [0, 3, 0]);

  host.send({ t: 'again' });
  const lobby = await host.waitNew((m) => m.t === 'state' && m.phase === 'lobby');
  assert.strictEqual(byName(lobby, 'Bob').score, 3, 'กลับล็อบบี้คะแนนต้องไม่หาย');
  assert.ok(lobby.players.every((p) => p.roundPoints === 0 && p.guess === null && p.late === false &&
    p.claimedBy.length === 0));

  host.send({ t: 'start' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'playing' && m.round === 2);
  confirm(host, 'Cara');
  await host.wait((m) => m.t === 'state' && m.round === 2 && byName(m, 'Cara').done);
  host.send({ t: 'reveal' });
  const r2 = await host.waitNew((m) => m.t === 'state' && m.phase === 'revealed');
  assert.strictEqual(byName(r2, 'Cara').score, 3);
  assert.strictEqual(byName(r2, 'Bob').score, 3);
  assert.strictEqual(byName(r2, 'Bob').roundPoints, 0, 'รอบนี้ Bob ไม่ได้ยืนยัน');
  await closeAll(game, host, bob, cara);
});

test('รีเซ็ตคะแนน: เฉพาะหัวห้องและเฉพาะตอนล็อบบี้ / ยกเลิกรอบกลางคันคืนคะแนน', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  confirm(host, 'Bob');
  await bob.wait((m) => m.t === 'state' && me(m).done && me(m).score === 3);

  host.send({ t: 'resetscores' });
  assert.match((await host.waitNew((m) => m.t === 'error')).msg, /ก่อนเริ่มเกม/);

  host.send({ t: 'again' }); // ยกเลิกรอบกลางคัน ต้องคืนคะแนนของรอบนั้น
  const lobby = await host.waitNew((m) => m.t === 'state' && m.phase === 'lobby');
  assert.strictEqual(byName(lobby, 'Bob').score, 0, 'รอบที่ไม่จบต้องไม่เก็บคะแนน');

  host.send({ t: 'start' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'playing');
  confirm(host, 'Bob');
  await bob.waitNew((m) => m.t === 'state' && me(m).score === 3);
  host.send({ t: 'reveal' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'revealed');
  host.send({ t: 'again' });
  await host.waitNew((m) => m.t === 'state' && m.phase === 'lobby');
  assert.strictEqual(byName(host.last('state'), 'Bob').score, 3);

  bob.send({ t: 'resetscores' });
  assert.match((await bob.waitNew((m) => m.t === 'error')).msg, /หัวห้อง/);
  assert.strictEqual(byName(host.last('state'), 'Bob').score, 3, 'คนอื่นรีเซ็ตไม่ได้');

  host.send({ t: 'resetscores' });
  const reset = await cara.waitNew((m) => m.t === 'state' && m.players.every((p) => p.score === 0));
  assert.strictEqual(reset.round, 0);
  await closeAll(game, host, bob, cara);
});

test('หัวห้องออกกลางรอบ: ผู้ตัดสินคนใหม่ คำขอและโหวตที่ค้างถูกล้าง', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await host.wait((m) => m.phase === 'playing');
  claim(cara, 'Bob');
  await bob.wait((m) => m.t === 'state' && byName(m, 'Bob').claimedBy?.length === 1);
  host.send({ t: 'leave' });
  const s = await bob.wait((m) => m.t === 'state' && m.players.length === 2 && m.hostId !== undefined &&
    !m.players.some((p) => p.name === 'Alice'));
  assert.ok(['Bob', 'Cara'].includes(byName(s, s.players.find((p) => p.id === s.hostId).name).name));
  assert.ok(s.players.every((p) => p.claimedBy.length === 0), 'คำขอที่ค้างต้องถูกล้างเมื่อผู้ตัดสินเปลี่ยน');
  assert.strictEqual(s.phase, 'playing');
  await closeAll(game, host, bob, cara);
});
