# RxNaija Sync

Sends a pharmacy's stock export to RxNaija on a schedule, so the catalogue
stops being something somebody has to remember to re-upload.

It runs on the computer that holds the pharmacy's POS data, because that is
the only machine that can reach it. A dashboard in a browser cannot read a
database sitting in a back office — that is not a feature that was skipped,
it is the browser's security model, and it is the whole reason this program
exists.

## What it does

1. Watches one folder for the newest `.xlsx`, `.xls` or `.csv`.
2. Uploads it to RxNaija.
3. RxNaija imports it — **only if the columns match what someone already
   confirmed.** If the columns changed, it stops and asks rather than
   guessing.

It never deletes the pharmacy's files, and it only ever reads the folder it
was pointed at.

## What it can see

To work out which stock software is installed, it reads the **names** of
installed programs and database services from the Windows registry. It shows
that list on screen and sends nothing until the person installing it says yes.

It does not read file contents, patient records, or anything inside the POS
database — only the export file the pharmacy chooses to produce.

Undisclosed, software that inventories a business's server and reports home is
malware regardless of intent. The disclosure is the difference, so it happens
before anything is sent, in plain words, on screen.

## Installing it on a pharmacy's computer

Send them **`rxnaija-sync.exe`**. One file. Nothing else needs installing — not
Node, not this folder. They double-click it and it asks for the pairing code.

Get that code from the dashboard: **Settings → Stock sync → Connect a
computer**. Single use, expires in 30 minutes. Read it out over the phone if
you like — it is four characters and deliberately has no 0/O or 1/I in it.

Double-clicking it later, once paired, shows the status and runs a sync,
rather than a list of commands nobody is going to type.

## Building that .exe

```
npm install      # esbuild + postject, build tools only
npm run build    # -> dist/rxnaija-sync.exe  (~80 MB)
```

80 MB because a Node runtime is inside it. That is the trade: one download,
nothing to install.

**It is unsigned.** Windows shows a SmartScreen warning, and coaching a
pharmacist to click past security warnings is a habit worth more to an
attacker than anything in this program. A code-signing certificate is the
real fix.

**Test any build on a machine that has never had Node installed.** A build
host always has one, so a missing-runtime bug cannot show up there.

## Running it from source (development)

Needs Node 22.12+. No runtime dependencies.

```
node index.js pair SY-XXXX
node index.js sync     # send once, now
node index.js watch    # keep running, check every few hours
node index.js status   # what it thinks is going on
```

## Commands

| Command | What it does |
|---|---|
| `pair SY-XXXX` | Join this computer to a pharmacy |
| `sync` | Send the newest export now |
| `watch` | Run continuously, checking on a schedule |
| `status` | Show config, what it is watching, whether the newest file was sent |

### Flags for `pair`

| Flag | Effect |
|---|---|
| `--folder "C:\path"` | Skip the folder question |
| `--pos "Name"` | Record the software without asking |
| `--share` | Send the software list — an explicit opt **in** |
| `--silent` | Never prompt. Without `--share`, nothing is sent |

Silence is never taken as consent: `--silent` alone pairs *without* sharing
the software list.

## Configuration

`C:\ProgramData\RxNaijaSync\config.json` on Windows, `~/.rxnaija-sync/` on
anything else. Override with `RXNAIJA_SYNC_HOME`.

ProgramData rather than a user profile on purpose — this is meant to run as a
service under a system account, and a config under `C:\Users\Ada\AppData` is
unreadable to it. That failure looks like "it works some days" rather than
like a permissions error.

### About the token in that file

It is a real limitation, worth naming rather than papering over. What limits
the damage:

- the file is permission-restricted
- the token is scoped to **catalogue upload only** — it cannot read a
  customer, an order, or a message
- it can be revoked from the dashboard without touching the computer

DPAPI would bind it to the machine and is the right upgrade. But the scope is
what stands between a shop PC and a data breach, not the storage.

## Scheduling

`watch` checks every 6 hours by default (`intervalMinutes` in config), and
once immediately on start.

Not a nightly cron: a pharmacy PC is often switched off at closing, and a 2am
schedule on a machine that is off at 2am never runs at all. Something that
fires a few times during opening hours survives how shops actually behave.

## Still to do

- **Signing.** See above. This is the one that blocks handing the file to a
  pharmacy you are not standing next to.
- **Run it as a Windows service**, so it starts with the computer instead of
  needing someone to launch it. Today `watch` runs while the window is open.
- **Read the POS database directly**, for whichever software turns out to be
  common. Folder-watching needs a person to click Export; a daily habit
  decays by about week three. Worth building only once real pharmacies have
  shown you which two or three packages matter — the fingerprints they send
  at pairing are what answers that.
