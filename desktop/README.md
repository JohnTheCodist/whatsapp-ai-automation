# RxNaija for Windows

A desktop shell around the dashboard at `app.rxnaija.com`.

## What this is, and what it deliberately is not

It is a window that loads the dashboard, with the things that would otherwise
give it away as a web page handled properly: no blank flash on launch, no
Chrome error page when the internet drops, no links opening inside a
chrome-less window with no way back.

It is **not** a copy of the dashboard. The pages are loaded from the server
every time, which is the point — shipping a fix to the dashboard reaches every
pharmacy immediately, without anyone installing anything.

## Running it during development

```bash
npm install
npm start              # against https://app.rxnaija.com
npm run start:local    # against http://localhost:5273 (Vite must be running)
```

## When it misbehaves on a pharmacy's counter

There is no console to look at there and no developer in the room, so the only
evidence is what a pharmacist can describe over the phone — which for a window
that "just went white" is nothing at all.

```bash
set RXNAIJA_DEBUG=1 && npm start
```

Prints the lifecycle, which is enough to tell the three failures apart:

```
[rxnaija] splash created
[rxnaija] loading {"url":"https://app.rxnaija.com"}
[rxnaija] page loaded, showing window {"url":"https://app.rxnaija.com/"}
[rxnaija] splash dismissed
```

A `load failed` line names the real reason (`ERR_NAME_NOT_RESOLVED`,
`ERR_CONNECTION_TIMED_OUT`), which separates "their internet is down" from
"the server is down" from "the app is broken" — three calls that sound
identical when they arrive.

Off unless asked for: a shipped app writing to stdout nobody reads is noise.

## Building the installer

```bash
npm run dist
```

Produces `dist/RxNaija Setup <version>.exe` — an NSIS wizard, not a one-click
installer. On unsigned software a silent install looks exactly like the thing a
pharmacy should be suspicious of.

**It is unsigned**, so Windows shows a SmartScreen warning. The dashboard tells
people to expect it, which is the honest mitigation until there is a
certificate. See the code-signing notes in the main project discussion — an EV
certificate is what removes the warning outright; an OV one still has to build
reputation first.

## The icon

`assets/icon.ico` is generated rather than drawn, from the same accent values
as the sign-in mark and the browser favicon, so the three places a person meets
this brand cannot drift apart:

```bash
node scripts/make-icon.js <file-containing-a-base64-png>
```

## Files

| | |
|---|---|
| `main.js` | Window lifecycle, splash handover, navigation lock |
| `splash.html` | The launch screen. Self-contained; it loads before any network exists |
| `error.html` | Shown instead of Chrome's offline page |
| `scripts/make-icon.js` | Wraps a PNG in an ICO container |

## Decisions worth not undoing

**The main window is hidden until `did-finish-load`.** Showing it immediately
gives you a white rectangle for as long as the dashboard takes to load, which
is the single clearest tell that an app is a wrapped web page.

**Navigation is locked to the app's own origin.** A wrapper is a browser with
the address bar removed, so a redirect to somewhere unexpected would run inside
a window that looks like this application, with nothing on screen to say
otherwise. Anything off-origin opens in the real browser instead.

**There is no preload script and no exposed API.** This shell gives the page
nothing to call, which is the strongest version of that boundary rather than a
carefully audited version of it.

**The application menu is removed.** The default Electron menu is a developer's
menu — Reload, Toggle DevTools — and on a pharmacy counter it is mostly a way
to break the app by accident. Copy and paste shortcuts still work.

**Window position is remembered** with `getNormalBounds`, not `getBounds`, so
closing while maximised does not record the maximised size as the restored
size and leave the window unable to return to something sensible.
