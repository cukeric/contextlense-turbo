import type { Statements } from "../store/database.js";

export interface OutlineEntry {
  id: string;
  name: string;
  kind: string;
  line_start: number;
  line_end: number;
  signature?: string;
  children?: OutlineEntry[];
}

export interface OutlineResult {
  file: string;
  entries: OutlineEntry[];
  total_symbols: number;
  total_sections: number;
}

/**
 * Return the structural outline of a file — symbols for code, headings for docs.
 * No content is returned, just the skeleton. Very token-efficient.
 */
export function handleOutline(
  args: { file: string },
  stmts: Statements
): OutlineResult {
  const filePath = args.file;

  // Get symbols for this file
  const symbols = stmts.getSymbolsByFile.all(filePath) as any[];
  const sections = stmts.getSectionsByFile.all(filePath) as any[];

  // Build symbol tree
  const symbolEntries: OutlineEntry[] = [];
  const symbolMap = new Map<string, OutlineEntry>();

  for (const sym of symbols) {
    const entry: OutlineEntry = {
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      line_start: sym.line_start,
      line_end: sym.line_end,
      signature: sym.signature,
    };
    symbolMap.set(sym.id, entry);

    if (sym.parent_id && symbolMap.has(sym.parent_id)) {
      const parent = symbolMap.get(sym.parent_id)!;
      parent.children = parent.children ?? [];
      parent.children.push(entry);
    } else {
      symbolEntries.push(entry);
    }
  }

  // Add sections as outline entries
  for (const sec of sections) {
    symbolEntries.push({
      id: sec.id,
      name: sec.title,
      kind: `h${sec.level}`,
      line_start: 0, // Sections use byte offsets, not lines
      line_end: 0,
    });
  }

  return {
    file: filePath,
    entries: symbolEntries,
    total_symbols: symbols.length,
    total_sections: sections.length,
  };
}
