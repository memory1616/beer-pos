/**
 * Đo tương phản thực tế của Card thưởng trên hoá đơn ở CẢ 2 THEME.
 *
 * Bối cảnh: `.promo-note--volume` dùng màu PASTEL CỐ ĐỊNH (#ddd6fe, #fde68a…)
 * → trên nền sáng (Light Mode) chữ gần như không đọc được (WCAG fail).
 *
 * Test này chốt lại NGƯỠNG tương phản tối thiểu cho từng biến thể card,
 * để sau này ai sửa màu cũng biết phải đạt chuẩn gì.
 */
const fs = require('fs');
const path = require('path');
const { contrastRatio, composite } = require('./helpers/contrast');

const UNIFIED = path.join(__dirname, '..', 'public', 'css', 'unified.css');
const css = fs.readFileSync(UNIFIED, 'utf8');

/** Trích nội dung 1 rule block của CSS theo selector */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Cho phép selector nằm ngay sau "}" hoặc đầu file (không bắt buộc có newline trước)
  const re = new RegExp('(?:^|[}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  return m ? m[1] : '';
}

function pickColor(body, prop) {
  const m = body.match(new RegExp(prop + '\\s*:\\s*([^;]+);'));
  return m ? m[1].trim() : '';
}

// ── Nền thực tế của card trong từng theme ────────────────────────────────
// Light: card nền trắng (#FFFFFF) — token --bg-card
// Dark:  card nền #1E2329 — token --bg-card
const THEMES = {
  light: { bgCard: '#FFFFFF', bgPage: '#F8FAFC' },
  dark: { bgCard: '#1E2329', bgPage: '#0B0E11' },
};

// Ngưỡng WCAG 2.1 AA
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

describe('Contrast Card thưởng (promo-note--volume) — WCAG 2.1 AA', () => {
  // ── 1. Card phải dùng TOKEN, không hardcode màu pastel ──────────────────
  test('màu chữ card thưởng phải qua CSS variable (không hex cố định)', () => {
    // Màu chữ nền của card (áp cho .promo-note__title chung)
    const baseRule = ruleBody('.promo-note--volume .promo-note__title');
    expect(pickColor(baseRule, 'color')).toMatch(/var\(--/);

    // Biến thể "chưa đạt mốc" (cam)
    const pendingRule = ruleBody('.promo-note--volume.is-pending .promo-note__title');
    expect(pickColor(pendingRule, 'color')).toMatch(/var\(--/);

    // Biến thể "thưởng quán mới" (hổ phách)
    const newshopRule = ruleBody('.promo-note--volume.is-newshop .promo-note__title');
    expect(pickColor(newshopRule, 'color')).toMatch(/var\(--/);
  });

  // ── 2. Nền card phải qua token ─────────────────────────────────────────
  test('nền card thưởng phải qua CSS variable', () => {
    const body = ruleBody('.promo-note--volume.is-reward');
    const bg = pickColor(body, 'background');
    expect(bg).toMatch(/var\(--/);
  });

  // ── 3. Tương phản thực tế trên từng theme ─────────────────────────────
  // Lấy màu chữ đang dùng trong CSS (nếu là var thì map sang giá trị theme)
  const TEXT_TOKEN_MAP = {
    // Ánh xạ token → giá trị hex theo theme (KHỚP với public/css/tokens.css)
    '--promo-title': { light: '#6D28D9', dark: '#C084FC' },
    '--promo-text': { light: '#5B21B6', dark: '#DDD6FE' },
    '--promo-strong': { light: '#5B21B6', dark: '#F0ABFC' },
    '--promo-pending-title': { light: '#946200', dark: '#FBBF24' },
    '--promo-pending-text': { light: '#78350F', dark: '#FDE68A' },
    '--promo-pending-strong': { light: '#78350F', dark: '#FCD34D' },
    '--promo-newshop-title': { light: '#946200', dark: '#FCD34D' },
    '--promo-newshop-text': { light: '#78350F', dark: '#FEF3C7' },
    '--promo-newshop-strong': { light: '#78350F', dark: '#FBBF24' },
    '--promo-card-bg': { light: '#F5F0FF', dark: '#1E1B2E' },
    '--promo-card-border': { light: '#8B5CF6', dark: '#A78BFA' },
  };

  test('mọi tổ hợp chữ/nền card thưởng đạt WCAG AA ở CẢ 2 theme', () => {
    const failures = [];

    Object.keys(THEMES).forEach((theme) => {
      const t = THEMES[theme];
      const cardBg = TEXT_TOKEN_MAP['--promo-card-bg'][theme];
      const isLight = theme === 'light';

      const pairs = isLight
        ? [
            ['title', TEXT_TOKEN_MAP['--promo-title'].light, cardBg],
            ['text', TEXT_TOKEN_MAP['--promo-text'].light, cardBg],
            ['strong', TEXT_TOKEN_MAP['--promo-strong'].light, cardBg],
            ['pending title', TEXT_TOKEN_MAP['--promo-pending-title'].light, cardBg],
            ['pending text', TEXT_TOKEN_MAP['--promo-pending-text'].light, cardBg],
            ['pending strong', TEXT_TOKEN_MAP['--promo-pending-strong'].light, cardBg],
            ['newshop title', TEXT_TOKEN_MAP['--promo-newshop-title'].light, cardBg],
            ['newshop text', TEXT_TOKEN_MAP['--promo-newshop-text'].light, cardBg],
            ['newshop strong', TEXT_TOKEN_MAP['--promo-newshop-strong'].light, cardBg],
          ]
        : [
            ['title', TEXT_TOKEN_MAP['--promo-title'].dark, cardBg],
            ['text', TEXT_TOKEN_MAP['--promo-text'].dark, cardBg],
            ['strong', TEXT_TOKEN_MAP['--promo-strong'].dark, cardBg],
            ['pending title', TEXT_TOKEN_MAP['--promo-pending-title'].dark, cardBg],
            ['pending text', TEXT_TOKEN_MAP['--promo-pending-text'].dark, cardBg],
            ['pending strong', TEXT_TOKEN_MAP['--promo-pending-strong'].dark, cardBg],
            ['newshop title', TEXT_TOKEN_MAP['--promo-newshop-title'].dark, cardBg],
            ['newshop text', TEXT_TOKEN_MAP['--promo-newshop-text'].dark, cardBg],
            ['newshop strong', TEXT_TOKEN_MAP['--promo-newshop-strong'].dark, cardBg],
          ];

      pairs.forEach(([label, fg, bg]) => {
        const ratio = contrastRatio(fg, bg);
        const min = label.includes('title') ? AA_LARGE : AA_NORMAL;
        if (ratio < min) {
          failures.push(
            `${theme} / ${label}: ${fg} trên ${bg} = ${ratio.toFixed(2)}:1 (cần ≥ ${min}:1)`
          );
        }
      });
    });

    expect(failures).toEqual([]);
  });

  // ── 4. Viền card đủ tương phản (≥3:1 cho UI component) ───────────────
  test('viền card thưởng đạt ≥ 3:1 so với nền card', () => {
    Object.keys(THEMES).forEach((theme) => {
      const cardBg = TEXT_TOKEN_MAP['--promo-card-bg'][theme];
      const border = TEXT_TOKEN_MAP['--promo-card-border'][theme];
      const ratio = contrastRatio(border, cardBg);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });
  });
});

describe('Contrast nền chữ chính (text tokens) — WCAG 2.1 AA', () => {
  const TEXT_PAIRS = {
    light: {
      '--text-primary': '#1E293B',
      '--text-secondary': '#475569',
      '--text-disabled': '#94A3B8',
    },
    dark: {
      '--text-primary': '#EAECEF',
      '--text-secondary': '#848E9C',
      '--text-disabled': '#5E6673',
    },
  };

  test('text-primary đạt AA trên nền trang & nền card', () => {
    Object.keys(THEMES).forEach((theme) => {
      const fg = TEXT_PAIRS[theme]['--text-primary'];
      expect(contrastRatio(fg, THEMES[theme].bgPage)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrastRatio(fg, THEMES[theme].bgCard)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  test('text-secondary đạt AA trên nền trang & nền card', () => {
    Object.keys(THEMES).forEach((theme) => {
      const fg = TEXT_PAIRS[theme]['--text-secondary'];
      expect(contrastRatio(fg, THEMES[theme].bgPage)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrastRatio(fg, THEMES[theme].bgCard)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  test('placeholder input đọc được (≥4.5:1)', () => {
    // placeholder = --text-secondary trên --input-bg (--bg-secondary)
    const INPUT_BG = { light: '#F1F5F9', dark: '#161A1E' };
    Object.keys(THEMES).forEach((theme) => {
      const fg = TEXT_PAIRS[theme]['--text-secondary'];
      expect(contrastRatio(fg, INPUT_BG[theme])).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });
});
