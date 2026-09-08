#!/usr/bin/env bun
// Most-recently-used tab and workspace toggles for herdr.
//
// Reproduces tmux's `last-window` (prefix+b, from tmux-sensible) and
// `switch-client -l` (prefix+shift+l).
//
// herdr 0.9.0 made tab and workspace focus client-local: a client switching
// its view no longer emits tab.focused/workspace.focused socket events and no
// longer runs plugin event hooks. Those events now fire only when an API
// focus call actually changes the server's canonical focus. The canonical
// focus (what `session.snapshot` and a caller-less `pane.current` report)
// still silently follows whichever client interacted last, so this plugin
// tracks it with a small watcher process that polls `pane.current` over the
// socket instead of the pre-0.9 event hooks.
//
// herdr's own `last_pane` cannot serve either role: it is a single global
// *pane* MRU, and any tab toggle overwrites it, so binding it to one key
// breaks the other. Both pairs are kept here, in two separate state files
// that cannot clobber each other.
//
//   lasttab.js ensure-watcher     startup hook; spawns `watch` if not running
//   lasttab.js watch              polls canonical focus, records MRU pairs
//   lasttab.js toggle             focuses the previous tab in this workspace
//   lasttab.js toggle-workspace   focuses the previous workspace
//
// Uses node: imports throughout, so it runs unchanged under node if bun ever
// goes away.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

// Deliberately two files rather than two keys in one. The watcher and a
// toggle can write in the same instant, so sharing a file would widen the
// read-modify-write window; per-concern files at least keep the tab pair and
// the workspace pair from clobbering each other.
const STATE_FILE = "mru.json";
const WORKSPACE_STATE_FILE = "workspace-mru.json";
const PID_FILE = "watcher.pid";

const POLL_MS = Number(process.env.LASTTAB_POLL_MS) > 0 ? Number(process.env.LASTTAB_POLL_MS) : 250;

export function stateDir() {
  const dir =
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), ".local", "state", "herdr-lasttab");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function load(file = STATE_FILE) {
  try {
    const data = JSON.parse(readFileSync(join(stateDir(), file), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function save(data, file = STATE_FILE) {
  const dir = stateDir();
  const target = join(dir, file);
  // Focus samples can arrive back to back, so never leave a half-written file.
  const tmp = join(dir, `${file}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function herdr(...args) {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  return spawnSync(bin, args, { encoding: "utf8" });
}

function socketPath() {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
}

// ---------------------------------------------------------------------------
// MRU pair transitions. Pure so the tests can drive them directly.

// Refocusing the tab you are already on must not clobber the pair, or the
// toggle degenerates into a no-op.
export function recordTab(data, workspaceId, tabId) {
  const current = data[workspaceId]?.current ?? null;
  if (current === tabId) return false;
  data[workspaceId] = { current: tabId, previous: current };
  return true;
}

export function recordWorkspace(data, workspaceId) {
  if (data.current === workspaceId) return false;
  return { current: workspaceId, previous: data.current ?? null };
}

// The invoking client's view wins over the recorded pair: when the watcher
// has not caught up to a switch yet, the recorded `current` IS the tab the
// user came from, so toggle to it instead of `previous`.
export function toggleTarget(pair, currentId) {
  const target = pair?.current === currentId ? pair?.previous : pair?.current;
  if (!target || target === currentId) return null;
  return target;
}

export function dropTarget(pair, target) {
  return {
    current: pair?.current === target ? null : (pair?.current ?? null),
    previous: pair?.previous === target ? null : (pair?.previous ?? null),
  };
}

// ---------------------------------------------------------------------------
// Invocation context. Action commands receive the invoking client's view in
// HERDR_PLUGIN_CONTEXT_JSON (and mirrored HERDR_WORKSPACE_ID/HERDR_TAB_ID).
// Because a client's local switch also silently updates the canonical focus,
// falling back to the snapshot stays correct for manual CLI invocations.

function invocationContext() {
  let ctx = {};
  try {
    ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}") || {};
  } catch {}
  let workspaceId = ctx.workspace_id ?? process.env.HERDR_WORKSPACE_ID ?? null;
  let tabId = ctx.tab_id ?? process.env.HERDR_TAB_ID ?? null;
  if (!workspaceId) {
    const result = herdr("api", "snapshot");
    if (result.status === 0) {
      try {
        const snap = JSON.parse(result.stdout)?.result?.snapshot;
        workspaceId = snap?.focused_workspace_id ?? null;
        tabId = tabId ?? snap?.focused_tab_id ?? null;
      } catch {}
    }
  }
  return { workspaceId, tabId };
}

// ---------------------------------------------------------------------------
// Toggles.

function toggle() {
  ensureWatcher();
  const { workspaceId, tabId } = invocationContext();
  if (!workspaceId) {
    console.error("lasttab: could not determine the focused workspace");
    return 1;
  }

  const data = load();
  const target = toggleTarget(data[workspaceId], tabId);
  // Nothing to go back to yet; not an error, just a fresh workspace.
  if (!target) return 0;

  if (herdr("tab", "focus", target).status !== 0) {
    // Most likely the tab was closed. Drop the stale pointer so the next
    // toggle does not keep failing.
    const after = load();
    after[workspaceId] = dropTarget(after[workspaceId], target);
    save(after);
    console.error(`lasttab: could not focus ${target}`);
    return 1;
  }

  // Record the jump immediately so a double-tap ping-pongs even before the
  // watcher's next poll sees it.
  const after = load();
  after[workspaceId] = { current: target, previous: tabId ?? after[workspaceId]?.current ?? null };
  save(after);
  return 0;
}

function toggleWorkspace() {
  ensureWatcher();
  const { workspaceId } = invocationContext();
  const data = load(WORKSPACE_STATE_FILE);
  const target = toggleTarget(data, workspaceId);
  // Nothing to go back to yet; only one workspace has been focused so far.
  if (!target) return 0;

  if (herdr("workspace", "focus", target).status !== 0) {
    save(dropTarget(load(WORKSPACE_STATE_FILE), target), WORKSPACE_STATE_FILE);
    console.error(`lasttab: could not focus workspace ${target}`);
    return 1;
  }

  const after = load(WORKSPACE_STATE_FILE);
  save({ current: target, previous: workspaceId ?? after.current ?? null }, WORKSPACE_STATE_FILE);
  return 0;
}

// ---------------------------------------------------------------------------
// Watcher. One per server; records the canonical focus into the state files.

function watcherPid() {
  try {
    const pid = parseInt(readFileSync(join(stateDir(), PID_FILE), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function watcherAlive() {
  const pid = watcherPid();
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureWatcher() {
  if (watcherAlive()) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "watch"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

// One request per connection; herdr closes the socket after responding.
function request(method, params = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath());
    let buf = "";
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => done(null));
    socket.on("error", () => done(null));
    socket.on("data", (chunk) => {
      buf += chunk;
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      try {
        done(JSON.parse(buf.slice(0, newline)));
      } catch {
        done(null);
      }
    });
    socket.on("end", () => done(null));
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: "lasttab", method, params }) + "\n");
    });
  });
}

async function currentFocus() {
  const response = await request("pane.current");
  const pane = response?.result?.pane;
  if (!pane?.workspace_id) return null;
  return { workspaceId: pane.workspace_id, tabId: pane.tab_id ?? null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function watch() {
  if (watcherAlive()) return 0;
  writeFileSync(join(stateDir(), PID_FILE), String(process.pid));

  let failures = 0;
  let ticks = 0;
  while (true) {
    const focus = await currentFocus();
    if (focus === null) {
      // Server stopping, restarting, or briefly unfocused. Give up only when
      // it stays unreachable, so the next action invocation respawns us.
      failures += 1;
      if (failures >= 20) break;
    } else {
      failures = 0;
      const tabs = load();
      if (focus.tabId && recordTab(tabs, focus.workspaceId, focus.tabId)) save(tabs);
      const workspaces = load(WORKSPACE_STATE_FILE);
      const next = recordWorkspace(workspaces, focus.workspaceId);
      if (next) save(next, WORKSPACE_STATE_FILE);
    }

    // Another watcher may have replaced us (plugin relink, races at spawn).
    ticks += 1;
    if (ticks % 20 === 0 && watcherPid() !== process.pid) return 0;

    await sleep(POLL_MS);
  }

  if (watcherPid() === process.pid) {
    try {
      unlinkSync(join(stateDir(), PID_FILE));
    } catch {}
  }
  return 0;
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "toggle") {
    process.exit(toggle());
  } else if (command === "toggle-workspace") {
    process.exit(toggleWorkspace());
  } else if (command === "ensure-watcher") {
    ensureWatcher();
    process.exit(0);
  } else if (command === "watch") {
    watch().then((code) => process.exit(code));
  } else {
    console.error("usage: lasttab.js <toggle|toggle-workspace|ensure-watcher|watch>");
    process.exit(2);
  }
}
