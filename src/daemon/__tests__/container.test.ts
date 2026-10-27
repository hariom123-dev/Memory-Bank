import { describe, it, expect } from "vitest";
import { ServiceContainer, createToken, TOKENS, ConsoleLogger } from "../container.js";

describe("Dependency Injection Container", () => {
  it("registers and resolves singleton instances", () => {
    const container = new ServiceContainer();
    const token = createToken<{ id: number }>("TestService");
    let createCount = 0;

    container.register(token, () => {
      createCount++;
      return { id: 42 };
    }, "singleton");

    const inst1 = container.resolve(token);
    const inst2 = container.resolve(token);

    expect(inst1).toBe(inst2);
    expect(inst1.id).toBe(42);
    expect(createCount).toBe(1);
  });

  it("registers and resolves transient instances", () => {
    const container = new ServiceContainer();
    const token = createToken<{ random: number }>("TransientService");

    container.register(token, () => ({ random: Math.random() }), "transient");

    const inst1 = container.resolve(token);
    const inst2 = container.resolve(token);

    expect(inst1).not.toBe(inst2);
  });

  it("registers direct instances", () => {
    const container = new ServiceContainer();
    const token = createToken<string>("ConfigToken");
    container.registerInstance(token, "http://localhost:8080");

    expect(container.resolve(token)).toBe("http://localhost:8080");
  });

  it("supports hierarchical child containers", () => {
    const parent = new ServiceContainer();
    const parentToken = createToken<string>("ParentValue");
    parent.registerInstance(parentToken, "parent-val");

    const child = parent.createChild();
    expect(child.resolve(parentToken)).toBe("parent-val");

    const childToken = createToken<string>("ChildValue");
    child.registerInstance(childToken, "child-val");
    expect(child.resolve(childToken)).toBe("child-val");
    expect(parent.has(childToken)).toBe(false);
  });

  it("throws error when resolving unregistered token", () => {
    const container = new ServiceContainer();
    const token = createToken<unknown>("UnregisteredToken");

    expect(() => container.resolve(token)).toThrowError(
      "ServiceContainer: No binding registered for token 'UnregisteredToken'."
    );
  });

  it("can register standard TOKENS like Logger", () => {
    const container = new ServiceContainer();
    container.registerInstance(TOKENS.Logger, new ConsoleLogger("[Test]"));

    const logger = container.resolve(TOKENS.Logger);
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });
});
