/**
 * Trang Sổ công nợ — kiểm tra HTML/JS sinh ra không có lỗi cú pháp
 * ─────────────────────────────────────────────────────────────────────────────
 * Bắt lỗi 2026-11-13:
 *  `onclick="revokePerm(giaohang01, 7)"` — `staff_id` là CHUỖI từ DB được
 *  chèn thẳng vào inline handler KHÔNG có dấu nháy → JS hiểu là tên biến
 *  → `ReferenceError: giaohang01 is not defined` khi bấm nút "Thu hồi".
 *
 *  Test này parse `views/debts.html` và kiểm tra:
 *   1. Mọi giá trị CHUỖI chèn vào inline `onclick` phải được quote/escape.
 *   2. `jsArg()` escape đúng cho các trường hợp khó (dấu nháy, backslash).
 *   3. `<link rel="preload" as="...">` dùng giá trị `as` hợp lệ.
 */
const fs = require('fs');
const path = require('path');

const VIEW_PATH = path.join(__dirname, '..', 'views', 'debts.html');
const html = fs.readFileSync(VIEW_PATH, 'utf8');

/**
 * Thu thập mọi inline handler `onclick="..."` từ file.
 * Bỏ qua các handler nằm trong COMMENT (docstring minh hoạ lỗi) — chúng không
 * được render ra DOM nên không gây lỗi runtime.
 */
function collectInlineHandlers(source) {
  const out = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    // Nhận diện comment block /* ... */
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }
    // Bỏ qua comment dòng đơn
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    const re = /onclick\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({ value: m[1], line: idx + 1, text: line });
    }
  });
  return out;
}

describe('views/debts.html — lỗi inline onclick & preload', () => {
  test('không có giá trị chuỗi trần nào trong inline onclick', () => {
    const handlers = collectInlineHandlers(html);
    expect(handlers.length).toBeGreaterThan(0);

    const knownFns = new Set([
      'openDetail', 'quickEntry', 'showTab', 'openPaymentModal',
      'unlinkGroup', 'openGroupModal', 'revokePerm', 'openPermModal',
      'applyReconciliation', 'closeModal', 'submitPayment',
      'submitGroup', 'submitPerm', 'event', 'this', 'return',
      'stopPropagation', 'preventDefault', 'confirm', 'alert',
      // Modal "Tạo nội dung công nợ" + modal xem trước công nợ
      'openClaimContentModal', 'onClaimQRChange', 'copyClaimMessage',
      'regenerateClaimMessage', 'renderClaimQR',
      'openClaimPreviewModal',
    ]);

    const offenders = [];
    for (const h of handlers) {
      // Bỏ qua các fragment động (chứa nối chuỗi) — chúng được test riêng
      if (h.value.includes("' + ") || h.value.includes('+ t.') || h.value.includes('+ c.')) {
        continue;
      }
      const callMatch = h.value.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (!callMatch) continue;

      const fnName = callMatch[1];
      if (!knownFns.has(fnName)) continue;

      const argsPart = h.value.slice(h.value.indexOf('(') + 1);
      const args = argsPart.split(',');

      for (const raw of args) {
        const arg = raw.trim();
        if (!arg) continue;
        const isQuoted = /^'.*'$/.test(arg) || /^".*"$/.test(arg);
        const isNumeric = /^-?\d+(\.\d+)?$/.test(arg);
        const isDynamic = arg.includes('+') || arg.includes('jsArg(');
        const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(arg);
        const isKnownVar = ['event', 'this'].includes(arg);

        if (isQuoted || isNumeric || isDynamic || isKnownVar) continue;

        if (isIdentifier) {
          offenders.push(`onclick="${h.value}" — đối số "${arg}" không được quote`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('revokePerm phải dùng jsArg() cho staff_id', () => {
    // Tìm dòng THỰC SỰ render (bỏ qua dòng trong comment)
    const lines = html.split('\n');
    const permLine = lines.find(
      (l) => l.includes('revokePerm(') && !l.trim().startsWith('*') && !l.trim().startsWith('//')
    );
    expect(permLine).toBeTruthy();
    expect(permLine).toMatch(/revokePerm\('\s*\+\s*jsArg\(/);
    expect(permLine).not.toMatch(/revokePerm\('\s*\+\s*x\.staff_id\s*,/);
  });

  test('hàm jsArg() tồn tại và escape đúng', () => {
    expect(html).toMatch(/function\s+jsArg\s*\(/);

    const start = html.indexOf('function jsArg(');
    expect(start).toBeGreaterThan(-1);
    const bodyStart = html.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(-1);

    const fnSrc = html.slice(start, end + 1);
    // eslint-disable-next-line no-new-func
    const jsArg = new Function(`${fnSrc}; return jsArg;`)();

    expect(jsArg('giaohang01')).toBe("'giaohang01'");
    expect(jsArg("O'Brien")).toBe("'O\\'Brien'");
    expect(jsArg('a\\b')).toBe("'a\\\\b'");
    expect(jsArg(null)).toBe("''");
    expect(jsArg(undefined)).toBe("''");
  });

  test('mọi <link rel="preload"> dùng giá trị `as` hợp lệ', () => {
    const validAs = ['script', 'style', 'font', 'image', 'fetch', 'document', 'worker'];
    const re = /<link[^>]*rel=["']?preload["']?[^>]*>/gi;
    let m;
    const bad = [];
    let count = 0;
    while ((m = re.exec(html)) !== null) {
      count++;
      const tag = m[0];
      const asMatch = tag.match(/\bas=["']?([^"'\s>]+)/i);
      if (!asMatch) {
        bad.push(`${tag} — thiếu thuộc tính as`);
        continue;
      }
      if (!validAs.includes(asMatch[1].toLowerCase())) {
        bad.push(`${tag} — as="${asMatch[1]}" không hợp lệ (phải là: ${validAs.join(', ')})`);
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Panel "Thu tiền nhanh" — mở khi click vào 1 khách
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — panel Thu tiền nhanh', () => {
  test('renderCollectPanel() tồn tại và có 2 nút Thu Toàn Bộ / Thu (1 Phần)', () => {
    expect(html).toMatch(/function\s+renderCollectPanel\s*\(/);
    expect(html).toMatch(/function\s+collectAll\s*\(/);
    expect(html).toMatch(/function\s+collectPartial\s*\(/);
    expect(html).toMatch(/function\s+submitCollectPartial\s*\(/);

    expect(html).toContain('Thu Toàn Bộ');
    expect(html).toContain('Thu (1 Phần)');
  });

  test('3 hàm mới được expose ra window cho inline onclick', () => {
    expect(html).toMatch(/window\.collectAll\s*=\s*collectAll/);
    expect(html).toMatch(/window\.collectPartial\s*=\s*collectPartial/);
    expect(html).toMatch(/window\.submitCollectPartial\s*=\s*submitCollectPartial/);
  });

  test('panel được chèn vào màn chi tiết khách', () => {
    expect(html).toMatch(/renderCollectPanel\(d,\s*cust\)/);
  });

  test('collectAll gửi đúng amount = số dư công nợ của khách', () => {
    // Không được để amount rỗng / 0 — phải lấy từ d.balance
    expect(html).toMatch(/amount:\s*balance/);
    expect(html).toMatch(/customerId:\s*id,\s*amount:\s*balance/);
  });

  test('collectPartial mở modal có sẵn số tiền = số dư công nợ', () => {
    expect(html).toMatch(/id="cpAmount"/);
    expect(html).toContain('data-format-number value="\' + balance + \'"');
    expect(html).toMatch(/id="cpNote"/);
  });

  test('nút bị disable khi khách không còn nợ', () => {
    // hasDebt = balance > 0 → disabled khi không có nợ
    expect(html).toMatch(/hasDebt\s*\?\s*''\s*:\s*'disabled'/);
  });

  test('CSS cho panel thu tiền nhanh tồn tại', () => {
    expect(html).toMatch(/\.dbt-collect\s*\{/);
    expect(html).toMatch(/\.dbt-collect-title\s*\{/);
    expect(html).toMatch(/\.dbt-collect-amount\s*\{/);
    expect(html).toMatch(/\.dbt-quick-btn\.partial:hover/);
  });

  test('hàm collectAll / collectPartial dùng đúng API endpoint', () => {
    const all = html.slice(html.indexOf('function collectAll('), html.indexOf('function collectPartial('));
    expect(all).toContain("API + '/payment'");
    expect(all).toContain("method: 'POST'");

    const partial = html.slice(html.indexOf('function submitCollectPartial('));
    expect(partial).toContain("API + '/payment'");
    expect(partial).toContain("method: 'POST'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NHẬP NHANH — chọn DẤU bằng NÚT (bàn phím điện thoại không có phím "+")
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — nhập nhanh không cần phím "+"', () => {
  test('có 2 nút chọn dấu +/−', () => {
    expect(html).toContain('id="qeSignPlus"');
    expect(html).toContain('id="qeSignMinus"');
    // Trong HTML, onclick nằm trong chuỗi JS → dấu nháy bị escape
    expect(html).toContain("setQuickSign(\\'+\\')");
    expect(html).toContain("setQuickSign(\\'-\\')");
    expect(html).toContain('window.setQuickSign = setQuickSign;');
  });

  test('ô nhập KHÔNG yêu cầu gõ dấu (placeholder chỉ số)', () => {
    // placeholder KHÔNG được chứa "+" → bàn phím mobile không có phím này
    const inputLine = html
      .split('\n')
      .find((l) => l.includes('id="qeCommand"') && l.includes('placeholder'));
    expect(inputLine).toBeTruthy();
    expect(inputLine).toContain('placeholder="1000"');
    expect(inputLine).not.toContain('placeholder="+1000"');
  });

  test('có badge hiển thị dấu đang chọn', () => {
    expect(html).toContain('id="qeSignBadge"');
    expect(html).toMatch(/\.dbt-amount-badge\.plus/);
    expect(html).toMatch(/\.dbt-amount-badge\.minus/);
  });

  test('hàm setQuickSign() tồn tại và cập nhật state', () => {
    expect(html).toMatch(/function\s+setQuickSign\s*\(/);
    const fn = html.slice(
      html.indexOf('function setQuickSign('),
      html.indexOf('function buildQuickContent(')
    );
    expect(fn).toContain("state.quickSign");
    expect(fn).toContain('qeSignPlus');
    expect(fn).toContain('qeSignMinus');
    expect(fn).toContain('qeSignBadge');
  });

  test('buildQuickContent() ghép dấu khi người dùng chỉ gõ số', () => {
    expect(html).toMatch(/function\s+buildQuickContent\s*\(/);
    const start = html.indexOf('function buildQuickContent(');
    const bodyStart = html.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(-1);
    const fnSrc = html.slice(start, end + 1);
    // eslint-disable-next-line no-new-func
    const buildQuickContent = new Function(`${fnSrc}; return buildQuickContent;`)();

    // Chỉ gõ số → ghép dấu đang chọn
    expect(buildQuickContent('1000', '+')).toBe('+1000');
    expect(buildQuickContent('1000', '-')).toBe('-1000');
    // Đã có dấu → giữ nguyên (tương thích bàn phím máy tính)
    expect(buildQuickContent('+1000', '-')).toBe('+1000');
    expect(buildQuickContent('-1000', '+')).toBe('-1000');
    // Rỗng → rỗng
    expect(buildQuickContent('', '+')).toBe('');
    expect(buildQuickContent(null, '+')).toBe('');
  });

  test('quickEntry dùng buildQuickContent khi submit', () => {
    const fn = html.slice(html.indexOf('function quickEntry('), html.indexOf('function refreshOverview('));
    expect(fn).toContain('buildQuickContent(content, state.quickSign)');
  });

  test('input chỉ nhận số + Enter để ghi nhận', () => {
    expect(html).toMatch(/function\s+bindQuickInput\s*\(/);
    const fn = html.slice(
      html.indexOf('function bindQuickInput('),
      html.indexOf('function setQuickSign(')
    );
    expect(fn).toContain("replace(/[^0-9+-]/g");
    expect(fn).toContain("e.key === 'Enter'");
    expect(fn).toContain("quickEntry('submit')");
  });

  test('nút +/− không còn dùng prompt() (bất tiện trên điện thoại)', () => {
    const fn = html.slice(html.indexOf('function quickEntry('), html.indexOf('function refreshOverview('));
    expect(fn).not.toContain('prompt(');
    expect(fn).toContain('setQuickSign(mode)');
    expect(fn).toContain('focusTarget.focus()');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bảng "Khách nợ cao nhất" — cột SĐT đã bị thay bằng "Số tiền đang nợ"
// (yêu cầu 2026-11-13): ô `.dbt-muted` từng hiện SĐT, nay hiện số tiền.
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — bảng Khách nợ cao nhất', () => {
  const overviewFn = html.slice(
    html.indexOf('function renderOverview('),
    html.indexOf('function renderCustomers(')
  );

  test('không còn cột SĐT trong bảng top debtors', () => {
    expect(overviewFn).not.toContain('<th>SĐT</th>');
    expect(overviewFn).not.toContain('dbt-muted');
  });

  test('cột "Số tiền đang nợ" hiện balance, canh phải', () => {
    expect(overviewFn).toContain('<th style="text-align:right">Số tiền đang nợ</th>');
    expect(overviewFn).toMatch(/<td class="dbt-mono dbt-amount-neg" style="text-align:right">'\s*\+\s*money\(t\.balance\)/);
  });

  test('bảng chỉ còn 2 cột: Khách hàng + Số tiền đang nợ', () => {
    const thCount = (overviewFn.match(/<th[\s>]/g) || []).length;
    expect(thCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bảng hẹp phải VỪA MÀN HÌNH ĐIỆN THOẠI (bug 2026-11-18)
// ─────────────────────────────────────────────────────────────────────────────
// Bug: `.dbt-table { min-width: 560px }` áp cho MỌI bảng → bảng 2 cột
// ("Khách hàng" + "Số tiền đang nợ") trên màn hình ~360px bị đẩy cột tiền
// ra ngoài màn hình → phải kéo ngang mới thấy số tiền nợ.
// Fix: bỏ `min-width` khỏi `.dbt-table`; bảng NHIỀU cột dùng class
//      `.dbt-table--wide` để vẫn cuộn ngang được.
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — bảng vừa màn hình điện thoại', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  test('.dbt-table KHÔNG còn min-width cứng', () => {
    // Lấy đúng khối rule `.dbt-table { ... }` (không phải `.dbt-table--wide`)
    const rule = styleBlock.match(/\.dbt-table\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).not.toContain('min-width');
  });

  test('có class .dbt-table--wide cho bảng nhiều cột', () => {
    expect(styleBlock).toMatch(/\.dbt-table--wide\s*\{[^}]*min-width:\s*560px/);
  });

  test('bảng top debtors (2 cột) dùng --narrow (vừa màn hình, KHÔNG --wide)', () => {
    const overviewFn = html.slice(
      html.indexOf('function renderOverview('),
      html.indexOf('function renderCustomers(')
    );
    expect(overviewFn).toContain('<table class="dbt-table dbt-table--narrow">');
    expect(overviewFn).not.toContain('dbt-table--wide');
  });

  test('các bảng nhiều cột ĐỀU dùng --wide (giữ được cuộn ngang)', () => {
    const tables = html.match(/<table class="dbt-table[^"]*"/g) || [];
    // 13 bảng: top debtors (hẹp) + 9 bảng rộng (giao dịch Sepay + lịch sử thông báo
    //         + bảng "Tin chưa gửi") + 2 bảng hẹp mới của tab Nhóm Zalo
    //         ("chưa liên kết" & "tất cả khách")
    expect(tables).toHaveLength(13);
    const wide = tables.filter((t) => t.includes('dbt-table--wide'));
    expect(wide).toHaveLength(9);
  });

  test('.dbt-table--narrow giữ cột tiền nowrap + tên cắt gọn', () => {
    const narrow = styleBlock.match(/\.dbt-table--narrow[^{]*\{[^}]*\}/g) || [];
    expect(narrow.length).toBeGreaterThan(0);
    const joined = narrow.join(' ');
    expect(joined).toContain('white-space: nowrap');
    expect(joined).toContain('text-overflow: ellipsis');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inline handler phải được expose ra window (IIFE → global scope)
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — inline onclick phải có hàm global tương ứng', () => {
  test('loadOmiGroups và onPickOmiGroup được expose ra window', () => {
    // Nếu thiếu → click nút "Tải danh sách nhóm từ OmiCall" báo
    // "ReferenceError: loadOmiGroups is not defined"
    expect(html).toMatch(/window\.loadOmiGroups\s*=\s*loadOmiGroups/);
    expect(html).toMatch(/window\.onPickOmiGroup\s*=\s*onPickOmiGroup/);
  });

  test('mọi hàm được gọi trong inline onclick/onchange đều tồn tại', () => {
    // Gom tất cả hàm được gọi trong attribute inline (kể cả trong string động)
    const called = new Set();
    const attrRe = /(?:onclick|onchange|onsubmit|oninput|onkeyup|onblur)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(html)) !== null) {
      const code = m[1] || m[2] || '';
      const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
      let c;
      while ((c = callRe.exec(code)) !== null) called.add(c[1]);
    }

    const allowed = new Set([
      'event', 'this', 'return', 'stopPropagation', 'preventDefault',
      'confirm', 'alert', 'prompt', 'parseInt', 'parseFloat', 'Number', 'String',
      'Boolean', 'Array', 'Object', 'JSON', 'Math', 'setTimeout', 'clearTimeout',
      'require', 'fetch', 'isNaN', 'fn', 'remove', 'add', 'replace', 'open',
    ]);

    // Hàm phải được: (a) export ra window, hoặc (b) khai báo trong file
    const exported = new Set();
    const exportRe = /window\.([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = exportRe.exec(html)) !== null) exported.add(m[1]);
    const defined = new Set();
    const defRe = /(?:^|\s)function\s+([A-Za-z_$][\w$]*)/g;
    while ((m = defRe.exec(html)) !== null) defined.add(m[1]);
    const declRe = /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = declRe.exec(html)) !== null) defined.add(m[1]);

    const missing = [...called].filter(
      (n) => !allowed.has(n) && !exported.has(n) && !defined.has(n)
    );
    expect(missing).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Nhóm Zalo — bộ lọc "chưa liên kết" + ô tìm kiếm + sao chép Group ID
// ═══════════════════════════════════════════════════════════════════════════
describe('views/debts.html — bộ lọc & thao tác với nhóm Zalo', () => {
  test('tab Nhóm Zalo có bộ lọc: đã liên kết / chưa liên kết / tất cả', () => {
    expect(html).toMatch(/function\s+setGroupFilter\s*\(/);
    expect(html).toMatch(/window\.setGroupFilter\s*=\s*setGroupFilter/);
    // 3 chip bộ lọc
    expect(html).toMatch(/Đã liên kết/);
    expect(html).toMatch(/Chưa liên kết/);
    expect(html).toMatch(/Tất cả khách/);
  });

  test('danh sách khách CHƯA liên kết nhóm được dựng từ state.groups + customer.groups', () => {
    const fn = html.slice(
      html.indexOf('function renderGroups('),
      html.indexOf('function setGroupFilter(')
    );
    expect(fn).toMatch(/var\s+linkedIds\s*=\s*\{\}/);
    expect(fn).toMatch(/c\.groups\s*&&\s*c\.groups\.length/);
    expect(fn).toMatch(/var\s+unlinked\s*=/);
  });

  test('nút Liên kết trong danh sách chưa liên kết gọi openGroupModalFor(customerId)', () => {
    expect(html).toMatch(/function\s+openGroupModalFor\s*\(/);
    expect(html).toMatch(/window\.openGroupModalFor\s*=\s*openGroupModalFor/);
    expect(html).toMatch(/onclick="openGroupModalFor\(' \+ c\.id \+ '\)"/);
  });

  test('modal có ô tìm kiếm nhóm (lọc client-side, không gọi lại API)', () => {
    expect(html).toMatch(/id="gpGroupSearch"/);
    expect(html).toMatch(/function\s+filterOmiGroups\s*\(/);
    expect(html).toMatch(/window\.filterOmiGroups\s*=\s*filterOmiGroups/);
    expect(html).toMatch(/function\s+renderOmiGroupOptions\s*\(/);
  });

  test('có ô tìm nhóm trên SERVER (Enter) — dành cho nhóm vừa tạo', () => {
    // Nhóm Zalo vừa tạo (chưa có tin nhắn) không có trong danh sách mặc định
    // → phải tìm được bằng keyword (tên nhóm hoặc convId).
    expect(html).toMatch(/function\s+searchOmiGroups\s*\(/);
    expect(html).toMatch(/window\.searchOmiGroups\s*=\s*searchOmiGroups/);
    expect(html).toMatch(/keyword=/);
    expect(html).toMatch(/searchOmiGroups\(this\.value\)/);
  });

  test('Group ID KHÔNG readonly + có nút sao chép', () => {
    const modal = html.slice(
      html.indexOf('function openGroupModal('),
      html.indexOf('function openGroupModalFor(')
    );
    // input gpGroupId không được readonly (readonly làm không copy được)
    expect(modal).toMatch(/id="gpGroupId"/);
    expect(modal).not.toMatch(/id="gpGroupId"[^>]*readonly/);
    // có nút copy
    expect(modal).toMatch(/id="gpCopyBtn"/);
    expect(html).toMatch(/function\s+copyGroupId\s*\(/);
    expect(html).toMatch(/window\.copyGroupId\s*=\s*copyGroupId/);
  });

  test('copyGroupId có fallback execCommand cho trình duyệt không hỗ trợ clipboard API', () => {
    const fn = html.slice(
      html.indexOf('function copyGroupId('),
      html.indexOf('function openPermModal(')
    );
    expect(fn).toMatch(/navigator\.clipboard/);
    expect(fn).toMatch(/execCommand\('copy'\)/);
    // Clipboard API bị reject → phải gọi fallback execCommand
    expect(fn).toMatch(/\.catch\(function\s*\(\)/);
    expect(fn).toMatch(/fallback\(\)/);
  });

  test('loadOmiGroups hỗ trợ tải thêm trang (không bỏ sót nhóm)', () => {
    const fn = html.slice(
      html.indexOf('function loadOmiGroups('),
      html.indexOf('function renderOmiGroupOptions(')
    );
    expect(fn).toMatch(/page=/);
    expect(fn).toMatch(/append/);
    expect(fn).toMatch(/state\.omiGroupPage/);
    // loại trùng theo convId
    expect(fn).toMatch(/seen\[g\.convId\]/);
  });

  test('tab Nhóm Zalo load cả danh sách khách để dựng bộ lọc', () => {
    const fn = html.slice(
      html.indexOf('function loadGroups()'),
      html.indexOf('function loadPermissions()')
    );
    expect(fn).toMatch(/API \+ '\/customers'/);
  });
});
