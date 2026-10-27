import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 15: Final NPM Packaging & Build", () => {
  it("verifies package.json bin mapping and engine configuration", () => {
    const pkgPath = resolve(process.cwd(), "package.json");
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      bin: Record<string, string>;
      type: string;
      engines: Record<string, string>;
    };

    expect(pkg.type).toBe("module");
    expect(pkg.bin["memory-bus"]).toBe("./dist/cli/index.js");
    expect(pkg.engines["node"]).toBe(">=20.0.0");
  });

  it("verifies tsup.config.ts externalizes native dependencies", () => {
    const configPath = resolve(process.cwd(), "tsup.config.ts");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("better-sqlite3");
    expect(content).toContain("@xenova/transformers");
  });
});
