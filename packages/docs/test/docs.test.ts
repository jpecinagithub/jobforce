/**
 * Tests de @jobforce/docs (node:test, patrón del repo).
 * El teléfono usado aquí es FICTICIO (+34 600 000 000): los tests nunca
 * tocan el teléfono real de Jon.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  JON_PROFILE,
  allChecksOk,
  buildCoverLetterModel,
  buildCvModel,
  buildManifest,
  coverLetterModelToDocxBuffer,
  cvModelToDocxBuffer,
  extractDocxText,
  renderCoverLetterHtml,
  renderCvHtml,
  validateDocuments,
} from "../src/index.js";
import type { CandidateProfile } from "../src/index.js";
import type { CvAdaptation, LetterAdaptation } from "../src/index.js";
import type { JobPosting } from "../src/index.js";

const FAKE_PHONE = "+34 600 000 000";

function profileWithPhone(): CandidateProfile {
  return { ...JON_PROFILE, identity: { ...JON_PROFILE.identity, phone: FAKE_PHONE } };
}

const ADAPT: CvAdaptation = {
  headline: "Finance Manager | Multi-Entity Financial Operations | IFRS",
  summary: ["Finance leader with over 15 years of experience."],
  roleBullets: { "experience.surexport": [0, 2] },
  skillOrder: ["skills.ifrs", "skills.erp"],
};

const JOB: JobPosting = {
  title: "Finance Manager",
  location: "Dubai, UAE",
  sourceName: "talentmate.com",
  sourceUrl: "https://www.talentmate.com/jobs/uae/dubai/finance-manager/2607-48498-1",
  employerNote: "Employer not named in the posting.",
};

const LETTER_ADAPT: LetterAdaptation = {
  body: [
    "I am writing to apply for the Finance Manager position in Dubai advertised on talentmate.com. As CFO of SurExport Peru Berries SAC (Lima, Peru), I bring over 15 years of experience in financial accounting across multiple entities and jurisdictions.",
    "I hold a Bachelor's Degree in Industrial Engineering from Universidad de Navarra and an Executive MBA (título propio, non-official degree) from ICADE Business School.",
  ],
  closing: "Thank you for your consideration.",
};

describe("cv-template-v1", () => {
  it("es determinista: dos construcciones generan el mismo HTML", () => {
    const a = renderCvHtml(buildCvModel(JON_PROFILE, ADAPT));
    const b = renderCvHtml(buildCvModel(JON_PROFILE, ADAPT));
    assert.equal(a, b);
  });

  it("respeta la selección de bullets (no inventa, no añade)", () => {
    const model = buildCvModel(JON_PROFILE, ADAPT);
    const surexport = model.experience.find((e) => e.company.includes("SurExport"));
    assert.ok(surexport);
    assert.deepEqual(surexport.bullets, [
      JON_PROFILE.experience[0].bullets[0],
      JON_PROFILE.experience[0].bullets[2],
    ]);
    // todo bullet del modelo existe literalmente en el perfil
    const allBullets = new Set(JON_PROFILE.experience.flatMap((e) => e.bullets));
    for (const e of model.experience) for (const bl of e.bullets) assert.ok(allBullets.has(bl), `bullet inventado: ${bl}`);
  });

  it("sin teléfono en el perfil versionado no aparece ningún teléfono", () => {
    const html = renderCvHtml(buildCvModel(JON_PROFILE, ADAPT));
    assert.ok(!/\+\d[\d .]{6,}/.test(html), "el perfil versionado no debe contener teléfono");
    const model = buildCvModel(JON_PROFILE, ADAPT);
    assert.ok(!model.factKeys.includes("identity.phone"));
  });

  it("con teléfono inyectado aparece en la línea de contacto", () => {
    const html = renderCvHtml(buildCvModel(profileWithPhone(), ADAPT));
    assert.ok(html.includes(FAKE_PHONE));
  });

  it("el EMBA se declara como título propio", () => {
    const html = renderCvHtml(buildCvModel(JON_PROFILE, ADAPT));
    assert.ok(/título propio/i.test(html));
    // "Master's degree in Finance" solo puede aparecer en la aclaración honesta del EMBA
    assert.ok(!/(?<!not an official )Master'?s degree in Finance/i.test(html));
  });

  it("no contiene reivindicaciones prohibidas (ACCA/CPA/...) ni marcadores", () => {
    const html = renderCvHtml(buildCvModel(JON_PROFILE, ADAPT));
    assert.ok(!/\b(ACCA|CPA|CIMA)\b/.test(html));
    assert.ok(!/\b(TODO|XXX|lorem ipsum)/i.test(html));
  });

  it("el DOCX contiene el mismo texto esencial que el HTML", async () => {
    const model = buildCvModel(profileWithPhone(), ADAPT);
    const buf = await cvModelToDocxBuffer(model);
    assert.ok(buf.length > 5000, `DOCX demasiado pequeño: ${buf.length}`);
    const text = await extractDocxText(buf);
    assert.ok(text.includes("Jon Peciña Iturbe"));
    assert.ok(text.includes(FAKE_PHONE));
    assert.ok(/título propio/i.test(text));
    assert.ok(!/\b(ACCA|CPA|CIMA)\b/.test(text));
    assert.ok(!/\b(TODO|XXX|lorem ipsum)/i.test(text));
  });
});

describe("cover-letter-template-v1", () => {
  it("la compactación aprieta la carta sin cambiar el contenido (garantía de una hoja)", () => {
    const model = buildCoverLetterModel(JON_PROFILE, JOB, LETTER_ADAPT, "19 October 2026");
    const normal = renderCoverLetterHtml(model);
    const compacta = renderCoverLetterHtml(model, { compact: 2 });
    assert.notEqual(compacta, normal);
    assert.ok(compacta.includes("10.5pt"));
    assert.ok(compacta.includes("Dear Hiring Manager,"));
    // El nivel por defecto es el 0: salida idéntica a no pasar opción.
    assert.equal(renderCoverLetterHtml(model, { compact: 0 }), normal);
  });

  it("es determinista y sin marcadores", () => {
    const a = renderCoverLetterHtml(buildCoverLetterModel(JON_PROFILE, JOB, LETTER_ADAPT, "19 October 2026"));
    const b = renderCoverLetterHtml(buildCoverLetterModel(JON_PROFILE, JOB, LETTER_ADAPT, "19 October 2026"));
    assert.equal(a, b);
    assert.ok(!/\b(TODO|XXX|\[Your)/i.test(a));
  });

  it("el DOCX de la carta es válido y extraíble", async () => {
    const model = buildCoverLetterModel(profileWithPhone(), JOB, LETTER_ADAPT, "19 October 2026");
    const buf = await coverLetterModelToDocxBuffer(model);
    const text = await extractDocxText(buf);
    assert.ok(text.includes("Finance Manager"));
    assert.ok(/título propio/i.test(text));
  });
});

describe("manifest + validateDocuments", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "docs-test-"));
    const cvHtml = renderCvHtml(buildCvModel(profileWithPhone(), ADAPT));
    const letterHtml = renderCoverLetterHtml(
      buildCoverLetterModel(profileWithPhone(), JOB, LETTER_ADAPT, "19 October 2026"),
    );
    const cvPath = join(dir, "cv.html");
    const letterPath = join(dir, "carta.html");
    const pdfPath = join(dir, "cv.pdf");
    writeFileSync(cvPath, cvHtml);
    writeFileSync(letterPath, letterHtml);
    writeFileSync(pdfPath, Buffer.alloc(5000, 7)); // stub binario
    const manifest = buildManifest({
      generator: "@jobforce/docs 0.1.0",
      templateVersions: { cv: "cv-template-v1", coverLetter: "cover-letter-template-v1" },
      files: { "cv.html": cvPath, "carta.html": letterPath, "cv.pdf": pdfPath },
      factsUsed: [
        "identity.fullName", "identity.email", "identity.linkedIn", "identity.location",
        "identity.phone", "profile.experienceClaim",
        "experience.surexport.title", "experience.surexport.company",
        "experience.dufry.title", "education.emba.title", "education.emba.note",
        "skills.ifrs",
      ],
      gaps: ["No ACCA/CPA"],
    });
    return { dir, manifest, texts: { "cv.html": cvHtml, "carta.html": letterHtml } };
  }

  const stubExtractor = () =>
    "Jon Peciña Iturbe Finance Manager over 15 years of experience ".repeat(30);

  it("pasa todas las validaciones con documentos sanos", () => {
    const { manifest, texts } = fixture();
    const checks = validateDocuments({
      manifest,
      texts,
      extractPdfText: stubExtractor,
      expectedContact: { email: "jpecina@gmail.com", linkedIn: "linkedin.com/in/jpecina", phoneDigits: "34600000000" },
    });
    const failed = checks.filter((c) => !c.ok);
    assert.ok(allChecksOk(checks), `checks fallidos: ${JSON.stringify(failed, null, 1)}`);
  });

  it("detecta un hash manipulado", () => {
    const { manifest, texts } = fixture();
    manifest.files["cv.html"].sha256 = "0".repeat(64);
    const checks = validateDocuments({
      manifest,
      texts,
      extractPdfText: stubExtractor,
      expectedContact: { email: "jpecina@gmail.com", linkedIn: "linkedin.com/in/jpecina", phoneDigits: "34600000000" },
    });
    assert.ok(!allChecksOk(checks));
    assert.ok(checks.some((c) => c.check === "file.sha256:cv.html" && !c.ok));
  });

  it("detecta texto marcador", () => {
    const { manifest, texts } = fixture();
    texts["cv.html"] += " TODO pendiente";
    const checks = validateDocuments({
      manifest,
      texts,
      extractPdfText: stubExtractor,
      expectedContact: { email: "jpecina@gmail.com", linkedIn: "linkedin.com/in/jpecina", phoneDigits: "34600000000" },
    });
    assert.ok(checks.some((c) => c.check === "no-placeholders:cv.html" && !c.ok));
  });

  it("detecta una reivindicación prohibida", () => {
    const { manifest, texts } = fixture();
    texts["carta.html"] += " I am ACCA certified.";
    const checks = validateDocuments({
      manifest,
      texts,
      extractPdfText: stubExtractor,
      expectedContact: { email: "jpecina@gmail.com", linkedIn: "linkedin.com/in/jpecina", phoneDigits: "34600000000" },
    });
    assert.ok(checks.some((c) => c.check === "no-forbidden-claims:carta.html" && !c.ok));
  });

  it("el manifest nunca incluye el valor del teléfono", () => {
    const { manifest } = fixture();
    assert.ok(!JSON.stringify(manifest).includes(FAKE_PHONE));
  });
});
