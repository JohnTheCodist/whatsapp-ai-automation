/**
 * RxNaija for Windows — a desktop shell around the dashboard.
 *
 * WHAT MAKES A WRAPPER FEEL LIKE A BROWSER IN A BOX
 * Three things, and all of them are handled here rather than hoped for:
 *
 *   1. A white rectangle on launch while the page loads. Native apps do not
 *      do this. The main window stays HIDDEN until the dashboard has actually
 *      finished loading, and a splash stands in front of that gap.
 *   2. Chrome's offline dinosaur the first time the internet drops. Nothing
 *      says "this is a web page" louder. A local error page is loaded instead.
 *   3. Links opening inside the app. Clicking a support link and watching
 *      rxnaija.com load in a chrome-less window with no back button is the
 *      moment somebody realises what they are looking at.
 *
 * SECURITY, BECAUSE THIS LOADS REMOTE CODE
 * A wrapper is a browser with the address bar removed, so the usual browser
 * protections have to be put back deliberately: no node integration, context
 * isolation on, and navigation locked to our own origin. Without that last
 * one, any redirect — an OAuth flow gone wrong, a compromised third-party
 * script — would run in a window that looks like our application.
 */

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_URL = process.env.RXNAIJA_URL || 'https://app.rxnaija.com';
const APP_ORIGIN = new URL(APP_URL).origin;

// How long the dashboard may take before the splash admits it is slow. Long
// enough that a normal load never sees it; short enough that somebody staring
// at a stalled window is told something rather than left guessing.
const SLOW_AFTER_MS = 6000;

let splash = null;
let win = null;

// ---------------------------------------------------------------- window ----

/**
 * Remember where the window was.
 *
 * A window that opens at a different size and position every launch is one of
 * those small things nobody names but everybody notices — it is the behaviour
 * of a document being opened, not of an application being returned to.
 */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* first run, or the file was damaged — defaults are fine */ }
  return { width: 1280, height: 860 };
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds, not getBounds: closing while maximised would otherwise
    // record the maximised size as the restored size, and the window could
    // never be un-maximised back to something sensible.
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* losing window position is not worth an error dialog */ }
}

function createSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    // Above the main window while it loads invisibly behind.
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
}

/** Fade the splash out rather than cutting it. A hard swap reads as a glitch. */
function dismissSplash() {
  if (!splash || splash.isDestroyed()) return;
  const s = splash;
  splash = null;
  let opacity = 1;
  const timer = setInterval(() => {
    opacity -= 0.12;
    if (opacity <= 0 || s.isDestroyed()) {
      clearInterval(timer);
      if (!s.isDestroyed()) s.destroy();
      return;
    }
    s.setOpacity(opacity);
  }, 16);
}

function createWindow() {
  const state = readState();

  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: 'RxNaija',
    backgroundColor: '#fbfdfc',
    // Hidden until the dashboard has loaded — see this file's header.
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // No preload: this shell exposes nothing to the page. There is no API
      // for remote code to reach, which is the strongest version of this.
      sandbox: true,
      spellcheck: true,
    },
  });

  if (state.maximized) win.maximize();

  // ---- the load ----
  let slowTimer = setTimeout(() => {
    if (splash && !splash.isDestroyed()) {
      splash.webContents.executeJavaScript("window.postMessage('slow','*')").catch(() => {});
    }
  }, SLOW_AFTER_MS);

  win.webContents.once('did-finish-load', () => {
    clearTimeout(slowTimer);
    win.show();
    dismissSplash();
  });

  // No internet, DNS failure, server down. Chrome's own error page here would
  // undo everything else in this file, so a local one is shown instead.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ABORTED, which fires on ordinary in-app navigations and is not a
    // failure. Treating it as one would flash an error page during normal use.
    if (!isMainFrame || code === -3) return;
    clearTimeout(slowTimer);
    win.loadFile(path.join(__dirname, 'error.html'), {
      query: { code: String(code), desc: desc || '', target: APP_URL },
    });
    win.show();
    dismissSplash();
  });

  // ---- navigation lock ----
  //
  // Anything not on our own origin is somebody else's site, and it opens in
  // the real browser where it has an address bar and the user can see where
  // they are. The local error page is allowed because it is ours.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    if (new URL(url).origin !== APP_ORIGIN) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // target=_blank and window.open. Never a second chrome-less window.
    if (url.startsWith('http')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Downloads the dashboard offers (the connector, a report) should behave
  // like downloads, not vanish into a window with no download bar.
  win.webContents.session.on('will-download', (_e, item) => {
    item.once('done', (__e, state) => {
      if (state === 'completed') {
        shell.showItemInFolder(item.getSavePath());
      }
    });
  });

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', saveState);
  win.on('closed', () => { win = null; });

  win.loadURL(APP_URL);
}

// ------------------------------------------------------------ lifecycle ----

// One window, not one per double-click. Someone who clicks the icon again
// while it is already open means "show me the app", not "open a second copy".
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // The default menu is a developer's menu — View, Reload, Toggle
    // DevTools. On a pharmacy's counter it is a way to break the app by
    // accident, and it announces Electron. Removed entirely; the standard
    // keyboard shortcuts for copy and paste keep working regardless.
    Menu.setApplicationMenu(null);

    createSplash();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // A wrapper that dies silently leaves somebody staring at a closed window
  // with nothing to report to support.
  process.on('uncaughtException', (err) => {
    dialog.showErrorBox('RxNaija', `Something went wrong and the app has to close.\n\n${err.message}`);
    app.quit();
  });
}
