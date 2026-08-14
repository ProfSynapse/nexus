# Protocol: headless-obsidian

Context: you are in a Linux container or cloud session with no Obsidian, and a
change needs proving in the running plugin. This stands up a real Obsidian,
headless, and hands you the CLI that `live-loop.md` drives. Verified end to end
on 2026-08-14 against Obsidian 1.13.7 in a Claude Code cloud container.

## Mission
A running Obsidian, a test vault with the plugin installed, and
`obsidian-cli` answering — so the in-app loop becomes available where it
otherwise is not.

## Steps

1. **Get the binary from GitHub, not obsidian.md.** The egress proxy blocks
   `obsidian.md` (403 CONNECT), but `github.com` is reachable. Read the current
   version out of the releases repo, then pull the release asset:

   ```bash
   cd /tmp && git clone -q --depth 1 https://github.com/obsidianmd/obsidian-releases.git obs-rel
   python3 -c "import json;print(json.load(open('obs-rel/desktop-releases.json'))['latestVersion'])"
   V=<that version>
   curl -sSL -o Obsidian.AppImage "https://github.com/obsidianmd/obsidian-releases/releases/download/v$V/Obsidian-$V.AppImage"
   ```

   The CLI needs Obsidian **1.12.4 or later**; latest is well past that.

2. **Extract rather than mount.** Containers rarely have FUSE:

   ```bash
   chmod +x Obsidian.AppImage && ./Obsidian.AppImage --appimage-extract >/dev/null
   ldd squashfs-root/obsidian | grep "not found"   # expect no output
   ```

   `squashfs-root/` contains both `obsidian` and `obsidian-cli`.

3. **Create the vault and register it** before first launch, so no vault picker
   appears:

   ```bash
   mkdir -p /tmp/test-vault/.obsidian/plugins/nexus ~/.config/obsidian
   cat > ~/.config/obsidian/obsidian.json <<'JSON'
   {"vaults":{"testvault0001":{"path":"/tmp/test-vault","ts":1700000000000,"open":true}},"updateDisabled":true,"cli":true}
   JSON
   ```

   `"cli": true` is the setting behind Settings → General → Advanced → Command
   line interface. **Write it while Obsidian is not running** — the app owns
   this file and rewrites it on exit.

4. **Launch under Xvfb with the full GPU flag set.** Fewer flags than this and
   Electron dies with `GPU process isn't usable. Goodbye.`:

   ```bash
   cd squashfs-root
   setsid nohup xvfb-run -a --server-args="-screen 0 1280x900x24" ./obsidian \
     --no-sandbox --disable-gpu --disable-gpu-sandbox --disable-software-rasterizer \
     --in-process-gpu --disable-dev-shm-usage > /tmp/obsidian.log 2>&1 < /dev/null &
   ```

   `--no-sandbox` is required when running as root. Give it ~30 s, then confirm:

   ```bash
   ./obsidian-cli --help    # prints the command list once the CLI is live
   ```

5. **Install the plugin into the vault** and let Obsidian past Restricted Mode:

   ```bash
   cd /home/user/nexus && npm run build
   cp main.js manifest.json styles.css /tmp/test-vault/.obsidian/plugins/nexus/
   echo '["nexus"]' > /tmp/test-vault/.obsidian/community-plugins.json
   cd /tmp/squashfs-root
   ./obsidian-cli eval code="app.plugins.setEnable(true); 'ok'"
   ```

   A fresh vault opens in Restricted Mode, where `app.plugins.isEnabled()` is
   false and no community plugin loads. Listing the plugin in
   `community-plugins.json` is not enough on its own.

6. **Confirm the plugin actually loaded**, which is a different question from
   whether Obsidian started:

   ```bash
   ./obsidian-cli eval code="JSON.stringify({enabled:app.plugins.isEnabled(),loaded:Object.keys(app.plugins.plugins)})"
   ./obsidian-cli dev:errors
   ```

   **Stop condition:** `loaded` contains `nexus`. Errors printed here are real
   findings — the first run of this setup surfaced a startup ordering bug that
   every Jest lane was blind to. Do not treat a noisy `dev:errors` as setup
   failure without reading it.

7. Hand off to `live-loop.md`, which owns the build → reload → observe cycle.

## Guidelines

- Pattern: kill by process name, not by asar path. `pkill -f obsidian.asar`
  matches only helper processes and leaves the main process serving a stale
  config, which looks exactly like your setting being ignored. Use
  `pkill -9 -x obsidian; pkill -9 -f 'squashfs-root/obsidian'`, and put it in a
  script — a `pkill -f` pattern typed inline also matches the shell running it.
- Pattern: restart, do not reload, when testing anything about startup order.
  `plugin:reload` re-runs `onload` against an already-initialised app.
- Pattern: `dev:console` returns nothing until `dev:debug on` has been run.
- Pattern: `dev:screenshot path=/tmp/x.png` works headless and is the fastest
  way to see a modal you did not expect — a first-run vault shows a trust
  dialog that no log mentions.
- Anti-pattern: reporting a container run as proof for desktop or mobile. This
  is a real Obsidian on a real vault, which is far more than Jest proves — but
  it is Linux, headless, with a synthetic vault. Mobile in particular is
  untouched by it; see `nexus-mobile-compat`.
- Anti-pattern: leaving the instance running and assuming the next session
  inherits it. Containers are reclaimed; the setup is cheap enough to redo.

## Next
`live-loop.md` to run the loop. Record anything that differed from these steps
in `refinement-log.md` — the exact flag set and the Restricted Mode step were
both learned the hard way.
