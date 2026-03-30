import type { Statements } from "../store/database.js";
import type { FileEntry } from "../utils/files.js";
import type { EmbeddingService } from "../embeddings/embedding-service.js";
import { buildSectionEmbeddingText } from "../embeddings/embedding-service.js";
import { turboQuantEncode } from "../compression/turbo-quant.js";

const MODEL_ID = "all-MiniLM-L6-v2";

const ATX_HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;
const SETEXT_HEADING_1 = /^={3,}\s*$/;
const SETEXT_HEADING_2 = /^-{3,}\s*$/;

interface ParsedSection {
  title: string;
  level: number;
  byteStart: number;
  byteEnd: number;
  parentTitle: string | null;
  summary: string | null;
}

function parseMarkdownSections(content: string): ParsedSection[] {
  const lines = content.split("\n");
  const sections: ParsedSection[] = [];
  const parentStack: { title: string; level: number }[] = [];

  let startLine = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        startLine = i + 1;
        break;
      }
    }
  }

  let currentByte = 0;
  for (let i = 0; i < startLine; i++) {
    currentByte += Buffer.byteLength((lines[i] ?? "") + "\n", "utf-8");
  }

  let pendingTitle: string | null = null;
  let pendingLevel: number | null = null;
  let pendingByteStart = 0;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");

    if (line.trimStart().startsWith("```")) {
      currentByte += lineBytes;
      i++;
      while (i < lines.length) {
        const fenceLine = lines[i] ?? "";
        currentByte += Buffer.byteLength(fenceLine + "\n", "utf-8");
        if (fenceLine.trimStart().startsWith("```")) break;
        i++;
      }
      continue;
    }

    let headingTitle: string | null = null;
    let headingLevel: number | null = null;

    const atxMatch = ATX_HEADING.exec(line);
    if (atxMatch) {
      headingLevel = atxMatch[1]!.length;
      headingTitle = atxMatch[2]!.trim();
    }

    if (!headingTitle && i > startLine) {
      const prevLine = lines[i - 1] ?? "";
      if (SETEXT_HEADING_1.test(line) && prevLine.trim()) {
        headingLevel = 1;
        headingTitle = prevLine.trim();
      } else if (SETEXT_HEADING_2.test(line) && prevLine.trim()) {
        headingLevel = 2;
        headingTitle = prevLine.trim();
      }
    }

    if (headingTitle !== null && headingLevel !== null) {
      if (pendingTitle !== null && pendingLevel !== null) {
        while (parentStack.length > 0 && (parentStack[parentStack.length - 1]?.level ?? 0) >= pendingLevel) {
          parentStack.pop();
        }
        const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
        const sectionContent = content.slice(pendingByteStart, currentByte);
        const firstLine = sectionContent.split("\n").find(
          (l) => l.trim() && !l.startsWith("#") && !l.startsWith("=") && !l.startsWith("-")
        );
        sections.push({
          title: pendingTitle,
          level: pendingLevel,
          byteStart: pendingByteStart,
          byteEnd: currentByte,
          parentTitle: parent?.title ?? null,
          summary: firstLine?.trim().slice(0, 120) ?? null,
        });
        parentStack.push({ title: pendingTitle, level: pendingLevel });
      }
      pendingTitle = headingTitle;
      pendingLevel = headingLevel;
      pendingByteStart = currentByte;
    }

    currentByte += lineBytes;
  }

  if (pendingTitle !== null && pendingLevel !== null) {
    while (parentStack.length > 0 && (parentStack[parentStack.length - 1]?.level ?? 0) >= pendingLevel) {
      parentStack.pop();
    }
    const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
    const sectionContent = content.slice(pendingByteStart, currentByte);
    const firstLine = sectionContent.split("\n").find(
      (l) => l.trim() && !l.startsWith("#") && !l.startsWith("=") && !l.startsWith("-")
    );
    sections.push({
      title: pendingTitle,
      level: pendingLevel,
      byteStart: pendingByteStart,
      byteEnd: currentByte,
      parentTitle: parent?.title ?? null,
      summary: firstLine?.trim().slice(0, 120) ?? null,
    });
  }

  return sections;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/**
 * Index a documentation file: parse headings, extract sections, store in DB.
 * If embeddingService is ready, also generate TurboQuant-compressed vectors.
 */
export async function indexDocFile(
  file: FileEntry,
  stmts: Statements,
  embeddingService?: EmbeddingService
): Promise<{ sections: number; vectors: number }> {
  const sections = parseMarkdownSections(file.content);

  // ── Pass 1: insert all sections + FTS entries ──────────────────────────────
  const sectionIds: string[] = [];
  const sectionEmbTexts: string[] = [];

  for (const section of sections) {
    const slug = slugify(section.title);
    const id = `${file.relativePath}::${slug}#${section.level}`;
    const parentId = section.parentTitle
      ? `${file.relativePath}::${slugify(section.parentTitle)}#${section.level - 1}`
      : null;

    stmts.insertSection.run({
      id,
      file_path: file.relativePath,
      title: section.title,
      level: section.level,
      parent_id: parentId,
      byte_start: section.byteStart,
      byte_end: section.byteEnd,
      summary: section.summary,
    });

    stmts.insertSearchEntry.run({
      entity_id: id,
      entity_type: "section",
      name: section.title,
      content: `${section.title} ${section.summary ?? ""}`,
    });

    stmts.insertTrigramEntry.run({
      entity_id: id,
      name: section.title,
    });

    sectionIds.push(id);
    sectionEmbTexts.push(buildSectionEmbeddingText({
      title: section.title,
      summary: section.summary,
    }));
  }

  // ── Pass 2: batch-embed all sections in one ONNX forward pass ────────────────
  let vectorCount = 0;

  if (embeddingService?.isReady() && sectionIds.length > 0) {
    const embeddings = await embeddingService.embedBatch(sectionEmbTexts);

    for (let i = 0; i < sectionIds.length; i++) {
      const embedding = embeddings[i];
      if (embedding === null || embedding === undefined) continue;

      const compressed = turboQuantEncode(embedding);
      stmts.insertVector.run({
        entity_id: sectionIds[i]!,
        entity_type: "section",
        embedding_text: sectionEmbTexts[i]!,
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

  return { sections: sectionIds.length, vectors: vectorCount };
}
