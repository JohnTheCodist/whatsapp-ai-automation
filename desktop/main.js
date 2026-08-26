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

const { app, BrowserWindow, shell, Menu, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_URL = process.env.RXNAIJA_URL || 'https://app.rxnaija.com';
const APP_ORIGIN = new URL(APP_URL).origin;

/**
 * Lifecycle logging, off unless asked for.
 *
 * When this app misbehaves on a pharmacy's counter there is no console to
 * look at and no developer in the room — the only evidence is whatever a
 * pharmacist can describe over the phone, which for a window that "just went
 * white" is nothing at all. Setting RXNAIJA_DEBUG=1 and reading back the
 * output turns that into a support call that can actually be answered.
 *
 * Off by default because a shipped app writing to stdout nobody reads is
 * noise, and these lines name internal states that would only confuse.
 */
const DEBUG = process.env.RXNAIJA_DEBUG === '1';
const trace = (msg, extra) => {
  if (DEBUG) console.log(`[rxnaija] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
};

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
  trace('splash created');
  splash.once('ready-to-show', () => splash.show());
}

/** Fade the splash out rather than cutting it. A hard swap reads as a glitch. */
function dismissSplash() {
  if (!splash || splash.isDestroyed()) return;
  const s = splash;
  splash = null;
  trace('splash dismissed');
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
      // Chromium throttles timers hard in a window that is not in front, which
      // for an ordinary web page is a kindness — nobody is reading it.
      //
      // Here it works against the badge. The dashboard learns that something
      // needs a pharmacist from a poll on a timer, and the one situation a
      // taskbar badge exists for is the app sitting BEHIND something else.
      // Throttled, the count only catches up once they look at the window,
      // which is exactly when they no longer needed telling.
      //
      // Set on that reasoning, NOT because it fixed an observed bug: timer-
      // driven title updates did not fire when the packaged app was driven
      // from a script, and this did not change that. The most likely cause is
      // the test harness — a window that is shown but never really composited
      // or focused — rather than the product, since a dashboard whose timers
      // never ran would be visibly frozen rather than subtly stale. Worth
      // confirming by watching a real window before trusting either way.
      backgroundThrottling: false,
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
    // The URL, not a fixed label: this same handler fires for the local error
    // page after a failed load, and a support log claiming "dashboard loaded"
    // while somebody is staring at "Can't reach RxNaija" sends whoever reads
    // it looking in exactly the wrong place.
    trace('page loaded, showing window', { url: win.webContents.getURL() });
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
    trace('load failed, showing error page', { code, desc });
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

  // ---- the taskbar badge ----
  //
  // HOW THE COUNT GETS HERE
  // Through the page title, which the dashboard sets to "(3) RxNaija". No
  // preload, no bridge, nothing exposed to the page — the count crosses
  // through a field the browser already owns, so the shell keeps offering
  // remote code no API at all. It also means the same code works in a plain
  // browser tab, where "(3) RxNaija" is the convention every mail client uses.
  let lastCount = 0;

  win.on('page-title-updated', (e, title) => {
    // The shell owns the window title. Without this the title flickers between
    // "(3) RxNaija" and whatever the router last set, which looks broken in
    // the taskbar's window preview.
    e.preventDefault();
    win.setTitle('RxNaija');

    const m = /^\((\d+\+?|9\+)\)/.exec(title);
    const raw = m ? m[1] : null;
    const count = raw ? (raw.includes('+') ? 10 : parseInt(raw, 10)) : 0;
    if (count === lastCount) return;

    if (count === 0) {
      win.setOverlayIcon(null, '');
    } else {
      const key = count > 9 ? '9plus' : String(count);
      const file = path.join(__dirname, 'assets', 'badges', `${key}.png`);
      try {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) {
          win.setOverlayIcon(img, `${count} ${count === 1 ? 'thing needs' : 'things need'} you`);
        }
      } catch { /* a missing badge must never take the window down */ }

      // Flash the taskbar button, but ONLY on a rise and only when the window
      // is not already in front. Flashing while somebody is looking at the
      // screen is nagging, and re-flashing on every poll that returns the same
      // number is how an app teaches people to ignore it.
      if (count > lastCount && !win.isFocused()) {
        win.flashFrame(true);
      }
    }
    trace('badge', { count });
    lastCount = count;
  });

  // Stop the flashing the moment they look at it — the attention request has
  // been answered, and a taskbar button still blinking at a focused window is
  // the app talking over itself.
  win.on('focus', () => win.flashFrame(false));

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', saveState);
  win.on('closed', () => { win = null; });

  trace('loading', { url: APP_URL });
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
