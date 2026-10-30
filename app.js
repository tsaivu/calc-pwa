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
    while (s && /[+\-*/.(]$/.test(s)) s = s.slice(0, -1); // bỏ toán tử / dấu chấm / '(' còn dở
    if (!s) return null;
    const unclosed = (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
    if (unclosed > 0) s += ')'.repeat(unclosed); // tự đóng ngoặc còn mở

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
      let v;
      if (peek() === '(') {
        i++;
        v = parseExpr();
        if (peek() !== ')') throw new Error('thiếu )');
        i++;
      } else {
        const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
        if (!m) throw new Error('cú pháp');
        i += m[0].length;
        v = parseFloat(m[0]);
      }
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

  // Mặc định: 15 chữ số có nghĩa, bỏ nhiễu số thực kiểu 4000000001.
  // Nếu người dùng chọn số chữ số thập phân cố định thì dùng bộ định dạng dưới.
  const fmt = new Intl.NumberFormat('vi-VN', { maximumSignificantDigits: 15 });
  const fixedFmt = [0, 1, 2, 3, 4, 5, 6].map((d) => new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }));
  const formatValue = (v) => (state.decimals === 'auto' ? fmt.format(v) : fixedFmt[Number(state.decimals)].format(v));
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

  // Ghi nhiều bản ghi trong một giao dịch (dùng khi nhập file JSON).
  function dbPutMany(list) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const r of list) st.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  /* ==========================================================
   * 3. Trạng thái và thao tác bàn phím
   * ========================================================== */

  const OPERATORS = ['+', '−', '×', '÷'];
  const DEC_KEY = 'calc-decimals';
  const DEC_OPTIONS = ['auto', '0', '1', '2', '3', '4', '5', '6'];

  // Nhớ lựa chọn số thập phân trên thiết bị này (nếu được phép lưu).
  function loadDecimals() {
    try {
      const v = localStorage.getItem(DEC_KEY);
      return DEC_OPTIONS.includes(v) ? v : 'auto';
    } catch (_) {
      return 'auto';
    }
  }
  function saveDecimals(v) {
    try { localStorage.setItem(DEC_KEY, v); } catch (_) { /* không lưu được thì thôi */ }
  }

  const state = {
    expr: '',          // biểu thức đang gõ, dùng ký hiệu hiển thị (× ÷ −)
    caret: 0,          // vị trí con trỏ trong expr (chỉ có tác dụng khi bật chế độ sửa)
    editMode: false,   // chế độ sửa: mặc định tắt
    decimals: loadDecimals(), // 'auto' hoặc '0'..'6'
    value: null,       // kết quả số sau khi bấm =
    justEvaluated: false,
    error: false,
  };

  // Đang lưu cả bảng (không phải một phép tính) vào lịch sử?
  let pendingTable = false;

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
    search: document.getElementById('search'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    importFile: document.getElementById('importFile'),
    noMatch: document.getElementById('noMatch'),
    editToggle: document.getElementById('editToggle'),
    caretLeft: document.getElementById('caretLeft'),
    caretRight: document.getElementById('caretRight'),
    decimals: document.getElementById('decimals'),
    calc: document.getElementById('calc'),
    card: document.getElementById('card'),
    cardTitle: document.getElementById('cardTitle'),
    cardRows: document.getElementById('cardRows'),
    cardBack: document.getElementById('cardBack'),
    openTable: document.getElementById('openTable'),
    tableScreen: document.getElementById('tableScreen'),
    grid: document.getElementById('grid'),
    totalVal: document.getElementById('totalVal'),
    toCalc: document.getElementById('toCalc'),
    tableHistory: document.getElementById('tableHistory'),
    tableSave: document.getElementById('tableSave'),
  };

  const isOp = (ch) => OPERATORS.includes(ch);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // Vị trí con trỏ hiệu lực: luôn ở cuối nếu không bật chế độ sửa.
  function caretPos() {
    return state.editMode ? clamp(state.caret, 0, state.expr.length) : state.expr.length;
  }

  // Tách biểu thức quanh con trỏ: [phần trước, phần sau].
  function parts() {
    const c = caretPos();
    return [state.expr.slice(0, c), state.expr.slice(c)];
  }

  // Ghi lại biểu thức và đặt con trỏ ngay sau phần vừa ghi.
  function setExpr(before, after = '') {
    state.expr = before + after;
    state.caret = before.length;
  }

  // Bỏ kết quả đang hiển thị và xóa biểu thức để bắt đầu lại.
  function clearResult() {
    state.expr = '';
    state.caret = 0;
    state.value = null;
    state.justEvaluated = false;
    state.error = false;
  }

  // Thoát trạng thái "vừa bấm =" nhưng giữ nguyên biểu thức (dùng khi sửa).
  function leaveResult() {
    state.justEvaluated = false;
    state.value = null;
    state.error = false;
  }

  function inputDigit(d) {
    if (state.justEvaluated) clearResult();
    let [b, a] = parts();
    if (b.endsWith(')')) b += '×';                             // (1+2)3 hiểu là (1+2)×3
    else if (/(^|[+\-−×÷(])0$/.test(b)) b = b.slice(0, -1);   // số 0 đứng đầu bị thay bằng chữ số mới
    setExpr(b + d, a);
    clearStale();
  }

  function inputComma() {
    if (state.justEvaluated) clearResult();
    let [b, a] = parts();
    const seg = /[\d,]*$/.exec(b)[0];
    if (seg.includes(',') || /^\d*,/.test(a)) return render(); // đã có dấu phẩy trong số này
    if (b.endsWith(')')) return render();
    if (b === '' || /[+\-−×÷(]$/.test(b)) b += '0';
    setExpr(b + ',', a);
    clearStale();
  }

  function inputParen(p) {
    if (state.justEvaluated) clearResult();
    let [b, a] = parts();
    if (p === '(') {
      if (/[\d)%]$/.test(b)) b += '×';                          // 2( hiểu là 2×(
      setExpr(b + '(', a);
    } else {
      const opens = (state.expr.match(/\(/g) || []).length;
      const closes = (state.expr.match(/\)/g) || []).length;
      if (opens > closes && /[\d)%]$/.test(b)) setExpr(b + ')', a);
    }
    clearStale();
  }

  function inputOperator(op) {
    state.error = false;
    if (state.justEvaluated) {
      if (state.value !== null) setExpr(rawForInput(state.value));
      leaveResult();
    }
    let [b, a] = parts();
    if (b.endsWith('(')) {
      if (op === '−') setExpr(b + op, a);                      // số âm đầu ngoặc
      return clearStale();
    }
    if (b === '') {
      if (op === '−') setExpr('−', a);                         // cho phép số âm ở đầu biểu thức
      return clearStale();
    }
    if (/[+−×÷]$/.test(b)) {
      if (op === '−' && !b.endsWith('−')) {
        b += op;                                               // 5×−3: '−' sau toán tử để viết số âm
      } else if (!(op === '−' && b.endsWith('−'))) {
        b = b.slice(0, -1) + op;                               // thay toán tử cũ bằng toán tử mới
      }
    } else {
      b += op;
    }
    setExpr(b, a);
    clearStale();
  }

  function inputPercent() {
    if (state.justEvaluated) {
      setExpr(state.value !== null ? rawForInput(state.value) : '');
      leaveResult();
    }
    const [b, a] = parts();
    if (/\d$/.test(b)) setExpr(b + '%', a);
    clearStale();
  }

  function toggleSign() {
    if (state.justEvaluated) {
      setExpr(state.value !== null ? rawForInput(state.value) : '');
      leaveResult();
    }
    const [b, a] = parts();
    if (b === '') { setExpr('−', a); return render(); }
    if (/[+−×÷]$/.test(b)) return render();

    const seg = /[\d,]+%*$/.exec(b);
    if (!seg) return render();
    const pre = b.slice(0, b.length - seg[0].length);
    const head = pre.slice(0, -1);
    let nb;
    if (pre.endsWith('−') && (head === '' || /[+−×÷(]$/.test(head))) nb = head + seg[0];
    else nb = pre + '−' + seg[0];
    setExpr(nb, a);
    clearStale();
  }

  function backspace() {
    if (state.justEvaluated) {
      clearResult();
      return render();
    }
    const [b, a] = parts();
    if (!b) return render();
    setExpr(b.slice(0, -1), a);
    clearStale();
  }

  // Phím Delete: xóa ký tự ngay sau con trỏ (chỉ ở chế độ sửa).
  function deleteAfter() {
    if (!state.editMode || state.justEvaluated) return;
    const [b, a] = parts();
    if (!a) return render();
    setExpr(b, a.slice(1));
    clearStale();
  }

  function clearAllState() {
    clearResult();
    render();
  }

  // Khi người dùng sửa biểu thức sau kết quả, bỏ trạng thái kết quả cũ.
  function clearStale() {
    leaveResult();
    render();
  }

  // Di chuyển con trỏ trái/phải (chỉ ở chế độ sửa).
  function moveCaret(d) {
    if (!state.editMode) return;
    leaveResult();
    state.caret = clamp(caretPos() + d, 0, state.expr.length);
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
    if (target) writeResult(v, state.expr);
    return true;
  }

  // Bật/tắt chế độ sửa. Khi bật, con trỏ nằm ở cuối biểu thức.
  function setEditMode(on) {
    state.editMode = on;
    if (on) {
      leaveResult();
      state.caret = state.expr.length;
    }
    els.editToggle.textContent = on ? 'Sửa: Bật' : 'Sửa: Tắt';
    els.editToggle.classList.toggle('on', on);
    els.editToggle.setAttribute('aria-pressed', String(on));
    els.caretLeft.hidden = !on;
    els.caretRight.hidden = !on;
    els.sub.classList.toggle('editing', on);
    render();
  }

  // Bấm save: mở ô ghi chú trước, rồi mới lưu.
  function saveCurrent() {
    // Nếu chưa có kết quả thì tính trước.
    if (!state.justEvaluated || state.error || state.value === null) {
      if (!equals()) return toast('Biểu thức chưa hợp lệ');
    }
    pendingTable = false;
    els.notePreview.textContent = `${state.expr} = ${formatValue(state.value)}`;
    openNoteSheet();
  }

  // Bấm Lưu ở màn hình Bảng: lưu cả bảng kèm ghi chú.
  function saveTableRecord() {
    pendingTable = true;
    els.notePreview.textContent = `Bảng — tổng cuối cùng: ${formatValue(grandSum())}`;
    openNoteSheet();
  }

  function openNoteSheet() {
    els.noteInput.value = '';
    els.noteSheet.hidden = false;
    setTimeout(() => els.noteInput.focus(), 50);
  }

  function closeNoteSheet() {
    els.noteSheet.hidden = true;
    els.noteInput.blur();
    pendingTable = false;
  }

  // Ghi chú để trống thì không lưu trường note.
  async function confirmSave() {
    const note = els.noteInput.value.trim();
    const isTable = pendingTable;
    let rec;
    if (isTable) {
      const total = grandSum();
      rec = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'table',
        expr: 'Bảng tính',
        result: formatValue(total),
        value: total,
        table: snapshotTable(),
        createdAt: Date.now(),
        ...(note ? { note } : {}),
      };
    } else {
      rec = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        expr: state.expr,
        result: formatValue(state.value),
        value: state.value,
        createdAt: Date.now(),
        ...(note ? { note } : {}),
      };
    }
    closeNoteSheet();
    try {
      await dbAdd(rec);
      toast(isTable ? 'Đã lưu bảng vào lịch sử' : 'Đã lưu vào lịch sử');
    } catch (err) {
      console.error(err);
      toast('Không thể lưu trên thiết bị này');
    }
  }

  /* ==========================================================
   * 4. Hiển thị
   * ========================================================== */

  function makeCaret() {
    const c = document.createElement('span');
    c.className = 'caret';
    return c;
  }

  // Dấu × ÷ màu vàng, các ký tự khác màu trắng.
  // Mỗi đoạn có data-start = vị trí của nó trong biểu thức, để đổi vị trí con trỏ khi chạm.
  // caretAt = -1 nghĩa là không vẽ con trỏ.
  function colorExpr(text, caretAt) {
    const wrap = document.createElement('span');
    wrap.className = 'expr-text';
    let plain = '';
    let plainStart = 0;
    const flush = () => {
      if (!plain) return;
      const s = document.createElement('span');
      s.dataset.start = String(plainStart);
      s.textContent = plain;
      wrap.append(s);
      plain = '';
    };
    let i = 0;
    for (const ch of text) {
      if (i === caretAt) { flush(); wrap.append(makeCaret()); }
      if (ch === '×' || ch === '÷') {
        flush();
        const m = document.createElement('span');
        m.className = 'op-mul';
        m.dataset.start = String(i);
        m.textContent = ch;
        wrap.append(m);
      } else {
        if (!plain) plainStart = i;
        plain += ch;
      }
      i++;
    }
    if (i === caretAt) { flush(); wrap.append(makeCaret()); }
    flush();
    return wrap;
  }

  // Kết quả (vàng, đậm) hiện ngay dưới thanh công cụ; biểu thức đầy đủ ở dưới.
  function render() {
    let main;
    let expr = state.expr;
    let caretAt = -1;
    if (state.error) {
      main = 'Lỗi';
    } else if (state.justEvaluated && state.value !== null) {
      main = formatValue(state.value);
      expr = state.expr + ' =';
    } else {
      const v = state.expr === '' ? null : evaluate(state.expr);
      main = v === null ? '0' : formatValue(v);
    }
    if (state.editMode && !state.justEvaluated) caretAt = caretPos();

    els.main.textContent = main;
    els.main.classList.toggle('error', state.error);
    els.main.classList.toggle('long', !state.error && main.length > 9);
    els.main.classList.toggle('xlong', !state.error && main.length > 14);
    els.sub.replaceChildren(colorExpr(expr, caretAt));
    followCaret();
  }

  // Cuộn biểu thức để con trỏ luôn hiện; không sửa thì cuộn xuống cuối.
  function followCaret() {
    const sub = els.sub;
    const c = sub.querySelector('.caret');
    if (!c) {
      sub.scrollTop = sub.scrollHeight;
      return;
    }
    const top = c.offsetTop;
    const bottom = top + c.offsetHeight;
    if (top < sub.scrollTop) sub.scrollTop = top;
    else if (bottom > sub.scrollTop + sub.clientHeight) sub.scrollTop = bottom - sub.clientHeight + 12;
  }

  // Đổi tọa độ chạm thành vị trí con trỏ trong biểu thức (null nếu không trúng chữ).
  function caretIndexAt(x, y) {
    let node = null;
    let off = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; off = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; off = r.startOffset; }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const el = node.parentElement && node.parentElement.closest('[data-start]');
    if (!el || !els.sub.contains(el)) return null;
    const start = Number(el.dataset.start);
    if (el.classList.contains('op-mul')) return start + (off > 0 ? 1 : 0);
    return start + off;
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
      ['(', 'lparen', 'fn'],
      [')', 'rparen', 'fn'],
    ],
    [
      ['7', 'd7', 'num'], ['8', 'd8', 'num'], ['9', 'd9', 'num'],
      ['÷', 'op÷', 'op'],
      [ICON.back, 'back', 'fn', { icon: true }],
    ],
    [
      ['4', 'd4', 'num'], ['5', 'd5', 'num'], ['6', 'd6', 'num'],
      ['×', 'op×', 'op'],
      [ICON.save, 'save', 'fn', { icon: true }],
    ],
    [
      ['1', 'd1', 'num'], ['2', 'd2', 'num'], ['3', 'd3', 'num'],
      ['−', 'op−', 'op'],
      [ICON.list, 'history', 'fn', { icon: true }],
    ],
    [
      ['0', 'd0', 'num', { zero: true }],
      [',', 'comma', 'num'],
      ['+', 'op+', 'op'],
      ['=', 'equals', 'op'],
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
    lparen: () => inputParen('('),
    rparen: () => inputParen(')'),
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

  // Thanh công cụ phía trên kết quả
  els.editToggle.addEventListener('click', () => setEditMode(!state.editMode));
  els.caretLeft.addEventListener('click', () => moveCaret(-1));
  els.caretRight.addEventListener('click', () => moveCaret(1));
  els.decimals.value = state.decimals;
  els.decimals.addEventListener('change', () => {
    state.decimals = els.decimals.value;
    saveDecimals(state.decimals);
    render();
  });

  // Chạm vào biểu thức khi đang sửa: đặt con trỏ tại vị trí đã chạm.
  els.sub.addEventListener('click', (e) => {
    if (!state.editMode) return;
    const idx = caretIndexAt(e.clientX, e.clientY);
    if (idx === null) return;
    leaveResult();
    state.caret = clamp(idx, 0, state.expr.length);
    render();
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
    if (!els.tableScreen.hidden) return;
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (state.editMode) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); return moveCaret(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); return moveCaret(1); }
      if (e.key === 'Delete') return deleteAfter();
    }
    if (/^[0-9]$/.test(e.key)) return inputDigit(e.key);
    if (e.key === ',' || e.key === '.') return inputComma();
    if (e.key === '+') return inputOperator('+');
    if (e.key === '-') return inputOperator('−');
    if (e.key === '*') return inputOperator('×');
    if (e.key === '/') return inputOperator('÷');
    if (e.key === '%') return inputPercent();
    if (e.key === '(' || e.key === ')') return inputParen(e.key);
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

  // Bản ghi đã tải, giữ trong bộ nhớ để lọc nhanh khi gõ tìm kiếm.
  let historyRecords = [];

  // Bỏ dấu tiếng Việt và chữ hoa, để "giay" khớp với "Giấy".
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .toLowerCase();
  }

  // Mỗi từ trong ô tìm kiếm phải xuất hiện trong ghi chú, biểu thức hoặc kết quả.
  function matchesQuery(rec, query) {
    const terms = fold(query).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = fold([rec.note, rec.expr, rec.result].join(' '));
    return terms.every((t) => hay.includes(t));
  }

  async function openHistory() {
    els.history.hidden = false;
    await refreshHistory();
  }

  function closeHistory() {
    els.history.hidden = true;
  }

  async function refreshHistory() {
    try {
      historyRecords = await dbGetAll();
      historyRecords.sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.error(err);
      historyRecords = [];
      toast('Không đọc được lịch sử');
    }
    drawList();
  }

  function drawList() {
    const shown = historyRecords.filter((r) => matchesQuery(r, els.search.value));

    els.list.replaceChildren();
    els.empty.hidden = historyRecords.length > 0;
    els.noMatch.hidden = historyRecords.length === 0 || shown.length > 0;
    els.clearAll.disabled = historyRecords.length === 0;
    els.exportBtn.disabled = historyRecords.length === 0;

    for (const rec of shown) els.list.appendChild(buildItem(rec));
  }

  function buildItem(rec) {
    const li = document.createElement('li');
    li.className = 'item';

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'item-body';
    body.title = rec.table ? 'Mở lại bảng này' : 'Mở lại phép tính này';

    const ex = document.createElement('div');
    ex.className = 'item-expr';
    ex.textContent = rec.table ? rec.expr : `${rec.expr} =`;

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
      if (rec.table) return restoreTable(rec);
      setExpr(rec.expr);
      leaveResult();
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
        historyRecords = historyRecords.filter((r) => r.id !== rec.id);
        drawList();
      } catch (err) {
        console.error(err);
        toast('Không xóa được');
      }
    });

    li.append(body, del);
    return li;
  }

  /* ---------- Xuất / nhập file JSON ---------- */

  function exportHistory() {
    if (!historyRecords.length) return toast('Chưa có gì để xuất');
    const payload = {
      app: 'calc-history',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: historyRecords.length,
      records: historyRecords.map((r) => ({
        id: r.id,
        expr: r.expr,
        result: r.result,
        value: r.value,
        createdAt: r.createdAt,
        ...(r.note ? { note: r.note } : {}),
        ...(r.table ? { kind: 'table', table: r.table } : {}),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const day = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lich-su-may-tinh-${day}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Đã xuất ${historyRecords.length} mục`);
  }

  function isValidRecord(r) {
    return r && typeof r.id === 'string' && typeof r.expr === 'string' &&
      typeof r.result === 'string' && Number.isFinite(r.createdAt) &&
      (r.note === undefined || typeof r.note === 'string');
  }

  // Nhập gộp: mục có cùng id sẽ được ghi đè, không tạo bản trùng.
  async function importFromFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      return toast('File không hợp lệ');
    }
    const list = Array.isArray(data)
      ? data
      : (data && data.app === 'calc-history' && Array.isArray(data.records) ? data.records : null);
    if (!list) return toast('File không đúng định dạng lịch sử');

    const valid = list.filter(isValidRecord).map((r) => ({
      id: r.id,
      expr: r.expr,
      result: r.result,
      value: Number.isFinite(r.value) ? r.value : null,
      createdAt: r.createdAt,
      ...(r.note ? { note: r.note.slice(0, 200) } : {}),
      ...(r.kind === 'table' && normalizeTable(r.table) ? { kind: 'table', table: normalizeTable(r.table) } : {}),
    }));
    if (!valid.length) return toast('Không có mục nào để nhập');

    try {
      await dbPutMany(valid);
      await refreshHistory();
      toast(`Đã nhập ${valid.length} mục`);
    } catch (err) {
      console.error(err);
      toast('Không nhập được');
    }
  }

  els.exportBtn.addEventListener('click', exportHistory);
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => {
    const f = els.importFile.files[0];
    els.importFile.value = '';
    if (f) importFromFile(f);
  });
  els.search.addEventListener('input', drawList);

  els.clearAll.addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ lịch sử trên thiết bị này?')) return;
    try {
      await dbClear();
      toast('Đã xóa lịch sử');
      await refreshHistory();
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
   * 7. Bảng: hạng mục là cột (Vỏ, Ruột, ...), trường là hàng (Q.cách, In, Gc, Giấy, Phụ phí, PS)
   * Chạm một trường hoặc một ô → máy tính nhập cho trường đó; chọn hạng mục trên thẻ, bấm = để ghi kết quả.
   * Cột Tổng: cộng theo trường. Hàng Tổng: cộng theo hạng mục. Ô cuối cùng: tổng tất cả.
   * ========================================================== */

  const TABLE_KEY = 'calc-table';
  const FIELDS = [
    { key: 'qcach', label: 'Q.cách' },
    { key: 'in', label: 'In' },
    { key: 'gc', label: 'Gc' },
    { key: 'giay', label: 'Giấy' },
    { key: 'pp', label: 'Phụ phí' },
    { key: 'ps', label: 'PS' },
  ];
  const ITEM_COUNT = 18;
  const fieldLabel = (key) => FIELDS.find((f) => f.key === key).label;

  function blankTable() {
    const rows = [];
    for (let i = 0; i < ITEM_COUNT; i++) {
      rows.push({ name: i === 0 ? 'Vỏ' : (i === 1 ? 'Ruột' : ''), cells: {}, formulas: {} });
    }
    return { rows };
  }

  // Kiểm tra và chuẩn hóa dữ liệu bảng (dùng khi tải, nhập file và khôi phục bản lưu).
  function normalizeTable(t) {
    if (!t || !Array.isArray(t.rows)) return null;
    return {
      rows: t.rows.map((r) => ({
        name: typeof r.name === 'string' ? r.name : '',
        cells: (r && typeof r.cells === 'object' && r.cells) || {},
        formulas: (r && typeof r.formulas === 'object' && r.formulas) || {},
      })),
    };
  }

  function loadTable() {
    try {
      const t = normalizeTable(JSON.parse(localStorage.getItem(TABLE_KEY) || 'null'));
      if (t) return t;
    } catch (_) { /* hỏng thì dùng bảng trống */ }
    return blankTable();
  }

  function saveTable() {
    try {
      localStorage.setItem(TABLE_KEY, JSON.stringify(table));
    } catch (_) {
      toast('Không lưu được bảng trên thiết bị này');
    }
  }

  const table = loadTable();
  const snapshotTable = () => JSON.parse(JSON.stringify(table));

  // target: { col } là trường đang nhập. selRow: chỉ số hạng mục (cột) được chọn.
  let target = null;
  let selRow = null;

  // Đọc số từ ô đã định dạng kiểu vi-VN (ví dụ "1.234,5"). Ô trống tính là 0.
  function toNum(s) {
    if (!s) return 0;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  const getCell = (field, r) => table.rows[r].cells[field] || '';
  const getFormula = (field, r) => table.rows[r].formulas[field] || '';

  function setCell(field, r, v, expr) {
    const row = table.rows[r];
    row.cells[field] = v;
    row.formulas[field] = expr;
    saveTable();
  }

  const fieldSum = (key) => table.rows.reduce((s, r) => s + toNum(r.cells[key]), 0);
  const itemSum = (r) => FIELDS.reduce((s, f) => s + toNum(table.rows[r].cells[f.key]), 0);
  const grandSum = () => table.rows.reduce((s, _, r) => s + itemSum(r), 0);

  function showScreen(name) {
    const onTable = name === 'table';
    if (onTable) {
      target = null;
      selRow = null;
      buildGrid();
    }
    els.tableScreen.hidden = !onTable;
    els.calc.hidden = onTable;
    renderCard();
    render();
  }

  function openCalc(field, row) {
    target = { col: field };
    selRow = row;
    clearResult();
    showScreen('calc');
  }

  function selectRow(i) {
    selRow = i;
    clearResult();
    renderCard();
    render();
  }

  // Bấm = trong chế độ bảng: ghi kết quả và công thức vào ô đang chọn.
  function writeResult(v, expr) {
    if (!target) return;
    if (selRow === null) return toast('Chọn một hạng mục trước khi bấm =');
    setCell(target.col, selRow, formatValue(v), expr);
    renderCard();
    toast(`Đã ghi vào ${fieldLabel(target.col)}`);
  }

  function renderCard() {
    els.card.hidden = !target;
    if (!target) return;
    els.cardTitle.textContent = fieldLabel(target.col);
    els.cardRows.replaceChildren(...table.rows.map((r, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card-row' + (idx === selRow ? ' sel' : '');
      const n = document.createElement('span');
      n.className = 'card-name';
      n.textContent = r.name || `Hạng mục ${idx + 1}`;
      const v = document.createElement('span');
      v.className = 'card-val';
      const f = getFormula(target.col, idx);
      if (f) {
        const fo = document.createElement('span');
        fo.className = 'card-formula';
        fo.textContent = `${f} =`;
        v.append(fo);
      }
      const res = document.createElement('span');
      res.textContent = getCell(target.col, idx);
      v.append(res);
      b.append(n, v);
      b.addEventListener('click', () => selectRow(idx));
      return b;
    }));
  }

  // Tạo phần tử có class (nếu có).
  function mk(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function buildGrid() {
    const g = els.grid;
    g.replaceChildren();

    // Hàng tiêu đề: tên hạng mục (sửa được) và cột Tổng
    const head = mk('tr');
    head.append(Object.assign(mk('th', 'sticky'), { textContent: 'Trường' }));
    table.rows.forEach((r, i) => {
      const th = mk('th');
      const inp = mk('input', 'name-input');
      inp.type = 'text';
      inp.value = r.name;
      inp.maxLength = 40;
      inp.setAttribute('aria-label', `Tên hạng mục ${i + 1}`);
      inp.addEventListener('change', () => {
        r.name = inp.value.trim();
        saveTable();
      });
      th.append(inp);
      head.append(th);
    });
    head.append(Object.assign(mk('th', 'sum-head'), { textContent: 'Tổng' }));
    g.append(head);

    // Mỗi trường là một hàng, ô cuối là tổng theo trường
    for (const f of FIELDS) {
      const tr = mk('tr');
      const th = mk('th', 'sticky');
      const b = mk('button', 'col-head');
      b.type = 'button';
      b.textContent = f.label;
      b.addEventListener('click', () => openCalc(f.key, null));
      th.append(b);
      tr.append(th);
      table.rows.forEach((r, i) => {
        const td = mk('td');
        const c = mk('button', 'cell');
        c.type = 'button';
        c.textContent = r.cells[f.key] || '';
        c.addEventListener('click', () => openCalc(f.key, i));
        td.append(c);
        tr.append(td);
      });
      tr.append(Object.assign(mk('td', 'sum'), { textContent: formatValue(fieldSum(f.key)) }));
      g.append(tr);
    }

    // Hàng Tổng: tổng theo hạng mục và ô tổng cuối cùng
    const foot = mk('tr', 'foot');
    foot.append(Object.assign(mk('th', 'sticky'), { textContent: 'Tổng' }));
    table.rows.forEach((_, i) => {
      foot.append(Object.assign(mk('td', 'sum'), { textContent: formatValue(itemSum(i)) }));
    });
    foot.append(Object.assign(mk('td', 'sum grand'), { textContent: formatValue(grandSum()) }));
    g.append(foot);

    els.totalVal.textContent = formatValue(grandSum());
  }

  // Mở lại một bảng đã lưu trong lịch sử (thay bảng hiện tại).
  function restoreTable(rec) {
    if (!confirm('Thay bảng hiện tại bằng bảng đã lưu này?')) return;
    const t = normalizeTable(rec.table);
    if (!t) return toast('Bản lưu bảng bị lỗi');
    table.rows.splice(0, table.rows.length, ...t.rows);
    saveTable();
    closeHistory();
    showScreen('table');
  }

  els.openTable.addEventListener('click', () => showScreen('table'));
  els.toCalc.addEventListener('click', () => {
    target = null;
    selRow = null;
    showScreen('calc');
  });
  els.tableHistory.addEventListener('click', openHistory);
  els.tableSave.addEventListener('click', saveTableRecord);
  els.cardBack.addEventListener('click', () => showScreen('table'));

  /* ==========================================================
   * 8. Khởi động
   * ========================================================== */

  buildKeys();
  setEditMode(false);
  showScreen('table');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.error('SW lỗi', err);
      });
    });
  }

  /* ==========================================================
   * 9. Chặn zoom (pinch, double-tap, Ctrl+cuộn chuột)
   * ========================================================== */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // Cho phép kiểm thử từ console / test tự động.
  window.__calc = { evaluate, state };
})();
