/**
 * Sinh SVG minh họa cho homepage (public/images/home/src/*.svg).
 * Vì script .js ghi UTF-8 chuẩn (khác với .svg bị lỗi encoding), toàn bộ
 * artwork được sinh từ đây rồi render sang WebP bởi scripts/render-home-images.js.
 *
 * Lưu ý: đây là HÌNH MINH HỌA vector, không phải ảnh chụp thực tế của
 * kho/đội xe. Giao diện ghi rõ "hình minh họa" để không gây hiểu nhầm.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'images', 'home', 'src');

/* ─────────────────────────  HERO: ly bia vàng  ───────────────────────── */
const HERO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0e11"/>
      <stop offset="55%" stop-color="#12161b"/>
      <stop offset="100%" stop-color="#05070a"/>
    </linearGradient>
    <radialGradient id="glowGold" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ffcf4d" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="#f5b800" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#f5b800" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowWarm" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ff9d2e" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ff9d2e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="beer" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd34d"/>
      <stop offset="35%" stop-color="#f2a413"/>
      <stop offset="78%" stop-color="#d97b06"/>
      <stop offset="100%" stop-color="#a94f02"/>
    </linearGradient>
    <linearGradient id="beerSide" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="28%" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="78%" stop-color="#000000" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.42"/>
    </linearGradient>
    <linearGradient id="foam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="55%" stop-color="#fdf6e3"/>
      <stop offset="100%" stop-color="#eadfc2"/>
    </linearGradient>
    <linearGradient id="glassSheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#ffd76a" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.75"/>
    </linearGradient>
    <filter id="softBlur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>
    <filter id="dropShadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="26" stdDeviation="26" flood-color="#000" flood-opacity="0.7"/>
    </filter>
    <clipPath id="glassClip">
      <path d="M600 250 L620 760 Q620 790 650 790 L950 790 Q980 790 980 760 L1000 250 Z"/>
    </clipPath>
  </defs>

  <rect width="1600" height="900" fill="url(#bg)"/>

  <ellipse cx="1180" cy="250" rx="520" ry="420" fill="url(#glowGold)" filter="url(#softBlur)"/>
  <ellipse cx="330" cy="700" rx="420" ry="320" fill="url(#glowWarm)" filter="url(#softBlur)"/>

  <g opacity="0.10" transform="rotate(-18 800 450)">
    <rect x="240" y="-200" width="120" height="1400" fill="#ffd76a"/>
    <rect x="520" y="-200" width="46" height="1400" fill="#ffd76a"/>
    <rect x="1180" y="-200" width="90" height="1400" fill="#ffd76a"/>
  </g>

  <rect x="0" y="778" width="1600" height="122" fill="#0a0c0f"/>
  <rect x="0" y="778" width="1600" height="5" fill="#f5b800" opacity="0.35"/>
  <ellipse cx="800" cy="800" rx="330" ry="34" fill="#f5b800" opacity="0.12" filter="url(#softBlur)"/>

  <g filter="url(#dropShadow)">
    <path d="M600 250 L620 760 Q620 790 650 790 L950 790 Q980 790 980 760 L1000 250 Z"
          fill="#0f1418" fill-opacity="0.55" stroke="url(#rim)" stroke-width="7"/>

    <g clip-path="url(#glassClip)">
      <rect x="590" y="300" width="420" height="500" fill="url(#beer)"/>
      <rect x="590" y="300" width="420" height="500" fill="url(#beerSide)"/>
      <path d="M590 318 Q640 300 690 314 Q740 296 790 312 Q840 294 890 310 Q940 296 990 314 L1010 300 L1010 262 L590 262 Z" fill="url(#foam)"/>
      <g fill="url(#foam)">
        <circle cx="646" cy="272" r="34"/>
        <circle cx="702" cy="258" r="40"/>
        <circle cx="762" cy="272" r="32"/>
        <circle cx="818" cy="256" r="42"/>
        <circle cx="878" cy="270" r="33"/>
        <circle cx="936" cy="258" r="38"/>
        <circle cx="978" cy="272" r="30"/>
      </g>
      <ellipse cx="700" cy="470" rx="60" ry="180" fill="#fff6cf" opacity="0.18"/>
    </g>

    <ellipse cx="800" cy="252" rx="200" ry="30" fill="none" stroke="url(#rim)" stroke-width="8"/>
    <ellipse cx="800" cy="254" rx="182" ry="24" fill="#fffaf0" opacity="0.16"/>

    <path d="M636 290 L652 748" stroke="url(#glassSheen)" stroke-width="17" stroke-linecap="round" opacity="0.75"/>
    <path d="M962 300 L948 720" stroke="#ffffff" stroke-width="8" stroke-linecap="round" opacity="0.16"/>

    <g fill="#ffffff" opacity="0.30">
      <ellipse cx="700" cy="420" rx="9" ry="13"/>
      <ellipse cx="726" cy="520" rx="7" ry="10"/>
      <ellipse cx="686" cy="596" rx="8" ry="11"/>
      <ellipse cx="930" cy="452" rx="8" ry="11"/>
      <ellipse cx="912" cy="580" rx="6" ry="9"/>
    </g>
  </g>

  <g fill="#ffffff">
    <circle cx="724" cy="404" r="7" opacity="0.42"/>
    <circle cx="756" cy="352" r="5" opacity="0.34"/>
    <circle cx="866" cy="396" r="6" opacity="0.38"/>
    <circle cx="838" cy="470" r="4" opacity="0.28"/>
    <circle cx="690" cy="500" r="5" opacity="0.30"/>
    <circle cx="884" cy="560" r="7" opacity="0.34"/>
    <circle cx="748" cy="600" r="6" opacity="0.26"/>
  </g>

  <g fill="#ffd76a">
    <ellipse cx="1140" cy="300" rx="9" ry="14" opacity="0.42"/>
    <ellipse cx="1204" cy="392" rx="7" ry="11" opacity="0.30"/>
    <ellipse cx="470" cy="238" rx="8" ry="12" opacity="0.34"/>
    <ellipse cx="398" cy="336" rx="6" ry="9" opacity="0.26"/>
  </g>

  <g fill="#ffe6a8">
    <circle cx="1350" cy="180" r="3" opacity="0.45"/>
    <circle cx="1420" cy="420" r="2" opacity="0.35"/>
    <circle cx="250" cy="430" r="3" opacity="0.32"/>
    <circle cx="180" cy="250" r="2" opacity="0.40"/>
    <circle cx="1290" cy="640" r="2.5" opacity="0.28"/>
    <circle cx="300" cy="120" r="2" opacity="0.36"/>
  </g>
</svg>
`;

/* ───────────────────────  WAREHOUSE: kho bia phân phối  ─────────────────────── */
const WAREHOUSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <defs>
    <linearGradient id="wbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#10151a"/>
      <stop offset="100%" stop-color="#070a0d"/>
    </linearGradient>
    <linearGradient id="wbeam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd76a" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffd76a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="kegMetal" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4a545c"/>
      <stop offset="35%" stop-color="#8d99a2"/>
      <stop offset="70%" stop-color="#3b444b"/>
      <stop offset="100%" stop-color="#232a30"/>
    </linearGradient>
    <linearGradient id="kegGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffcf4d"/>
      <stop offset="100%" stop-color="#c98a06"/>
    </linearGradient>
    <filter id="wblur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="20"/>
    </filter>
  </defs>

  <rect width="1200" height="800" fill="url(#wbg)"/>

  <rect x="150" y="40" width="900" height="420" fill="url(#wbeam)" opacity="0.5"/>
  <rect x="180" y="40" width="840" height="14" rx="7" fill="#ffe6a8" opacity="0.5"/>
  <ellipse cx="600" cy="60" rx="420" ry="34" fill="#ffd76a" opacity="0.28" filter="url(#wblur)"/>

  <rect x="0" y="620" width="1200" height="180" fill="#0a0d10"/>
  <rect x="0" y="618" width="1200" height="4" fill="#f5b800" opacity="0.22"/>

  <g opacity="0.5">
    <rect x="80" y="200" width="12" height="430" fill="#2b3238"/>
    <rect x="500" y="200" width="12" height="430" fill="#2b3238"/>
    <rect x="700" y="200" width="12" height="430" fill="#2b3238"/>
    <rect x="1110" y="200" width="12" height="430" fill="#2b3238"/>
    <rect x="80" y="360" width="1042" height="10" fill="#333b42"/>
    <rect x="80" y="520" width="1042" height="10" fill="#333b42"/>
  </g>

  <g>
    <rect x="120" y="470" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="120" y="470" width="230" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
    <rect x="370" y="470" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="370" y="470" width="230" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
    <rect x="620" y="470" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="620" y="470" width="230" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
    <rect x="870" y="470" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="870" y="470" width="230" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
  </g>
  <g opacity="0.92">
    <rect x="120" y="398" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="120" y="398" width="230" height="16" rx="6" fill="#f5b800" opacity="0.4"/>
    <rect x="370" y="398" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="370" y="398" width="230" height="16" rx="6" fill="#f5b800" opacity="0.4"/>
    <rect x="620" y="398" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="620" y="398" width="230" height="16" rx="6" fill="#f5b800" opacity="0.4"/>
    <rect x="870" y="398" width="230" height="60" rx="8" fill="url(#kegMetal)"/>
    <rect x="870" y="398" width="230" height="16" rx="6" fill="#f5b800" opacity="0.4"/>
  </g>

  <g>
    <ellipse cx="600" cy="250" rx="92" ry="26" fill="url(#kegGold)"/>
    <path d="M508 250 L512 300 Q512 318 530 318 L670 318 Q688 318 688 300 L692 250 Z" fill="url(#kegGold)"/>
    <ellipse cx="600" cy="250" rx="92" ry="26" fill="none" stroke="#fff3cf" stroke-width="4" opacity="0.8"/>
    <rect x="520" y="272" width="160" height="8" fill="#8a5a02" opacity="0.45"/>
    <rect x="588" y="196" width="24" height="18" rx="5" fill="#cbb27a"/>
    <rect x="576" y="214" width="48" height="10" rx="4" fill="#9c854f"/>
  </g>

  <g>
    <rect x="440" y="600" width="320" height="26" rx="4" fill="#6b4f28"/>
    <rect x="440" y="626" width="320" height="12" rx="3" fill="#4e3a1c"/>
    <rect x="470" y="638" width="28" height="26" fill="#3c2c14"/>
    <rect x="586" y="638" width="28" height="26" fill="#3c2c14"/>
    <rect x="702" y="638" width="28" height="26" fill="#3c2c14"/>
  </g>

  <g transform="translate(960, 430)">
    <rect x="0" y="120" width="150" height="16" rx="6" fill="#3b444b"/>
    <rect x="10" y="60" width="130" height="60" rx="6" fill="url(#kegMetal)"/>
    <rect x="10" y="60" width="130" height="14" rx="5" fill="#f5b800" opacity="0.45"/>
    <rect x="60" y="136" width="10" height="60" fill="#4a545c"/>
    <rect x="18" y="196" width="22" height="22" rx="11" fill="#1a1f24"/>
    <rect x="98" y="196" width="22" height="22" rx="11" fill="#1a1f24"/>
    <rect x="126" y="0" width="10" height="124" fill="#4a545c"/>
    <rect x="112" y="0" width="38" height="10" rx="5" fill="#4a545c"/>
  </g>

  <g transform="translate(190, 300)">
    <circle cx="40" cy="40" r="26" fill="#2c333a"/>
    <path d="M4 90 Q4 62 40 62 Q76 62 76 90 L82 230 Q82 250 62 250 L18 250 Q-2 250 -2 230 Z" fill="#232a30"/>
    <rect x="10" y="250" width="22" height="130" rx="8" fill="#1a2026"/>
    <rect x="48" y="250" width="22" height="130" rx="8" fill="#1a2026"/>
    <path d="M70 80 L110 150" stroke="#2c333a" stroke-width="16" stroke-linecap="round"/>
    <rect x="96" y="140" width="34" height="46" rx="5" fill="url(#kegMetal)"/>
    <rect x="96" y="140" width="34" height="12" rx="4" fill="#f5b800" opacity="0.5"/>
  </g>

  <ellipse cx="600" cy="676" rx="330" ry="26" fill="#000" opacity="0.5" filter="url(#wblur)"/>
</svg>
`;

/* ───────────────────────  DELIVERY: xe giao hàng bia  ─────────────────────── */
const DELIVERY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <defs>
    <linearGradient id="dbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d1217"/>
      <stop offset="60%" stop-color="#131a20"/>
      <stop offset="100%" stop-color="#070a0d"/>
    </linearGradient>
    <linearGradient id="dawn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffb545" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffb545" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="vanBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f2f5f7"/>
      <stop offset="55%" stop-color="#cfd6db"/>
      <stop offset="100%" stop-color="#8d979e"/>
    </linearGradient>
    <linearGradient id="vanBand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffcc00"/>
      <stop offset="100%" stop-color="#d99b00"/>
    </linearGradient>
    <linearGradient id="keg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4a545c"/>
      <stop offset="35%" stop-color="#8d99a2"/>
      <stop offset="72%" stop-color="#3b444b"/>
      <stop offset="100%" stop-color="#232a30"/>
    </linearGradient>
    <filter id="dblur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
  </defs>

  <rect width="1200" height="800" fill="url(#dbg)"/>
  <rect x="0" y="0" width="1200" height="420" fill="url(#dawn)"/>
  <circle cx="900" cy="180" r="90" fill="#ffcf4d" opacity="0.20" filter="url(#dblur)"/>

  <rect x="0" y="520" width="1200" height="280" fill="#0a0d10"/>
  <rect x="0" y="520" width="1200" height="5" fill="#f5b800" opacity="0.25"/>
  <g fill="#f5b800" opacity="0.45">
    <rect x="80" y="672" width="150" height="10" rx="5"/>
    <rect x="330" y="672" width="150" height="10" rx="5"/>
    <rect x="580" y="672" width="150" height="10" rx="5"/>
    <rect x="830" y="672" width="150" height="10" rx="5"/>
    <rect x="1080" y="672" width="100" height="10" rx="5"/>
  </g>

  <rect x="0" y="470" width="1200" height="52" fill="#12171c"/>
  <rect x="0" y="470" width="1200" height="4" fill="#2b3238"/>

  <g opacity="0.45" fill="#161c22">
    <rect x="40" y="290" width="180" height="190" rx="6"/>
    <rect x="250" y="340" width="130" height="140" rx="6"/>
    <rect x="1020" y="320" width="150" height="160" rx="6"/>
  </g>
  <g opacity="0.35" fill="#ffcc00">
    <rect x="60" y="320" width="36" height="26" rx="4"/>
    <rect x="120" y="320" width="36" height="26" rx="4"/>
    <rect x="60" y="380" width="36" height="26" rx="4"/>
    <rect x="1040" y="350" width="34" height="24" rx="4"/>
    <rect x="1090" y="350" width="34" height="24" rx="4"/>
  </g>

  <g transform="translate(120, 210)">
    <rect x="200" y="60" width="600" height="290" rx="18" fill="url(#vanBody)"/>
    <rect x="200" y="60" width="600" height="290" rx="18" fill="none" stroke="#7e888f" stroke-width="3"/>
    <rect x="200" y="150" width="600" height="62" fill="url(#vanBand)"/>
    <text x="500" y="192" font-family="Verdana, DejaVu Sans, sans-serif" font-weight="bold" font-size="34" text-anchor="middle" fill="#1a1208">TÂY NINH BIA TƯƠI</text>
    <rect x="222" y="80" width="150" height="80" rx="6" fill="#b9c2c8" opacity="0.55"/>
    <rect x="600" y="80" width="180" height="80" rx="6" fill="#b9c2c8" opacity="0.4"/>
    <path d="M20 350 L20 130 Q20 96 56 96 L150 96 Q176 96 186 118 L214 160 L214 350 Z" fill="url(#vanBody)"/>
    <path d="M20 350 L20 130 Q20 96 56 96 L150 96 Q176 96 186 118 L214 160 L214 350 Z" fill="none" stroke="#7e888f" stroke-width="3"/>
    <path d="M42 140 L42 108 Q42 100 54 100 L140 100 Q152 100 158 114 L176 142 Z" fill="#2a3f4d" opacity="0.85"/>
    <rect x="20" y="230" width="194" height="18" fill="url(#vanBand)"/>
    <rect x="8" y="286" width="16" height="34" rx="5" fill="#ffe6a8"/>
    <g fill="#15191d">
      <circle cx="96" cy="352" r="52"/>
      <circle cx="620" cy="352" r="52"/>
      <circle cx="720" cy="352" r="52"/>
    </g>
    <g fill="#6e7880">
      <circle cx="96" cy="352" r="22"/>
      <circle cx="620" cy="352" r="22"/>
      <circle cx="720" cy="352" r="22"/>
    </g>
    <g fill="#8d99a2">
      <circle cx="96" cy="352" r="12"/>
      <circle cx="620" cy="352" r="12"/>
      <circle cx="720" cy="352" r="12"/>
    </g>
  </g>

  <g transform="translate(430, 300)">
    <rect x="0" y="0" width="220" height="58" rx="8" fill="url(#keg)"/>
    <rect x="0" y="0" width="220" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
    <rect x="238" y="0" width="220" height="58" rx="8" fill="url(#keg)"/>
    <rect x="238" y="0" width="220" height="16" rx="6" fill="#f5b800" opacity="0.5"/>
  </g>

  <g transform="translate(900, 330)">
    <circle cx="34" cy="34" r="24" fill="#2c333a"/>
    <path d="M2 76 Q2 52 34 52 Q66 52 66 76 L72 196 Q72 214 54 214 L14 214 Q-4 214 -4 196 Z" fill="#232a30"/>
    <rect x="8" y="214" width="20" height="110" rx="8" fill="#1a2026"/>
    <rect x="44" y="214" width="20" height="110" rx="8" fill="#1a2026"/>
    <path d="M62 68 L104 128" stroke="#2c333a" stroke-width="15" stroke-linecap="round"/>
    <rect x="86" y="120" width="30" height="42" rx="5" fill="url(#keg)"/>
    <rect x="86" y="120" width="30" height="11" rx="4" fill="#f5b800" opacity="0.5"/>
  </g>

  <path d="M100 500 L-60 620 L-60 380 Z" fill="#ffe6a8" opacity="0.10"/>
  <path d="M100 500 L40 620 L-40 380 Z" fill="#ffe6a8" opacity="0.10"/>

  <g fill="#c9ced3" opacity="0.14">
    <ellipse cx="1050" cy="600" rx="90" ry="22"/>
    <ellipse cx="1130" cy="580" rx="60" ry="16"/>
    <ellipse cx="980" cy="626" rx="50" ry="13"/>
  </g>
</svg>
`;

/* ─────────────────────  PROMOTION: bia thưởng sản lượng  ───────────────────── */
const PROMOTION = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <defs>
    <linearGradient id="pbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#12100a"/>
      <stop offset="50%" stop-color="#1a1509"/>
      <stop offset="100%" stop-color="#07070a"/>
    </linearGradient>
    <radialGradient id="pglow" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0%" stop-color="#ffd76a" stop-opacity="0.5"/>
      <stop offset="55%" stop-color="#f5b800" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#f5b800" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="pbeer" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd34d"/>
      <stop offset="60%" stop-color="#e89709"/>
      <stop offset="100%" stop-color="#a85402"/>
    </linearGradient>
    <linearGradient id="pglass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="30%" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="pkeg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4a545c"/>
      <stop offset="35%" stop-color="#95a1aa"/>
      <stop offset="72%" stop-color="#3b444b"/>
      <stop offset="100%" stop-color="#232a30"/>
    </linearGradient>
    <linearGradient id="pribbon" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffcc00"/>
      <stop offset="100%" stop-color="#ff8a00"/>
    </linearGradient>
    <filter id="pblur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="24"/>
    </filter>
    <filter id="pshadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000" flood-opacity="0.65"/>
    </filter>
  </defs>

  <rect width="1200" height="800" fill="url(#pbg)"/>
  <ellipse cx="600" cy="380" rx="520" ry="400" fill="url(#pglow)"/>

  <g opacity="0.10" transform="rotate(-22 600 400)">
    <rect x="120" y="-260" width="90" height="1400" fill="#ffd76a"/>
    <rect x="640" y="-260" width="130" height="1400" fill="#ffd76a"/>
    <rect x="1000" y="-260" width="60" height="1400" fill="#ffd76a"/>
  </g>

  <rect x="0" y="660" width="1200" height="140" fill="#0a0806"/>
  <rect x="0" y="658" width="1200" height="4" fill="#f5b800" opacity="0.35"/>
  <ellipse cx="600" cy="690" rx="380" ry="36" fill="#f5b800" opacity="0.14" filter="url(#pblur)"/>

  <g filter="url(#pshadow)">
    <rect x="720" y="430" width="330" height="86" rx="10" fill="url(#pkeg)"/>
    <rect x="720" y="430" width="330" height="22" rx="8" fill="url(#pribbon)" opacity="0.85"/>
    <rect x="720" y="466" width="330" height="10" fill="#0f0c07" opacity="0.55"/>
    <rect x="700" y="380" width="300" height="72" rx="10" fill="url(#pkeg)" opacity="0.95"/>
    <rect x="700" y="380" width="300" height="20" rx="8" fill="url(#pribbon)" opacity="0.7"/>
  </g>

  <g filter="url(#pshadow)">
    <g transform="translate(300, 0)">
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pbeer)"/>
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pglass)"/>
      <path d="M46 300 L46 190 Q46 176 62 168 L74 160 Q84 154 84 140 L84 96 L116 96 L116 140 Q116 154 126 160 L138 168 Q154 176 154 190 L154 300 Z" fill="none" stroke="#ffd76a" stroke-width="3" stroke-opacity="0.5"/>
      <rect x="58" y="200" width="84" height="62" rx="5" fill="#12100a" opacity="0.82"/>
      <rect x="58" y="200" width="84" height="12" rx="4" fill="url(#pribbon)"/>
      <circle cx="100" cy="238" r="15" fill="none" stroke="#ffd76a" stroke-width="3" opacity="0.85"/>
      <rect x="76" y="250" width="48" height="5" rx="2" fill="#ffd76a" opacity="0.7"/>
      <rect x="84" y="84" width="32" height="16" rx="3" fill="#cbb27a"/>
    </g>
    <g transform="translate(410, -50)">
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pbeer)"/>
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pglass)"/>
      <path d="M46 300 L46 190 Q46 176 62 168 L74 160 Q84 154 84 140 L84 96 L116 96 L116 140 Q116 154 126 160 L138 168 Q154 176 154 190 L154 300 Z" fill="none" stroke="#ffd76a" stroke-width="3" stroke-opacity="0.6"/>
      <rect x="58" y="196" width="84" height="70" rx="5" fill="#12100a" opacity="0.85"/>
      <rect x="58" y="196" width="84" height="14" rx="4" fill="url(#pribbon)"/>
      <circle cx="100" cy="238" r="17" fill="none" stroke="#ffd76a" stroke-width="3.5" opacity="0.9"/>
      <path d="M92 238 l6 7 11 -14" fill="none" stroke="#ffd76a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="74" y="256" width="52" height="5" rx="2" fill="#ffd76a" opacity="0.7"/>
      <rect x="84" y="84" width="32" height="16" rx="3" fill="#cbb27a"/>
      <ellipse cx="82" cy="170" rx="10" ry="60" fill="#fff6cf" opacity="0.28"/>
    </g>
    <g transform="translate(520, 0)">
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pbeer)"/>
      <path d="M52 292 L52 192 Q52 180 66 172 L78 164 Q88 158 88 142 L88 100 L112 100 L112 142 Q112 158 122 164 L134 172 Q148 180 148 192 L148 292 Z" fill="url(#pglass)"/>
      <path d="M46 300 L46 190 Q46 176 62 168 L74 160 Q84 154 84 140 L84 96 L116 96 L116 140 Q116 154 126 160 L138 168 Q154 176 154 190 L154 300 Z" fill="none" stroke="#ffd76a" stroke-width="3" stroke-opacity="0.5"/>
      <rect x="58" y="200" width="84" height="62" rx="5" fill="#12100a" opacity="0.8"/>
      <rect x="58" y="200" width="84" height="12" rx="4" fill="url(#pribbon)"/>
      <circle cx="100" cy="238" r="15" fill="none" stroke="#ffd76a" stroke-width="3" opacity="0.8"/>
      <rect x="76" y="250" width="48" height="5" rx="2" fill="#ffd76a" opacity="0.65"/>
      <rect x="84" y="84" width="32" height="16" rx="3" fill="#cbb27a"/>
    </g>
  </g>

  <g fill="#ffe6a8">
    <circle cx="250" cy="200" r="4" opacity="0.55"/>
    <circle cx="720" cy="180" r="3" opacity="0.45"/>
    <circle cx="1040" cy="280" r="4" opacity="0.5"/>
    <circle cx="1130" cy="440" r="3" opacity="0.38"/>
    <circle cx="150" cy="380" r="3" opacity="0.42"/>
    <circle cx="620" cy="120" r="3" opacity="0.48"/>
    <circle cx="900" cy="620" r="3" opacity="0.32"/>
    <circle cx="300" cy="580" r="2.5" opacity="0.34"/>
  </g>

  <path d="M60 640 Q300 590 560 630 T1180 620" fill="none" stroke="url(#pribbon)" stroke-width="7" opacity="0.45"/>
  <path d="M40 690 Q320 646 600 684 T1180 676" fill="none" stroke="#ffd76a" stroke-width="3" opacity="0.25"/>
</svg>
`;

/* ─────────────────────  SIGNAGE: hộp đèn phát sáng ban đêm  ───────────────────── */
const SIGNAGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <defs>
    <linearGradient id="sbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#05070b"/>
      <stop offset="55%" stop-color="#0a0f16"/>
      <stop offset="100%" stop-color="#12161c"/>
    </linearGradient>
    <linearGradient id="signBox" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1c2229"/>
      <stop offset="100%" stop-color="#0d1116"/>
    </linearGradient>
    <linearGradient id="signFace" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff4c9"/>
      <stop offset="60%" stop-color="#ffd76a"/>
      <stop offset="100%" stop-color="#f0a800"/>
    </linearGradient>
    <linearGradient id="neonGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff8dd"/>
      <stop offset="45%" stop-color="#ffcc00"/>
      <stop offset="100%" stop-color="#c98a06"/>
    </linearGradient>
    <radialGradient id="signGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ffcc00" stop-opacity="0.55"/>
      <stop offset="50%" stop-color="#f5b800" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#f5b800" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="street" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#161b21"/>
      <stop offset="100%" stop-color="#070a0d"/>
    </linearGradient>
    <filter id="sblur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="30"/>
    </filter>
    <filter id="sblur2" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
  </defs>

  <rect width="1200" height="800" fill="url(#sbg)"/>

  <g fill="#ffffff">
    <circle cx="120" cy="80" r="1.6" opacity="0.4"/>
    <circle cx="300" cy="140" r="1.2" opacity="0.3"/>
    <circle cx="920" cy="70" r="1.8" opacity="0.35"/>
    <circle cx="1090" cy="170" r="1.3" opacity="0.28"/>
    <circle cx="480" cy="60" r="1.5" opacity="0.3"/>
  </g>

  <rect x="180" y="300" width="840" height="380" fill="#10151b"/>
  <rect x="180" y="300" width="840" height="380" fill="none" stroke="#1e252c" stroke-width="3"/>
  <g opacity="0.16" fill="#39434c">
    <rect x="200" y="320" width="60" height="10" rx="2"/>
    <rect x="280" y="320" width="60" height="10" rx="2"/>
    <rect x="360" y="320" width="60" height="10" rx="2"/>
    <rect x="440" y="320" width="60" height="10" rx="2"/>
    <rect x="520" y="320" width="60" height="10" rx="2"/>
    <rect x="600" y="320" width="60" height="10" rx="2"/>
    <rect x="680" y="320" width="60" height="10" rx="2"/>
    <rect x="760" y="320" width="60" height="10" rx="2"/>
    <rect x="840" y="320" width="60" height="10" rx="2"/>
    <rect x="920" y="320" width="60" height="10" rx="2"/>
  </g>

  <g>
    <ellipse cx="600" cy="215" rx="380" ry="150" fill="url(#signGlow)" filter="url(#sblur)"/>
    <rect x="290" y="130" width="620" height="150" rx="10" fill="url(#signBox)" stroke="#39434c" stroke-width="3"/>
    <rect x="308" y="146" width="584" height="118" rx="6" fill="url(#signFace)"/>
    <rect x="308" y="146" width="584" height="118" rx="6" fill="none" stroke="#fff8dd" stroke-width="2" opacity="0.7"/>
    <rect x="298" y="138" width="604" height="134" rx="8" fill="none" stroke="url(#neonGold)" stroke-width="5" filter="url(#sblur2)"/>
    <g font-family="Verdana, DejaVu Sans, sans-serif" text-anchor="middle" fill="#2a1a02">
      <text x="600" y="192" font-size="42" font-weight="bold" letter-spacing="2">TÂY NINH BIA TƯƠI</text>
      <text x="600" y="234" font-size="26" font-weight="bold" letter-spacing="6" fill="#5a3d05">NHÀ PHÂN PHỐI BIA TƯƠI</text>
    </g>
    <path d="M330 280 L370 300 L300 300 Z" fill="#ffe6a8" opacity="0.16"/>
    <path d="M600 280 L640 300 L560 300 Z" fill="#ffe6a8" opacity="0.16"/>
    <path d="M870 280 L910 300 L840 300 Z" fill="#ffe6a8" opacity="0.16"/>
  </g>

  <g>
    <rect x="270" y="440" width="230" height="240" rx="6" fill="#2a2011"/>
    <rect x="282" y="452" width="206" height="216" rx="4" fill="#ffca6e" opacity="0.30"/>
    <rect x="282" y="452" width="206" height="216" rx="4" fill="none" stroke="#ffcc00" stroke-width="3" opacity="0.5"/>
    <rect x="278" y="436" width="214" height="10" rx="4" fill="#ffcc00" opacity="0.7"/>
    <circle cx="360" cy="540" r="22" fill="#3a2a0d" opacity="0.65"/>
    <path d="M332 640 L332 566 Q332 552 360 552 Q388 552 388 566 L388 640 Z" fill="#3a2a0d" opacity="0.65"/>

    <rect x="700" y="440" width="230" height="240" rx="6" fill="#2a2011"/>
    <rect x="712" y="452" width="206" height="216" rx="4" fill="#ffca6e" opacity="0.30"/>
    <rect x="712" y="452" width="206" height="216" rx="4" fill="none" stroke="#ffcc00" stroke-width="3" opacity="0.5"/>
    <rect x="708" y="436" width="214" height="10" rx="4" fill="#ffcc00" opacity="0.7"/>
    <circle cx="800" cy="548" r="22" fill="#3a2a0d" opacity="0.65"/>
    <path d="M772 640 L772 574 Q772 560 800 560 Q828 560 828 574 L828 640 Z" fill="#3a2a0d" opacity="0.65"/>
  </g>

  <ellipse cx="600" cy="700" rx="440" ry="90" fill="url(#signGlow)" opacity="0.45" filter="url(#sblur)"/>

  <rect x="0" y="680" width="1200" height="120" fill="url(#street)"/>
  <rect x="0" y="678" width="1200" height="5" fill="#ffcc00" opacity="0.28"/>
  <g fill="#f5b800" opacity="0.30">
    <rect x="60" y="752" width="120" height="8" rx="4"/>
    <rect x="260" y="752" width="120" height="8" rx="4"/>
    <rect x="460" y="752" width="120" height="8" rx="4"/>
    <rect x="660" y="752" width="120" height="8" rx="4"/>
    <rect x="860" y="752" width="120" height="8" rx="4"/>
    <rect x="1060" y="752" width="100" height="8" rx="4"/>
  </g>

  <ellipse cx="600" cy="690" rx="400" ry="28" fill="#ffcc00" opacity="0.16" filter="url(#sblur)"/>
</svg>
`;

const FILES = {
  'hero-beer.svg': HERO,
  'warehouse.svg': WAREHOUSE,
  'beer-delivery.svg': DELIVERY,
  'monthly-promotion.svg': PROMOTION,
  'illuminated-signage.svg': SIGNAGE,
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(FILES)) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, content, 'utf8');
  console.log(`[written] ${name} (${(content.length / 1024).toFixed(1)} KB)`);
}
