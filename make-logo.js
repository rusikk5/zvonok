'use strict';
/* Генерирует пиксель-арт иконку телефона: тёмный квадрат + неоновый телефон */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { default: pngToIco } = require('png-to-ico');

const BUILD_ICO = path.join(__dirname, 'build', 'icon.ico');
const BUILD_PNG = path.join(__dirname, 'build', 'icon.png');
const PUB_PNG   = path.join(__dirname, 'public', 'icon.png');
const SIZES = [16, 32, 48, 64, 128, 256];

function backup(p) {
  const bak = p + '.glass.bak';
  if (fs.existsSync(p) && !fs.existsSync(bak)) fs.copyFileSync(p, bak);
}

// Пиксель-арт трубка (11×11 сетка, каждый пиксель 16px)
// Диагональная трубка: наушник вверху-слева, микрофон внизу-справа
const PIXEL_SIZE = 16;
const OFFSET_X = 40;
const OFFSET_Y = 40;

// [col, row] — основные пиксели телефона
const MAIN_PIX = [
  // Наушник (earpiece) — строки 0-2
  [2,0],[3,0],[4,0],[5,0],
  [1,1],[2,1],[3,1],[4,1],[5,1],[6,1],
  [1,2],[2,2],[3,2],[4,2],[5,2],[6,2],
  // Ручка (diagonal handle) — строки 3-6
  [2,3],[3,3],[4,3],
  [3,4],[4,4],[5,4],
  [4,5],[5,5],[6,5],
  [5,6],[6,6],[7,6],
  // Переход к микрофону
  [6,7],[7,7],[8,7],[9,7],
  // Микрофон (mouthpiece) — строки 8-10
  [5,8],[6,8],[7,8],[8,8],[9,8],[10,8],
  [5,9],[6,9],[7,9],[8,9],[9,9],[10,9],
  [5,10],[6,10],[7,10],[8,10],[9,10],[10,10],
];

// Светлые highlight-пиксели (верхний-левый угол наушника)
const HIGHLIGHT_PIX = new Set([[2,0],[3,0],[1,1],[2,1],[1,2],[2,2]].map(([c,r]) => `${c},${r}`));

// Маленькие квадратные искры вокруг
const SPARKLES = [
  [12, 20, 4, 0.40], [220, 24, 3, 0.35], [238, 80, 4, 0.45],
  [8,  80, 3, 0.38], [8, 170, 4, 0.32], [18, 220, 3, 0.40],
  [230,180, 4, 0.42],[150, 12, 3, 0.36],[100, 238, 4, 0.38],
  [240,140, 3, 0.44],[50, 10, 4, 0.30], [236, 46, 3, 0.42],
];

function genSVG() {
  const pixelRects = MAIN_PIX.map(([col, row]) => {
    const x = OFFSET_X + col * PIXEL_SIZE;
    const y = OFFSET_Y + row * PIXEL_SIZE;
    const fill = HIGHLIGHT_PIX.has(`${col},${row}`) ? '#c0ffc8' : '#40ff68';
    return `<rect x="${x}" y="${y}" width="${PIXEL_SIZE}" height="${PIXEL_SIZE}" fill="${fill}"/>`;
  }).join('\n    ');

  const sparkleRects = SPARKLES.map(([x, y, s, op]) =>
    `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="#40ff68" opacity="${op}"/>`
  ).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#0d1f0f"/>
      <stop offset="100%" stop-color="#030804"/>
    </radialGradient>
    <filter id="neon" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur"/>
      <feColorMatrix in="blur" type="matrix"
        values="0 0 0 0 0.1  0 0 0 0 0.9  0 0 0 0 0.25  0 0 0 5 0" result="colored"/>
      <feMerge>
        <feMergeNode in="colored"/>
        <feMergeNode in="colored"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <radialGradient id="refl" cx="72%" cy="18%" r="45%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.22)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgba(64,255,104,0.40)"/>
      <stop offset="60%" stop-color="rgba(64,255,104,0.10)"/>
      <stop offset="100%" stop-color="rgba(64,255,104,0.04)"/>
    </linearGradient>
    <clipPath id="clip"><rect width="256" height="256" rx="52"/></clipPath>
  </defs>

  <!-- Фон -->
  <rect width="256" height="256" rx="52" fill="url(#bg)"/>
  <!-- Центральное свечение фона -->
  <circle cx="128" cy="128" r="80" fill="rgba(20,80,30,0.18)"/>

  <!-- Искры (внутри rounded rect) -->
  <g clip-path="url(#clip)">
    ${sparkleRects}
  </g>

  <!-- Пиксельный телефон с неоновым свечением -->
  <g filter="url(#neon)">
    ${pixelRects}
  </g>

  <!-- Стеклянный блик сверху-справа -->
  <rect width="256" height="256" rx="52" fill="url(#refl)" clip-path="url(#clip)"/>

  <!-- Рамка с зелёным свечением -->
  <rect x="1" y="1" width="254" height="254" rx="51"
    fill="none" stroke="url(#border)" stroke-width="2"/>
  <!-- Внутренняя белая подсветка -->
  <rect x="1" y="1" width="254" height="254" rx="51"
    fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>
</svg>`;
}

async function main() {
  [BUILD_ICO, BUILD_PNG, PUB_PNG].forEach(backup);

  const svg = genSVG();
  const png256 = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  fs.writeFileSync(PUB_PNG, png256);
  fs.writeFileSync(BUILD_PNG, png256);
  console.log('Saved 256px pixel art phone icon');

  const buffers = await Promise.all(
    SIZES.map(s => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer())
  );
  const ico = await pngToIco(buffers);
  fs.writeFileSync(BUILD_ICO, ico);
  console.log(`Saved ICO (${(ico.length / 1024).toFixed(1)} KB): ${SIZES.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
