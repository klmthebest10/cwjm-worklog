/* ==========================================================
   창원정밀 작업일보 — app.js (v2, sinkron Supabase)
   - Data utama ada di tabel Supabase `public.worklog`
   - Cache + antrean offline di localStorage, jadi tetap bisa
     input saat Wi-Fi pabrik putus; dikirim otomatis saat online
   - Perangkat lain menarik data baru tiap 10 detik
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Konstanta & util ---------- */
  const PREF = 'cwjm_prefs_v1';
  const DRAFT = 'cwjm_draft_v1';
  const CFG_KEY = 'cwjm_cfg_v1';
  const CACHE_KEY = 'cwjm_cache_v2';
  const OUTBOX_KEY = 'cwjm_outbox_v1';
  const OLD_KEY = 'cwjm_worklog_v1';      // data lokal versi 1
  const MIGRATED_KEY = 'cwjm_migrated_v1';
  const TABLE = 'worklog';
  const POLL_MS = 10000;

  const LABELS = {
    date: '날짜', shift: '근무', worker: '작업자', machine: '설비명', item: '품명',
    client: '발주처', process: '생산 현황', good: '양품', bad: '불량',
    start: '시작', end: '종료', remark: '정지 내역 및 비고'
  };
  const REQUIRED = ['date', 'worker', 'machine', 'item', 'start', 'end'];
  const TEXT_FIELDS = ['worker', 'machine', 'item', 'client', 'process', 'remark'];
  // Urutan kolom saat disalin ke Excel
  const COPY_ORDER = ['date', 'shift', 'worker', 'machine', 'item', 'client', 'process', 'good', 'bad', 'start', 'end', 'remark'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const fmtN = n => Number(n || 0).toLocaleString('ko-KR');
  const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const readJSON = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  const prefs = readJSON(PREF, {});
  let flashId = null;

  /* ---------- DOM ---------- */
  const form = $('#logForm');
  const fDate = $('#f_date');
  const fFrom = $('#fFrom');
  const fTo = $('#fTo');
  const tbody = $('#tbody');
  const mobileList = $('#mobileList');
  const tableWrap = $('#tableWrap');
  const emptyState = $('#emptyState');
  const stats = $('#stats');
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
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, ms);
  }

  /* ==========================================================
     CUSTOM ASYNC MODAL (pengganti alert / confirm)
     const ok = await openModal({...})  → true / false
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
        if (prevFocus && prevFocus.focus && innerWidth >= 900) prevFocus.focus({ preventScroll: true });
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
  const confirmModal = (title, message, opts = {}) =>
    openModal({ title, message, variant: 'warn', confirmText: '확인', cancelText: '취소', ...opts });

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
        throw err;
      }
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  const toRow = r => ({
    id: r.id,
    date: r.date,
    shift: r.shift,
    worker: r.worker || '',
    machine: r.machine || '',
    item: r.item || '',
    client: r.client || '',
    process: r.process || '',
    good: toInt(r.good),
    bad: toInt(r.bad),
    start_time: r.start || null,
    end_time: r.end || null,
    remark: r.remark || '',
    copied_at: r.copiedAt ? new Date(r.copiedAt).toISOString() : null,
    created_at: new Date(r.createdAt || Date.now()).toISOString()
  });
  const fromRow = x => ({
    id: x.id,
    date: x.date,
    shift: x.shift,
    worker: x.worker || '',
    machine: x.machine || '',
    item: x.item || '',
    client: x.client || '',
    process: x.process || '',
    good: toInt(x.good),
    bad: toInt(x.bad),
    start: (x.start_time || '').slice(0, 5),
    end: (x.end_time || '').slice(0, 5),
    remark: x.remark || '',
    copiedAt: x.copied_at ? Date.parse(x.copied_at) : null,
    createdAt: Date.parse(x.created_at) || 0
  });

  let cache = readJSON(CACHE_KEY, {});       // id → record
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  let outbox = readJSON(OUTBOX_KEY, []);     // operasi yang belum terkirim
  if (!Array.isArray(outbox)) outbox = [];

  const allRecords = () => Object.values(cache);
  const saveCache = () => { if (!writeJSON(CACHE_KEY, cache)) toast('저장 공간이 부족합니다', 'err'); };
  const saveOutbox = () => writeJSON(OUTBOX_KEY, outbox);

  function addRecord(rec) {
    cache[rec.id] = rec;
    saveCache();
    outbox.push({ op: 'upsert', id: rec.id });
    saveOutbox();
    flush();
  }
  function removeRecord(id) {
    delete cache[id];
    saveCache();
    outbox = outbox.filter(o => !(o.op === 'upsert' && o.id === id));
    outbox.push({ op: 'delete', id });
    saveOutbox();
    flush();
  }
  function markCopied(ids, ts) {
    ids.forEach(id => { if (cache[id]) cache[id].copiedAt = ts; });
    saveCache();
    outbox.push({ op: 'copied', ids, ts });
    saveOutbox();
    flush();
  }

  /* ---------- Status koneksi ---------- */
  let netState = 'local';   // local | ok | offline | auth | notable
  let busy = false;

  function setNet(ok, err) {
    if (!getConfig().ok) netState = 'local';
    else if (ok) netState = 'ok';
    else if (err && (err.status === 401 || err.status === 403)) netState = 'auth';
    else if (err && err.status === 404) netState = 'notable';
    else netState = 'offline';
    updateStatus();
  }

  function updateStatus() {
    const pill = $('#syncPill');
    const n = outbox.length;
    let cls, txt;
    if (netState === 'local') { cls = 'local'; txt = '서버 미연결'; }
    else if (netState === 'auth') { cls = 'err'; txt = '키 오류'; }
    else if (netState === 'notable') { cls = 'err'; txt = '테이블 없음'; }
    else if (netState === 'offline') { cls = 'err'; txt = n ? `오프라인 · 대기 ${n}` : '오프라인'; }
    else if (busy || n) { cls = 'sync'; txt = n ? `전송 중 · ${n}` : '동기화 중'; }
    else { cls = 'ok'; txt = '동기화됨'; }
    pill.className = 'sync-pill s-' + cls;
    $('#syncText').textContent = txt;
    pill.title = lastSync ? `마지막 동기화 ${hhmm(lastSync)}` : '동기화 상태';
  }

  /* ---------- Kirim antrean ---------- */
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => { flushing = null; updateStatus(); });
    return flushing;
  }
  async function doFlush() {
    if (!getConfig().ok || !outbox.length) { updateStatus(); return; }
    updateStatus();
    while (outbox.length) {
      const o = outbox[0];
      try {
        if (o.op === 'upsert') {
          const r = cache[o.id];
          if (r) {
            await api(`${TABLE}?on_conflict=id`, {
              method: 'POST', body: [toRow(r)],
              prefer: 'resolution=merge-duplicates,return=minimal'
            });
          }
        } else if (o.op === 'delete') {
          await api(`${TABLE}?id=eq.${encodeURIComponent(o.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
        } else if (o.op === 'copied') {
          const ids = o.ids.map(encodeURIComponent).join(',');
          await api(`${TABLE}?id=in.(${ids})`, {
            method: 'PATCH', body: { copied_at: new Date(o.ts).toISOString() }, prefer: 'return=minimal'
          });
        }
        outbox.shift();
        saveOutbox();
        updateStatus();
      } catch (err) {
        const s = err.status || 0;
        // Data ditolak server (bukan masalah jaringan/izin): buang agar antrean tidak macet
        if (s >= 400 && s < 500 && ![401, 403, 404, 408, 429].includes(s)) {
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

  /* ---------- Tarik data dari server ---------- */
  let lastSync = 0;
  let pulling = false;
  async function pull({ manual = false } = {}) {
    if (!getConfig().ok) { setNet(false); return; }
    if (pulling) return;
    pulling = true;
    busy = true;
    updateStatus();
    const { from, to } = range();
    try {
      await flush();
      if (netState !== 'ok' && outbox.length) throw Object.assign(new Error('flush failed'), { status: 0, soft: true });
      const rows = await api(`${TABLE}?select=*&date=gte.${from}&date=lte.${to}&order=date.asc,created_at.asc&limit=5000`);

      const pendingUp = new Set(outbox.filter(o => o.op === 'upsert').map(o => o.id));
      const pendingDel = new Set(outbox.filter(o => o.op === 'delete').map(o => o.id));
      const serverIds = new Set(rows.map(r => r.id));

      // Hapus dari cache yang sudah dihapus perangkat lain
      allRecords().forEach(r => {
        if (r.date >= from && r.date <= to && !serverIds.has(r.id) && !pendingUp.has(r.id)) delete cache[r.id];
      });
      rows.forEach(x => {
        if (pendingDel.has(x.id) || pendingUp.has(x.id)) return;
        cache[x.id] = fromRow(x);
      });
      // Tanda copy yang belum terkirim tetap dipertahankan
      outbox.filter(o => o.op === 'copied').forEach(o => o.ids.forEach(id => { if (cache[id]) cache[id].copiedAt = o.ts; }));

      saveCache();
      lastSync = Date.now();
      setNet(true);
      refreshDatalists();
      render();
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

  function netMessage(err) {
    const s = err && err.status;
    if (s === 401 || s === 403) return 'API 키가 올바르지 않습니다';
    if (s === 404) return 'worklog 테이블이 없습니다 (setup.sql 실행 필요)';
    return '서버에 연결할 수 없습니다';
  }

  /* ---------- Pengaturan server ---------- */
  async function openSettings() {
    const c = getConfig();
    const wrap = document.createElement('div');
    wrap.className = 'cfg-form';
    wrap.innerHTML = `
      <div>Supabase 프로젝트 정보를 입력하세요.<br>모든 기기에 같은 값을 넣으면 하나의 작업일보로 합쳐집니다.</div>
      <label>Project URL
        <input id="cfgUrl" type="url" inputmode="url" placeholder="https://xxxx.supabase.co" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <label>Anon / Publishable key
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
      await api(`${TABLE}?select=id&limit=1`);
      setNet(true);
      toast('서버 연결 성공 ✓');
      await maybeMigrate();
      pull();
    } catch (err) {
      setNet(false, err);
      await alertModal('연결 실패', `${netMessage(err)}\n\nURL과 키를 다시 확인해 주세요.`, 'danger');
    }
  }

  /* ---------- Pindahkan data lokal versi lama ke server ---------- */
  async function maybeMigrate() {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const old = readJSON(OLD_KEY, []);
    if (!Array.isArray(old) || !old.length) { localStorage.setItem(MIGRATED_KEY, '1'); return; }
    const ok = await confirmModal('기존 데이터 업로드',
      `이 기기에만 저장된 기존 기록 ${old.length}건이 있습니다.\n공장 서버로 올려서 모든 기기와 공유할까요?`,
      { confirmText: '업로드', cancelText: '나중에', variant: 'info' });
    if (!ok) return;
    old.forEach(r => {
      if (!r || !r.id || !r.date) return;
      cache[r.id] = { ...r, createdAt: r.createdAt || Date.now() };
      outbox.push({ op: 'upsert', id: r.id });
    });
    saveCache();
    saveOutbox();
    localStorage.setItem(MIGRATED_KEY, '1');
    render();
    await flush();
    toast(`기존 기록 ${old.length}건 업로드`, 'info');
  }

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#syncPill').addEventListener('click', () => {
    if (!getConfig().ok) openSettings();
    else pull({ manual: true });
  });

  /* ==========================================================
     FORM
     ========================================================== */
  // Pakai namedItem: form.elements['item'] akan mengembalikan method item(), bukan input 품명
  const el = name => form.elements.namedItem(name);
  const getShift = () => (form.querySelector('input[name="shift"]:checked') || {}).value || '주간';
  const setShift = v => { const r = form.querySelector(`input[name="shift"][value="${v}"]`); if (r) r.checked = true; };

  function readForm() {
    return {
      date: fDate.value,
      shift: getShift(),
      worker: el('worker').value.trim(),
      machine: el('machine').value.trim(),
      item: el('item').value.trim(),
      client: el('client').value.trim(),
      process: el('process').value.trim(),
      good: toInt(el('good').value),
      bad: toInt(el('bad').value),
      start: el('start').value,
      end: el('end').value,
      remark: el('remark').value.trim()
    };
  }

  function minutesBetween(s, e) {
    if (!s || !e) return null;
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    let m = (eh * 60 + em) - (sh * 60 + sm);
    if (m < 0) m += 1440; // lewat tengah malam (야간)
    return m;
  }
  function fmtDur(m) {
    if (m == null) return '—';
    const h = Math.floor(m / 60), mm = m % 60;
    return h ? `${h}시간 ${mm}분` : `${mm}분`;
  }
  function updateDuration() {
    $('#durationVal').textContent = fmtDur(minutesBetween(el('start').value, el('end').value));
  }

  // Draft otomatis (per perangkat)
  function saveDraft() {
    const d = readForm();
    d.savedOn = todayStr();
    writeJSON(DRAFT, d);
  }
  function restoreDraft() {
    const d = readJSON(DRAFT, null);
    const now = new Date();
    fDate.value = todayStr();
    setShift(now.getHours() >= 7 && now.getHours() < 19 ? '주간' : '야간');
    if (!d) return;
    TEXT_FIELDS.forEach(k => { if (typeof d[k] === 'string') el(k).value = d[k]; });
    el('good').value = d.good ?? 0;
    el('bad').value = d.bad ?? 0;
    if (d.start) el('start').value = d.start;
    if (d.end) el('end').value = d.end;
    if (d.savedOn === todayStr()) {
      if (d.date) fDate.value = d.date;
      if (d.shift) setShift(d.shift);
    }
  }

  form.addEventListener('input', e => {
    if (e.target.classList.contains('invalid')) e.target.classList.remove('invalid');
    if (e.target.name === 'start' || e.target.name === 'end') updateDuration();
    saveDraft();
  });
  form.addEventListener('change', e => {
    if (e.target === fDate && fDate.value) {
      fFrom.value = fTo.value = fDate.value;
      render();
      pull();
    }
    saveDraft();
  });

  // Stepper +/−
  form.addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (!b) return;
    const input = el(b.dataset.target);
    input.value = Math.max(0, toInt(input.value) + Number(b.dataset.step));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ['good', 'bad'].forEach(n => {
    el(n).addEventListener('focus', e => { if (e.target.value === '0') e.target.select(); });
    el(n).addEventListener('blur', e => { e.target.value = toInt(e.target.value); });
  });

  // Enter → field berikutnya (aman untuk IME Korea)
  form.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.type === 'radio') return;
    e.preventDefault();
    const order = $$('[data-nav]', form);
    const i = order.indexOf(t);
    if (i > -1 && i < order.length - 1) order[i + 1].focus();
    else el('remark').focus();
  });

  // Submit
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const d = readForm();
    $$('.invalid', form).forEach(x => x.classList.remove('invalid'));

    const missing = REQUIRED.filter(k => !d[k]);
    if (missing.length) {
      missing.forEach(k => (k === 'date' ? fDate : el(k)).classList.add('invalid'));
      if (document.activeElement) document.activeElement.blur();
      await alertModal('입력 확인', `다음 항목을 입력해 주세요.\n\n• ${missing.map(k => LABELS[k]).join('\n• ')}`, 'warn');
      (missing[0] === 'date' ? fDate : el(missing[0])).focus();
      return;
    }
    if (d.start === d.end) {
      const go = await confirmModal('시간 확인', '시작 시간과 종료 시간이 같습니다.\n그래도 저장할까요?', { confirmText: '저장' });
      if (!go) return;
    }

    const rec = { id: uid(), ...d, createdAt: Date.now(), copiedAt: null };
    addRecord(rec);
    refreshDatalists();

    // Reset sebagian: 작업자·설비명 dipertahankan, 시작 = 종료 sebelumnya
    ['item', 'client', 'process', 'remark'].forEach(k => (el(k).value = ''));
    el('good').value = 0;
    el('bad').value = 0;
    el('start').value = d.end;
    el('end').value = '';
    updateDuration();
    saveDraft();
    if (document.activeElement) document.activeElement.blur();

    if (!fFrom.value || d.date < fFrom.value) fFrom.value = d.date;
    if (!fTo.value || d.date > fTo.value) fTo.value = d.date;
    flashId = rec.id;
    render();
    toast(getConfig().ok ? '저장되었습니다 ✓' : '이 기기에 저장됨 (서버 미연결)', getConfig().ok ? 'ok' : 'info');
  });

  // Reset form
  $('#resetBtn').addEventListener('click', async () => {
    const ok = await confirmModal('입력 초기화', '작성 중인 내용을 모두 지울까요?\n(날짜와 근무 구분은 유지됩니다)', { confirmText: '초기화', variant: 'danger' });
    if (!ok) return;
    TEXT_FIELDS.forEach(k => (el(k).value = ''));
    el('good').value = 0;
    el('bad').value = 0;
    el('start').value = '';
    el('end').value = '';
    $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
    updateDuration();
    saveDraft();
    toast('초기화되었습니다', 'info');
  });

  // Datalist (autocomplete dari riwayat bersama)
  function refreshDatalists() {
    const list = allRecords().sort((a, b) => b.createdAt - a.createdAt);
    ['worker', 'machine', 'item', 'client', 'process'].forEach(k => {
      const seen = new Set();
      for (const r of list) {
        if (r[k]) seen.add(r[k]);
        if (seen.size >= 40) break;
      }
      $('#dl_' + k).innerHTML = [...seen].map(v => `<option value="${esc(v)}"></option>`).join('');
    });
  }

  /* ==========================================================
     HISTORY
     ========================================================== */
  const shiftOrder = s => (s === '주간' ? 0 : 1);
  const filterShift = () => ($('input[name="fshift"]:checked') || {}).value || 'all';

  function range() {
    let from = fFrom.value || '1900-01-01';
    let to = fTo.value || '2999-12-31';
    if (from > to) [from, to] = [to, from];
    return { from, to };
  }

  function getFiltered() {
    const { from, to } = range();
    const sh = filterShift();
    return allRecords()
      .filter(r => r.date >= from && r.date <= to && (sh === 'all' || r.shift === sh))
      .sort((a, b) =>
        a.date.localeCompare(b.date) ||
        shiftOrder(a.shift) - shiftOrder(b.shift) ||
        (a.start || '').localeCompare(b.start || '') ||
        a.createdAt - b.createdAt);
  }

  const shiftBadge = s => `<span class="badge ${s === '주간' ? 'b-day' : 'b-night'}">${s === '주간' ? '☀' : '☾'} ${esc(s)}</span>`;
  const orDash = v => (v ? esc(v) : '<span class="dim">-</span>');

  let lastSig = '';
  function render() {
    const list = getFiltered();
    const pendingIds = new Set(outbox.filter(o => o.op === 'upsert').map(o => o.id));

    // Jangan gambar ulang jika tidak ada perubahan (polling tiap 10 detik)
    const sig = JSON.stringify([list, flashId, [...pendingIds]]);
    if (sig === lastSig) return;
    lastSig = sig;

    const good = list.reduce((s, r) => s + (r.good || 0), 0);
    const bad = list.reduce((s, r) => s + (r.bad || 0), 0);
    const rate = good + bad ? ((bad / (good + bad)) * 100).toFixed(1) : '0.0';
    stats.innerHTML = `
      <span class="stat">기록 <b>${list.length}</b>건</span>
      <span class="stat s-good">양품 <b>${fmtN(good)}</b></span>
      <span class="stat s-bad">불량 <b>${fmtN(bad)}</b></span>
      <span class="stat">불량률 <b>${rate}%</b></span>`;

    const empty = list.length === 0;
    emptyState.hidden = !empty;
    tableWrap.style.visibility = empty ? 'hidden' : '';
    tableWrap.style.height = empty ? '0' : '';
    tableWrap.style.borderWidth = empty ? '0' : '';

    const pendingMark = id => (pendingIds.has(id) ? ' <span class="pending" title="서버 전송 대기">⏳</span>' : '');

    // Tabel (desktop)
    tbody.innerHTML = list.map((r, i) => `
      <tr data-id="${r.id}" class="${r.copiedAt ? 'copied' : ''}${r.id === flashId ? ' flash' : ''}">
        <td class="idx">${i + 1}${pendingMark(r.id)}</td>
        <td class="nowrap">${esc(r.date)}</td>
        <td>${shiftBadge(r.shift)}</td>
        <td>${orDash(r.worker)}</td>
        <td>${orDash(r.machine)}</td>
        <td>${orDash(r.item)}</td>
        <td>${orDash(r.client)}</td>
        <td>${orDash(r.process)}</td>
        <td class="num">${fmtN(r.good)}</td>
        <td class="num bad-num">${fmtN(r.bad)}</td>
        <td class="nowrap">${orDash(r.start)}</td>
        <td class="nowrap">${orDash(r.end)}</td>
        <td class="remark">${orDash(r.remark)}</td>
        <td class="actions">
          <div class="act">
            <button type="button" class="btn btn-xs btn-sky" data-action="copy" data-id="${r.id}">📋 Copy</button>
            <button type="button" class="btn btn-xs btn-danger" data-action="delete" data-id="${r.id}">🗑 Delete</button>
          </div>
          ${r.copiedAt ? `<small class="copied-at">✓ 복사됨 ${hhmm(r.copiedAt)}</small>` : ''}
        </td>
      </tr>`).join('');

    // Kartu (mobile)
    mobileList.innerHTML = list.map(r => `
      <article class="rec-card${r.copiedAt ? ' copied' : ''}${r.id === flashId ? ' flash' : ''}" data-id="${r.id}">
        <div class="rec-top">
          <div>${shiftBadge(r.shift)} <b>${esc(r.date)}</b>${pendingMark(r.id)}</div>
          <span class="rec-time">${esc(r.start || '--:--')} – ${esc(r.end || '--:--')}</span>
        </div>
        <h4>${esc(r.item)}${r.client ? ` <small>· ${esc(r.client)}</small>` : ''}</h4>
        <dl class="rec-grid">
          <div><dt>작업자</dt><dd>${orDash(r.worker)}</dd></div>
          <div><dt>설비명</dt><dd>${orDash(r.machine)}</dd></div>
          <div class="full"><dt>생산 현황</dt><dd>${orDash(r.process)}</dd></div>
          <div><dt>양품</dt><dd>${fmtN(r.good)}</dd></div>
          <div><dt>불량</dt><dd class="bad-num">${fmtN(r.bad)}</dd></div>
        </dl>
        ${r.remark ? `<p class="rec-remark">${esc(r.remark)}</p>` : ''}
        <div class="rec-actions">
          <button type="button" class="btn btn-sm btn-sky" data-action="copy" data-id="${r.id}">📋 Copy</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete" data-id="${r.id}">🗑 Delete</button>
        </div>
      </article>`).join('');

    if (flashId) {
      const id = flashId;
      setTimeout(() => { if (flashId === id) flashId = null; }, 1400);
    }
  }

  /* ---------- Clipboard ---------- */
  const clean = v => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n+/g, ' / ').trim();
  const rowToTSV = r => COPY_ORDER.map(k => clean(r[k])).join('\t');

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
    wrap.append('클립보드에 접근할 수 없습니다.\n아래 내용을 길게 눌러 직접 복사해 주세요.');
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    wrap.appendChild(ta);
    setTimeout(() => ta.select(), 120);
    await alertModal('복사 실패', wrap, 'warn');
  }

  async function copyRecord(id) {
    const r = cache[id];
    if (!r) return;
    const text = rowToTSV(r);
    if (await copyText(text)) {
      markCopied([id], Date.now());
      flashId = id;
      render();
      toast('Tersalin! 📋');
    } else {
      await copyFailed(text);
    }
  }

  async function deleteRecord(id) {
    const r = cache[id];
    if (!r) return;
    const msg = document.createElement('div');
    msg.append('이 기록을 삭제할까요? 모든 기기에서 삭제되며 되돌릴 수 없습니다.');
    const sum = document.createElement('div');
    sum.className = 'modal-summary';
    sum.innerHTML = `<b>${esc(r.date)} · ${esc(r.shift)}</b><br>${esc(r.worker)} / ${esc(r.machine)}<br>${esc(r.item)} — 양품 ${fmtN(r.good)}, 불량 ${fmtN(r.bad)}`;
    msg.appendChild(sum);

    const ok = await openModal({ title: '기록 삭제', message: msg, variant: 'danger', confirmText: '삭제', cancelText: '취소' });
    if (!ok) return;

    $$(`[data-id="${id}"]`).forEach(n => { if (n.matches('tr, .rec-card')) n.classList.add('removing'); });
    setTimeout(() => {
      removeRecord(id);
      refreshDatalists();
      render();
      toast('삭제되었습니다', 'info');
    }, 260);
  }

  $('#history').addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'copy') copyRecord(b.dataset.id);
    else if (b.dataset.action === 'delete') deleteRecord(b.dataset.id);
  });

  // Salin semua baris yang tampil
  $('#copyAllBtn').addEventListener('click', async () => {
    const list = getFiltered();
    if (!list.length) { toast('복사할 기록이 없습니다', 'info'); return; }
    const text = list.map(rowToTSV).join('\n');
    if (await copyText(text)) {
      markCopied(list.map(r => r.id), Date.now());
      render();
      toast(`Tersalin! (${list.length}건) 📋`);
    } else {
      await copyFailed(text);
    }
  });

  // Filter
  const onFilter = () => { render(); pull(); };
  fFrom.addEventListener('change', onFilter);
  fTo.addEventListener('change', onFilter);
  $$('input[name="fshift"]').forEach(r => r.addEventListener('change', render));
  $('#todayBtn').addEventListener('click', () => {
    fFrom.value = fTo.value = todayStr();
    onFilter();
  });

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
  form.addEventListener('focusin', e => {
    const t = e.target;
    if (innerWidth >= 900 || !t.matches('input:not([type="radio"]), textarea')) return;
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
  });

  /* ==========================================================
     PWA: install + service worker
     ========================================================== */
  let deferredPrompt = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* ==========================================================
     SINKRON OTOMATIS
     ========================================================== */
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  window.addEventListener('online', () => pull());
  window.addEventListener('offline', () => setNet(false, { status: 0 }));

  /* ==========================================================
     INIT
     ========================================================== */
  restoreDraft();
  updateDuration();
  fFrom.value = fTo.value = fDate.value || todayStr();
  refreshDatalists();
  (async () => {
    if (getConfig().ok) {
      netState = 'ok';
      busy = true;
      render();
      updateStatus();
      await maybeMigrate();
      await pull();
    } else {
      // Mode lokal: data lama versi 1 tetap ditampilkan
      const old = readJSON(OLD_KEY, []);
      if (Array.isArray(old)) old.forEach(r => { if (r && r.id && r.date && !cache[r.id]) cache[r.id] = r; });
      netState = 'local';
      render();
      updateStatus();
      if (!prefs.cfgPrompted) {
        prefs.cfgPrompted = true;
        writeJSON(PREF, prefs);
        openSettings();
      }
    }
  })();
})();
