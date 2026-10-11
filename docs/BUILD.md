# Build instructions

Requires Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm start          # local run
```

## Producing installers

electron-builder reads `electron-builder.yml`. Output goes to `release/`.

```bash
npm run package:linux   # AppImage + deb        (build on Linux)
npm run package:win     # NSIS installer + zip  (build on Windows)
npm run package:mac     # dmg + zip             (build on macOS)
```

Cross-compilation caveats:

- **Windows on Linux**: NSIS builds work (`npm run package:win` produces an unsigned `.exe`).
  Code signing requires Windows or `winCodeSign`. For a signed build, run on Windows.
- **macOS**: must be built on macOS. Unsigned builds are quarantined by Gatekeeper on first launch —
  use Finder ▸ right-click ▸ Open, or `xattr -dr com.apple.quarantine <app>`.
- **Linux**: build on Linux. AppImage requires `libfuse2` on the machine that runs it; the `.deb`
  declares the usual Electron dependencies.

### Signing

Set the standard electron-builder environment variables before packaging:

```bash
# macOS
export CSC_LINK=/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD=…

# Windows
export CSC_LINK=/path/to/cert.pfx
export CSC_KEY_PASSWORD=…
```

## What ships

`dist/main/main.cjs`, `dist/preload/preload.cjs`, `dist/renderer/**` and `package.json`, packed into
an asar archive. No native modules are used, so `npmRebuild` is disabled and no rebuild step is needed
at install time.

## Configuration at runtime

There is nothing to configure at build time. On first launch the app asks for:

- **Server address** (`host:port`, default `http://192.168.1.100:8765`) — the phone's IP changes with
  the network, so it is a per-user setting stored in `settings.json` under Electron's `userData`.
- **Access token** — optional on loopback, required in LAN mode. Encrypted with the OS keychain via
  Electron's `safeStorage`; the renderer never sees it. If no keychain exists the token is refused
  rather than stored in plain text.

Files on disk:

| Path | Contents |
| --- | --- |
| `userData/settings.json` | Server URL, transfer preferences, and the encrypted token blob. Mode `0600`. |
| `userData/` (OS keychain) | The actual token secret, stored via `safeStorage` where supported. |

## Firewall

The **server** side needs the port reachable on the LAN. This app makes outbound connections only, so
no inbound rules are required on the desktop. If the desktop cannot reach the phone:

1. `curl http://<phone-ip>:8765/api/v1/health` from the desktop — connection refused means the server
   is bound to loopback or LAN mode is off.
2. Confirm both devices are on the same subnet and not on a guest/isolated Wi-Fi.
3. Confirm no client-AP isolation is enabled on the router.
4. Re-check the phone's IP — it changed if the phone moved networks.