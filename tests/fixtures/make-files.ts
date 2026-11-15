/**
 * Test fixture builders — minimal real PDF, DOCX and PPTX files
 *
 * Built in memory so tests exercise the real parsing libraries without
 * binary fixtures in the repo. Each builder produces only the parts the
 * readers (and the underlying libraries) need.
 */

import JSZip from "jszip";

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function pdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * A PDF with one page per entry; each page draws its lines as separate text
 * runs in Helvetica. An empty array produces a page with no text layer.
 */
export function makePdf(pages: string[][]): ArrayBuffer {
  const objects: string[] = [];
  const kids: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let next = 4;
  for (const lines of pages) {
    const pageNo = next++;
    const contentNo = next++;
    kids.push(`${pageNo} 0 R`);
    const ops = lines
      .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 18} Td (${pdfString(line)}) Tj ET`)
      .join("\n");
    objects[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNo} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentNo] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return toArrayBuffer(new TextEncoder().encode(out));
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type DocxBlock =
  | { heading: 1 | 2 | 3; text: string }
  | { paragraph: string }
  | { table: string[][] };

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wParagraph(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

export async function makeDocx(blocks: DocxBlock[]): Promise<ArrayBuffer> {
  const body = blocks
    .map((b) => {
      if ("heading" in b) return wParagraph(b.text, `Heading${b.heading}`);
      if ("paragraph" in b) return wParagraph(b.paragraph);
      const rows = b.table
        .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${wParagraph(cell)}</w:tc>`).join("")}</w:tr>`)
        .join("");
      return `<w:tbl>${rows}</w:tbl>`;
    })
    .join("");

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/styles" Target="styles.xml"/></Relationships>`
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W_NS}">${[1, 2, 3]
      .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`)
      .join("")}</w:styles>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

export type SlideSpec = {
  /** Text of the title placeholder (omit for no title). */
  title?: string;
  /** Body placeholder paragraphs; each paragraph may be split into runs. */
  body?: Array<string | string[]>;
  /** Table rows of cell texts. */
  table?: string[][];
  /** Speaker notes paragraphs. */
  notes?: string[];
};

function aParagraph(runs: string | string[]): string {
  const list = Array.isArray(runs) ? runs : [runs];
  return `<a:p>${list.map((r) => `<a:r><a:t>${xmlEscape(r)}</a:t></a:r>`).join("")}</a:p>`;
}

function shape(id: number, ph: string, paragraphs: Array<string | string[]>): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs
    .map(aParagraph)
    .join("")}</p:txBody></p:sp>`;
}

function slideXml(spec: SlideSpec): string {
  const parts: string[] = [];
  if (spec.title !== undefined) parts.push(shape(2, `<p:ph type="title"/>`, [spec.title]));
  if (spec.body) parts.push(shape(3, `<p:ph idx="1"/>`, spec.body));
  if (spec.table) {
    const rows = spec.table
      .map((row) => `<a:tr>${row.map((c) => `<a:tc><a:txBody>${aParagraph(c)}</a:txBody></a:tc>`).join("")}</a:tr>`)
      .join("");
    parts.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${parts.join(
    ""
  )}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(paragraphs: string[], slideNumber: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${[
    shape(2, `<p:ph type="sldImg"/>`, []),
    shape(3, `<p:ph type="body" idx="1"/>`, paragraphs),
    shape(4, `<p:ph type="sldNum" idx="5"/>`, [String(slideNumber)]),
  ].join("")}</p:spTree></p:cSld></p:notes>`;
}

/**
 * A presentation whose slides are shown in `slides` order.
 *
 * @param fileNumbers File number for each slide (slideN.xml). Lets tests
 *   store slides under names that do not match their presentation order.
 * @param withPresentationXml Omit ppt/presentation.xml to exercise the
 *   file-name fallback.
 */
export async function makePptx(
  slides: SlideSpec[],
  { fileNumbers, withPresentationXml = true }: { fileNumbers?: number[]; withPresentationXml?: boolean } = {}
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const numbers = fileNumbers ?? slides.map((_, i) => i + 1);
  const presRels: string[] = [];
  const sldIds: string[] = [];

  slides.forEach((spec, i) => {
    const n = numbers[i];
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(spec));
    const slideRels = [
      `<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    if (spec.notes) {
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(spec.notes, i + 1));
      slideRels.push(
        `<Relationship Id="rId2" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`
      );
    }
    zip.file(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${slideRels.join("")}</Relationships>`
    );
    presRels.push(`<Relationship Id="rId${10 + i}" Type="${OFFICE_REL}/slide" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`);
  });

  if (withPresentationXml) {
    zip.file(
      "ppt/presentation.xml",
      `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P_NS}" xmlns:r="${OFFICE_REL}"><p:sldIdLst>${sldIds.join(
        ""
      )}</p:sldIdLst></p:presentation>`
    );
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${presRels.join("")}</Relationships>`
    );
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Bytes that start like a legacy/encrypted Office (OLE compound) file. */
export function makeOleHeader(): ArrayBuffer {
  return toArrayBuffer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
