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
  // Mọi số lẻ làm tròn tối đa 2 chữ số sau dấu thập phân (bỏ số 0 thừa ở cuối).
  const fmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  const fixedFmt = [0, 1, 2, 3, 4, 5, 6].map((d) => new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }));
  const formatMoney = (v) => fmt.format(v); // dùng cho Bảng: luôn tối đa 2 chữ số thập phân
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
    tableProducts: document.getElementById('tableProducts'),
    tableNew: document.getElementById('tableNew'),
    tableTitle: document.getElementById('tableTitle'),
    paidInput: document.getElementById('paidInput'),
    leftVal: document.getElementById('leftVal'),
    productScreen: document.getElementById('productScreen'),
    productList: document.getElementById('productList'),
    productEmpty: document.getElementById('productEmpty'),
    productBack: document.getElementById('productBack'),
    productAdd: document.getElementById('productAdd'),
    productSearch: document.getElementById('productSearch'),
    productNoMatch: document.getElementById('productNoMatch'),
    nameInput: document.getElementById('nameInput'),
    tableSave: document.getElementById('tableSave'),
    detailToggle: document.getElementById('detailToggle'),
    gridWrap: document.getElementById('gridWrap'),
    addLine: document.getElementById('addLine'),
    unitVal: document.getElementById('unitVal'),
    orderVal: document.getElementById('orderVal'),
    quoteVal: document.getElementById('quoteVal'),
    marginInput: document.getElementById('marginInput'),
    specText: document.getElementById('specText'),
    specDelete: document.getElementById('specDelete'),
    specSheet: document.getElementById('specSheet'),
    specInput: document.getElementById('specInput'),
    specOk: document.getElementById('specOk'),
    specCancel: document.getElementById('specCancel'),
    specTitle: document.getElementById('specTitle'),
    specLabel: document.getElementById('specLabel'),
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

  // Bấm Lưu ở màn hình Bảng: lưu cả bảng kèm ghi chú.
  function saveTableRecord() {
    table.paid = els.paidInput.value;
    pendingTable = true;
    els.notePreview.textContent = `Bảng — tổng đơn: ${formatMoney(orderTotal())}`;
    openNoteSheet(table.name || '');
  }

  function openNoteSheet(prefillName = '') {
    els.nameInput.value = prefillName;
    els.noteInput.value = '';
    els.noteSheet.hidden = false;
    setTimeout(() => els.nameInput.focus(), 50);
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
    const name = els.nameInput.value.trim();
    if (isTable) table.paid = els.paidInput.value;
    if (isTable && !name) return toast('Nhập tên sản phẩm trước khi lưu');
    let rec;
    if (isTable) {
      const total = orderTotal();
      rec = {
        id: table.recId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'table',
        expr: name,
        name,
        result: formatMoney(total),
        value: total,
        paid: toNum(table.paid),
        left: total - toNum(table.paid),
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
      if (isTable) {
        table.recId = rec.id;
        table.name = name;
        saveTable();
        els.tableTitle.textContent = name;
        saveTable();
        openProducts(); // lưu xong quay về danh sách sản phẩm
      }
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
    save: () => saveTableRecord(), // lưu toàn bộ bảng kèm ghi chú
    history: () => openHistory(),
    comma: () => inputComma(),
    equals: () => equals(),
    'op÷': () => inputOperator('÷'),
    'op×': () => inputOperator('×'),
    'op−': () => inputOperator('−'),
    'op+': () => inputOperator('+'),
  };
  for (let d = 0; d <= 9; d++) ACTIONS[`d${d}`] = () => inputDigit(String(d));

  // Bấm phím phản hồi ngay khi chạm xuống (pointerdown), không chờ nhả tay.
  // Sự kiện click sau đó bị bỏ qua để tránh nhập đôi; phím bàn phím (Enter/Space) vẫn dùng click.
  let lastKeyPointer = 0;
  function pressKey(btn) {
    const fn = ACTIONS[btn.dataset.action];
    if (fn) fn();
  }
  els.keys.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    lastKeyPointer = Date.now();
    pressKey(btn);
  });
  els.keys.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (Date.now() - lastKeyPointer < 600) return;
    pressKey(btn);
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
    if (!els.specSheet.hidden) {
      if (e.key === 'Escape') closeSpec();
      return;
    }
    if (!els.history.hidden) {
      if (e.key === 'Escape') closeHistory();
      return;
    }
    if (!els.tableScreen.hidden || !els.productScreen.hidden) return;
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
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
      if (rec.table) return openProduct(rec);
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
        ...(r.name ? { name: r.name } : {}),
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
      ...(r.name ? { name: String(r.name).slice(0, 60) } : {}),
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
  els.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.noteInput.focus(); }
  });
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
  // Dòng đầu (chỉ số 0) luôn là Số lượng: không cộng vào TỔNG, dùng để tính Đơn giá.
  const DEFAULT_LINES = ['Số lượng', 'Giấy', 'In', 'Cán', 'Bế dán', 'Ép thúc', 'Phụ phí'];
  const DEFAULT_MARGIN = '20';
  const defaultLines = () => DEFAULT_LINES.map((label) => ({ label, note: '', val: '', formula: '' }));
  const fmtPlain = (n) => n.toLocaleString('vi-VN', { maximumFractionDigits: 6 });

  // Đổi bảng kiểu cũ (cột Vỏ/Ruột, hàng Q.Cách/Giấy/In/G.Công/Phụ phí/Phát sinh) sang dòng mới.
  function migrateOldRows(rows) {
    const nums = (key) => rows.map((r) => (r && r.cells && r.cells[key]) || '');
    const sumOf = (key) => nums(key).reduce((s, v) => s + (Number(String(v).replace(/\./g, '').replace(',', '.')) || 0), 0);
    const spec = rows
      .map((r) => ((r && r.cells && r.cells.qcach) ? `${r.name || ''}: ${r.cells.qcach}` : ''))
      .filter(Boolean)
      .join('; ');
    const lines = [{ label: 'Số lượng', note: spec, val: '', formula: '' }];
    [['giay', 'Giấy'], ['in', 'In'], ['gc', 'G.Công'], ['pp', 'Phụ phí'], ['ps', 'Phát sinh']].forEach(([key, label]) => {
      const parts = rows
        .map((r) => {
          const cell = (r && r.cells && r.cells[key]) || '';
          const fx = (r && r.formulas && r.formulas[key]) || '';
          return cell ? (fx || cell) : '';
        })
        .filter(Boolean);
      const total = sumOf(key);
      lines.push({ label, note: '', val: parts.length ? fmtPlain(total) : '', formula: parts.length > 1 ? parts.join(' + ') : (parts[0] || '') });
    });
    return lines;
  }

  // Kiểm tra và chuẩn hóa dữ liệu bảng (dùng khi tải, nhập file và khôi phục bản lưu).
  function normalizeTable(t) {
    const str = (v) => (typeof v === 'string' ? v : '');
    let lines;
    if (t && Array.isArray(t.lines) && t.lines.length) {
      lines = t.lines.map((l, i) => ({
        label: str(l && l.label) || (i === 0 ? 'Số lượng' : 'Dòng'),
        note: str(l && l.note),
        val: str(l && l.val),
        formula: str(l && l.formula),
      }));
    } else if (t && Array.isArray(t.rows) && t.rows.length) {
      lines = migrateOldRows(t.rows);
    } else {
      lines = defaultLines();
    }
    // recId: id sản phẩm đang mở (để Lưu cập nhật đúng sản phẩm đó); name: tên sản phẩm.
    return {
      lines,
      margin: (t && typeof t.margin === 'string' && t.margin !== '') ? t.margin : DEFAULT_MARGIN,
      recId: (t && t.recId) || null,
      name: (t && typeof t.name === 'string') ? t.name : '',
      paid: (t && typeof t.paid === 'string') ? t.paid : '',
    };
  }

  function loadTable() {
    try {
      return normalizeTable(JSON.parse(localStorage.getItem(TABLE_KEY) || 'null'));
    } catch (_) {
      return normalizeTable(null); // hỏng thì dùng bảng trống
    }
  }

  function saveTable() {
    try {
      localStorage.setItem(TABLE_KEY, JSON.stringify(table));
    } catch (_) {
      toast('Không lưu được bảng trên thiết bị này');
    }
  }

  const table = loadTable();
  const snapshotTable = () => JSON.parse(JSON.stringify({ lines: table.lines, margin: table.margin }));
  // Nạp dòng và % lợi nhuận từ một bảng đã chuẩn hóa (không đổi recId/name/paid).
  function setTableBody(t) {
    table.lines = t.lines;
    table.margin = t.margin;
  }
  const tableHasData = () => table.lines.some((l) => l.val || l.note);

  // target: { line } là dòng đang nhập giá bằng máy tính.
  let target = null;

  // Đọc số từ ô đã định dạng kiểu vi-VN (ví dụ "1.234,5"). Ô trống tính là 0.
  function toNum(s) {
    if (!s) return 0;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  // % lợi nhuận: người dùng gõ "12,5" hoặc "12.5".
  function pctNum(s) {
    const n = Number(String(s || '').trim().replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  const grandSum = () => table.lines.reduce((s, l, i) => (i === 0 ? s : s + toNum(l.val)), 0);
  const qtyVal = () => toNum(table.lines[0].val);
  const unitPrice = () => (qtyVal() > 0 ? grandSum() / qtyVal() : 0);
  const quotePrice = () => unitPrice() * (1 + pctNum(table.margin) / 100);
  // Tổng đơn = Giá báo × Số lượng = TỔNG × (1 + %). Không có số lượng vẫn tính được từ TỔNG.
  const orderTotal = () => grandSum() * (1 + pctNum(table.margin) / 100);


  function showScreen(name) {
    const onTable = name === 'table';
    if (onTable) {
      target = null;
      buildGrid();
    }
    els.tableScreen.hidden = !onTable;
    els.productScreen.hidden = true;
    els.calc.hidden = onTable;
    if (onTable) fitRows();
    renderCard();
    render();
  }

  function openCalc(lineIdx) {
    target = { line: lineIdx };
    clearResult();
    // Dòng đã có công thức thì nạp lại để xem và sửa tiếp.
    const f = table.lines[lineIdx] && table.lines[lineIdx].formula;
    if (f) {
      state.expr = f;
      state.caret = f.length;
    }
    showScreen('calc');
  }

  // Bấm = trong chế độ bảng: ghi kết quả và công thức vào dòng đang chọn, rồi về màn hình Bảng.
  function writeResult(v, expr) {
    if (!target) return;
    const line = table.lines[target.line];
    if (!line) return;
    line.val = formatMoney(v);
    line.formula = expr;
    saveTable();
    toast(`Đã ghi vào ${line.label}`);
    showScreen('table');
  }

  // Thẻ phía trên máy tính: chỉ cho biết đang nhập cho dòng nào. Mở từ bảng thì dùng bàn phím gọn.
  function renderCard() {
    els.keys.classList.toggle('compact', !!target);
    els.card.hidden = !target;
    if (!target) return;
    const line = table.lines[target.line];
    els.cardTitle.textContent = line ? line.label : '';
    els.cardRows.replaceChildren();
  }

  // Tạo phần tử có class (nếu có).
  function mk(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  // Chế độ "Chi tiết": hiện thêm phép tính gốc dưới mỗi kết quả. Lưu theo máy xem.
  let detailMode = (() => {
    try { return localStorage.getItem('calc-detail') === '1'; } catch (_) { return false; }
  })();

  function setDetailMode(on) {
    detailMode = on;
    try { localStorage.setItem('calc-detail', on ? '1' : '0'); } catch (_) { /* bỏ qua */ }
    buildGrid();
    fitRows();
  }

  // Chia chiều cao bảng cho các dòng: thêm dòng thì mỗi dòng tự thấp lại để vừa màn hình.
  function fitRows() {
    const wrap = els.gridWrap;
    if (!wrap || els.tableScreen.hidden) return;
    const n = table.lines.length;
    const head = 34;
    const avail = wrap.clientHeight - head;
    const minH = detailMode ? 44 : 30;
    const h = Math.max(minH, Math.min(64, Math.floor(avail / Math.max(n, 1))));
    els.grid.style.setProperty('--row-h', `${h}px`);
  }
  window.addEventListener('resize', fitRows);

  function buildGrid() {
    const g = els.grid;
    g.replaceChildren();
    g.classList.toggle('detail', detailMode);
    els.detailToggle.classList.toggle('on', detailMode);
    els.detailToggle.setAttribute('aria-pressed', String(detailMode));
    els.detailToggle.setAttribute('aria-label', detailMode ? 'Chi tiết: Bật' : 'Chi tiết: Tắt');
    els.detailToggle.title = detailMode ? 'Đang xem chi tiết (bấm để tắt)' : 'Xem chi tiết';

    const head = mk('tr');
    head.append(
      Object.assign(mk('th', 'sticky'), { textContent: 'Trường' }),
      Object.assign(mk('th', 'col-note'), { textContent: 'Ghi chú' }),
      Object.assign(mk('th', 'col-price'), { textContent: 'Amount' }),
    );
    g.append(head);

    table.lines.forEach((line, i) => {
      const tr = mk('tr');

      // Tên dòng: chạm để sửa tên (hoặc xóa dòng).
      const th = mk('th', 'sticky');
      const lb = mk('button', 'col-head');
      lb.type = 'button';
      lb.textContent = line.label;
      lb.addEventListener('click', () => openLabel(i));
      th.append(lb);

      // Quy cách: ghi chú dài, chạm để xem đủ nội dung và sửa.
      const tdNote = mk('td', 'note-td');
      const nb = mk('button', 'cell note');
      nb.type = 'button';
      const nt = mk('span', 'note-text');
      nt.textContent = line.note;
      nb.append(nt);
      nb.addEventListener('click', () => openNote(i));
      tdNote.append(nb);

      // Giá: chạm để mở máy tính.
      const tdPrice = mk('td');
      const pb = mk('button', 'cell');
      pb.type = 'button';
      if (detailMode && line.formula) {
        pb.classList.add('detail');
        const val = mk('span', 'cell-val');
        val.textContent = line.val;
        const fx = mk('span', 'cell-formula');
        fx.textContent = line.formula;
        pb.append(val, fx);
      } else {
        pb.textContent = line.val;
      }
      pb.addEventListener('click', () => openCalc(i));
      tdPrice.append(pb);

      tr.append(th, tdNote, tdPrice);
      g.append(tr);
    });

    renderTotals();
    els.tableTitle.textContent = table.name || 'Bảng';
  }

  // Mở một sản phẩm đã lưu thành bảng tính. Sản phẩm đang mở được tự lưu, không hỏi lại.
  // Chỉ hỏi khi bảng hiện tại là bảng mới chưa có tên sản phẩm và còn số liệu.
  async function openProduct(rec) {
    closeHistory();
    if (table.recId === rec.id) return showScreen('table');
    if (!table.recId && tableHasData() && !confirm('Bảng hiện tại chưa lưu sẽ bị thay thế. Tiếp tục?')) return;
    const t = normalizeTable(rec.table);
    if (!t) return toast('Bản lưu bảng bị lỗi');
    if (table.recId) await autoSaveCurrent();
    setTableBody(t);
    table.recId = rec.id;
    table.name = rec.name || rec.expr || '';
    table.paid = rec.paid ? formatMoney(rec.paid) : '';
    saveTable();
    showScreen('table');
  }

  /* ---------- Màn hình Sản phẩm: mỗi dòng là một bảng đã lưu (tên + tổng cuối cùng) ---------- */
  let productRecords = [];

  async function openProducts() {
    els.tableScreen.hidden = true;
    els.calc.hidden = true;
    els.productScreen.hidden = false;
    await loadProducts();
  }

  async function loadProducts() {
    try {
      const all = await dbGetAll();
      productRecords = all.filter((r) => r.table).sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.error(err);
      productRecords = [];
      toast('Không đọc được danh sách sản phẩm');
    }
    drawProducts();
  }

  function drawProducts() {
    const shown = productRecords.filter((r) => matchesQuery(r, els.productSearch.value));
    els.productList.replaceChildren(...shown.map((r) => buildProductItem(r)));
    els.productEmpty.hidden = productRecords.length > 0;
    els.productNoMatch.hidden = productRecords.length === 0 || shown.length > 0;
  }

  function productLine(label, value) {
    const l = mk('div', 'product-line');
    const a = mk('span', 'product-label');
    a.textContent = label;
    const b = mk('span', 'product-val');
    b.textContent = value;
    l.append(a, b);
    return l;
  }

  function buildProductItem(rec) {
    const li = mk('li', 'item product-card');

    // Dòng 1: tên sản phẩm cùng với nút sửa, xóa
    const name = mk('div', 'product-name');
    name.textContent = rec.name || rec.expr || 'Chưa đặt tên';

    // Các dòng bên dưới: bấm vào để mở bảng tính
    const body = mk('button', 'product-body');
    body.type = 'button';
    body.title = 'Mở bảng tính của sản phẩm này';
    const total = mk('div', 'product-line');
    const lbl = mk('span', 'product-label');
    lbl.textContent = 'Tổng tiền';
    const val = mk('span', 'product-val');
    val.textContent = rec.result;
    total.append(lbl, val);
    const paidNum = typeof rec.paid === 'number' ? rec.paid : 0;
    const leftNum = typeof rec.left === 'number' ? rec.left : (rec.value || 0) - paidNum;
    body.append(total, productLine('Đã trả', formatMoney(paidNum)), productLine('Còn lại', formatMoney(leftNum)));
    if (rec.note) {
      const nt = mk('div', 'item-note');
      nt.textContent = rec.note;
      body.append(nt);
    }
    const dt = mk('div', 'item-date');
    dt.textContent = dateFmt.format(new Date(rec.createdAt));
    body.append(dt);
    body.addEventListener('click', () => openProduct(rec));

    const edit = mk('button', 'item-edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Sửa tên sản phẩm này');
    edit.textContent = '✎';
    edit.addEventListener('click', () => openRename(rec));

    const del = mk('button', 'item-del');
    del.type = 'button';
    del.setAttribute('aria-label', 'Xóa sản phẩm này');
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      if (!confirm('Xóa bảng này khỏi lịch sử?')) return;
      try {
        await dbDelete(rec.id);
        productRecords = productRecords.filter((r) => r.id !== rec.id);
        if (table.recId === rec.id) { table.recId = null; saveTable(); }
        drawProducts();
      } catch (err) {
        console.error(err);
        toast('Không xóa được');
      }
    });

    const top = mk('div', 'product-top');
    top.append(name, edit, del);
    li.append(top, body);
    return li;
  }

  // Ô nhập dùng chung: 'label' (tên dòng), 'note' (quy cách nhiều dòng),
  // 'rename' (sửa tên sản phẩm) hoặc 'newProduct' (sản phẩm mới).
  let specRow = null;
  let specMode = 'note';
  let renameId = null;

  // multi: dùng ô nhiều dòng; canDelete: hiện nút Xóa dòng.
  function showSpec({ multi = false, canDelete = false } = {}) {
    els.specInput.hidden = multi;
    els.specText.hidden = !multi;
    els.specDelete.hidden = !canDelete;
    els.specSheet.hidden = false;
    setTimeout(() => (multi ? els.specText : els.specInput).focus(), 50);
  }

  // Sửa tên dòng (Giấy, In, ...). Dòng Số lượng đổi tên được nhưng không xóa được.
  function openLabel(row) {
    specMode = 'label';
    specRow = row;
    els.specTitle.textContent = 'Sửa tên dòng';
    els.specLabel.textContent = 'Tên dòng';
    els.specInput.placeholder = 'Ví dụ: Giấy';
    els.specInput.value = table.lines[row].label;
    showSpec({ canDelete: row > 0 });
  }

  // Xem đủ nội dung và sửa quy cách của một dòng.
  function openNote(row) {
    specMode = 'note';
    specRow = row;
    els.specTitle.textContent = table.lines[row].label;
    els.specLabel.textContent = 'Ghi chú';
    els.specText.placeholder = 'Ví dụ: Couche 250gsm, khổ 79x109, cán màng mờ...';
    els.specText.value = table.lines[row].note;
    showSpec({ multi: true });
  }

  function openRename(rec) {
    specMode = 'rename';
    renameId = rec.id;
    els.specTitle.textContent = 'Sửa tên sản phẩm';
    els.specLabel.textContent = 'Tên sản phẩm';
    els.specInput.placeholder = 'Ví dụ: Hộp quà tết';
    els.specInput.value = rec.name || '';
    showSpec();
  }

  function closeSpec() {
    els.specSheet.hidden = true;
    els.specInput.blur();
    els.specText.blur();
    specRow = null;
    renameId = null;
  }

  async function saveRename() {
    const name = els.specInput.value.trim();
    if (!name) return toast('Nhập tên sản phẩm');
    const rec = productRecords.find((r) => r.id === renameId);
    if (!rec) return closeSpec();
    rec.name = name;
    rec.expr = name;
    try {
      await dbAdd(rec); // ghi đè theo id
      closeSpec();
      drawProducts();
      toast('Đã sửa tên');
    } catch (err) {
      console.error(err);
      toast('Không sửa được tên');
    }
  }

  // Sản phẩm mới: hỏi tên, rồi mở bảng trống mang tên đó (lưu khi bấm Lưu trên bảng).
  function openNewProduct() {
    if (!table.recId && tableHasData() && !confirm('Bảng hiện tại chưa lưu sẽ bị thay thế. Tiếp tục?')) return;
    specMode = 'newProduct';
    specRow = null;
    renameId = null;
    els.specTitle.textContent = 'Sản phẩm mới';
    els.specLabel.textContent = 'Tên sản phẩm';
    els.specInput.placeholder = 'Ví dụ: Hộp quà tết';
    els.specInput.value = '';
    showSpec();
  }

  async function createProduct(name) {
    if (!name) return toast('Nhập tên sản phẩm');
    if (table.recId) await autoSaveCurrent();
    setTableBody(normalizeTable(null));
    table.recId = null;
    table.name = name;
    table.paid = '';
    saveTable();
    closeSpec();
    showScreen('table');
  }

  function saveSpec() {
    if (specMode === 'newProduct') return createProduct(els.specInput.value.trim());
    if (specMode === 'rename') return saveRename();
    if (specRow === null) return closeSpec();
    const line = table.lines[specRow];
    if (specMode === 'label') {
      const v = els.specInput.value.trim();
      if (v) line.label = v;
    } else {
      line.note = els.specText.value.trim();
    }
    saveTable();
    closeSpec();
    buildGrid();
    fitRows();
  }

  // Xóa dòng đang sửa tên (trừ dòng Số lượng).
  function deleteLine() {
    if (specMode !== 'label' || specRow === null || specRow === 0) return;
    const line = table.lines[specRow];
    if ((line.val || line.note) && !confirm(`Xóa dòng "${line.label}"?`)) return;
    table.lines.splice(specRow, 1);
    saveTable();
    closeSpec();
    buildGrid();
    fitRows();
  }

  // Thêm dòng mới ở cuối và mở luôn ô đặt tên.
  function addLine() {
    table.lines.push({ label: 'Dòng mới', note: '', val: '', formula: '' });
    saveTable();
    buildGrid();
    fitRows();
    openLabel(table.lines.length - 1);
  }

  els.specOk.addEventListener('click', saveSpec);
  els.specDelete.addEventListener('click', deleteLine);
  els.addLine.addEventListener('click', addLine);
  els.specCancel.addEventListener('click', closeSpec);
  els.specSheet.addEventListener('click', (e) => {
    if (e.target === els.specSheet) closeSpec();
  });
  els.specInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSpec(); }
  });

  els.openTable.addEventListener('click', () => showScreen('table'));
  els.toCalc.addEventListener('click', () => {
    target = null;
    showScreen('calc');
  });
  // Tạo bảng mới trống. Nếu bảng hiện tại có số liệu thì hỏi trước, tránh ghi đè.
  async function newTable() {
    if (!table.recId && tableHasData() && !confirm('Bảng hiện tại chưa lưu sẽ bị xóa. Tạo bảng mới?')) return;
    if (table.recId) await autoSaveCurrent();
    setTableBody(normalizeTable(null));
    table.recId = null;
    table.name = '';
    table.paid = '';
    saveTable();
    buildGrid();
    toast('Đã tạo bảng mới');
  }

  // TỔNG (tổng cột Amount), Đơn giá (= TỔNG / Số lượng), Giá báo (= Đơn giá × (1 + %)),
  // Tổng đơn (= Giá báo × Số lượng), Đã trả và Còn lại (= Tổng đơn − Đã trả).
  function renderTotals() {
    const order = orderTotal();
    const paid = toNum(table.paid);
    els.totalVal.textContent = formatMoney(grandSum());
    els.unitVal.textContent = formatMoney(unitPrice());
    els.quoteVal.textContent = formatMoney(quotePrice());
    els.orderVal.textContent = formatMoney(order);
    if (document.activeElement !== els.marginInput) els.marginInput.value = table.margin;
    if (document.activeElement !== els.paidInput) els.paidInput.value = table.paid;
    els.leftVal.textContent = formatMoney(order - paid);
  }

  // Ghi bảng đang mở vào đúng sản phẩm của nó, không hỏi lại.
  async function autoSaveCurrent() {
    if (!table.recId) return;
    const old = productRecords.find((r) => r.id === table.recId) || {};
    const grand = orderTotal();
    const paid = toNum(table.paid);
    await dbAdd({
      id: table.recId,
      kind: 'table',
      expr: table.name || 'Chưa đặt tên',
      name: table.name || '',
      result: formatMoney(grand),
      value: grand,
      paid,
      left: grand - paid,
      table: snapshotTable(),
      createdAt: old.createdAt || Date.now(),
      ...(old.note ? { note: old.note } : {}),
    });
  }

  els.detailToggle.addEventListener('click', () => setDetailMode(!detailMode));
  els.marginInput.addEventListener('input', () => {
    table.margin = els.marginInput.value;
    saveTable();
    renderTotals();
  });
  els.tableNew.addEventListener('click', newTable);
  els.paidInput.addEventListener('input', () => {
    table.paid = els.paidInput.value;
    saveTable();
    renderTotals();
  });
  els.tableProducts.addEventListener('click', openProducts);
  els.productBack.addEventListener('click', () => showScreen('table'));
  els.productAdd.addEventListener('click', openNewProduct);
  els.productSearch.addEventListener('input', drawProducts);
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
