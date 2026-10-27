import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import { daemonMachine } from "../lifecycle.machine.js";

describe("Daemon Lifecycle State Machine (XState v5)", () => {
  it("starts in the INITIALIZING state with empty context", () => {
    const actor = createActor(daemonMachine).start();
    const snapshot = actor.getSnapshot();

    expect(snapshot.value).toBe("INITIALIZING");
    expect(snapshot.context.startedAt).toBeNull();
    expect(snapshot.context.activeOperations).toBe(0);
    expect(snapshot.context.lastError).toBeNull();
    actor.stop();
  });

  it("transitions from INITIALIZING to LISTENING on INITIALIZE_SUCCESS", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_SUCCESS" });
    const snapshot = actor.getSnapshot();

    expect(snapshot.value).toBe("LISTENING");
    expect(typeof snapshot.context.startedAt).toBe("number");
    expect(snapshot.context.lastError).toBeNull();
    actor.stop();
  });

  it("transitions from INITIALIZING to SHUTDOWN on INITIALIZE_FAILURE", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_FAILURE", error: "Failed to connect to subsystem" });
    const snapshot = actor.getSnapshot();

    expect(snapshot.value).toBe("SHUTDOWN");
    expect(snapshot.context.lastError).toBe("Failed to connect to subsystem");
    actor.stop();
  });

  it("transitions LISTENING -> INGESTING_MEMORY -> LISTENING on successful ingestion", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_SUCCESS" });
    expect(actor.getSnapshot().value).toBe("LISTENING");

    actor.send({
      type: "START_INGESTION",
      payload: { sessionId: "sess-123", source: "agent-run-1" },
    });
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("INGESTING_MEMORY");
    expect(snapshot.context.activeOperations).toBe(1);
    expect(snapshot.context.currentSessionId).toBe("sess-123");

    actor.send({ type: "INGESTION_SUCCESS", payload: { decisionId: "dec-456" } });
    snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("LISTENING");
    expect(snapshot.context.activeOperations).toBe(0);
    expect(snapshot.context.currentSessionId).toBeNull();
    actor.stop();
  });

  it("transitions LISTENING -> INGESTING_MEMORY -> LISTENING with recorded error on failure", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_SUCCESS" });

    actor.send({
      type: "START_INGESTION",
      payload: { sessionId: "sess-err", source: "agent-run-2" },
    });
    expect(actor.getSnapshot().value).toBe("INGESTING_MEMORY");

    actor.send({ type: "INGESTION_FAILURE", error: "AST parse timeout" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("LISTENING");
    expect(snapshot.context.activeOperations).toBe(0);
    expect(snapshot.context.lastError).toBe("AST parse timeout");
    actor.stop();
  });

  it("transitions LISTENING -> RETRIEVING_CONTEXT -> LISTENING on successful retrieval", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_SUCCESS" });

    actor.send({
      type: "START_RETRIEVAL",
      payload: { query: "How does auth work?" },
    });
    let snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("RETRIEVING_CONTEXT");
    expect(snapshot.context.activeOperations).toBe(1);

    actor.send({ type: "RETRIEVAL_SUCCESS", payload: { resultCount: 3 } });
    snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("LISTENING");
    expect(snapshot.context.activeOperations).toBe(0);
    actor.stop();
  });

  it("transitions LISTENING -> RETRIEVING_CONTEXT -> LISTENING with error on retrieval failure", () => {
    const actor = createActor(daemonMachine).start();
    actor.send({ type: "INITIALIZE_SUCCESS" });

    actor.send({
      type: "START_RETRIEVAL",
      payload: { query: "How does auth work?" },
    });
    expect(actor.getSnapshot().value).toBe("RETRIEVING_CONTEXT");

    actor.send({ type: "RETRIEVAL_FAILURE", error: "Vector store unavailable" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("LISTENING");
    expect(snapshot.context.activeOperations).toBe(0);
    expect(snapshot.context.lastError).toBe("Vector store unavailable");
    actor.stop();
  });

  it("transitions to SHUTDOWN on TERMINATE from any active state", () => {
    const states = ["INITIALIZING", "LISTENING", "INGESTING_MEMORY", "RETRIEVING_CONTEXT"] as const;

    for (const st of states) {
      const actor = createActor(daemonMachine).start();
      if (st === "LISTENING") {
        actor.send({ type: "INITIALIZE_SUCCESS" });
      } else if (st === "INGESTING_MEMORY") {
        actor.send({ type: "INITIALIZE_SUCCESS" });
        actor.send({ type: "START_INGESTION", payload: { sessionId: "s1", source: "test" } });
      } else if (st === "RETRIEVING_CONTEXT") {
        actor.send({ type: "INITIALIZE_SUCCESS" });
        actor.send({ type: "START_RETRIEVAL", payload: { query: "test" } });
      }

      expect(actor.getSnapshot().value).toBe(st);
      actor.send({ type: "TERMINATE", reason: `Terminated from ${st}` });
      expect(actor.getSnapshot().value).toBe("SHUTDOWN");
      expect(actor.getSnapshot().context.shutdownReason).toBe(`Terminated from ${st}`);
      actor.stop();
    }
  });
});
