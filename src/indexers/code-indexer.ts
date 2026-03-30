import type { Statements } from "../store/database.js";
import type { FileEntry } from "../utils/files.js";
import { getLanguage } from "../utils/project.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { buildSymbolEmbeddingText } from "../embeddings/embedding-service.js";
import { turboQuantEncode } from "../compression/turbo-quant.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUNDLED_GRAMMARS_DIR = join(__dirname, "..", "..", "grammars");

const MODEL_ID = "all-MiniLM-L6-v2";

interface ExtractedSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  parentName: string | null;
  docComment: string | null;
}

const SYMBOL_NODE_TYPES: Record<string, Record<string, string>> = {
  typescript: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "variable",
    export_statement: "export",
  },
  tsx: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    lexical_declaration: "variable",
    export_statement: "export",
  },
  javascript: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    lexical_declaration: "variable",
    export_statement: "export",
  },
  jsx: {
    function_declaration: "function",
    arrow_function: "function",
    method_definition: "method",
    class_declaration: "class",
    lexical_declaration: "variable",
    export_statement: "export",
  },
  python: {
    function_definition: "function",
    class_definition: "class",
    decorated_definition: "function",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
  },
  rust: {
    function_item: "function",
    impl_item: "class",
    struct_item: "class",
    enum_item: "enum",
    trait_item: "interface",
    type_item: "type",
  },
};

function extractName(node: any, source: string): string | null {
  const nameNode =
    node.childForFieldName?.("name") ??
    node.childForFieldName?.("declarator");

  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === "variable_declarator") {
        const varName = child.childForFieldName?.("name");
        if (varName) {
          return source.slice(varName.startIndex, varName.endIndex);
        }
      }
    }
  }

  if (node.type === "export_statement") {
    const decl = node.childForFieldName?.("declaration");
    if (decl) {
      return extractName(decl, source);
    }
  }

  return null;
}

function extractSignature(node: any, source: string): string {
  const fullText = source.slice(node.startIndex, node.endIndex);
  const braceIdx = fullText.indexOf("{");
  if (braceIdx > 0) {
    return fullText.slice(0, braceIdx).trim();
  }
  const newline = fullText.indexOf("\n");
  if (newline > 0) {
    return fullText.slice(0, newline).trim();
  }
  return fullText.slice(0, 200).trim();
}

function extractDocComment(node: any, source: string): string | null {
  const prev = node.previousNamedSibling;
  if (!prev) return null;

  if (prev.type === "comment" || prev.type === "block_comment") {
    const text = source.slice(prev.startIndex, prev.endIndex);
    if (text.startsWith("/**") || text.startsWith("///") || text.startsWith('"""')) {
      return text.slice(0, 500);
    }
  }

  return null;
}

function walkTree(
  node: any,
  source: string,
  language: string,
  filePath: string,
  parentName: string | null = null
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const nodeTypes = SYMBOL_NODE_TYPES[language];
  if (!nodeTypes) return symbols;

  const kind = nodeTypes[node.type];
  if (kind) {
    let name = extractName(node, source);

    if (node.type === "export_statement") {
      const decl = node.childForFieldName?.("declaration");
      if (!decl || !nodeTypes[decl.type]) {
        if (name) {
          symbols.push({
            name,
            qualifiedName: parentName ? `${parentName}.${name}` : name,
            kind: "export",
            signature: extractSignature(node, source),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            byteStart: node.startIndex,
            byteEnd: node.endIndex,
            parentName,
            docComment: extractDocComment(node, source),
          });
        }
      }
    } else if (name) {
      symbols.push({
        name,
        qualifiedName: parentName ? `${parentName}.${name}` : name,
        kind,
        signature: extractSignature(node, source),
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        parentName,
        docComment: extractDocComment(node, source),
      });

      if (kind === "class" || kind === "interface") {
        const body = node.childForFieldName?.("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) {
              symbols.push(...walkTree(child, source, language, filePath, name));
            }
          }
          return symbols;
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      symbols.push(...walkTree(child, source, language, filePath, parentName));
    }
  }

  return symbols;
}

let TreeSitterParser: any = null;
let TreeSitterLanguage: any = null;
const languageParsers = new Map<string, any>();

const GRAMMAR_MAP: Record<string, string> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  java: "java",
  ruby: "ruby",
  c_sharp: "c_sharp",
};

async function getParser(language: string): Promise<any | null> {
  if (!TreeSitterParser) {
    const mod = await import("web-tree-sitter") as any;
    TreeSitterParser = mod.Parser;
    TreeSitterLanguage = mod.Language;
    if (typeof TreeSitterParser.init === "function") {
      await TreeSitterParser.init();
    }
  }

  const grammarName = GRAMMAR_MAP[language];
  if (!grammarName) return null;

  if (!languageParsers.has(language)) {
    const wasmPaths = [
      join(BUNDLED_GRAMMARS_DIR, `tree-sitter-${grammarName}.wasm`),
      `${process.env["HOME"] ?? ""}/.contextlens/grammars/tree-sitter-${grammarName}.wasm`,
    ];

    let loaded = false;
    for (const wasmPath of wasmPaths) {
      if (!existsSync(wasmPath)) continue;
      try {
        const lang = await TreeSitterLanguage.load(wasmPath);
        const parser = new TreeSitterParser();
        parser.setLanguage(lang);
        languageParsers.set(language, parser);
        loaded = true;
        break;
      } catch {
        continue;
      }
    }

    if (!loaded) return null;
  }

  return languageParsers.get(language) ?? null;
}

/**
 * Index a single code file: parse AST, extract symbols, store in DB.
 * If embeddingService is ready, also generate TurboQuant-compressed vectors.
 */
export async function indexCodeFile(
  file: FileEntry,
  stmts: Statements,
  projectRoot: string,
  embeddingService?: EmbeddingService
): Promise<{ symbols: number; vectors: number }> {
  const language = getLanguage(file.absolutePath);
  if (!language) return { symbols: 0, vectors: 0 };

  const parser = await getParser(language);
  let symbols: ExtractedSymbol[];

  if (parser) {
    const tree = parser.parse(file.content);
    symbols = walkTree(tree.rootNode, file.content, language, file.relativePath);
    tree.delete();
  } else {
    // Regex fallback for unsupported languages
    symbols = extractWithRegex(file, language);
  }

  // ── Pass 1: insert all symbols + FTS entries (no embedding I/O) ──────────────
  const symbolIds: string[] = [];
  const symbolEmbTexts: string[] = [];

  for (const sym of symbols) {
    const id = `${file.relativePath}::${sym.qualifiedName}`;
    const parentId = sym.parentName
      ? `${file.relativePath}::${sym.parentName}`
      : null;

    stmts.insertSymbol.run({
      id,
      file_path: file.relativePath,
      name: sym.name,
      qualified_name: sym.qualifiedName,
      kind: sym.kind,
      language,
      signature: sym.signature,
      line_start: sym.lineStart,
      line_end: sym.lineEnd,
      byte_start: sym.byteStart,
      byte_end: sym.byteEnd,
      parent_id: parentId,
      doc_comment: sym.docComment,
    });

    stmts.insertSearchEntry.run({
      entity_id: id,
      entity_type: "symbol",
      name: sym.name,
      content: `${sym.name} ${sym.qualifiedName} ${sym.kind} ${sym.signature} ${sym.docComment ?? ""}`,
    });

    stmts.insertTrigramEntry.run({
      entity_id: id,
      name: `${sym.name} ${sym.qualifiedName}`,
    });

    symbolIds.push(id);
    symbolEmbTexts.push(buildSymbolEmbeddingText({
      kind: sym.kind,
      name: sym.name,
      signature: sym.signature,
      doc_comment: sym.docComment,
    }));
  }

  // ── Pass 2: batch-embed all symbols in one ONNX forward pass ─────────────────
  let vectorCount = 0;

  if (embeddingService?.isReady() && symbolIds.length > 0) {
    const embeddings = await embeddingService.embedBatch(symbolEmbTexts);

    for (let i = 0; i < symbolIds.length; i++) {
      const embedding = embeddings[i];
      if (embedding === null || embedding === undefined) continue;

      const compressed = turboQuantEncode(embedding);
      stmts.insertVector.run({
        entity_id: symbolIds[i]!,
        entity_type: "symbol",
        embedding_text: symbolEmbTexts[i]!,
        final_radius: compressed.finalRadius,
        pq_angles: Buffer.from(compressed.pqAngles),
        qjl_bits: Buffer.from(compressed.qjlBits),
        pq_dimensions: compressed.dimensions,
        qjl_projected_dimensions: compressed.projectedDimensions,
        model_id: MODEL_ID,
      });
      vectorCount++;
    }
  }

  return { symbols: symbolIds.length, vectors: vectorCount };
}

function extractWithRegex(file: FileEntry, language: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const patterns: RegExp[] = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/gm,
    /^(?:async\s+)?function\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
    /^def\s+(\w+)/gm,
    /^func\s+(\w+)/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(file.content)) !== null) {
      const name = match[1];
      if (!name) continue;

      const byteStart = match.index;
      const afterMatch = file.content.indexOf("\n\n", byteStart);
      const byteEnd = afterMatch > 0 ? afterMatch : file.content.length;
      const lineStart = file.content.slice(0, byteStart).split("\n").length;
      const lineEnd = file.content.slice(0, byteEnd).split("\n").length;

      symbols.push({
        name,
        qualifiedName: name,
        kind: "function",
        signature: match[0].trim().slice(0, 200),
        lineStart,
        lineEnd,
        byteStart,
        byteEnd,
        parentName: null,
        docComment: null,
      });
    }
  }

  return symbols;
}
