import { describe, it, expect } from "vitest";
import { AstMemoryParser } from "../parser.js";

describe("Phase 4: AST Memory Extraction", () => {
  it("extracts exported classes, methods, parameters, and JSDoc comments", () => {
    const parser = new AstMemoryParser();
    const sourceCode = `
      import { ILogger } from "./types.js";
      import Database from "better-sqlite3";

      /**
       * Primary auth token manager
       */
      export class TokenManager {
        private secret: string;

        /**
         * Validates signature of JWT
         */
        verifyToken(token: string): boolean {
          return token.length > 0;
        }
      }

      /**
       * Helper hash calculation
       */
      export function generateHash(val: string): string {
        return "hash_" + val;
      }
    `;

    const result = parser.parseSource("src/auth/token.ts", sourceCode);

    expect(result.filePath).toBe("src/auth/token.ts");
    expect(result.exports).toContain("TokenManager");
    expect(result.exports).toContain("generateHash");

    // Check Class
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("TokenManager");
    expect(cls.isExported).toBe(true);
    expect(cls.jsDoc).toContain("Primary auth token manager");
    expect(cls.methods.length).toBe(1);
    expect(cls.methods[0]?.name).toBe("verifyToken");
    expect(cls.methods[0]?.jsDoc).toContain("Validates signature of JWT");

    // Check Function
    expect(result.functions.length).toBe(1);
    const fn = result.functions[0]!;
    expect(fn.name).toBe("generateHash");
    expect(fn.isExported).toBe(true);
    expect(fn.jsDoc).toContain("Helper hash calculation");

    // Check Imports & Dependencies
    expect(result.dependencies).toContain("./types.js");
    expect(result.dependencies).toContain("better-sqlite3");

    // Check minified JSON
    const minified = parser.toMinifiedJson(result);
    expect(typeof minified).toBe("string");
    expect(JSON.parse(minified)).toHaveProperty("classes");
  });
});
