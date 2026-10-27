import { Project, ScriptTarget } from "ts-morph";
import { readFileSync, existsSync } from "node:fs";
import type {
  AstSnapshotData,
  ClassAstInfo,
  FunctionAstInfo,
  ImportAstInfo,
} from "./types.js";

export class AstMemoryParser {
  private project: Project;

  constructor() {
    this.project = new Project({
      compilerOptions: {
        target: ScriptTarget.ES2022,
        allowJs: true,
      },
      useInMemoryFileSystem: true,
    });
  }

  /**
   * Parses a raw source file or string content into a structured AST graph.
   */
  parseSource(filePath: string, rawContent?: string): AstSnapshotData {
    let sourceText = rawContent;
    if (sourceText === undefined && existsSync(filePath)) {
      sourceText = readFileSync(filePath, "utf-8");
    }

    if (sourceText === undefined) {
      sourceText = "";
    }

    // In-memory virtual file parsing to avoid polluting the file system
    const virtualPath = filePath.replace(/\\/g, "/");
    const sourceFile =
      this.project.getSourceFile(virtualPath) ??
      this.project.createSourceFile(virtualPath, sourceText, { overwrite: true });

    const classes: ClassAstInfo[] = [];
    const functions: FunctionAstInfo[] = [];
    const imports: ImportAstInfo[] = [];
    const exportsList: string[] = [];
    const dependencies: string[] = [];

    // Extract Classes
    for (const cls of sourceFile.getClasses()) {
      const isExported = cls.isExported();
      const name = cls.getName() ?? "AnonymousClass";
      if (isExported) {
        exportsList.push(name);
      }

      const jsDocs = cls.getJsDocs().map((d) => d.getCommentText()).filter(Boolean);

      const methods = cls.getMethods().map((m) => ({
        name: m.getName(),
        parameters: m.getParameters().map((p) => p.getText()),
        returnType: m.getReturnType().getText(),
        jsDoc: m.getJsDocs().map((d) => d.getCommentText()).filter(Boolean).join("\n") || null,
      }));

      const properties = cls.getProperties().map((p) => p.getName());

      classes.push({
        name,
        isExported,
        jsDoc: jsDocs.join("\n") || null,
        methods,
        properties,
      });
    }

    // Extract Functions
    for (const fn of sourceFile.getFunctions()) {
      const isExported = fn.isExported();
      const name = fn.getName() ?? "anonymousFunction";
      if (isExported) {
        exportsList.push(name);
      }

      const jsDocs = fn.getJsDocs().map((d) => d.getCommentText()).filter(Boolean);

      functions.push({
        name,
        isExported,
        jsDoc: jsDocs.join("\n") || null,
        parameters: fn.getParameters().map((p) => p.getText()),
        returnType: fn.getReturnType().getText(),
      });
    }

    // Extract Imports and Dependencies
    for (const imp of sourceFile.getImportDeclarations()) {
      const specifier = imp.getModuleSpecifierValue();
      const defaultImport = imp.getDefaultImport()?.getText();
      const namedImports = imp.getNamedImports().map((ni) => ni.getName());

      imports.push({
        moduleSpecifier: specifier,
        namedImports,
        ...(defaultImport ? { defaultImport } : {}),
      });

      if (!dependencies.includes(specifier)) {
        dependencies.push(specifier);
      }
    }

    // Clean up memory
    this.project.removeSourceFile(sourceFile);

    return {
      filePath,
      classes,
      functions,
      imports,
      exports: exportsList,
      dependencies,
    };
  }

  toMinifiedJson(data: AstSnapshotData): string {
    return JSON.stringify(data);
  }
}
