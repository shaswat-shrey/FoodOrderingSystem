/**
 * Minimal PDF 1.4 writer for text documents (invoices). Standard Helvetica
 * fonts, A4 pages, WinAnsi text only — callers write "Rs." rather than "₹".
 */
export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Right-aligned column text on the same line. */
  right?: string;
  gapBefore?: number;
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;

const escape = (s: string) =>
  s
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

/** Helvetica average glyph width ≈ 0.5 em; good enough to right-align numbers. */
const width = (s: string, size: number) => s.length * size * 0.5;

export function simplePdf(lines: PdfLine[], meta: { title: string }): Buffer {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  for (const line of lines) {
    const size = line.size ?? 10;
    const step = size * 1.45 + (line.gapBefore ?? 0);
    if (y - step < MARGIN) {
      pages.push(ops.join('\n'));
      ops = [];
      y = PAGE_H - MARGIN;
    }
    y -= step;
    const font = line.bold ? 'F2' : 'F1';
    ops.push(`BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${escape(line.text)}) Tj ET`);
    if (line.right) {
      const x = PAGE_W - MARGIN - width(line.right, size);
      ops.push(
        `BT /${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${escape(line.right)}) Tj ET`,
      );
    }
  }
  pages.push(ops.join('\n'));

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // 1-based ids
  const catalog = add('');
  const pagesId = add('');
  const f1 = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const f2 = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const info = add(`<< /Title (${escape(meta.title)}) /Producer (FoodOrderSystem) >>`);
  const kids: number[] = [];
  for (const content of pages) {
    const stream = add(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
