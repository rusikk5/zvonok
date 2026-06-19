'use strict';
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { default: pngToIco } = require('png-to-ico');

const SRC = path.join(__dirname, 'Мысли на лого2.png');
const OUT_ICO = path.join(__dirname, 'build', 'icon.ico');
const OUT_PNG = path.join(__dirname, 'build', 'icon.png');
const PUB_PNG = path.join(__dirname, 'public', 'icon.png');

const SIZES = [16, 32, 48, 64, 128, 256];

async function main() {
  // Save square 256px PNG for build/icon.png and public/icon.png
  const img256 = await sharp(SRC)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync(OUT_PNG, img256);
  fs.writeFileSync(PUB_PNG, img256);
  console.log('Saved 256px PNG');

  // Create buffers for each ICO size
  const buffers = await Promise.all(
    SIZES.map(s =>
      sharp(SRC)
        .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  const ico = await pngToIco(buffers);
  fs.writeFileSync(OUT_ICO, ico);
  console.log(`Saved ICO (${(ico.length / 1024).toFixed(1)} KB) with sizes: ${SIZES.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
