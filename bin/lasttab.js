#!/usr/bin/env bun
// Per-workspace most-recently-used tab toggle for herdr.
//
// Reproduces tmux's `last-window` (bound to prefix+b by tmux-sensible). herdr
// ships a single MRU binding, `last_pane`, which is global; this keeps a
// separate MRU pair per workspace so toggling tabs and toggling workspaces stay
// independent, the way they were in tmux.
//
//   lasttab.js record   run from a tab.focused event hook
//   lasttab.js toggle   run from an action; focuses the previous tab
//
// Uses node: imports throughout, so it runs unchanged under node if bun ever
// goes away.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const STATE_FILE = "mru.json";

function stateDir() {
  const dir =
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), ".local", "state", "herdr-lasttab");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function load() {
  try {
    const data = JSON.parse(readFileSync(join(stateDir(), STATE_FILE), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function save(data) {
  const dir = stateDir();
  const target = join(dir, STATE_FILE);
  // Focus events can arrive back to back, so never leave a half-written file.
  const tmp = join(dir, `${STATE_FILE}.${process.pid}.tmp`);
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

function record() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return 0;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return 0;
  }

  // The payload may be the event body or wrapped; accept either.
  const body = event && typeof event.data === "object" && event.data !== null ? event.data : event;
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

const command = process.argv[2];
if (command === "record") process.exit(record());
if (command === "toggle") process.exit(toggle());

console.error("usage: lasttab.js <record|toggle>");
process.exit(2);
