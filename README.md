# herdr-lasttab

Per-workspace last-used tab toggle for [herdr](https://herdr.dev). The
equivalent of tmux's `last-window`.

herdr ships exactly one MRU binding, `last_pane`, and it is global. This keeps a
separate most-recently-used pair **per workspace**, so toggling tabs and
toggling workspaces stay independent the way they were in tmux.

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
```

## Requirements

`bun` or `node`. The script uses only `node:` imports, so either works; change
the shebang in `bin/lasttab.js` if you prefer node.

## How it works

A `tab.focused` event hook records the previously focused tab per workspace into
`$HERDR_PLUGIN_STATE_DIR/mru.json`, and an action reads it back and calls
`herdr tab focus`. Writes are atomic, since focus events can arrive back to back.

Refocusing the tab you are already on is ignored, or the toggle would degenerate
into a no-op. If the remembered tab has been closed, the toggle fails once with a
message and clears the stale pointer rather than failing forever.

## License

MIT
