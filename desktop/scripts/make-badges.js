#!/usr/bin/env electron
/**
 * Generates the taskbar overlay badges into assets/badges/.
 *
 *   npx electron scripts/make-badges.js
 *
 * WHY THESE ARE FILES AND NOT DRAWN AT RUNTIME
 * Windows wants a real image for setOverlayIcon, and the alternative is
 * spinning up an offscreen renderer on every count change to draw a red circle
 * with a number in it. Ten small PNGs generated once is less machinery than
 * that, and the badge cannot fail to appear because a renderer was busy.
 *
 * WHY THE SCRIPT RUNS UNDER ELECTRON
 * It needs a canvas to draw text, and Electron already contains one. That
 * means no image library in the dependency tree for something run by hand
 * roughly never — and it regenerates identically if the colour ever changes,
 * rather than being a binary somebody has to remember how to recreate.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets', 'badges');
const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9plus'];

const draw = `(() => {
  const S = 32;                       // drawn at 32, Windows downscales to 16
  const out = {};
  const labels = ${JSON.stringify(LABELS)};
  for (const key of labels) {
    const label = key === '9plus' ? '9+' : key;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');

    // Red rather than the brand green. This is an attention state, and red is
    // the one badge convention every operating system already shares — a green
    // badge would read as a status, not as something waiting.
    x.fillStyle = '#dc2626';
    x.beginPath(); x.arc(S/2, S/2, S/2 - 1, 0, Math.PI*2); x.fill();

    // A white ring so the badge still separates from a dark taskbar or a
    // dark app icon underneath it.
    x.strokeStyle = 'rgba(255,255,255,0.92)';
    x.lineWidth = 1.5;
    x.beginPath(); x.arc(S/2, S/2, S/2 - 1, 0, Math.PI*2); x.stroke();

    x.fillStyle = '#ffffff';
    x.font = (label.length > 1 ? '700 15px' : '700 19px') + ' Segoe UI, system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(label, S/2, S/2 + 1);

    out[key] = c.toDataURL('image/png').split(',')[1];
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 64, height: 64 });
  await w.loadURL('data:text/html,<html><body></body></html>');
  const badges = await w.webContents.executeJavaScript(draw);

  fs.mkdirSync(OUT, { recursive: true });
  for (const [key, b64] of Object.entries(badges)) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      console.error(`badge ${key} is not a PNG`);
      app.exit(1);
      return;
    }
    fs.writeFileSync(path.join(OUT, `${key}.png`), buf);
    console.log(`  ${key}.png  ${buf.length} bytes`);
  }
  console.log(`\nwrote ${Object.keys(badges).length} badges to ${OUT}`);
  app.quit();
});
