'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createGameServer } = require('../server');

async function boot() {
  const game = createGameServer();
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

async function setup3() {
  const { game, url } = await boot();
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

test('ทายถูกแล้วเห็นคำตัวเอง / หัวห้องเฉลยแล้วทุกคนเห็นทุกคำ', async () => {
  const { game, host, bob, cara } = await setup3();
  host.send({ t: 'start' });
  await bob.wait((m) => m.phase === 'playing');

  bob.send({ t: 'done' });
  const s = await bob.wait((m) => m.t === 'state' && m.players.find((p) => p.id === m.you)?.done);
  const me = s.players.find((p) => p.id === s.you);
  assert.ok(me.word, 'ทายถูกแล้วต้องเห็นคำตัวเอง');
  // คนอื่นที่ยังไม่ทายถูกยังต้องไม่เห็นคำตัวเอง
  const sh = host.last('state');
  assert.strictEqual(sh.players.find((p) => p.id === sh.you).word, null);

  host.send({ t: 'reveal' });
  const sr = await host.wait((m) => m.phase === 'revealed');
  assert.ok(sr.players.every((p) => typeof p.word === 'string'));
  await closeAll(game, host, bob, cara);
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
