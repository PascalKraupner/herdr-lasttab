# herdr-lasttab

Last-used tab and workspace toggles for [herdr](https://herdr.dev). The
equivalents of tmux's `last-window` and `switch-client -l`.

herdr's `last_pane` is a single global pane MRU and cannot back either toggle.
This plugin keeps a tab pair per workspace and a separate workspace pair, so
the two toggles cannot overwrite each other's state.

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

## Requirements

`bun` or `node`. The script uses only `node:` imports, so either works; change
the shebang in `bin/lasttab.js` if you prefer node.

## How it works

A `tab.focused` event hook records the previously focused tab per workspace in
`$HERDR_PLUGIN_STATE_DIR/mru.json`. A `workspace.focused` hook keeps the global
workspace pair in `workspace-mru.json`. The actions read those files and call
`herdr tab focus` or `herdr workspace focus`. Writes are atomic because focus
events can arrive back to back.

Refocusing the current tab or workspace is ignored, or the toggle would become
a no-op. If a remembered target has been closed, the toggle fails once with a
message and clears the stale pointer rather than failing forever.

## License

MIT
