/* ==========================================================
   창원정밀 작업일보 — app.js (v3: form tabel seperti kertas)
   - Header: 날짜 + 주간/야간 → satu lembar laporan
   - Isi: tabel baris (PC) / kartu (HP), edit langsung + simpan otomatis
   - Copy per kolom (untuk paste ke Excel)
   - Sinkron Supabase + antrean offline
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Konstanta ---------- */
  const PREF = 'cwjm_prefs_v1';
  const CFG_KEY = 'cwjm_cfg_v1';
  const CACHE_KEY = 'cwjm_cache_v3';
  const NOTES_KEY = 'cwjm_notes_v1';
  const OUTBOX_KEY = 'cwjm_outbox_v2';
  const COPIED_KEY = 'cwjm_copiedcols_v1';
  const T_ROWS = 'worklog';
  const T_NOTE = 'worklog_note';
  const POLL_MS = 10000;
  const SAVE_DELAY = 700;

  // Kolom sesuai form kertas 작업일보
  const COLS = [
    { k: 'worker',   label: '작업자',           type: 'text', list: 'dl_worker' },
    { k: 'machine',  label: '설비명',           type: 'text', list: 'dl_machine' },
    { k: 'item',     label: '품명',             type: 'text', list: 'dl_item' },
    { k: 'client',   label: '발주처',           type: 'text', list: 'dl_client' },
    { k: 'process',  label: '진행현황',         type: 'text', list: 'dl_process', group: true },
    { k: 'good',     label: '양품',             type: 'num', group: true },
    { k: 'bad',      label: '불량',             type: 'num', group: true },
    { k: 'start',    label: '시작',             type: 'time' },
    { k: 'end',      label: '종료',             type: 'time' },
    { k: 'remark',   label: '정지내역 및 비고', type: 'area' }
  ];
  const INPUT_COLS = COLS.filter(c => c.type !== 'calc');
  const TEXT_KEYS = ['worker', 'machine', 'item', 'client', 'process', 'remark'];
  const NUM_KEYS = ['good', 'bad'];

  /* ---------- Util ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const fmtN = n => Number(n || 0).toLocaleString('ko-KR');
  const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numOrNull = v => { if (v === '' || v == null) return null; const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  const readJSON = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  const prefs = readJSON(PREF, {});

  /* ---------- DOM ---------- */
  const dateEl = $('#sheetDate');
  const rowsEl = $('#rows');
  const headEl = $('#sheetHead');
  const totalsEl = $('#totals');
  const noteEl = $('#noteText');
  const installBtn = $('#installBtn');

  /* ==========================================================
     TOAST
     ========================================================== */
  function toast(msg, variant = 'ok', ms = 1800) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = `toast ${variant}`;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
  }

  /* ==========================================================
     CUSTOM ASYNC MODAL (pengganti alert / confirm)
     ========================================================== */
  const ICONS = { info: 'i', ok: '✓', warn: '!', danger: '✕' };
  let modalBusy = Promise.resolve();
  let hideTimer = null;

  function openModal(opts) {
    const run = () => showModal(opts);
    const p = modalBusy.then(run, run);
    modalBusy = p.catch(() => {});
    return p;
  }

  function showModal({ title = '알림', message = '', variant = 'info', confirmText = '확인', cancelText = null, focus = null } = {}) {
    return new Promise(resolve => {
      const root = $('#modal');
      const ok = $('#modalOk');
      const cancel = $('#modalCancel');
      const body = $('#modalMsg');

      clearTimeout(hideTimer);
      $('#modalTitle').textContent = title;
      $('#modalIco').textContent = ICONS[variant] || 'i';
      body.replaceChildren();
      if (message instanceof Node) body.appendChild(message);
      else body.textContent = message;

      root.dataset.variant = variant;
      ok.textContent = confirmText;
      ok.className = 'btn ' + (variant === 'danger' ? 'btn-danger' : 'btn-primary');
      cancel.hidden = !cancelText;
      if (cancelText) cancel.textContent = cancelText;

      const prevFocus = document.activeElement;
      root.hidden = false;
      document.body.classList.add('no-scroll');
      requestAnimationFrame(() => root.classList.add('open'));

      const focusables = () => $$('button:not([hidden]), textarea, input', root);
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.isComposing) { e.preventDefault(); close(true); }
        else if (e.key === 'Tab') {
          const f = focusables(); if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      const onBackdrop = e => { if (e.target === root) close(false); };

      function close(value) {
        root.classList.remove('open');
        document.removeEventListener('keydown', onKey, true);
        root.removeEventListener('click', onBackdrop);
        ok.onclick = cancel.onclick = null;
        document.body.classList.remove('no-scroll');
        hideTimer = setTimeout(() => { root.hidden = true; }, 190);
        if (prevFocus && prevFocus.focus && innerWidth >= 900 && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
        resolve(value);
      }

      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      root.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => {
        const target = (focus && root.querySelector(focus)) || (cancelText ? cancel : ok);
        target.focus({ preventScroll: true });
      }, 60);
    });
  }
  const alertModal = (title, message, variant = 'info') => openModal({ title, message, variant });

  /* ==========================================================
     TEMA
     ========================================================== */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#17191d' : '#f4efe6');
  }
  applyTheme(document.documentElement.dataset.theme || 'light');
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    prefs.theme = next;
    writeJSON(PREF, prefs);
  });

  /* ==========================================================
     PERHITUNGAN
     ========================================================== */
  function minutesOf(r) {
    if (!r.start || !r.end) return null;
    const [sh, sm] = r.start.split(':').map(Number);
    const [eh, em] = r.end.split(':').map(Number);
    let m = (eh * 60 + em) - (sh * 60 + sm);
    if (m < 0) m += 1440; // lewat tengah malam (야간)
    return m;
  }
  function netOf(r) {
    const m = minutesOf(r);
    if (m == null) return null;
    return Math.max(0, m - (r.downtime || 0));
  }
  function valueOf(r, k) {
    if (k === 'minutes') return minutesOf(r);
    if (k === 'net') return netOf(r);
    return r[k];
  }
  function hasContent(r) {
    return TEXT_KEYS.some(k => (r[k] || '').trim()) ||
      NUM_KEYS.some(k => r[k] != null) || !!r.start || !!r.end;
  }

  /* ==========================================================
     DATA LAYER — Supabase REST + cache + antrean offline
     ========================================================== */
  function getConfig() {
    const local = readJSON(CFG_KEY, {});
    const base = window.CWJM_CONFIG || {};
    const url = String(local.url || base.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
    const key = String(local.key || base.SUPABASE_KEY || '').trim();
    return { url, key, ok: !!(url && key) };
  }

  async function api(path, { method = 'GET', body, prefer } = {}) {
    const c = getConfig();
    if (!c.ok) { const e = new Error('NO_CONFIG'); e.code = 'NO_CONFIG'; throw e; }
    const headers = { apikey: c.key, 'Content-Type': 'application/json' };
    if (c.key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.key;
    if (prefer) headers.Prefer = prefer;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${c.url}/rest/v1/${path}`, {
        method, headers, cache: 'no-store', signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${txt.slice(0, 240)}`);
        err.status = res.status;
        err.schema = /PGRST2\d\d|column|schema cache|relation/i.test(txt);
        throw err;
      }
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  const toRow = r => ({
    id: r.id, date: r.date, shift: r.shift,
    worker: r.worker || '', machine: r.machine || '', item: r.item || '',
    client: r.client || '', process: r.process || '',
    good: numOrNull(r.good), bad: numOrNull(r.bad), downtime: numOrNull(r.downtime),
    start_time: r.start || null, end_time: r.end || null,
    remark: r.remark || '',
    created_at: new Date(r.createdAt || Date.now()).toISOString()
  });
  const fromRow = x => ({
    id: x.id, date: x.date, shift: x.shift,
    worker: x.worker || '', machine: x.machine || '', item: x.item || '',
    client: x.client || '', process: x.process || '',
    good: numOrNull(x.good), bad: numOrNull(x.bad), downtime: numOrNull(x.downtime),
    start: (x.start_time || '').slice(0, 5), end: (x.end_time || '').slice(0, 5),
    remark: x.remark || '',
    createdAt: Date.parse(x.created_at) || 0
  });

  // cache: id → baris; baris "blank" (belum disentuh) tidak pernah disimpan
  let cache = readJSON(CACHE_KEY, {});
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  Object.values(cache).forEach(r => { if (r.blank) delete cache[r.id]; });
  let notes = readJSON(NOTES_KEY, {});          // "date|shift" → teks
  let outbox = readJSON(OUTBOX_KEY, []);
  if (!Array.isArray(outbox)) outbox = [];
  let copiedCols = readJSON(COPIED_KEY, {});    // "date|shift" → { kolom: waktu }

  const allRecords = () => Object.values(cache);
  const saveCache = () => {
    const keep = {};
    Object.values(cache).forEach(r => { if (!r.blank) keep[r.id] = r; });
    if (!writeJSON(CACHE_KEY, keep)) toast('저장 공간이 부족합니다', 'err');
  };
  const saveOutbox = () => writeJSON(OUTBOX_KEY, outbox);

  let sending = false;
  function enqueue(op) {
    const same = o => o.op === op.op && (o.id || o.key) === (op.id || op.key);
    const rest = sending ? outbox.slice(1) : outbox;
    if (!rest.some(same)) { outbox.push(op); saveOutbox(); }
  }
  const pendingRow = id => outbox.some(o => o.op === 'upsert' && o.id === id) || saveTimers.has(id);

  /* ---------- Status koneksi ---------- */
  let netState = 'local';   // local | ok | offline | auth | schema
  let busy = false;
  let lastSync = 0;

  function setNet(ok, err) {
    if (!getConfig().ok) netState = 'local';
    else if (ok) netState = 'ok';
    else if (err && (err.status === 401 || err.status === 403)) netState = 'auth';
    else if (err && (err.status === 404 || err.schema)) netState = 'schema';
    else netState = 'offline';
    updateStatus();
  }
  function updateStatus() {
    const pill = $('#syncPill');
    const n = outbox.length + saveTimers.size;
    let cls, txt;
    if (netState === 'local') { cls = 'local'; txt = n ? `서버 미연결 · ${n}` : '서버 미연결'; }
    else if (netState === 'auth') { cls = 'err'; txt = '키 오류'; }
    else if (netState === 'schema') { cls = 'err'; txt = 'DB 설정 필요'; }
    else if (netState === 'offline') { cls = 'err'; txt = n ? `오프라인 · 대기 ${n}` : '오프라인'; }
    else if (busy || n) { cls = 'sync'; txt = n ? `저장 중 · ${n}` : '동기화 중'; }
    else { cls = 'ok'; txt = '저장됨'; }
    pill.className = 'sync-pill s-' + cls;
    $('#syncText').textContent = txt;
    pill.title = lastSync ? `마지막 동기화 ${hhmm(lastSync)}` : '동기화 상태';
  }
  function netMessage(err) {
    const s = err && err.status;
    if (s === 401 || s === 403) return 'API 키가 올바르지 않습니다';
    if (s === 404 || (err && err.schema)) return 'DB 테이블이 최신이 아닙니다. setup.sql을 다시 실행하세요';
    return '서버에 연결할 수 없습니다';
  }

  /* ---------- Kirim antrean ---------- */
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => { flushing = null; sending = false; updateStatus(); renderPendingMarks(); });
    return flushing;
  }
  async function doFlush() {
    if (!getConfig().ok || !outbox.length) { updateStatus(); return; }
    updateStatus();
    while (outbox.length) {
      const o = outbox[0];
      sending = true;
      try {
        if (o.op === 'upsert') {
          const r = cache[o.id];
          if (r && !r.blank) {
            await api(`${T_ROWS}?on_conflict=id`, { method: 'POST', body: [toRow(r)], prefer: 'resolution=merge-duplicates,return=minimal' });
          }
        } else if (o.op === 'delete') {
          await api(`${T_ROWS}?id=eq.${encodeURIComponent(o.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
        } else if (o.op === 'note') {
          const [date, shift] = o.key.split('|');
          await api(`${T_NOTE}?on_conflict=date,shift`, {
            method: 'POST', body: [{ date, shift, note: notes[o.key] || '' }],
            prefer: 'resolution=merge-duplicates,return=minimal'
          });
        }
        outbox.shift();
        saveOutbox();
        sending = false;
        updateStatus();
      } catch (err) {
        sending = false;
        const s = err.status || 0;
        // Ditolak karena isi data (bukan jaringan/izin/skema): buang agar antrean tidak macet
        if (s >= 400 && s < 500 && !err.schema && ![401, 403, 404, 408, 429].includes(s)) {
          console.error('Operasi ditolak server:', o, err);
          outbox.shift();
          saveOutbox();
          toast('서버가 데이터를 거부했습니다', 'err', 3000);
          continue;
        }
        setNet(false, err);
        return;
      }
    }
    setNet(true);
  }

  /* ---------- Tarik data lembar yang sedang dibuka ---------- */
  let pulling = false;
  async function pull({ manual = false } = {}) {
    if (!getConfig().ok) { setNet(false); return; }
    if (pulling) return;
    pulling = true;
    busy = true;
    updateStatus();
    const date = dateEl.value, shift = getShift(), key = sheetKey();
    try {
      await flush();
      if (netState !== 'ok' && outbox.length) throw Object.assign(new Error('flush failed'), { soft: true });
      const qs = `date=eq.${date}&shift=eq.${encodeURIComponent(shift)}`;
      const [rows, noteRows] = await Promise.all([
        api(`${T_ROWS}?select=*&${qs}&order=created_at.asc&limit=1000`),
        api(`${T_NOTE}?select=note&${qs}`)
      ]);
      if (date !== dateEl.value || shift !== getShift()) return; // lembar sudah diganti

      const pendingDel = new Set(outbox.filter(o => o.op === 'delete').map(o => o.id));
      const serverIds = new Set(rows.map(r => r.id));
      allRecords().forEach(r => {
        if (r.date === date && r.shift === shift && !r.blank && !serverIds.has(r.id) && !pendingRow(r.id)) delete cache[r.id];
      });
      rows.forEach(x => {
        if (pendingDel.has(x.id) || pendingRow(x.id)) return;
        const focusedRow = document.activeElement && document.activeElement.closest && document.activeElement.closest(`[data-id="${x.id}"]`);
        if (focusedRow) return; // jangan timpa baris yang sedang diketik
        cache[x.id] = fromRow(x);
      });

      const pendingNote = outbox.some(o => o.op === 'note' && o.key === key) || noteTimer;
      if (!pendingNote && document.activeElement !== noteEl) {
        notes[key] = (noteRows[0] && noteRows[0].note) || '';
        writeJSON(NOTES_KEY, notes);
        if (noteEl.value !== notes[key]) { noteEl.value = notes[key]; autoGrow(noteEl); }
      }

      saveCache();
      lastSync = Date.now();
      setNet(true);
      refreshDatalists();
      syncSheet();
      if (manual) toast('최신 데이터로 갱신했습니다', 'info');
    } catch (err) {
      if (!err.soft) setNet(false, err);
      if (manual) toast(netMessage(err), 'err', 3000);
    } finally {
      pulling = false;
      busy = false;
      updateStatus();
    }
  }

  /* ---------- Pengaturan server ---------- */
  async function openSettings() {
    const c = getConfig();
    const wrap = document.createElement('div');
    wrap.className = 'cfg-form';
    wrap.innerHTML = `
      <div>서버(Supabase) 프로젝트 정보를 입력하세요.<br>모든 기기에 같은 값을 넣으면 하나의 작업일보로 합쳐집니다.</div>
      <label>프로젝트 URL
        <input id="cfgUrl" type="url" inputmode="url" placeholder="https://xxxx.supabase.co" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <label>API 키 (anon / publishable)
        <input id="cfgKey" type="text" placeholder="eyJ... 또는 sb_publishable_..." autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <div class="cfg-hint">config.js에 미리 입력해 두면 기기마다 입력할 필요가 없습니다. 비워 두고 저장하면 서버 연결이 해제됩니다.</div>`;
    $('#cfgUrl', wrap).value = c.url;
    $('#cfgKey', wrap).value = c.key;

    const ok = await openModal({ title: '서버 설정', message: wrap, variant: 'info', confirmText: '저장 · 연결', cancelText: '취소', focus: '#cfgUrl' });
    if (!ok) return;
    const url = $('#cfgUrl', wrap).value.trim();
    const key = $('#cfgKey', wrap).value.trim();
    writeJSON(CFG_KEY, { url, key });
    if (!url || !key) { setNet(false); toast('로컬 모드로 전환했습니다', 'info'); return; }
    try {
      await api(`${T_ROWS}?select=id&limit=1`);
      await api(`${T_NOTE}?select=date&limit=1`);
      setNet(true);
      toast('서버 연결 성공 ✓');
      pull();
    } catch (err) {
      setNet(false, err);
      await alertModal('연결 실패', `${netMessage(err)}\n\nURL과 키, 그리고 setup.sql 실행 여부를 확인해 주세요.`, 'danger');
    }
  }
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#syncPill').addEventListener('click', () => { if (!getConfig().ok) openSettings(); else pull({ manual: true }); });

  /* ==========================================================
     HEADER: tanggal & 근무
     ========================================================== */
  const getShift = () => ($('input[name="shift"]:checked') || {}).value || '주간';
  const setShift = v => { const r = $(`input[name="shift"][value="${v}"]`); if (r) r.checked = true; };
  const sheetKey = () => `${dateEl.value}|${getShift()}`;

  function updateHeaderText() {
    const d = dateEl.value ? new Date(dateEl.value + 'T00:00:00') : null;
    $('#docDate').textContent = d ? `(${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())} ${DOW[d.getDay()]}) · ${getShift()}` : '';
    // Sabtu & Minggu (kalau masuk) memakai jam akhir pekan; labelnya (토) atau (일)
    const sun = d && d.getDay() === 0;
    const sat = d && (d.getDay() === 6 || sun);
    const h = WORK_HOURS[getShift()];
    $('#whDay').textContent = `(${getShift()}) ${h.week}`;
    $('#whSat').textContent = `(${sun ? '일' : '토'}) ${h.sat}`;
    $('#whDay').classList.toggle('on', !!d && !sat);
    $('#whSat').classList.toggle('on', !!sat);
  }

  function shiftDate(days) {
    const d = new Date((dateEl.value || ymd(new Date())) + 'T00:00:00');
    d.setDate(d.getDate() + days);
    dateEl.value = ymd(d);
    loadSheet();
  }
  $('#prevDay').addEventListener('click', () => shiftDate(-1));
  $('#nextDay').addEventListener('click', () => shiftDate(1));
  $('#todayBtn').addEventListener('click', () => { setDefaultSheet(); loadSheet(); });
  dateEl.addEventListener('change', () => { if (dateEl.value) loadSheet(); });
  $$('input[name="shift"]').forEach(r => r.addEventListener('change', loadSheet));

  // Jam kerja: 주간 07:30~19:00 (토 07:30~16:00) · 야간 19:00~07:30 (토 16:00~00:30)
  const WORK_HOURS = {
    '주간': { week: '07:30~19:00', sat: '07:30~16:00' },
    '야간': { week: '19:00~07:30', sat: '16:00~00:30' }
  };
  // Default: sebelum 07:30 dianggap lanjutan 야간 hari sebelumnya
  function setDefaultSheet() {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins < 450) {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      dateEl.value = ymd(y); setShift('야간');
    } else {
      dateEl.value = ymd(now);
      const dayEnd = (now.getDay() === 6 || now.getDay() === 0) ? 960 : 1140; // 토·일 16:00, lainnya 19:00
      setShift(mins < dayEnd ? '주간' : '야간');
    }
  }

  function loadSheet() {
    commitAll();
    commitNote();
    updateHeaderText();
    const key = sheetKey();
    noteEl.value = notes[key] || '';
    autoGrow(noteEl);
    syncSheet();
    pull();
  }

  /* ==========================================================
     SHEET: tabel PC / kartu HP (satu DOM)
     ========================================================== */
  // Header dua tingkat (일일 생산 현황 di atas 진행현황/양품/불량)
  function buildHead() {
    const parts = [];
    const place = (html, col, row, span = 1, rowSpan = 1, cls = '') =>
      parts.push(`<div class="hcell ${cls}" style="grid-column:${col} / span ${span};grid-row:${row} / span ${rowSpan}">${html}</div>`);
    place('번호', 1, 1, 1, 2);
    let col = 2;
    let groupPlaced = false;
    COLS.forEach(c => {
      const btn = `<button type="button" class="hc-btn" data-copy="${c.k}" title="${esc(c.label)} 열 복사" aria-label="${esc(c.label)} 열 복사">📋</button>`;
      const inner = `<span>${esc(c.label)}</span>${btn}`;
      if (c.group) {
        if (!groupPlaced) { place('일일 생산 현황', col, 1, 3, 1, 'group'); groupPlaced = true; }
        parts.push(`<div class="hcell" data-col="${c.k}" style="grid-column:${col};grid-row:2">${inner}</div>`);
      } else {
        parts.push(`<div class="hcell" data-col="${c.k}" style="grid-column:${col};grid-row:1 / span 2">${inner}</div>`);
      }
      col++;
    });
    place('삭제', col, 1, 1, 2);
    headEl.innerHTML = parts.join('');

    $('#colChips').innerHTML = COLS.map(c =>
      `<button type="button" class="chip" data-copy="${c.k}">📋 ${esc(c.label)}</button>`).join('');
  }

  function buildRow(r) {
    const el = document.createElement('div');
    el.className = 'srow';
    el.dataset.id = r.id;
    const cells = [`<div class="cell c-idx"><span class="idx"></span></div>`];
    COLS.forEach(c => {
      const lbl = `<span class="m-lbl">${esc(c.label)}</span>`;
      if (c.type === 'calc') {
        cells.push(`<div class="cell calc" data-col="${c.k}">${lbl}<output data-calc="${c.k}"></output></div>`);
      } else if (c.type === 'area') {
        cells.push(`<label class="cell" data-col="${c.k}">${lbl}<textarea data-k="${c.k}" rows="1" autocapitalize="characters"></textarea></label>`);
      } else if (c.type === 'num') {
        cells.push(`<label class="cell" data-col="${c.k}">${lbl}<input class="num" data-k="${c.k}" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" enterkeyhint="next"></label>`);
      } else if (c.type === 'time') {
        cells.push(`<label class="cell" data-col="${c.k}">${lbl}<input data-k="${c.k}" type="time"></label>`);
      } else {
        cells.push(`<label class="cell" data-col="${c.k}">${lbl}<input data-k="${c.k}" type="text" list="${c.list}" autocomplete="off" autocapitalize="characters" enterkeyhint="next"></label>`);
      }
    });
    cells.push(`<div class="cell c-del"><button type="button" class="del-btn" data-action="del" aria-label="이 줄 삭제" title="이 줄 삭제">🗑</button></div>`);
    el.innerHTML = cells.join('');
    return el;
  }

  function fillRow(el, r, i) {
    el.classList.toggle('blank', !!r.blank);
    el.querySelector('.idx').innerHTML = `${i + 1}${!r.blank && pendingRow(r.id) ? '<span class="pend" title="저장 대기">⏳</span>' : ''}`;
    const active = document.activeElement;
    $$('[data-k]', el).forEach(inp => {
      if (inp === active) return;
      const v = r[inp.dataset.k];
      const s = v == null ? '' : String(v);
      if (inp.value !== s) { inp.value = s; if (inp.tagName === 'TEXTAREA') autoGrow(inp); }
    });
    updateCalc(el, r);
  }

  function updateCalc(el, r) {
    $$('output[data-calc]', el).forEach(o => {
      const v = valueOf(r, o.dataset.calc);
      o.textContent = v == null ? '' : fmtN(v);
    });
  }

  function sheetRows() {
    const d = dateEl.value, s = getShift();
    return allRecords()
      .filter(r => r.date === d && r.shift === s)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  const realRows = () => sheetRows().filter(r => !r.blank);

  // Default satu baris kosong; baris berikutnya ditambah lewat tombol 작업 추가
  function newBlank(auto = false) {
    const r = {
      id: uid(), date: dateEl.value, shift: getShift(),
      worker: '', machine: '', item: '', client: '', process: '',
      good: null, bad: null, downtime: null, start: '', end: '', remark: '',
      createdAt: Date.now(), blank: true, auto
    };
    cache[r.id] = r;
    return r;
  }
  function ensureBlank() {
    if (!dateEl.value) return;
    const rows = sheetRows();
    if (!rows.length) { newBlank(true); return; }
    // Ada data dari perangkat lain → baris kosong default tidak diperlukan lagi
    if (rows.some(r => !r.blank)) {
      rows.forEach(r => {
        if (r.blank && r.auto && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(`[data-id="${r.id}"]`))) delete cache[r.id];
      });
    }
  }

  function syncSheet() {
    ensureBlank();
    const list = sheetRows();
    const existing = new Map($$('#rows > .srow').map(e => [e.dataset.id, e]));
    list.forEach((r, i) => {
      let el = existing.get(r.id);
      if (el) existing.delete(r.id);
      else el = buildRow(r);
      if (rowsEl.children[i] !== el) rowsEl.insertBefore(el, rowsEl.children[i] || null);
      fillRow(el, r, i);
    });
    existing.forEach(el => el.remove());
    renderTotals();
    applyCopied();
  }

  function renderPendingMarks() {
    const list = sheetRows();
    list.forEach((r, i) => {
      const el = rowsEl.querySelector(`[data-id="${r.id}"]`);
      if (el) el.querySelector('.idx').innerHTML = `${i + 1}${!r.blank && pendingRow(r.id) ? '<span class="pend" title="저장 대기">⏳</span>' : ''}`;
    });
  }

  function renderTotals() {
    const list = realRows().filter(hasContent);
    const sum = k => list.reduce((s, r) => s + (valueOf(r, k) || 0), 0);
    const cells = [`<div class="fcell flabel" style="grid-column:1 / span 5">합계 (${list.length}건)</div>`, `<div class="fcell" style="grid-column:6"></div>`];
    const at = (k, col) => cells.push(`<div class="fcell" style="grid-column:${col}">${fmtN(sum(k))}</div>`);
    at('good', 7); at('bad', 8);
    cells.push(`<div class="fcell" style="grid-column:9 / span 4"></div>`);
    totalsEl.innerHTML = cells.join('');
    $('#sheetStats').innerHTML = `작업 <b>${list.length}</b>건 · 양품 <b>${fmtN(sum('good'))}</b> · 불량 <b>${fmtN(sum('bad'))}</b>`;
  }

  /* ---------- Edit & simpan otomatis ---------- */
  const saveTimers = new Map();

  function commitRow(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const r = cache[id];
    if (!r || r.blank) return;
    enqueue({ op: 'upsert', id });
    saveCache();
    refreshDatalists();
    flush();
  }
  function commitAll() { [...saveTimers.keys()].forEach(commitRow); }

  // Huruf alfabet otomatis kapital (huruf Korea tidak berubah); kursor tetap di tempatnya
  function toUpper(el) {
    const v = el.value, up = v.toUpperCase();
    if (v === up) return;
    const s = el.selectionStart, en = el.selectionEnd;
    el.value = up;
    try { el.setSelectionRange(s, en); } catch { /* input tanpa seleksi */ }
  }
  const isTextField = el => el.matches('textarea, input[type="text"]:not(.num)');
  // Selesai merangkai huruf (IME Korea) → proses ulang sebagai input biasa
  document.addEventListener('compositionend', e => {
    if (e.target.matches && (e.target.matches('#rows [data-k]') || e.target === noteEl) && isTextField(e.target)) {
      e.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  rowsEl.addEventListener('input', e => {
    const inp = e.target.closest('[data-k]');
    if (!inp) return;
    const rowEl = inp.closest('.srow');
    const r = cache[rowEl.dataset.id];
    if (!r) return;
    const k = inp.dataset.k;
    if (isTextField(inp) && !e.isComposing) toUpper(inp);
    if (NUM_KEYS.includes(k)) {
      const clean = inp.value.replace(/\D/g, '');
      if (clean !== inp.value) inp.value = clean;
      r[k] = numOrNull(clean);
    } else {
      r[k] = inp.value;
    }
    if (inp.tagName === 'TEXTAREA') autoGrow(inp);

    if (r.blank) {
      // Baris kosong mulai diisi → jadi baris nyata (posisinya tetap)
      r.blank = false;
      rowEl.classList.remove('blank');
    }
    updateCalc(rowEl, r);
    renderTotals();
    clearTimeout(saveTimers.get(r.id));
    saveTimers.set(r.id, setTimeout(() => commitRow(r.id), SAVE_DELAY));
    renderPendingMarks();
    updateStatus();
  });
  // Simpan segera saat keluar dari sel
  rowsEl.addEventListener('focusout', e => {
    const rowEl = e.target.closest && e.target.closest('.srow');
    if (rowEl && saveTimers.has(rowEl.dataset.id) && !rowEl.contains(e.relatedTarget)) commitRow(rowEl.dataset.id);
  });

  // Enter → sel berikutnya; di akhir baris lanjut ke baris berikutnya
  rowsEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey) return;
    const t = e.target;
    if (!t.matches('input[data-k]')) return;
    e.preventDefault();
    const all = $$('#rows [data-k]');
    const i = all.indexOf(t);
    const next = all[i + 1];
    if (next) next.focus();
    else t.blur();
  });

  // Hapus baris
  rowsEl.addEventListener('click', async e => {
    const b = e.target.closest('[data-action="del"]');
    if (!b) return;
    const rowEl = b.closest('.srow');
    const id = rowEl.dataset.id;
    const r = cache[id];
    if (!r) return;
    const n = sheetRows().indexOf(r) + 1;
    const msg = document.createElement('div');
    if (r.blank || !hasContent(r)) {
      msg.append(`${n}번 작업(빈 줄)을 삭제할까요?`);
    } else {
      msg.append(`${n}번 작업을 삭제할까요?\n모든 기기에서 삭제되며 되돌릴 수 없습니다.`);
      const sum = document.createElement('div');
      sum.className = 'modal-summary';
      sum.innerHTML = `<b>${esc(r.worker || '-')} · ${esc(r.machine || '-')}</b><br>${esc(r.item || '(품명 없음)')}${r.client ? ' / ' + esc(r.client) : ''}<br>양품 ${fmtN(r.good)} · 불량 ${fmtN(r.bad)} · ${esc(r.start || '--:--')}~${esc(r.end || '--:--')}`;
      msg.appendChild(sum);
    }
    const ok = await openModal({ title: '작업 삭제', message: msg, variant: 'danger', confirmText: '삭제', cancelText: '취소' });
    if (!ok) return;

    rowEl.classList.add('removing');
    setTimeout(() => {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      const wasSaved = !r.blank;
      delete cache[id];
      if (wasSaved) {
        outbox = outbox.filter((o, idx) => !(o.op === 'upsert' && o.id === id && !(sending && idx === 0)));
        enqueue({ op: 'delete', id });
      }
      saveCache();
      syncSheet();
      refreshDatalists();
      flush();
      toast('삭제되었습니다', 'info');
    }, 250);
  });

  // Tinggi textarea mengikuti isi
  function autoGrow(t) {
    t.style.height = 'auto';
    t.style.height = Math.max(t.scrollHeight + 4, 38) + 'px';
  }

  /* ---------- 특이사항 ---------- */
  let noteTimer = null;
  function commitNote() {
    if (!noteTimer) return;
    clearTimeout(noteTimer);
    noteTimer = null;
    enqueue({ op: 'note', key: noteEl.dataset.key });
    flush();
  }
  noteEl.addEventListener('input', e => {
    if (!e.isComposing) toUpper(noteEl);
    const key = sheetKey();
    noteEl.dataset.key = key;
    notes[key] = noteEl.value;
    writeJSON(NOTES_KEY, notes);
    autoGrow(noteEl);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(commitNote, SAVE_DELAY);
    updateStatus();
  });
  noteEl.addEventListener('blur', commitNote);

  /* ---------- Tombol tambah & simpan ---------- */
  $('#addRowBtn').addEventListener('click', () => {
    const r = newBlank();
    syncSheet();
    const target = rowsEl.querySelector(`[data-id="${r.id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => target.querySelector('[data-k="worker"]').focus({ preventScroll: true }), 250);
  });

  $('#saveBtn').addEventListener('click', async () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    commitAll();
    commitNote();
    if (!getConfig().ok) { toast('이 기기에 저장됨 (서버 미연결)', 'info', 2400); return; }
    await flush();
    if (!outbox.length) toast('저장되었습니다 ✓');
    else toast(`${netMessage({ status: 0 })} · 연결되면 자동 전송`, 'err', 3000);
  });

  /* ==========================================================
     COPY PER KOLOM
     ========================================================== */
  const clean = v => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n+/g, ' / ').trim();
  const cellText = (r, k) => { const v = valueOf(r, k); return v == null ? '' : clean(v); };

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  async function copyFailed(text) {
    const wrap = document.createElement('div');
    wrap.append('클립보드에 접근할 수 없습니다.\n아래 내용을 직접 복사해 주세요.');
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    wrap.appendChild(ta);
    setTimeout(() => ta.select(), 120);
    await alertModal('복사 실패', wrap, 'warn');
  }

  function applyCopied(flashKey) {
    const marks = copiedCols[sheetKey()] || {};
    COLS.forEach(c => {
      const on = !!marks[c.k];
      $$(`[data-col="${c.k}"]`).forEach(n => {
        n.classList.toggle('copied', on);
        if (flashKey === c.k && n.classList.contains('cell')) {
          n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
        }
      });
      $$(`.chip[data-copy="${c.k}"]`).forEach(n => n.classList.toggle('copied', on));
    });
  }

  async function copyColumn(k) {
    commitAll();
    const col = COLS.find(c => c.k === k);
    const list = realRows().filter(hasContent);
    if (!list.length) { toast('복사할 작업이 없습니다', 'info'); return; }
    const text = list.map(r => cellText(r, k)).join('\n');
    if (await copyText(text)) {
      const key = sheetKey();
      copiedCols[key] = { ...(copiedCols[key] || {}), [k]: Date.now() };
      writeJSON(COPIED_KEY, copiedCols);
      applyCopied(k);
      toast(`복사되었습니다! · ${col.label} (${list.length}건)`);
    } else {
      await copyFailed(text);
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (b) copyColumn(b.dataset.copy);
  });

  $('#copyAllBtn').addEventListener('click', async () => {
    commitAll();
    const list = realRows().filter(hasContent);
    if (!list.length) { toast('복사할 작업이 없습니다', 'info'); return; }
    const text = list.map(r => COLS.map(c => cellText(r, c.k)).join('\t')).join('\n');
    if (await copyText(text)) toast(`복사되었습니다! · 표 전체 (${list.length}건)`);
    else await copyFailed(text);
  });

  /* ---------- Datalist (autocomplete dari data bersama) ---------- */
  function refreshDatalists() {
    const list = allRecords().filter(r => !r.blank).sort((a, b) => b.createdAt - a.createdAt);
    ['worker', 'machine', 'item', 'client', 'process'].forEach(k => {
      const seen = new Set();
      for (const r of list) {
        const v = (r[k] || '').trim();
        if (v) seen.add(v);
        if (seen.size >= 40) break;
      }
      $('#dl_' + k).innerHTML = [...seen].map(v => `<option value="${esc(v)}"></option>`).join('');
    });
  }

  /* ==========================================================
     KEYBOARD VIRTUAL (mobile)
     ========================================================== */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const update = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--kb', kb + 'px');
      document.body.classList.toggle('kb-open', kb > 120);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (innerWidth >= 900 || !t.matches || !t.matches('#main input:not([type="radio"]), #main textarea')) return;
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
  });

  /* ==========================================================
     PWA: install + service worker
     ========================================================== */
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone()) installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.hidden = true;
    toast('앱이 설치되었습니다 🎉');
  });
  if (isIOS && !isStandalone()) installBtn.hidden = false;

  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome === 'accepted') installBtn.hidden = true;
    } else if (isIOS) {
      await alertModal('홈 화면에 추가', 'Safari 하단의 공유 버튼( □↑ )을 누른 뒤\n"홈 화면에 추가"를 선택하세요.', 'info');
    } else {
      await alertModal('앱 설치', '브라우저 메뉴(⋮)에서 "앱 설치" 또는\n"홈 화면에 추가"를 선택하세요.', 'info');
    }
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  /* ==========================================================
     SINKRON OTOMATIS
     ========================================================== */
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pull();
    else { commitAll(); commitNote(); }
  });
  window.addEventListener('pagehide', () => { commitAll(); commitNote(); });
  window.addEventListener('online', () => pull());
  window.addEventListener('offline', () => setNet(false, { status: 0 }));

  /* ==========================================================
     INIT
     ========================================================== */
  buildHead();
  setDefaultSheet();
  netState = getConfig().ok ? 'ok' : 'local';
  refreshDatalists();
  loadSheet();
  updateStatus();
  if (!getConfig().ok && !prefs.cfgPrompted) {
    prefs.cfgPrompted = true;
    writeJSON(PREF, prefs);
    openSettings();
  }
})();
