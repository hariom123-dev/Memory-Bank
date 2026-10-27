export interface FunctionAstInfo {
  name: string;
  isExported: boolean;
  jsDoc?: string | null;
  parameters: string[];
  returnType: string;
}

export interface ClassMethodAstInfo {
  name: string;
  parameters: string[];
  returnType: string;
  jsDoc?: string | null;
}

export interface ClassAstInfo {
  name: string;
  isExported: boolean;
  jsDoc?: string | null;
  methods: ClassMethodAstInfo[];
  properties: string[];
}

export interface ImportAstInfo {
  moduleSpecifier: string;
  namedImports: string[];
  defaultImport?: string;
}

export interface AstSnapshotData {
  filePath: string;
  classes: ClassAstInfo[];
  functions: FunctionAstInfo[];
  imports: ImportAstInfo[];
  exports: string[];
  dependencies: string[];
}
