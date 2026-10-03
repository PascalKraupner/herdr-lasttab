# herdr-lasttab

Last-used tab and workspace toggles for [herdr](https://herdr.dev). The
equivalents of tmux's `last-window` and `switch-client -l`.

herdr's `last_pane` is a single global pane MRU and cannot back either toggle.
This plugin keeps a tab pair per workspace and a separate workspace pair, so
the two toggles cannot overwrite each other's state.

Requires herdr 0.9.0 or newer, Git, and [Bun](https://bun.sh).
Supports Linux and macOS. Tested with herdr 0.9.3.

## Install

```bash
herdr plugin install PascalKraupner/herdr-lasttab
```

Then bind it in `~/.config/herdr/config.toml`:

```toml
[keys]
# prefix+b is toggle_sidebar by default; move it out of the way.
toggle_sidebar = "prefix+shift+b"

[[keys.command]]
key = "prefix+b"
type = "shell"
command = "herdr plugin action invoke toggle --plugin lasttab"

[[keys.command]]
key = "prefix+shift+l"
type = "shell"
command = "herdr plugin action invoke toggle-workspace --plugin lasttab"
```

Do not bind `keys.last_pane` (or anything else) to the same keys: when two
bindings collide, herdr keeps the first and disables the other with a
`config diagnostic` warning in `herdr-client.log`, and the toggle silently
stops working. Run `herdr server reload-config` after changing bindings.

## Requirements

[Bun](https://bun.sh) must be on `PATH`. No packages or build step are needed.
The source uses Node's standard library, but the executable entrypoint uses Bun.

## How it works

herdr 0.9.0 made tab and workspace focus client-local. A client switching its
view emits no `tab.focused`/`workspace.focused` events and runs no plugin
event hooks anymore; those fire only when an API call changes the server's
canonical focus. The canonical focus still silently follows whichever client
interacted last, so event hooks alone go stale immediately.

The plugin therefore runs a small watcher process (spawned by the manifest
startup hook, respawned by any toggle if it died) that polls the canonical
focus over the herdr socket (`pane.current`, 250 ms default, override with
`LASTTAB_POLL_MS`). The watcher records the previously focused tab per
workspace in `$HERDR_PLUGIN_STATE_DIR/mru.json` and the global workspace pair
in `workspace-mru.json`. It exits when the server goes away and holds a pid
file so only one instance runs.

The toggle actions read the invoking client's current tab and workspace from
`HERDR_PLUGIN_CONTEXT_JSON`, pick the other half of the recorded pair, and
call `herdr tab focus` or `herdr workspace focus`. Each successful toggle also
records the jump immediately, so a quick double-tap ping-pongs without waiting
for the next poll. Writes are atomic because samples can arrive back to back.

Refocusing the current tab or workspace is ignored, or the toggle would become
a no-op. If a remembered target has been closed, the toggle fails once with a
message and clears the stale pointer rather than failing forever.

Known limits of the polling model: a tab viewed for less than one poll
interval may not be recorded, and with several clients interacting at once the
pairs follow whichever client interacted last, because herdr exposes no
per-client focus history to plugins.

## Tests

```bash
bun test
```

The toggle commands run end-to-end against a fake `herdr` binary via
`HERDR_BIN_PATH`, and the watcher against a fake herdr socket via
`HERDR_SOCKET_PATH`.

## Update or remove

Re-run the install command to update. To remove it:

```bash
herdr plugin uninstall lasttab
```

Tested against herdr 0.9.3. Herdr has no built-in per-workspace last-tab toggle.

## License

MIT
