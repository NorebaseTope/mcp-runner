import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { EnrichmentRateMonitor } from "../coached/enrichment-rate-monitor.js";

function tmpPersistPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erm-test-"));
  return path.join(dir, "outcomes.json");
}

test("does not alert before the window is full", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    minThreshold: 0.3,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  for (let i = 0; i < 4; i++) {
    monitor.record("fallback:sample_failed");
  }
  assert.equal(alerts.length, 0);
});

test("alerts when enrichment rate drops below threshold", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    minThreshold: 0.3,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  for (let i = 0; i < 5; i++) {
    monitor.record("skipped:no_state");
  }
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.rate, 0);
  assert.equal(alerts[0]!.window, 5);
  assert.equal(alerts[0]!.threshold, 0.3);
});

test("does not alert when rate is at or above threshold", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    minThreshold: 0.4,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("enriched");
  monitor.record("enriched");
  monitor.record("skipped:no_state");
  monitor.record("skipped:empty_diff");
  monitor.record("skipped:no_baseline");

  assert.equal(alerts.length, 0);
  assert.equal(monitor.stats.rate, 0.4);
});

test("ignores skipped:hard_fixed outcomes", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.3,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("enriched");
  monitor.record("skipped:hard_fixed");
  monitor.record("skipped:hard_fixed");
  monitor.record("enriched");

  assert.equal(monitor.stats.total, 2);
  assert.equal(monitor.stats.enriched, 2);
  assert.equal(alerts.length, 0);
});

test("deduplicates consecutive alerts in same degraded window", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.5,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  assert.equal(alerts.length, 1);

  monitor.record("skipped:no_state");
  assert.equal(alerts.length, 1);
});

test("re-arms alert after rate recovers above threshold then drops again", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.5,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  assert.equal(alerts.length, 1);

  monitor.record("enriched");
  monitor.record("enriched");
  assert.equal(alerts.length, 1);

  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  assert.equal(alerts.length, 2);
});

test("rolling window evicts oldest outcomes", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.5,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("enriched");
  monitor.record("enriched");
  monitor.record("enriched");
  assert.equal(alerts.length, 0);

  monitor.record("skipped:no_state");
  monitor.record("skipped:no_state");
  assert.equal(monitor.stats.total, 3);
  assert.equal(monitor.stats.enriched, 1);
});

test("handles unknown outcome strings as not_enriched", () => {
  const alerts: Array<{ rate: number; window: number; threshold: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.5,
    onAlert: (rate, window, threshold) => alerts.push({ rate, window, threshold }),
  });

  monitor.record("error:uncaught");
  monitor.record("error:uncaught");
  monitor.record("error:uncaught");
  assert.equal(alerts.length, 1);
  assert.equal(monitor.stats.enriched, 0);
});

test("stats returns null rate when no outcomes recorded", () => {
  const monitor = new EnrichmentRateMonitor({ windowSize: 5 });
  assert.deepEqual(monitor.stats, { total: 0, enriched: 0, rate: null });
});

test("persists outcomes to disk and restores on new instance", async () => {
  const persistPath = tmpPersistPath();
  const m1 = new EnrichmentRateMonitor({
    windowSize: 5,
    persistPath,
  });

  m1.record("enriched");
  m1.record("skipped:no_state");
  m1.record("enriched");

  await new Promise((r) => setTimeout(r, 50));

  const m2 = new EnrichmentRateMonitor({
    windowSize: 5,
    persistPath,
  });

  assert.equal(m2.stats.total, 3);
  assert.equal(m2.stats.enriched, 2);
});

test("discards stale persisted entries beyond TTL", async () => {
  const persistPath = tmpPersistPath();

  const staleTs = Date.now() - 2 * 60 * 60 * 1000;
  const freshTs = Date.now();
  const data = {
    entries: [
      { outcome: "enriched", ts: staleTs },
      { outcome: "not_enriched", ts: staleTs },
      { outcome: "enriched", ts: freshTs },
    ],
  };
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, JSON.stringify(data));

  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    persistPath,
    ttlMs: 60 * 60 * 1000,
  });

  assert.equal(monitor.stats.total, 1);
  assert.equal(monitor.stats.enriched, 1);
});

test("truncates restored entries to windowSize", async () => {
  const persistPath = tmpPersistPath();

  const now = Date.now();
  const entries = Array.from({ length: 10 }, (_, i) => ({
    outcome: i < 5 ? "enriched" : "not_enriched",
    ts: now - (10 - i) * 1000,
  }));
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, JSON.stringify({ entries }));

  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    persistPath,
    ttlMs: 60 * 60 * 1000,
  });

  assert.equal(monitor.stats.total, 3);
  assert.equal(monitor.stats.enriched, 0);
});

test("handles missing persist file gracefully", () => {
  const persistPath = path.join(os.tmpdir(), "nonexistent-dir-erm", "nope.json");
  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    persistPath,
  });
  assert.equal(monitor.stats.total, 0);
});

test("handles corrupt persist file gracefully", () => {
  const persistPath = tmpPersistPath();
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, "not valid json {{{");

  const monitor = new EnrichmentRateMonitor({
    windowSize: 5,
    persistPath,
  });
  assert.equal(monitor.stats.total, 0);
});

test("no persistence when persistPath is not set", () => {
  const monitor = new EnrichmentRateMonitor({ windowSize: 3 });
  monitor.record("enriched");
  monitor.record("enriched");
  assert.equal(monitor.stats.total, 2);
});

test("restored outcomes trigger alert check correctly", async () => {
  const persistPath = tmpPersistPath();

  const now = Date.now();
  const data = {
    entries: [
      { outcome: "not_enriched", ts: now - 3000 },
      { outcome: "not_enriched", ts: now - 2000 },
    ],
  };
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, JSON.stringify(data));

  const alerts: Array<{ rate: number }> = [];
  const monitor = new EnrichmentRateMonitor({
    windowSize: 3,
    minThreshold: 0.5,
    persistPath,
    ttlMs: 60 * 60 * 1000,
    onAlert: (rate) => alerts.push({ rate }),
  });

  assert.equal(monitor.stats.total, 2);
  assert.equal(alerts.length, 0);

  monitor.record("skipped:no_state");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.rate, 0);
});
