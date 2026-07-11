// Docs capture harness. Boots the REAL app (requires the built main process so
// every IPC handler is registered and the renderer behaves exactly as shipped),
// then walks the sidebar tabs and grabs a clean webContents.capturePage() of
// each — no OS window chrome, no desktop clutter. Output → docs/media/*.png.
//
//   npm run build && npx electron scripts/capture.cjs
//
// Purely a documentation tool; it is never bundled into the app.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Boot the real main process (registers handlers + creates the window on ready).
require('../dist-electron/main.js');

const OUT = path.resolve(__dirname, '..', 'docs', 'media');
fs.mkdirSync(OUT, { recursive: true });

// Sidebar tab order from src/App.tsx (the first N .tab-btn buttons).
const TABS = [
  'chat', 'library', 'console', 'brain', 'council', 'skills',
  'history', 'prompts', 'settings', 'upgrades', 'self', 'security',
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
  for (let i = 0; i < 120; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) return w;
    await delay(250);
  }
  throw new Error('no window appeared');
}

async function waitForUi(win) {
  for (let i = 0; i < 120; i++) {
    const ready = await win.webContents
      .executeJavaScript(`document.querySelectorAll('.tab-btn').length > 0`)
      .catch(() => false);
    if (ready) return;
    await delay(250);
  }
  throw new Error('UI never rendered .tab-btn');
}

async function main() {
  const win = await waitForWindow();
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await waitForUi(win);

  // Suppress the first-launch onboarding modal + welcome banner so captures
  // show real tab content, then reload to apply.
  await win.webContents.executeJavaScript(`
    localStorage.setItem('clawdeck:onboarded', '1');
    localStorage.setItem('clawdeck:welcome:dismissed', '1');
    true;
  `);
  win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await waitForUi(win);
  await delay(1200); // let first-paint async data settle

  for (let i = 0; i < TABS.length; i++) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.tab-btn')[${i}]?.click(); true;`
    );
    await delay(900);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `tab-${String(i).padStart(2, '0')}-${TABS[i]}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('captured', file);
  }

  // Land back on Chat for a clean final frame.
  await win.webContents.executeJavaScript(`document.querySelectorAll('.tab-btn')[0]?.click(); true;`);
  await delay(400);
  console.log('DONE');
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error('CAPTURE FAILED:', e); app.exit(1); }));
