/**
 * Verify contrast THỰC TẾ trên production:
 * đọc tokens.css + unified.css từ server, tính contrast cho từng biến thể card thưởng.
 */
const { contrastRatio } = require('../tests/helpers/contrast');

const BASE = process.env.BASE_URL || 'https://admin.biatuoitayninh.store';

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'Cache-Control': 'no-cache' } });
  return r.text();
}

/** Trích giá trị 1 token trong 1 block CSS (selector cụ thể) */
function tokenIn(css, blockSelector, token) {
  // Tách selector thành các phần riêng (`:root.light,` / `:root[data-theme="light"]`)
  const parts = blockSelector.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const esc = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp('(?:^|[}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}'));
    if (!m) continue;
    const t = m[1].match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+);'));
    if (t) return t[1].trim();
  }
  return null;
}

(async () => {
  const tokens = await get('/css/tokens.css');
  const unified = await get('/css/unified.css');

  const THEMES = {
    light: ':root.light, :root[data-theme="light"]',
    dark: ':root.dark, :root[data-theme="dark"]',
  };

  // Nhóm: [nhãn, token nền card, token chữ tiêu đề, token chữ nội dung, token chữ strong]
  const GROUPS = [
    ['is-reward / is-newshop (the tim)', '--promo-card-bg', '--promo-title', '--promo-text', '--promo-strong'],
    ['is-pending (the cam)', '--promo-pending-bg', '--promo-pending-title', '--promo-pending-text', '--promo-pending-strong'],
  ];

  let allPass = true;
  const rows = [];

  for (const [theme, sel] of Object.entries(THEMES)) {
    for (const [label, bgTok, titleTok, textTok, strongTok] of GROUPS) {
      const bg = tokenIn(tokens, sel, bgTok);
      const title = tokenIn(tokens, sel, titleTok);
      const text = tokenIn(tokens, sel, textTok);
      const strong = tokenIn(tokens, sel, strongTok);
      if (!bg || !title || !text || !strong) {
        rows.push({ theme, label, status: 'THIEU TOKEN', bg, title, text, strong });
        allPass = false;
        continue;
      }
      const rTitle = contrastRatio(title, bg);
      const rText = contrastRatio(text, bg);
      const rStrong = contrastRatio(strong, bg);
      const ok = rTitle >= 3 && rText >= 4.5 && rStrong >= 4.5;
      if (!ok) allPass = false;
      rows.push({
        theme,
        label,
        bg,
        title: title + ' (' + rTitle.toFixed(2) + ':1)',
        text: text + ' (' + rText.toFixed(2) + ':1)',
        strong: strong + ' (' + rStrong.toFixed(2) + ':1)',
        status: ok ? 'PASS' : 'FAIL',
      });
    }
  }

  console.log('\n=== CONTRAST CARD THUONG TREN PRODUCTION ===\n');
  for (const r of rows) {
    console.log('[' + r.status + '] ' + r.theme.toUpperCase() + ' - ' + r.label);
    console.log('   nen     : ' + r.bg);
    console.log('   tieu de : ' + r.title);
    console.log('   noi dung: ' + r.text);
    console.log('   so manh : ' + r.strong);
    console.log('');
  }

  // Kiểm tra: card thuong KHONG duoc dung hex cung
  const hardcoded = [...unified.matchAll(/\.promo-note--volume[^{]*\{[^}]*color:\s*#[0-9a-f]{3,8}/gi)];
  console.log('Hex cung trong .promo-note--volume: ' + hardcoded.length + ' (mong doi 0)');
  if (hardcoded.length) allPass = false;

  console.log('\nKET QUA: ' + (allPass ? 'PASS' : 'FAIL'));
  process.exit(allPass ? 0 : 1);
})();
