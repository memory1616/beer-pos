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
      'openDetail', 'quickEntry', 'showTab', 'openPaymentModal', 'openManualDebtModal',
      'openAdjustModal', 'unlinkGroup', 'openGroupModal', 'revokePerm', 'openPermModal',
      'applyReconciliation', 'closeModal', 'submitPayment', 'submitManualDebt',
      'submitAdjust', 'submitGroup', 'submitPerm', 'event', 'this', 'return',
      'stopPropagation', 'preventDefault', 'confirm', 'alert',
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
