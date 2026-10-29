import type { TypedEventBus } from "../events/bus.js";
import type { MemoryBankEventMap } from "../events/types.js";
import type { MemoryBankDaemon } from "../daemon/daemon.js";
import type { MemoryRepository } from "../db/relational.js";
import { statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DashboardMetrics {
  daemonState: string;
  dbSizeBytes: number;
  totalDecisions: number;
  totalSnapshots: number;
  recentEvents: Array<{ timestamp: number; type: string; summary: string }>;
}

export interface TerminalMonitorOptions {
  bus: TypedEventBus<MemoryBankEventMap>;
  daemon?: MemoryBankDaemon;
  repository?: MemoryRepository;
  dbPath?: string;
  maxEvents?: number;
  refreshIntervalMs?: number;
}

export class TerminalMonitorDashboard {
  private bus: TypedEventBus<MemoryBankEventMap>;
  private daemon?: MemoryBankDaemon | undefined;
  private repository?: MemoryRepository | undefined;
  private dbPath?: string | undefined;
  private maxEvents: number;
  private refreshIntervalMs: number;
  private recentEvents: Array<{ timestamp: number; type: string; summary: string }> = [];
  private unsubscribeBus?: (() => void) | undefined;
  private timer?: NodeJS.Timeout | undefined;

  constructor(options: TerminalMonitorOptions) {
    this.bus = options.bus;
    this.daemon = options.daemon;
    this.repository = options.repository;
    this.dbPath = options.dbPath ? resolve(options.dbPath) : undefined;
    this.maxEvents = options.maxEvents ?? 10;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 1000;
  }

  start(): this {
    if (this.unsubscribeBus) {
      return this;
    }

    if (this.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        // Periodic heartbeat refresh
      }, this.refreshIntervalMs);
      if (typeof this.timer.unref === "function") {
        this.timer.unref();
      }
    }

    this.unsubscribeBus = this.bus.subscribeAll((event, payload) => {
      let summary = "";
      if (event === "MEMORY_INGESTED" && "summary" in payload) {
        summary = `${payload.sourceFile} - ${payload.summary}`;
      } else if (event === "FILE_CHANGED" && "filePath" in payload) {
        summary = `${payload.changeType}: ${payload.filePath}`;
      } else if (event === "CONTEXT_REQUESTED" && "query" in payload) {
        summary = `Query: "${payload.query}"`;
      } else if (event === "CRITICAL_ERROR" && "message" in payload) {
        summary = `[ERROR] ${payload.message}`;
      }

      this.recordEvent(String(event), summary);
    });

    return this;
  }

  stop(): this {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this;
  }

  recordEvent(type: string, summary: string): void {
    this.recentEvents.unshift({
      timestamp: Date.now(),
      type,
      summary,
    });
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents.pop();
    }
  }

  getMetrics(): DashboardMetrics {
    const daemonState = this.daemon ? this.daemon.getState() : "LISTENING";
    let dbSizeBytes = 0;
    if (this.dbPath && existsSync(this.dbPath)) {
      try {
        dbSizeBytes = statSync(this.dbPath).size;
      } catch {
        dbSizeBytes = 0;
      }
    }

    let totalDecisions = 0;
    let totalSnapshots = 0;

    if (this.repository) {
      totalDecisions = this.repository.findAllDecisions().length;
      totalSnapshots = this.repository.findAllSnapshots().length;
    }

    return {
      daemonState,
      dbSizeBytes,
      totalDecisions,
      totalSnapshots,
      recentEvents: [...this.recentEvents],
    };
  }

  /**
   * Renders the current dashboard snapshot as formatted terminal text.
   */
  renderSnapshot(): string {
    const metrics = this.getMetrics();
    const dbSizeKb = (metrics.dbSizeBytes / 1024).toFixed(1);

    const lines: string[] = [
      "==================================================================",
      "             MEMORY BANK - AGENT SWARM OS MONITOR                 ",
      "==================================================================",
      `[Daemon State]:     ${metrics.daemonState}`,
      `[Database Size]:    ${dbSizeKb} KB | [Decisions]: ${metrics.totalDecisions} | [Snapshots]: ${metrics.totalSnapshots}`,
      "------------------------------------------------------------------",
      "                     LIVE INGESTION & EVENT STREAM                ",
      "------------------------------------------------------------------",
    ];

    if (metrics.recentEvents.length === 0) {
      lines.push("  (Waiting for agent actions...)");
    } else {
      for (const ev of metrics.recentEvents) {
        const timeStr = new Date(ev.timestamp).toLocaleTimeString();
        lines.push(`  [${timeStr}] ${ev.type.padEnd(16)}: ${ev.summary}`);
      }
    }

    lines.push("==================================================================");
    return lines.join("\n");
  }
}
