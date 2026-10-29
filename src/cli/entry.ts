#!/usr/bin/env node
import { resolve } from "node:path";
import { MemoryBankDaemon } from "../daemon/daemon.js";
import { DaemonProcessManager } from "./daemonize.js";
import { TerminalMonitorDashboard } from "./monitor.js";
import { TypedEventBus } from "../events/bus.js";
import type { MemoryBankEventMap } from "../events/types.js";
import { createMemoryBankMcpServer } from "../mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runHealthcheck } from "./healthcheck.js";
import { validateEnv } from "../config/env.js";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const manager = new DaemonProcessManager();

async function main() {
  // Validate environment at entry point
  validateEnv();

  switch (command) {
    case "run":
    case "start": {
      const isDetached = args.includes("--daemon") || args.includes("-d");
      const health = await runHealthcheck();
      if (!health.ok) {
        process.exit(1);
      }

      if (isDetached) {
        const entryScript = resolve(process.argv[1] ?? "");
        const result = manager.startDaemon(entryScript, ["run"]);
        if (result.status === "already_running") {
          console.log(`Memory Bank daemon is already running (PID: ${result.pid}).`);
        } else {
          console.log(`Memory Bank daemon started in background (PID: ${result.pid}).`);
        }
      } else {
        console.log("Starting Memory Bank daemon in foreground...");
        const daemon = new MemoryBankDaemon({ autoBindSignals: true });
        await daemon.start();
        console.log("Memory Bank daemon running. Press Ctrl+C to terminate.");
      }
      break;
    }

    case "bootstrap":
    case "healthcheck": {
      const health = await runHealthcheck();
      if (!health.ok) {
        process.exit(1);
      }
      break;
    }

    case "stop": {
      const result = manager.stopDaemon();
      if (result.status === "stopped") {
        console.log(`Memory Bank daemon (PID: ${result.pid}) stopped successfully.`);
      } else {
        console.log("Memory Bank daemon is not running.");
      }
      break;
    }

    case "status": {
      const status = manager.statusDaemon();
      if (status.running) {
        console.log(`Memory Bank daemon is RUNNING (PID: ${status.pid}).`);
      } else {
        console.log("Memory Bank daemon is STOPPED.");
      }
      break;
    }

    case "monitor": {
      const bus = new TypedEventBus<MemoryBankEventMap>();
      const monitor = new TerminalMonitorDashboard({ bus });
      monitor.start();
      console.clear();
      console.log(monitor.renderSnapshot());
      break;
    }

    case "mcp": {
      const { server } = createMemoryBankMcpServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      console.log("memory-bank v0.1.0");
      break;
    }

    default: {
      console.log(`
Memory Bank - Local Agent Swarm Operating System

Usage:
  memory-bank <command> [options]

Commands:
  start [--daemon]   Start the daemon in foreground or detached background
  stop               Gracefully terminate the background daemon
  status             Check if the daemon is currently running
  monitor            Launch the terminal monitoring dashboard
  mcp                Run the Model Context Protocol (MCP) stdio server
  healthcheck        Run preflight healthchecks (Git, Docker, Permissions, Env)
  version            Print version information
`);
      break;
    }
  }
}

void main();
