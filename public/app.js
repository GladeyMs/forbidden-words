'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'fw-session';

  let ws = null;
  let state = null;
  let retry = 0;
  let pending = null; // ข้อความที่รอส่งตอนเชื่อมต่อเสร็จ
  let deadline = null; // เวลาหมดรอบ (performance.now) คำนวณจากเวลาที่เหลือที่เซิร์ฟเวอร์ส่งมา
  let session = loadSession();

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* โหมดส่วนตัวอาจใช้ไม่ได้ ไม่เป็นไร */ }
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else {
      pending = obj;
      toast('กำลังเชื่อมต่อ...');
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      if (pending) {
        const p = pending;
        pending = null;
        ws.send(JSON.stringify(p));
      } else if (session) {
        ws.send(JSON.stringify({ t: 'join', code: session.code, token: session.token, name: session.name }));
      }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
    };
  }

  function leaveToHome() {
    state = null;
    saveSession(null);
    history.replaceState(null, '', location.pathname);
    render();
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        saveSession({ code: m.code, token: m.token, name: m.name });
        history.replaceState(null, '', `?room=${m.code}`);
        break;
      case 'state':
        state = m;
        deadline = m.remainingMs == null ? null : performance.now() + m.remainingMs;
        render();
        break;
      case 'error':
        toast(m.msg);
        if (m.fatal) leaveToHome();
        break;
      case 'kicked':
        toast('คุณถูกเชิญออกจากห้อง');
        leaveToHome();
        break;
      case 'left':
        leaveToHome();
        break;
      default:
        break;
    }
  }

  function statusText(s) {
    const me = s.players.find((p) => p.id === s.you);
    const isHost = s.you === s.hostId;
    if (s.phase === 'lobby') {
      if (s.players.length < s.minPlayers) return 'รอเพื่อนเข้าห้อง... แชร์ลิงก์ให้เพื่อนได้เลย';
      return isHost ? 'พร้อมแล้ว กด "เริ่มเกม" ได้เลย' : 'รอหัวห้องเริ่มเกม...';
    }
    if (s.phase === 'playing') {
      return me.done
        ? 'คุณทายถูกแล้ว! รอคนอื่นทายต่อ'
        : 'ถามคำถามเพื่อทายคำบนหัวคุณ (พูดคุยกันนอกเกม) ห้ามมองคำของตัวเอง!';
    }
    if (s.endReason === 'timeout') return 'หมดเวลา! เฉลยคำของทุกคนแล้ว';
    if (s.endReason === 'all-done') return 'ทุกคนทายถูกแล้ว! ดูคำของทุกคนด้านล่าง';
    return 'เฉลยแล้ว! ดูคำของทุกคนด้านล่าง';
  }

  function formatTime(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const m = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  function tick() {
    const t = $('timer');
    if (!state || state.phase !== 'playing' || deadline == null) return;
    const left = deadline - performance.now();
    t.textContent = `⏱ ${formatTime(left)}`;
    t.classList.toggle('low', left <= 30000);
  }

  // ตารางคะแนนเรียงจากมากไปน้อย คะแนนเท่ากันได้อันดับเดียวกัน
  function renderScoreboard(s) {
    const box = $('scoreboard');
    box.hidden = !(s.round > 0 && s.phase !== 'playing');
    if (box.hidden) return;
    $('round-no').textContent = `· เล่นไปแล้ว ${s.round} รอบ`;
    const list = $('score-list');
    list.textContent = '';
    const sorted = s.players.slice().sort((a, b) => b.score - a.score);
    let rank = 0;
    let prev = null;
    sorted.forEach((p, i) => {
      if (p.score !== prev) rank = i + 1;
      prev = p.score;
      const li = el('li', rank === 1 && p.score > 0 ? 'first' : '');
      li.append(el('span', 'rank', String(rank)));
      li.append(el('span', 'nm', p.id === s.you ? `${p.name} (คุณ)` : p.name));
      li.append(el('span', 'pts', String(p.score)));
      list.append(li);
    });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(text, onClick, cls) {
    const b = el('button', cls || '', text);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    $('home').hidden = !!state;
    $('room').hidden = !state;
    if (!state) return;
    const s = state;
    const isHost = s.you === s.hostId;

    $('room-code').textContent = s.code;

    // ตัวจับเวลา: ตอนเล่น = นับถอยหลัง, ตอนล็อบบี้ = แสดงเวลาที่ตั้งไว้
    const timer = $('timer');
    const picker = $('time-picker');
    picker.hidden = !(isHost && s.phase === 'lobby');
    timer.hidden = s.phase === 'revealed';
    timer.classList.remove('low');
    if (s.phase === 'lobby') {
      timer.classList.add('small');
      timer.textContent = `⏱ เวลาต่อรอบ ${s.timeLimit} นาที`;
      timer.hidden = isHost; // หัวห้องเห็นปุ่มเลือกอยู่แล้ว
    } else if (s.phase === 'playing') {
      timer.classList.remove('small');
      tick();
    }
    const seg = $('time-seg');
    seg.textContent = '';
    for (const minutes of s.timeOptions) {
      const b = el('button', '', `${minutes} นาที`);
      b.setAttribute('aria-pressed', String(minutes === s.timeLimit));
      b.addEventListener('click', () => send({ t: 'time', minutes }));
      seg.append(b);
    }
    $('status').textContent = statusText(s);

    const list = $('players');
    list.textContent = '';
    for (const p of s.players) {
      const li = el('li', `player${p.id === s.you ? ' me' : ''}${p.connected ? '' : ' offline'}`);
      const top = el('div', 'top');
      const left = el('div');
      left.append(el('span', 'name', p.name));
      const tags = [];
      if (p.id === s.hostId) tags.push('👑 หัวห้อง');
      if (p.id === s.you) tags.push('คุณ');
      if (!p.connected) tags.push('หลุดการเชื่อมต่อ');
      if (tags.length) left.append(el('div', 'tag', tags.join(' · ')));
      top.append(left);
      const right = el('div', 'right');
      if (s.round > 0) {
        if (s.phase !== 'lobby' && p.roundPoints > 0) right.append(el('span', 'gain', `+${p.roundPoints}`));
        right.append(el('span', 'score', `⭐ ${p.score}`));
      }
      if (isHost && p.id !== s.you && s.phase === 'lobby') {
        right.append(button('เชิญออก', () => {
          if (confirm(`เชิญ ${p.name} ออกจากห้อง?`)) send({ t: 'kick', id: p.id });
        }, 'danger'));
      }
      top.append(right);
      li.append(top);

      if (s.phase !== 'lobby') {
        if (p.word === null) li.append(el('div', 'word hidden', '???'));
        else li.append(el('div', `word${p.id === s.you ? ' done' : ''}`, p.word));
      }
      list.append(li);
    }

    renderScoreboard(s);

    const actions = $('me-actions');
    actions.textContent = '';
    const me = s.players.find((p) => p.id === s.you);
    if (s.phase === 'lobby' && isHost) {
      const b = button('เริ่มเกม', () => send({ t: 'start' }), 'primary');
      b.disabled = s.players.length < s.minPlayers;
      actions.append(b);
      if (s.round > 0) {
        actions.append(button('รีเซ็ตคะแนน', () => {
          if (confirm('ล้างคะแนนของทุกคนและเริ่มนับใหม่?')) send({ t: 'resetscores' });
        }));
      }
    }
    if (s.phase === 'playing') {
      if (!me.done) {
        actions.append(button('ฉันทายถูกแล้ว (เปิดคำของฉัน)', () => {
          if (confirm('เปิดดูคำของคุณเลยไหม? กดแล้วย้อนกลับไม่ได้')) send({ t: 'done' });
        }, 'primary'));
      }
      if (isHost) {
        actions.append(button('เฉลยทุกคน', () => {
          if (confirm('เฉลยคำของทุกคนเลยไหม?')) send({ t: 'reveal' });
        }));
      }
    }
    if (s.phase === 'revealed' && isHost) {
      actions.append(button('เล่นรอบใหม่', () => send({ t: 'again' }), 'primary'));
    }
    if (s.phase === 'revealed' && !isHost) {
      actions.append(el('p', 'muted', 'รอหัวห้องเริ่มรอบใหม่...'));
    }

    // กล่องคำที่ตั้งเอง: เฉพาะหัวห้องและตอนอยู่ในล็อบบี้
    const box = $('custom-box');
    box.hidden = !(isHost && s.phase === 'lobby');
    const ta = $('custom');
    if (!box.hidden && document.activeElement !== ta) {
      ta.value = (s.customWords || []).join('\n');
    }
  }

  function shareLink() {
    return `${location.origin}${location.pathname}?room=${state.code}`;
  }

  $('btn-share').addEventListener('click', async () => {
    const url = shareLink();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'เกมคำต้องห้าม', text: `มาเล่นคำต้องห้ามกัน! รหัสห้อง ${state.code}`, url });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('คัดลอกลิงก์แล้ว');
    } catch {
      prompt('คัดลอกลิงก์นี้ส่งให้เพื่อน', url);
    }
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('name').value.trim();
    if (!name) return toast('กรุณาใส่ชื่อ');
    send({ t: 'create', name });
    return undefined;
  });

  function joinFromForm() {
    const name = $('name').value.trim();
    const code = $('code').value.trim().toUpperCase();
    if (!name) return toast('กรุณาใส่ชื่อ');
    if (code.length !== 4) return toast('รหัสห้องต้องมี 4 ตัว');
    send({ t: 'join', code, name });
    return undefined;
  }
  $('btn-join').addEventListener('click', joinFromForm);
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromForm(); });

  $('btn-save-words').addEventListener('click', () => {
    const list = $('custom').value.split('\n');
    send({ t: 'words', list });
    toast('บันทึกแล้ว');
  });

  $('btn-leave').addEventListener('click', () => {
    if (confirm('ออกจากห้องนี้?')) send({ t: 'leave' });
  });

  // เปิดลิงก์แชร์ -> เติมรหัสห้องให้
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);
  if (session && urlRoom && session.code !== urlRoom.toUpperCase()) saveSession(null);
  if (session && session.name) $('name').value = session.name;

  render();
  connect();
  setInterval(tick, 250);
})();
