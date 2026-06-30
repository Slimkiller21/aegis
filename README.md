# NSFW Guard

A local, always-on desktop guard that watches your screen in real time, blocks
NSFW content the instant it appears, and helps you stay off compulsive habits.

**100% offline.** Screen frames are classified in-process and are **never
written to disk or sent anywhere.** The only network use is a one-time model
download on first launch.

## How it works

```
Screen ──(Windows screen capture)──► hidden detector window
                                          │  downscale to 224x224
                                          ▼
                                   NSFWJS (MobileNetV2)
                                          │  porn / hentai / sexy / drawing / neutral
                                          ▼
                                 enforcement FSM (main process)
              ┌───────────────────────────┼───────────────────────────┐
              ▼                            ▼                           ▼
        blur scrim + warning      minimize window if it       streak / event log
        (instant, non-focusing)   persists past grace          (planned)
```

- **Detector** (`src/detector`) — captures the primary screen via Electron's
  `desktopCapturer`, classifies ~2 frames/sec with NSFWJS (the JS port of the
  same GantMan model this project's sister repo forks).
- **Overlay** (`src/overlay`) — a frameless, non-focusable, always-on-top scrim
  that fully covers the screen with a supportive message. Because it never
  takes focus, the offending app stays foreground so escalation can target it.
- **Enforcement** (`src/main/enforcement.js`) — if content is still flagged
  after `graceMs`, minimizes the foreground window (minimize, not close — no
  unsaved-work loss). No native modules; uses a tiny PowerShell user32 call.
- **Main** (`src/main/main.js`) — tray app, autostart on login, single
  instance, quit confirmation, and the detection state machine.

## Run (dev)

```bash
npm install
npm run icon      # generate the tray icon (needs Python 3)
npm start
```

Runs in the system tray. Right-click the tray icon to pause/resume or quit.

## Config

Stored at `%APPDATA%/nsfw-guard/config.json` (created on first run). Tunables:
`fps`, per-category `thresholds`, `flagSexy`, `graceMs`, `clearFrames`,
`enforceMinimize`, `autoStart`, `message`.

## Status

Working:
- Background capture, realtime classification, blocking overlay, foreground-window
  minimize escalation, tray, autostart.
- **Premium dark GUI** (`src/ui`) — dashboard + first-run onboarding wizard
  (name, your "why", triggers, baseline, accountability partner, commitment) and
  a panic/breathing crisis screen.
- **Tamper-resistance (Strict)** — guardian watchdog that auto-restarts the app
  if it's killed (verified: kill the app, it returns within seconds with a fresh
  watchdog); disabling/quitting is gated behind the partner-held password **and**
  a cooldown delay.
- **Accountability** — streak tracking, incident log, weekly/last-incident stats,
  CSV export. All local.
- **Offline model** — NSFWJS MobileNetV2 ships inside the package and loads with
  no network; packaging unpacks it from asar for installer builds.
- **Multi-monitor** — one capturer + one overlay per display, each with its own
  detection state; only the offending screen is covered. Coverage rebuilds when
  displays are plugged/unplugged.
- **Tiling** — besides the whole frame, a configurable grid of sub-regions
  (default 2×2 + full) is scored each tick so small on-screen images aren't lost
  to the 224px downscale; the worst region drives the decision.

Planned: partner email/cloud reports, model upgrade + int8 quantization,
Lockdown (Windows-service) tamper tier, packaged installer (`npm run dist`).

## Privacy

No telemetry. No screenshots saved. No frames transmitted. All inference is
local. See `src/detector/detector.js` — the captured canvas is classified and
discarded every tick.

## License

MIT.
