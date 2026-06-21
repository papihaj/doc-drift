/**
 * Converts markdown to Confluence Storage Format (XHTML).
 * Handles the subset of markdown that DocDrift generates:
 * headings, tables, fenced code blocks, bold, italic, inline code,
 * blockquotes, field-definition lines, and paragraphs.
 */
export function markdownToStorage(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "none";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // consume closing ```
      const code = escapeXml(codeLines.join("\n"));
      output.push(
        `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${lang}</ac:parameter><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`,
      );
      continue;
    }

    // Markdown table — collect all consecutive table lines
    if (line.startsWith("|") && line.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("|") && lines[i]!.endsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      output.push(buildTable(tableLines));
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = inlineMarkdown(headingMatch[2]!);
      output.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote (⚠️ warnings → Confluence warning macro)
    if (line.startsWith("> ")) {
      const text = inlineMarkdown(line.slice(2));
      const isWarning = text.includes("⚠️") || text.toLowerCase().includes("warning") || text.toLowerCase().includes("caution");
      if (isWarning) {
        output.push(
          `<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>${text}</p></ac:rich-text-body></ac:structured-macro>`,
        );
      } else {
        output.push(
          `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>${text}</p></ac:rich-text-body></ac:structured-macro>`,
        );
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-*]{3,}$/.test(line.trim())) {
      output.push("<hr />");
      i++;
      continue;
    }

    // Empty line — paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph (collect until blank line or special line)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("#") &&
      !lines[i]!.startsWith(">") &&
      !lines[i]!.startsWith("|") &&
      !lines[i]!.startsWith("```") &&
      !/^[-*]{3,}$/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      output.push(`<p>${inlineMarkdown(paraLines.join(" "))}</p>`);
    }
  }

  return output.join("\n");
}

function buildTable(tableLines: string[]): string {
  // Filter separator lines (|---|---|)
  const dataLines = tableLines.filter((l) => !/^\|[-| :]+\|$/.test(l));
  if (dataLines.length === 0) return "";

  const rows = dataLines.map((l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

  const [headerRow, ...bodyRows] = rows;
  if (!headerRow) return "";

  const head = `<thead><tr>${headerRow.map((c) => `<th><p>${inlineMarkdown(c)}</p></th>`).join("")}</tr></thead>`;
  const body =
    bodyRows.length > 0
      ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td><p>${inlineMarkdown(c)}</p></td>`).join("")}</tr>`).join("")}</tbody>`
      : "";

  return `<table><colgroup>${headerRow.map(() => "<col />").join("")}</colgroup>${head}${body}</table>`;
}

function inlineMarkdown(text: string): string {
  return (
    text
      // Bold+italic
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      // Bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // Italic (underscore or asterisk)
      .replace(/\b_(.+?)_\b/g, "<em>$1</em>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Escape remaining XML special chars (outside tags)
      .replace(/&(?![a-z]+;|#\d+;)/g, "&amp;")
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
