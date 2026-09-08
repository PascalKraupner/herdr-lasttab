// Run with: bun test
//
// The pure MRU transitions are imported directly. The toggle commands are
// exercised end-to-end as child processes against a fake `herdr` binary
// (HERDR_BIN_PATH) and a temp state dir (HERDR_PLUGIN_STATE_DIR), the same
// seams the real herdr runtime uses. The watcher is exercised against a fake
// herdr socket (HERDR_SOCKET_PATH) serving canned pane.current responses.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";

import { recordTab, recordWorkspace, toggleTarget, dropTarget } from "../bin/lasttab.js";

const SCRIPT = new URL("../bin/lasttab.js", import.meta.url).pathname;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lasttab-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure transitions

test("recordTab keeps a per-workspace pair and ignores refocus", () => {
  const data = {};
  expect(recordTab(data, "w1", "w1:t1")).toBe(true);
  expect(data.w1).toEqual({ current: "w1:t1", previous: null });

  expect(recordTab(data, "w1", "w1:t2")).toBe(true);
  expect(data.w1).toEqual({ current: "w1:t2", previous: "w1:t1" });

  // Refocusing the current tab must not clobber the pair.
  expect(recordTab(data, "w1", "w1:t2")).toBe(false);
  expect(data.w1).toEqual({ current: "w1:t2", previous: "w1:t1" });

  // Other workspaces keep their own pairs.
  expect(recordTab(data, "w2", "w2:t1")).toBe(true);
  expect(data.w1.current).toBe("w1:t2");
});

test("recordWorkspace keeps the global pair and ignores refocus", () => {
  let data = {};
  data = recordWorkspace(data, "w1") || data;
  expect(data).toEqual({ current: "w1", previous: null });
  data = recordWorkspace(data, "w2") || data;
  expect(data).toEqual({ current: "w2", previous: "w1" });
  expect(recordWorkspace(data, "w2")).toBe(false);
});

test("toggleTarget prefers previous when state matches the caller", () => {
  const pair = { current: "w1:t2", previous: "w1:t1" };
  expect(toggleTarget(pair, "w1:t2")).toBe("w1:t1");
});

test("toggleTarget falls back to current when the watcher lags", () => {
  // The user switched to t3 after the last recorded sample; the recorded
  // current IS the tab they came from.
  const pair = { current: "w1:t2", previous: "w1:t1" };
  expect(toggleTarget(pair, "w1:t3")).toBe("w1:t2");
});

test("toggleTarget returns null with nothing to go back to", () => {
  expect(toggleTarget(undefined, "w1:t1")).toBe(null);
  expect(toggleTarget({ current: "w1:t1", previous: null }, "w1:t1")).toBe(null);
  expect(toggleTarget({ current: "w1:t1", previous: "w1:t1" }, "w1:t1")).toBe(null);
});

test("dropTarget clears only the stale pointer", () => {
  expect(dropTarget({ current: "w1:t2", previous: "w1:t1" }, "w1:t1")).toEqual({
    current: "w1:t2",
    previous: null,
  });
  expect(dropTarget({ current: "w1:t2", previous: "w1:t1" }, "w1:t2")).toEqual({
    current: null,
    previous: "w1:t1",
  });
});

// ---------------------------------------------------------------------------
// Toggle commands against a fake herdr

function fakeHerdr(exitCode = 0) {
  const log = join(dir, "herdr-args.log");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

function runToggle(args, env, herdrExit = 0) {
  const { bin, log } = fakeHerdr(herdrExit);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: dir,
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_CONTEXT_JSON: "",
      HERDR_WORKSPACE_ID: "",
      HERDR_TAB_ID: "",
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { result, calls };
}

const context = (workspaceId, tabId) =>
  JSON.stringify({ workspace_id: workspaceId, tab_id: tabId });

test("toggle focuses the previous tab and records the jump", () => {
  writeFileSync(join(dir, "mru.json"), JSON.stringify({ w1: { current: "w1:t2", previous: "w1:t1" } }));
  // A stale pid blocks the watcher spawn during tests.
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));

  const { result, calls } = runToggle(["toggle"], {
    HERDR_PLUGIN_CONTEXT_JSON: context("w1", "w1:t2"),
  });

  expect(result.status).toBe(0);
  expect(calls).toEqual(["tab focus w1:t1"]);
  expect(JSON.parse(readFileSync(join(dir, "mru.json"), "utf8")).w1).toEqual({
    current: "w1:t1",
    previous: "w1:t2",
  });
});

test("toggle uses recorded current when the watcher lags behind", () => {
  writeFileSync(join(dir, "mru.json"), JSON.stringify({ w1: { current: "w1:t2", previous: "w1:t1" } }));
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));

  const { result, calls } = runToggle(["toggle"], {
    HERDR_PLUGIN_CONTEXT_JSON: context("w1", "w1:t3"),
  });

  expect(result.status).toBe(0);
  expect(calls).toEqual(["tab focus w1:t2"]);
  expect(JSON.parse(readFileSync(join(dir, "mru.json"), "utf8")).w1).toEqual({
    current: "w1:t2",
    previous: "w1:t3",
  });
});

test("toggle with no history is a quiet no-op", () => {
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));
  const { result, calls } = runToggle(["toggle"], {
    HERDR_PLUGIN_CONTEXT_JSON: context("w1", "w1:t1"),
  });
  expect(result.status).toBe(0);
  expect(calls).toEqual([]);
});

test("toggle drops a stale pointer when the tab is gone", () => {
  writeFileSync(join(dir, "mru.json"), JSON.stringify({ w1: { current: "w1:t2", previous: "w1:t9" } }));
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));

  const { result } = runToggle(
    ["toggle"],
    { HERDR_PLUGIN_CONTEXT_JSON: context("w1", "w1:t2") },
    1,
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("could not focus w1:t9");
  expect(JSON.parse(readFileSync(join(dir, "mru.json"), "utf8")).w1).toEqual({
    current: "w1:t2",
    previous: null,
  });
});

test("toggle-workspace ping-pongs between the last two workspaces", () => {
  writeFileSync(join(dir, "workspace-mru.json"), JSON.stringify({ current: "w2", previous: "w1" }));
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));

  const { result, calls } = runToggle(["toggle-workspace"], {
    HERDR_PLUGIN_CONTEXT_JSON: context("w2", "w2:t1"),
  });

  expect(result.status).toBe(0);
  expect(calls).toEqual(["workspace focus w1"]);
  expect(JSON.parse(readFileSync(join(dir, "workspace-mru.json"), "utf8"))).toEqual({
    current: "w1",
    previous: "w2",
  });
});

// ---------------------------------------------------------------------------
// Watcher against a fake herdr socket

test("watch records canonical focus transitions from pane.current", async () => {
  const socketPath = join(dir, "herdr.sock");
  const focusSequence = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2" },
    { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" },
  ];
  let call = 0;
  const server = createServer((socket) => {
    socket.on("data", () => {
      const pane = focusSequence[Math.min(call, focusSequence.length - 1)];
      call += 1;
      socket.end(JSON.stringify({ id: "lasttab", result: { type: "pane_current", pane } }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const watcher = spawn(process.execPath, [SCRIPT, "watch"], {
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: dir,
      HERDR_SOCKET_PATH: socketPath,
      LASTTAB_POLL_MS: "20",
    },
    stdio: "ignore",
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const tabs = JSON.parse(readFileSync(join(dir, "mru.json"), "utf8"));
    const workspaces = JSON.parse(readFileSync(join(dir, "workspace-mru.json"), "utf8"));
    expect(tabs.w1).toEqual({ current: "w1:t2", previous: "w1:t1" });
    expect(tabs.w2).toEqual({ current: "w2:t1", previous: null });
    expect(workspaces).toEqual({ current: "w2", previous: "w1" });
    expect(readFileSync(join(dir, "watcher.pid"), "utf8")).toBe(String(watcher.pid));
  } finally {
    watcher.kill();
    server.close();
  }
});

test("watch exits when another watcher owns the pid file", async () => {
  writeFileSync(join(dir, "watcher.pid"), String(process.pid));
  const result = spawnSync(process.execPath, [SCRIPT, "watch"], {
    encoding: "utf8",
    timeout: 3000,
    env: { ...process.env, HERDR_PLUGIN_STATE_DIR: dir },
  });
  expect(result.status).toBe(0);
  // The pid file still names the original owner.
  expect(readFileSync(join(dir, "watcher.pid"), "utf8")).toBe(String(process.pid));
});
