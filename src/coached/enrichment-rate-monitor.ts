import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MIN_THRESHOLD = 0.3;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const HARD_FIXED_OUTCOME = "skipped:hard_fixed";

export interface EnrichmentRateMonitorOpts {
  windowSize?: number;
  minThreshold?: number;
  onAlert?: (rate: number, window: number, threshold: number) => void;
  persistPath?: string;
  ttlMs?: number;
}

interface PersistedEntry {
  outcome: "enriched" | "not_enriched";
  ts: number;
}

interface PersistedData {
  entries: PersistedEntry[];
}

function readEnvNumber(key: string): number | undefined {
  const raw = process.env[key];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export class EnrichmentRateMonitor {
  private readonly outcomes: Array<"enriched" | "not_enriched"> = [];
  private readonly timestamps: Array<number> = [];
  private readonly windowSize: number;
  private readonly minThreshold: number;
  private readonly onAlert: (
    rate: number,
    window: number,
    threshold: number,
  ) => void;
  private alertFired = false;
  private readonly persistPath: string | undefined;
  private readonly ttlMs: number;
  private pendingFlush: Promise<void> | null = null;

  constructor(opts?: EnrichmentRateMonitorOpts) {
    this.windowSize =
      readEnvNumber("ENRICH_RATE_WINDOW") ??
      opts?.windowSize ??
      DEFAULT_WINDOW_SIZE;
    this.minThreshold =
      readEnvNumber("ENRICH_RATE_MIN_THRESHOLD") ??
      opts?.minThreshold ??
      DEFAULT_MIN_THRESHOLD;
    this.onAlert =
      opts?.onAlert ??
      ((rate, window, threshold) => {
        process.stderr.write(
          `[coached_check_in] WARNING: diff-aware enrichment rate ${(rate * 100).toFixed(1)}% ` +
            `over last ${window} eligible outcomes is below threshold ${(threshold * 100).toFixed(1)}%\n`,
        );
      });
    this.ttlMs =
      readEnvNumber("ENRICH_RATE_TTL_MS") ?? opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.persistPath = opts?.persistPath;

    this.loadPersistedData();
  }

  private loadPersistedData(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      const data = JSON.parse(raw) as PersistedData;
      if (!data || !Array.isArray(data.entries)) return;

      const now = Date.now();
      const cutoff = now - this.ttlMs;

      const valid = data.entries
        .filter(
          (e) =>
            typeof e.ts === "number" &&
            e.ts > cutoff &&
            (e.outcome === "enriched" || e.outcome === "not_enriched"),
        )
        .slice(-this.windowSize);

      for (const entry of valid) {
        this.outcomes.push(entry.outcome);
        this.timestamps.push(entry.ts);
      }
    } catch {
      // Missing or corrupt file — start fresh.
    }
  }

  private flushToDisk(): void {
    if (!this.persistPath) return;

    const entries: PersistedEntry[] = this.outcomes.map((outcome, i) => ({
      outcome,
      ts: this.timestamps[i] ?? Date.now(),
    }));
    const data: PersistedData = { entries };
    const filePath = this.persistPath;

    this.pendingFlush = (this.pendingFlush ?? Promise.resolve())
      .then(() => {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      })
      .catch(() => {
        // Best-effort persistence — never break the monitor.
      });
  }

  record(outcome: string): void {
    if (outcome === HARD_FIXED_OUTCOME) return;

    const mapped = outcome === "enriched" ? "enriched" : "not_enriched";
    this.outcomes.push(mapped);
    this.timestamps.push(Date.now());

    if (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
      this.timestamps.shift();
    }

    this.flushToDisk();

    if (this.outcomes.length < this.windowSize) {
      this.alertFired = false;
      return;
    }

    const enrichedCount = this.outcomes.filter((o) => o === "enriched").length;
    const rate = enrichedCount / this.windowSize;

    if (rate < this.minThreshold) {
      if (!this.alertFired) {
        this.onAlert(rate, this.windowSize, this.minThreshold);
        this.alertFired = true;
      }
    } else {
      this.alertFired = false;
    }
  }

  get stats(): { total: number; enriched: number; rate: number | null } {
    const total = this.outcomes.length;
    const enriched = this.outcomes.filter((o) => o === "enriched").length;
    return {
      total,
      enriched,
      rate: total > 0 ? enriched / total : null,
    };
  }
}
