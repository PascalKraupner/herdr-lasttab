#!/usr/bin/env bun
// Most-recently-used tab and workspace toggles for herdr.
//
// Reproduces tmux's `last-window` (prefix+b, from tmux-sensible) and
// `switch-client -l` (prefix+L).
//
// herdr's own `last_pane` cannot serve either role. It is a single global
// *pane* MRU, and `herdr tab focus` changes the focused pane, so any tab toggle
// overwrites it. Binding it to prefix+L therefore turned prefix+L into a second
// last-tab as soon as prefix+b was used. There is no last_workspace key in
// herdr 0.7.5 and no way to focus a tab without touching the MRU, so both
// toggles are kept here instead, in two separate state files that cannot
// clobber each other.
//
//   lasttab.js record             run from a tab.focused event hook
//   lasttab.js toggle             focuses the previous tab in this workspace
//   lasttab.js record-workspace   run from a workspace.focused event hook
//   lasttab.js toggle-workspace   focuses the previous workspace
//
// Uses node: imports throughout, so it runs unchanged under node if bun ever
// goes away.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// Deliberately two files rather than two keys in one. The tab and workspace
// hooks run as separate processes and can fire in the same instant, so sharing
// a file would mean one read-modify-write silently dropping the other's update.
const STATE_FILE = "mru.json";
const WORKSPACE_STATE_FILE = "workspace-mru.json";

function stateDir() {
  const dir =
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), ".local", "state", "herdr-lasttab");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function load(file = STATE_FILE) {
  try {
    const data = JSON.parse(readFileSync(join(stateDir(), file), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function save(data, file = STATE_FILE) {
  const dir = stateDir();
  const target = join(dir, file);
  // Focus events can arrive back to back, so never leave a half-written file.
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

function eventBody() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return null;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }

  // The payload may be the event body or wrapped; accept either.
  return event && typeof event.data === "object" && event.data !== null ? event.data : event;
}

function record() {
  const body = eventBody();
  if (!body) return 0;

  const tabId = body?.tab_id;
  const workspaceId = body?.workspace_id;
  if (!tabId || !workspaceId) return 0;

  const data = load();
  const current = data[workspaceId]?.current ?? null;

  // Refocusing the tab you are already on must not clobber the pair, or the
  // toggle degenerates into a no-op.
  if (current === tabId) return 0;

  data[workspaceId] = { current: tabId, previous: current };
  save(data);
  return 0;
}

function currentWorkspace() {
  if (process.env.HERDR_WORKSPACE_ID) return process.env.HERDR_WORKSPACE_ID;

  const result = herdr("api", "snapshot");
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout)?.result?.snapshot?.focused_workspace_id ?? null;
  } catch {
    return null;
  }
}

function toggle() {
  const workspace = currentWorkspace();
  if (!workspace) {
    console.error("lasttab: could not determine the focused workspace");
    return 1;
  }

  const previous = load()[workspace]?.previous;
  // Nothing to go back to yet; not an error, just a fresh workspace.
  if (!previous) return 0;

  if (herdr("tab", "focus", previous).status !== 0) {
    // Most likely the tab was closed. Drop the stale pointer so the next
    // toggle does not keep failing.
    const data = load();
    if (data[workspace]) {
      data[workspace].previous = null;
      save(data);
    }
    console.error(`lasttab: could not focus ${previous}`);
    return 1;
  }

  return 0;
}

function recordWorkspace() {
  const body = eventBody();
  if (!body) return 0;

  // workspace.focused carries the id as workspace_id; accept a bare id too, in
  // case the event body is ever flattened.
  const workspaceId = body?.workspace_id ?? body?.id;
  if (!workspaceId) return 0;

  const data = load(WORKSPACE_STATE_FILE);
  // Same guard as the tab pair: refocusing the workspace you are already on
  // must not overwrite previous, or the toggle becomes a no-op.
  if (data.current === workspaceId) return 0;

  save({ current: workspaceId, previous: data.current ?? null }, WORKSPACE_STATE_FILE);
  return 0;
}

function toggleWorkspace() {
  const previous = load(WORKSPACE_STATE_FILE).previous;
  // Nothing to go back to yet; only one workspace has been focused so far.
  if (!previous) return 0;

  if (herdr("workspace", "focus", previous).status !== 0) {
    // Most likely the workspace was closed. Drop the stale pointer so the next
    // toggle does not keep failing.
    const data = load(WORKSPACE_STATE_FILE);
    data.previous = null;
    save(data, WORKSPACE_STATE_FILE);
    console.error(`lasttab: could not focus workspace ${previous}`);
    return 1;
  }

  return 0;
}

const command = process.argv[2];
if (command === "record") process.exit(record());
if (command === "toggle") process.exit(toggle());
if (command === "record-workspace") process.exit(recordWorkspace());
if (command === "toggle-workspace") process.exit(toggleWorkspace());

console.error("usage: lasttab.js <record|toggle|record-workspace|toggle-workspace>");
process.exit(2);
