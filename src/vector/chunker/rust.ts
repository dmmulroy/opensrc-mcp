import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { CodeChunk, ChunkKind } from "../types.js";

/**
 * Rust AST-based chunker using tree-sitter
 */
export class RustChunker {
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    // tree-sitter-rust exports the language directly
    this.parser.setLanguage(Rust as unknown as Parser.Language);
  }

  chunk(file: string, content: string): CodeChunk[] {
    const tree = this.parser.parse(content);
    const chunks: CodeChunk[] = [];

    for (const node of tree.rootNode.children) {
      switch (node.type) {
        case "function_item":
          chunks.push(this.extractNode(file, node, "function"));
          break;
        case "struct_item":
          chunks.push(this.extractNode(file, node, "struct"));
          break;
        case "enum_item":
          chunks.push(this.extractNode(file, node, "enum"));
          break;
        case "trait_item":
          chunks.push(this.extractNode(file, node, "trait"));
          break;
        case "impl_item":
          chunks.push(...this.extractImpl(file, node));
          break;
        case "mod_item":
          chunks.push(this.extractNode(file, node, "mod"));
          break;
        case "macro_definition":
          chunks.push(this.extractNode(file, node, "macro"));
          break;
      }
    }

    return chunks;
  }

  private extractNode(
    file: string,
    node: Parser.SyntaxNode,
    kind: ChunkKind
  ): CodeChunk {
    const name = node.childForFieldName("name")?.text ?? "<anonymous>";
    return {
      file,
      identifier: name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      content: node.text,
    };
  }

  private extractImpl(file: string, node: Parser.SyntaxNode): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const typeNode = node.childForFieldName("type");
    const traitNode = node.childForFieldName("trait");

    const typeName = typeNode?.text ?? "<unknown>";
    const implContext = traitNode
      ? `impl ${traitNode.text} for ${typeName}`
      : `impl ${typeName}`;

    // Impl block itself
    chunks.push({
      file,
      identifier: implContext,
      kind: "impl",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      content: node.text,
    });

    // Methods
    const body = node.childForFieldName("body");
    if (body) {
      for (const method of body.descendantsOfType("function_item")) {
        const name = method.childForFieldName("name")?.text ?? "<anonymous>";
        chunks.push({
          file,
          identifier: name,
          kind: "method",
          startLine: method.startPosition.row + 1,
          endLine: method.endPosition.row + 1,
          content: method.text,
          parent: implContext,
        });
      }
    }

    return chunks;
  }
}
