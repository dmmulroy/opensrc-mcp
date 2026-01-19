import type { CodeChunk } from "../types.js";

interface MdSection {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  content: string;
}

/**
 * Markdown chunker - splits by headings and extracts code blocks
 */
export function chunkMarkdown(file: string, content: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = content.split("\n");

  // Extract heading-based sections
  const sections = extractSections(lines);
  for (const section of sections) {
    chunks.push({
      file,
      identifier: section.heading || "preamble",
      kind: "section",
      startLine: section.startLine,
      endLine: section.endLine,
      content: section.content,
    });
  }

  // Extract code blocks as separate chunks
  const codeBlocks = extractCodeBlocks(lines, file);
  chunks.push(...codeBlocks);

  return chunks;
}

function extractSections(lines: string[]): MdSection[] {
  const sections: MdSection[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  let currentSection: MdSection | null = null;
  let sectionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(headingRegex);

    if (match) {
      // Save previous section
      if (currentSection) {
        currentSection.endLine = i;
        currentSection.content = sectionLines.join("\n").trim();
        if (currentSection.content) {
          sections.push(currentSection);
        }
      } else if (sectionLines.length > 0) {
        // Preamble before first heading
        const preamble = sectionLines.join("\n").trim();
        if (preamble) {
          sections.push({
            heading: "",
            level: 0,
            startLine: 1,
            endLine: i,
            content: preamble,
          });
        }
      }

      // Start new section
      currentSection = {
        heading: match[2].trim(),
        level: match[1].length,
        startLine: i + 1,
        endLine: 0,
        content: "",
      };
      sectionLines = [line];
    } else {
      sectionLines.push(line);
    }
  }

  // Don't forget last section
  if (currentSection) {
    currentSection.endLine = lines.length;
    currentSection.content = sectionLines.join("\n").trim();
    if (currentSection.content) {
      sections.push(currentSection);
    }
  } else if (sectionLines.length > 0) {
    // File with no headings
    const content = sectionLines.join("\n").trim();
    if (content) {
      sections.push({
        heading: "",
        level: 0,
        startLine: 1,
        endLine: lines.length,
        content,
      });
    }
  }

  return sections;
}

function extractCodeBlocks(lines: string[], file: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const fenceRegex = /^```(\w*)$/;

  let inBlock = false;
  let blockLang = "";
  let blockStart = 0;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(fenceRegex);

    if (match && !inBlock) {
      // Start of code block
      inBlock = true;
      blockLang = match[1] || "code";
      blockStart = i;
      blockLines = [];
    } else if (line.startsWith("```") && inBlock) {
      // End of code block
      inBlock = false;
      const content = blockLines.join("\n").trim();

      // Skip tiny blocks
      if (content && content.length > 20) {
        chunks.push({
          file,
          identifier: `codeblock_${blockLang}_L${blockStart + 1}`,
          kind: "codeblock",
          startLine: blockStart + 1,
          endLine: i + 1,
          content: `\`\`\`${blockLang}\n${content}\n\`\`\``,
        });
      }
    } else if (inBlock) {
      blockLines.push(line);
    }
  }

  return chunks;
}
