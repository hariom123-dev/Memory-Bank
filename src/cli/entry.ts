#!/usr/bin/env node
import { MemoryBusDaemon } from "../daemon/daemon.js";
import { DaemonProcessManager } from "./daemonize.js";
import { TerminalMonitorDashboard } from "./monitor.js";
import { TypedEventBus } from "../events/bus.js";
import type { MemoryBusEventMap } from "../events/types.js";
import { createMemoryBusMcpServer } from "../mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const manager = new DaemonProcessManager();

async function main() {
  switch (command) {
    case "start": {
      const isDetached = args.includes("--daemon") || args.includes("-d");
      if (isDetached) {
        const result = manager.startDaemon(process.argv[1] ?? "", ["run"]);
        if (result.status === "already_running") {
          console.log(`Memory Bus daemon is already running (PID: ${result.pid}).`);
        } else {
          console.log(`Memory Bus daemon started in background (PID: ${result.pid}).`);
        }
      } else {
        console.log("Starting Memory Bus daemon in foreground...");
        const daemon = new MemoryBusDaemon({ autoBindSignals: true });
        await daemon.start();
        console.log("Memory Bus daemon running. Press Ctrl+C to terminate.");
      }
      break;
    }

    case "stop": {
      const result = manager.stopDaemon();
      if (result.status === "stopped") {
        console.log(`Memory Bus daemon (PID: ${result.pid}) stopped successfully.`);
      } else {
        console.log("Memory Bus daemon is not running.");
      }
      break;
    }

    case "status": {
      const status = manager.statusDaemon();
      if (status.running) {
        console.log(`Memory Bus daemon is RUNNING (PID: ${status.pid}).`);
      } else {
        console.log("Memory Bus daemon is STOPPED.");
      }
      break;
    }

    case "monitor": {
      const bus = new TypedEventBus<MemoryBusEventMap>();
      const monitor = new TerminalMonitorDashboard({ bus });
      monitor.start();
      console.clear();
      console.log(monitor.renderSnapshot());
      break;
    }

    case "mcp": {
      const { server } = createMemoryBusMcpServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      console.log("memory-bus v0.1.0");
      break;
    }

    default: {
      console.log(`
Memory Bus - Local Agent Swarm Operating System

Usage:
  memory-bus <command> [options]

Commands:
  start [--daemon]   Start the daemon in foreground or detached background
  stop               Gracefully terminate the background daemon
  status             Check if the daemon is currently running
  monitor            Launch the terminal monitoring dashboard
  mcp                Run the Model Context Protocol (MCP) stdio server
  version            Print version information
`);
      break;
    }
  }
}

void main();
