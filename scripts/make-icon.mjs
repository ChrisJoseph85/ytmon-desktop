/**
 * Generates build/icon.png (1024x1024) by rendering the app mark in a hidden
 * Electron window. Run once before packaging:
 *
 *   npm run icon
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'build', 'icon.png');

const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent}
  .icon{width:1024px;height:1024px;border-radius:220px;
    background:linear-gradient(140deg,#ff4d4f 0%,#ff7a3d 55%,#ffa63d 100%);
    display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 -30px 60px rgba(0,0,0,.18);}
  .play{width:0;height:0;margin-left:40px;
    border-left:330px solid #fff;
    border-top:215px solid transparent;
    border-bottom:215px solid transparent;
    filter:drop-shadow(0 12px 24px rgba(0,0,0,.25));}
</style></head><body><div class="icon"><div class="play"></div></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 700));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});