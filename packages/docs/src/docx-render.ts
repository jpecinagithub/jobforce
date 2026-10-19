/**
 * Renderers DOCX (ATS-legible): una sola columna, fuente Calibri,
 * sin tablas ni cuadros de texto; la información crítica va en el cuerpo.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import JSZip from "jszip";
import type { CoverLetterModel } from "./templates/cover-letter-template-v1.js";
import type { CvModel } from "./templates/cv-template-v1.js";

const FONT = "Calibri";

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 25, font: FONT })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "333333" } },
    spacing: { before: 240, after: 120 },
  });
}

function body(text: string, opts: { bold?: boolean; italics?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 22, font: FONT }),
    ],
    spacing: { after: 80 },
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, font: FONT })],
    bullet: { level: 0 },
    spacing: { after: 40 },
  });
}

function baseDocument(children: Paragraph[]): Document {
  return new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } },
        heading2: { run: { font: FONT } },
      },
    },
    sections: [{ children }],
  });
}

export async function cvModelToDocxBuffer(model: CvModel): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: model.name, bold: true, size: 44, font: FONT })],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: model.headline, size: 24, font: FONT, color: "333333" })],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [new TextRun({ text: model.contactLine.join(" • "), size: 20, font: FONT, color: "444444" })],
      spacing: { after: 120 },
    }),
    sectionHeading("Summary"),
    ...model.summary.map((p) => body(p)),
    sectionHeading("Work Experience"),
    ...model.experience.flatMap((e) => [
      new Paragraph({
        children: [
          new TextRun({ text: e.title, bold: true, size: 23, font: FONT }),
          new TextRun({ text: ` — ${e.company}`, size: 23, font: FONT }),
        ],
        spacing: { before: 120, after: 20 },
      }),
      new Paragraph({
        children: [new TextRun({ text: e.meta, size: 20, font: FONT, color: "555555" })],
        spacing: { after: 60 },
      }),
      ...e.bullets.map((b) => bullet(b)),
    ]),
    sectionHeading("Education"),
    ...model.education.flatMap((e) => [
      body(e.title, { bold: true }),
      body(`${e.institution} • ${e.period}`),
      body(e.note, { italics: true, size: 20 }),
    ]),
    sectionHeading("Core Skills"),
    body(model.skills.join(" • ")),
    sectionHeading("Languages"),
    body(model.languages.join(" • ")),
    sectionHeading("Certifications"),
    ...model.certifications.map((c) => bullet(`${c.title} — ${c.issuer} (${c.date})`)),
  ];
  return Packer.toBuffer(baseDocument(children));
}

export async function coverLetterModelToDocxBuffer(model: CoverLetterModel): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: model.name, bold: true, size: 32, font: FONT })],
      spacing: { after: 20 },
    }),
    new Paragraph({
      children: [new TextRun({ text: model.contactLine.join(" • "), size: 20, font: FONT, color: "444444" })],
      spacing: { after: 200 },
    }),
    body(model.date),
    new Paragraph({
      children: [new TextRun({ text: model.subject, bold: true, size: 22, font: FONT })],
      spacing: { before: 120, after: 120 },
    }),
    body(model.greeting),
    ...model.body.map((p) => body(p)),
    body(model.closing),
    new Paragraph({
      children: [new TextRun({ text: "Kind regards,", size: 22, font: FONT })],
      spacing: { before: 160, after: 40 },
    }),
    body(model.signature, { bold: true }),
  ];
  const doc = baseDocument(children);
  return Packer.toBuffer(doc);
}

/**
 * Extrae el texto plano de un DOCX (para validación pre-envío).
 * Implementación propia con jszip: lee word/document.xml y elimina etiquetas.
 */
export async function extractDocxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("DOCX inválido: falta word/document.xml");
  const xml = await file.async("string");
  return xml
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .trim();
}
