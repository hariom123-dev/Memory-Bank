import { setup, assign } from "xstate";
import type { DaemonMachineContext, DaemonLifecycleEvent } from "./types.js";

export const initialDaemonContext: DaemonMachineContext = {
  startedAt: null,
  activeOperations: 0,
  lastError: null,
  currentSessionId: null,
  shutdownReason: null,
};

export const daemonMachine = setup({
  types: {
    context: {} as DaemonMachineContext,
    events: {} as DaemonLifecycleEvent,
  },
  actions: {
    markStarted: assign({
      startedAt: () => Date.now(),
      lastError: () => null,
    }),
    recordInitError: assign({
      lastError: ({ event }) => ("error" in event ? event.error : "Unknown initialization error"),
    }),
    beginIngestion: assign({
      activeOperations: ({ context }) => context.activeOperations + 1,
      currentSessionId: ({ event }) =>
        event.type === "START_INGESTION" ? event.payload.sessionId : null,
      lastError: () => null,
    }),
    finishIngestion: assign({
      activeOperations: ({ context }) => Math.max(0, context.activeOperations - 1),
      currentSessionId: () => null,
    }),
    recordIngestionError: assign({
      activeOperations: ({ context }) => Math.max(0, context.activeOperations - 1),
      currentSessionId: () => null,
      lastError: ({ event }) => ("error" in event ? event.error : "Unknown ingestion error"),
    }),
    beginRetrieval: assign({
      activeOperations: ({ context }) => context.activeOperations + 1,
      lastError: () => null,
    }),
    finishRetrieval: assign({
      activeOperations: ({ context }) => Math.max(0, context.activeOperations - 1),
    }),
    recordRetrievalError: assign({
      activeOperations: ({ context }) => Math.max(0, context.activeOperations - 1),
      lastError: ({ event }) => ("error" in event ? event.error : "Unknown retrieval error"),
    }),
    recordShutdownReason: assign({
      shutdownReason: ({ event }) =>
        "reason" in event && event.reason ? event.reason : "Normal termination",
    }),
  },
}).createMachine({
  id: "memoryBankDaemon",
  initial: "INITIALIZING",
  context: initialDaemonContext,
  states: {
    INITIALIZING: {
      on: {
        INITIALIZE_SUCCESS: {
          target: "LISTENING",
          actions: ["markStarted"],
        },
        INITIALIZE_FAILURE: {
          target: "SHUTDOWN",
          actions: ["recordInitError"],
        },
        TERMINATE: {
          target: "SHUTDOWN",
          actions: ["recordShutdownReason"],
        },
      },
    },
    LISTENING: {
      on: {
        START_INGESTION: {
          target: "INGESTING_MEMORY",
          actions: ["beginIngestion"],
        },
        START_RETRIEVAL: {
          target: "RETRIEVING_CONTEXT",
          actions: ["beginRetrieval"],
        },
        TERMINATE: {
          target: "SHUTDOWN",
          actions: ["recordShutdownReason"],
        },
      },
    },
    INGESTING_MEMORY: {
      on: {
        INGESTION_SUCCESS: {
          target: "LISTENING",
          actions: ["finishIngestion"],
        },
        INGESTION_FAILURE: {
          target: "LISTENING",
          actions: ["recordIngestionError"],
        },
        TERMINATE: {
          target: "SHUTDOWN",
          actions: ["recordShutdownReason"],
        },
      },
    },
    RETRIEVING_CONTEXT: {
      on: {
        RETRIEVAL_SUCCESS: {
          target: "LISTENING",
          actions: ["finishRetrieval"],
        },
        RETRIEVAL_FAILURE: {
          target: "LISTENING",
          actions: ["recordRetrievalError"],
        },
        TERMINATE: {
          target: "SHUTDOWN",
          actions: ["recordShutdownReason"],
        },
      },
    },
    SHUTDOWN: {
      type: "final",
    },
  },
});
