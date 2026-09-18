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

5. **Install the plugin into the vault** and let Obsidian past Restricted Mode.
   Copy every build artifact, not just the three the manifest names —
   `sqlite3.wasm` is emitted by the build and the cache cannot start without it:

   ```bash
   cd /home/user/nexus && npm run build
   cp main.js manifest.json styles.css sqlite3.wasm /tmp/test-vault/.obsidian/plugins/nexus/
   echo '["nexus"]' > /tmp/test-vault/.obsidian/community-plugins.json
   cd /tmp/squashfs-root
   ./obsidian-cli eval code="app.plugins.setEnable(true); 'ok'"
   ```

   A fresh vault opens in Restricted Mode, where `app.plugins.isEnabled()` is
   false and no community plugin loads. Listing the plugin in
   `community-plugins.json` is not enough on its own.

   Derive the list rather than trusting this one — the build's copy steps say
   what it emits:

   ```bash
   cd /home/user/nexus && npm run build 2>&1 | grep -i copied
   ```

   **If the plugin folder did not exist before Obsidian launched, this silently
   does nothing.** Obsidian reads `.obsidian/plugins/` once at vault load, so a
   folder copied in afterwards is invisible: `app.plugins.manifests` lacks it, and
   `enablePlugin('<id>')` resolves without an error and without loading anything,
   which looks exactly like a load failure. `dev:errors` stays empty and gives no
   hint. Either create the folder before step 4, or rescan first:

   ```bash
   ./obsidian-cli eval code="await app.plugins.loadManifests(); await app.plugins.enablePluginAndSave('nexus'); 'ok'"
   ```

   Confirmed 2026-09-18: in a real run where the plugin folder was copied in
   after launch, this rescan was required and worked exactly as documented,
   with no further workaround needed.

   **`enablePluginAndSave` persists the enabled state to
   `community-plugins.json`.** That gets you past Restricted Mode once, but it
   also means the *next* launch auto-loads the plugin before any harness has
   attached, and the plugin's background indexing is already running by the
   time `obsidian-cli` answers (roughly 30 s in). If you intend to measure
   anything from enable onward, that head start makes the measurement wrong.
   For a launch you intend to instrument:

   ```bash
   echo '[]' > /tmp/test-vault/.obsidian/community-plugins.json   # before launch
   # launch (step 4), install the payload (above), then, once the CLI answers:
   ./obsidian-cli eval code="await app.plugins.enablePluginAndSave('nexus'); 'ok'"
   ```

   and poll for readiness at roughly 10 ms rather than waiting a fixed delay,
   clearing your poll timer as soon as `plugin.embeddingManager` appears on the
   loaded instance: measured at roughly 3.3 s after enable, well ahead of the
   CLI's own ~30 s.

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

   Then confirm the **storage backend** came up, which is a third question again
   and the one that fails silently:

   ```bash
   ./obsidian-cli eval code="(async()=>{const a=await app.plugins.plugins['nexus'].serviceManager.getService('hybridStorageAdapter');const c=a.getSqliteCache?a.getSqliteCache():a.sqliteCache;try{const r=await c.query('SELECT MAX(version) AS v FROM schema_version');return 'schema v'+r[0].v}catch(e){return 'CACHE DOWN: '+e}})()"
   ```

   A missing `sqlite3.wasm` leaves SQLite uninitialised, and `ConversationService`
   then quietly falls back to the legacy `.conversations/*.json` backend. Nothing
   errors — the plugin loads, conversations save and reload — so a storage test
   run in that state passes against the wrong backend entirely. Assert the schema
   version before trusting any storage result.

7. Hand off to `live-loop.md`, which owns the build → reload → observe cycle.

## Guidelines

- Pattern: kill by process name, not by asar path. `pkill -f obsidian.asar`
  matches only helper processes and leaves the main process serving a stale
  config, which looks exactly like your setting being ignored. Use
  `pkill -9 -x obsidian; pkill -9 -f 'squashfs-root/obsidian'`, and put it in a
  script (a `pkill -f` pattern typed inline also matches the shell running it).
- Pattern: `xvfb-run` leaves its X server behind when the child is SIGKILLed,
  so the two `pkill` targets above are not enough by themselves. Add
  `pkill -9 -f Xvfb` to the same cleanup script, or `xvfb-run -a` accumulates
  orphaned X servers across runs.
- Anti-pattern: wiping `/root/.config/obsidian/IndexedDB` to force a clean
  cache without checking what else lives there. It is where the desktop cache
  blob is stored, but it is also every other IndexedDB database the renderer
  holds for that profile, so clearing it clears all of them. Fine to blow away
  in a throwaway container, destructive against a real profile.
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
