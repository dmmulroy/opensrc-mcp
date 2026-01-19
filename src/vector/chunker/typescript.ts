import { Project, SourceFile, Node, ScriptKind } from "ts-morph";
import type { CodeChunk } from "../types.js";

/**
 * TypeScript/JavaScript AST-based chunker using ts-morph
 * Supports: .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs
 */
export class TypeScriptChunker {
  private project: Project;

  constructor() {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      useInMemoryFileSystem: true,
      compilerOptions: {
        allowJs: true,
        jsx: 2, // JsxEmit.React
        target: 99, // ESNext
        moduleResolution: 2, // NodeJs
      },
    });
  }

  chunk(file: string, content: string): CodeChunk[] {
    const scriptKind = this.getScriptKind(file);

    const sf = this.project.createSourceFile(file, content, {
      overwrite: true,
      scriptKind,
    });

    try {
      return [
        ...this.extractFunctions(sf, file),
        ...this.extractClasses(sf, file),
        ...this.extractTypes(sf, file),
      ];
    } finally {
      this.project.removeSourceFile(sf);
    }
  }

  private getScriptKind(file: string): ScriptKind {
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".mts":
      case ".cts":
        return ScriptKind.TS;
      case ".tsx":
        return ScriptKind.TSX;
      case ".js":
      case ".mjs":
      case ".cjs":
        return ScriptKind.JS;
      case ".jsx":
        return ScriptKind.JSX;
      default:
        return ScriptKind.TS;
    }
  }

  private extractFunctions(sf: SourceFile, file: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // Regular function declarations
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      chunks.push({
        file,
        identifier: name,
        kind: "function",
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        content: fn.getText(true),
      });
    }

    // Arrow functions & function expressions in variables
    for (const v of sf.getVariableDeclarations()) {
      const init = v.getInitializer();
      if (!init) continue;

      const isFunc = Node.isArrowFunction(init) || Node.isFunctionExpression(init);

      if (isFunc) {
        chunks.push({
          file,
          identifier: v.getName(),
          kind: "function",
          startLine: v.getStartLineNumber(),
          endLine: v.getEndLineNumber(),
          content: v.getText(),
        });
      }
    }

    return chunks;
  }

  private extractClasses(sf: SourceFile, file: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;

      // Whole class
      chunks.push({
        file,
        identifier: name,
        kind: "class",
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        content: cls.getText(true),
      });

      // Methods
      for (const method of cls.getMethods()) {
        chunks.push({
          file,
          identifier: method.getName(),
          kind: "method",
          startLine: method.getStartLineNumber(),
          endLine: method.getEndLineNumber(),
          content: method.getText(true),
          parent: name,
        });
      }
    }

    return chunks;
  }

  private extractTypes(sf: SourceFile, file: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // Interfaces
    for (const iface of sf.getInterfaces()) {
      chunks.push({
        file,
        identifier: iface.getName(),
        kind: "interface",
        startLine: iface.getStartLineNumber(),
        endLine: iface.getEndLineNumber(),
        content: iface.getText(),
      });
    }

    // Type aliases
    for (const t of sf.getTypeAliases()) {
      chunks.push({
        file,
        identifier: t.getName(),
        kind: "type",
        startLine: t.getStartLineNumber(),
        endLine: t.getEndLineNumber(),
        content: t.getText(),
      });
    }

    // Enums
    for (const e of sf.getEnums()) {
      chunks.push({
        file,
        identifier: e.getName(),
        kind: "enum",
        startLine: e.getStartLineNumber(),
        endLine: e.getEndLineNumber(),
        content: e.getText(),
      });
    }

    return chunks;
  }
}
