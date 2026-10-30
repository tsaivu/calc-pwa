(() => {
  'use strict';

  /* ==========================================================
   * 1. Bộ tính toán (không dùng eval)
   * Hỗ trợ + − × ÷ %, dấu thập phân là dấu phẩy (,) hoặc chấm (.)
   * ========================================================== */

  function normalize(src) {
    return src
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')
      .replace(/,/g, '.')
      .replace(/\s+/g, '');
  }

  // Trả về số, hoặc null nếu biểu thức không hợp lệ / chia cho 0.
  function evaluate(src) {
    let s = normalize(src);
    while (s && /[+\-*/.]$/.test(s)) s = s.slice(0, -1); // bỏ toán tử cuối còn dở
    if (!s) return null;

    let i = 0;
    const peek = () => s[i];

    function parseExpr() {
      let v = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = s[i++];
        const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }

    function parseTerm() {
      let v = parseUnary();
      while (peek() === '*' || peek() === '/') {
        const op = s[i++];
        const r = parseUnary();
        if (op === '/') {
          if (r === 0) throw new Error('chia cho 0');
          v = v / r;
        } else {
          v = v * r;
        }
      }
      return v;
    }

    function parseUnary() {
      if (peek() === '-') { i++; return -parseUnary(); }
      if (peek() === '+') { i++; return parseUnary(); }
      return parseFactor();
    }

    function parseFactor() {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (!m) throw new Error('cú pháp');
      i += m[0].length;
      let v = parseFloat(m[0]);
      while (peek() === '%') { i++; v = v / 100; }
      return v;
    }

    try {
      const v = parseExpr();
      if (i !== s.length) return null;
      return Number.isFinite(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  const fmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 10 });
  const formatValue = (v) => fmt.format(v);
  // Số thô dạng dấu phẩy để đưa ngược vào biểu thức khi tiếp tục tính.
  const rawForInput = (v) => String(v).replace('.', ',');

  /* ==========================================================
   * 2. Lưu trữ lịch sử (IndexedDB, chỉ trên thiết bị này)
   * ========================================================== */

  const DB_NAME = 'calc-history';
  const STORE = 'records';
  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('no idb'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function run(mode, make) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = make(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  const dbAdd = (rec) => run('readwrite', (s) => s.put(rec));
  const dbDelete = (id) => run('readwrite', (s) => s.delete(id));
  const dbClear = () => run('readwrite', (s) => s.clear());
  const dbGetAll = () => run('readonly', (s) => s.getAll());

  /* ==========================================================
   * 3. Trạng thái và thao tác bàn phím
   * ========================================================== */

  const OPERATORS = ['+', '−', '×', '÷'];
  const state = {
    expr: '',          // biểu thức đang gõ, dùng ký hiệu hiển thị (× ÷ −)
    value: null,       // kết quả số sau khi bấm =
    justEvaluated: false,
    error: false,
  };

  const els = {
    main: document.getElementById('main'),
    sub: document.getElementById('sub'),
    keys: document.getElementById('keys'),
    history: document.getElementById('history'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    clearAll: document.getElementById('clearAll'),
    closeHist: document.getElementById('closeHist'),
    toast: document.getElementById('toast'),
    noteSheet: document.getElementById('noteSheet'),
    noteInput: document.getElementById('noteInput'),
    notePreview: document.getElementById('notePreview'),
    noteOk: document.getElementById('noteOk'),
    noteCancel: document.getElementById('noteCancel'),
  };

  const isOp = (ch) => OPERATORS.includes(ch);
  const lastChar = () => state.expr.slice(-1);

  // Đoạn số đang gõ ở cuối biểu thức.
  function currentSegment() {
    const m = /[\d,]*$/.exec(state.expr);
    return m ? m[0] : '';
  }

  function inputDigit(d) {
    if (state.justEvaluated) {
      state.expr = '';
      state.justEvaluated = false;
      state.value = null;
      state.error = false;
    }
    if (state.expr === '0') state.expr = d;
    else state.expr += d;
    clearStale();
  }

  function inputComma() {
    if (state.justEvaluated) { state.expr = ''; state.justEvaluated = false; state.value = null; state.error = false; }
    if (currentSegment().includes(',')) return;
    if (state.expr === '' || isOp(lastChar())) state.expr += '0';
    state.expr += ',';
    clearStale();
  }

  function inputOperator(op) {
    if (state.error) state.error = false;
    if (state.justEvaluated) {
      if (state.value !== null) {
        state.expr = rawForInput(state.value);
      }
      state.justEvaluated = false;
      state.value = null;
    }
    if (state.expr === '') {
      // Cho phép số âm ở đầu biểu thức.
      if (op === '−') state.expr = '−';
      return;
    }
    if (isOp(lastChar())) {
      // Cho phép '−' ngay sau một toán tử khác để viết số âm, ví dụ 5×−3.
      if (op === '−' && lastChar() !== '−') {
        state.expr += op;
      } else if (lastChar() === '−' && op === '−') {
        // bỏ qua
      } else {
        state.expr = state.expr.slice(0, -1) + op;
      }
    } else {
      state.expr += op;
    }
    clearStale();
  }

  function inputPercent() {
    if (state.justEvaluated) {
      state.expr = state.value !== null ? rawForInput(state.value) : '';
      state.justEvaluated = false;
      state.value = null;
    }
    if (/[\d]$/.test(state.expr)) state.expr += '%';
    clearStale();
  }

  function toggleSign() {
    if (state.justEvaluated) {
      state.expr = state.value !== null ? rawForInput(state.value) : '';
      state.justEvaluated = false;
      state.value = null;
    }
    if (state.expr === '') { state.expr = '−'; return render(); }
    if (isOp(lastChar())) return render();

    const seg = /[\d,]+%*$/.exec(state.expr);
    if (!seg) return render();
    const pos = state.expr.length - seg[0].length;
    const before = state.expr.slice(0, pos);
    if (before.endsWith('−') && (before.length === 1 || isOp(before.slice(-2, -1)))) {
      state.expr = before.slice(0, -1) + seg[0];
    } else {
      state.expr = before + '−' + seg[0];
    }
    clearStale();
  }

  function backspace() {
    if (state.justEvaluated) {
      state.justEvaluated = false;
      state.value = null;
      state.error = false;
      state.expr = '';
      return render();
    }
    state.expr = state.expr.slice(0, -1);
    clearStale();
  }

  function clearAllState() {
    state.expr = '';
    state.value = null;
    state.justEvaluated = false;
    state.error = false;
    render();
  }

  // Khi người dùng sửa biểu thức sau kết quả, bỏ trạng thái kết quả cũ.
  function clearStale() {
    state.justEvaluated = false;
    state.value = null;
    state.error = false;
    render();
  }

  function equals() {
    if (state.expr === '') return false;
    const v = evaluate(state.expr);
    state.justEvaluated = true;
    if (v === null) {
      state.value = null;
      state.error = true;
      render();
      return false;
    }
    state.value = v;
    state.error = false;
    render();
    return true;
  }

  // Bấm save: mở ô ghi chú trước, rồi mới lưu.
  function saveCurrent() {
    // Nếu chưa có kết quả thì tính trước.
    if (!state.justEvaluated || state.error || state.value === null) {
      if (!equals()) return toast('Biểu thức chưa hợp lệ');
    }
    els.notePreview.textContent = `${state.expr} = ${formatValue(state.value)}`;
    els.noteInput.value = '';
    els.noteSheet.hidden = false;
    setTimeout(() => els.noteInput.focus(), 50);
  }

  function closeNoteSheet() {
    els.noteSheet.hidden = true;
    els.noteInput.blur();
  }

  // Ghi chú để trống thì không lưu trường note.
  async function confirmSave() {
    const note = els.noteInput.value.trim();
    const rec = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expr: state.expr,
      result: formatValue(state.value),
      value: state.value,
      createdAt: Date.now(),
      ...(note ? { note } : {}),
    };
    closeNoteSheet();
    try {
      await dbAdd(rec);
      toast('Đã lưu vào lịch sử');
    } catch (err) {
      console.error(err);
      toast('Không thể lưu trên thiết bị này');
    }
  }

  /* ==========================================================
   * 4. Hiển thị
   * ========================================================== */

  function render() {
    let main;
    let sub = '';
    if (state.error) {
      main = 'Lỗi';
      sub = state.expr;
    } else if (state.justEvaluated && state.value !== null) {
      main = formatValue(state.value);
      sub = state.expr + ' =';
    } else {
      main = state.expr === '' ? '0' : state.expr;
      if (state.expr !== '') {
        const v = evaluate(state.expr);
        if (v !== null) sub = '= ' + formatValue(v);
      }
    }
    els.main.textContent = main;
    els.main.classList.toggle('error', state.error);
    els.main.classList.toggle('long', !state.error && main.length > 9);
    els.main.classList.toggle('xlong', !state.error && main.length > 14);
    els.sub.textContent = sub;
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  /* ==========================================================
   * 5. Bàn phím (giao diện theo mockup)
   * ========================================================== */

  const ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H6"/><path d="M11 6l-6 6 6 6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/></svg>',
  };

  // Mỗi phím: [nhãn hoặc icon, hành động, kiểu, tùy chọn]
  const ROWS = [
    [
      ['AC', 'clear', 'fn'],
      ['+/-', 'sign', 'fn'],
      ['%', 'percent', 'fn'],
      [ICON.back, 'back', 'fn', { icon: true }],
      [ICON.save, 'save', 'fn', { icon: true }],
    ],
    [
      ['7', 'd7', 'num'], ['8', 'd8', 'num'], ['9', 'd9', 'num'],
      ['÷', 'op÷', 'op'],
      [ICON.trash, 'trash', 'fn', { icon: true }],
    ],
    [
      ['4', 'd4', 'num'], ['5', 'd5', 'num'], ['6', 'd6', 'num'],
      ['×', 'op×', 'op'],
      [ICON.list, 'history', 'fn', { icon: true }],
    ],
    [
      ['1', 'd1', 'num'], ['2', 'd2', 'num'], ['3', 'd3', 'num'],
      ['−', 'op−', 'op'],
      ['=', 'equals', 'op', { equals: true }],
    ],
    [
      ['0', 'd0', 'num', { zero: true }],
      [',', 'comma', 'num'],
      ['+', 'op+', 'op'],
    ],
  ];

  function buildKeys() {
    const frag = document.createDocumentFragment();
    for (const row of ROWS) {
      for (const [label, action, kind, opt = {}] of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `key ${kind}` +
          (opt.zero ? ' zero' : '') + (opt.equals ? ' equals' : '');
        btn.dataset.action = action;
        if (opt.icon) {
          btn.innerHTML = label;
          btn.setAttribute('aria-label', action);
        } else {
          btn.textContent = label;
        }
        frag.appendChild(btn);
      }
    }
    els.keys.appendChild(frag);
  }

  const ACTIONS = {
    clear: () => clearAllState(),
    trash: () => clearAllState(),
    sign: () => toggleSign(),
    percent: () => inputPercent(),
    back: () => backspace(),
    save: () => saveCurrent(),
    history: () => openHistory(),
    comma: () => inputComma(),
    equals: () => equals(),
    'op÷': () => inputOperator('÷'),
    'op×': () => inputOperator('×'),
    'op−': () => inputOperator('−'),
    'op+': () => inputOperator('+'),
  };
  for (let d = 0; d <= 9; d++) ACTIONS[`d${d}`] = () => inputDigit(String(d));

  els.keys.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const fn = ACTIONS[btn.dataset.action];
    if (fn) fn();
  });

  // Bàn phím vật lý (máy tính bảng, laptop)
  document.addEventListener('keydown', (e) => {
    if (!els.noteSheet.hidden) {
      if (e.key === 'Escape') closeNoteSheet();
      return;
    }
    if (!els.history.hidden) {
      if (e.key === 'Escape') closeHistory();
      return;
    }
    if (/^[0-9]$/.test(e.key)) return inputDigit(e.key);
    if (e.key === ',' || e.key === '.') return inputComma();
    if (e.key === '+') return inputOperator('+');
    if (e.key === '-') return inputOperator('−');
    if (e.key === '*') return inputOperator('×');
    if (e.key === '/') return inputOperator('÷');
    if (e.key === '%') return inputPercent();
    if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); return equals(); }
    if (e.key === 'Backspace') return backspace();
    if (e.key === 'Escape') return clearAllState();
  });

  /* ==========================================================
   * 6. Màn hình lịch sử
   * ========================================================== */

  const dateFmt = new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  async function openHistory() {
    els.history.hidden = false;
    await renderHistory();
  }

  function closeHistory() {
    els.history.hidden = true;
  }

  async function renderHistory() {
    let records = [];
    try {
      records = await dbGetAll();
    } catch (err) {
      console.error(err);
      toast('Không đọc được lịch sử');
    }
    records.sort((a, b) => b.createdAt - a.createdAt);

    els.list.replaceChildren();
    els.empty.hidden = records.length > 0;
    els.clearAll.disabled = records.length === 0;

    for (const rec of records) {
      const li = document.createElement('li');
      li.className = 'item';

      const body = document.createElement('button');
      body.type = 'button';
      body.className = 'item-body';
      body.title = 'Mở lại phép tính này';

      const ex = document.createElement('div');
      ex.className = 'item-expr';
      ex.textContent = `${rec.expr} =`;

      const res = document.createElement('div');
      res.className = 'item-result';
      res.textContent = rec.result;

      const dt = document.createElement('div');
      dt.className = 'item-date';
      dt.textContent = dateFmt.format(new Date(rec.createdAt));

      body.append(ex, res);
      if (rec.note) {
        const nt = document.createElement('div');
        nt.className = 'item-note';
        nt.textContent = rec.note;
        body.append(nt);
      }
      body.append(dt);
      body.addEventListener('click', () => {
        state.expr = rec.expr;
        state.value = null;
        state.justEvaluated = false;
        state.error = false;
        closeHistory();
        render();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'item-del';
      del.setAttribute('aria-label', 'Xóa mục này');
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        try {
          await dbDelete(rec.id);
          li.remove();
          if (!els.list.children.length) {
            els.empty.hidden = false;
            els.clearAll.disabled = true;
          }
        } catch (err) {
          console.error(err);
          toast('Không xóa được');
        }
      });

      li.append(body, del);
      els.list.appendChild(li);
    }
  }

  els.clearAll.addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ lịch sử trên thiết bị này?')) return;
    try {
      await dbClear();
      toast('Đã xóa lịch sử');
      await renderHistory();
    } catch (err) {
      console.error(err);
      toast('Không xóa được');
    }
  });

  els.noteOk.addEventListener('click', confirmSave);
  els.noteCancel.addEventListener('click', closeNoteSheet);
  els.noteSheet.addEventListener('click', (e) => {
    if (e.target === els.noteSheet) closeNoteSheet();
  });
  els.noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmSave(); }
  });

  els.closeHist.addEventListener('click', closeHistory);
  els.history.addEventListener('click', (e) => {
    if (e.target === els.history) closeHistory();
  });

  /* ==========================================================
   * 7. Khởi động
   * ========================================================== */

  buildKeys();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.error('SW lỗi', err);
      });
    });
  }

  // Cho phép kiểm thử từ console / test tự động.
  window.__calc = { evaluate, state };
})();
