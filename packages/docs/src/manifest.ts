/**
 * Manifest de candidatura + validación pre-envío.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  generator: string;
  generatedAt: string;
  templateVersions: { cv: string; coverLetter: string };
  files: Record<string, ManifestFile>;
  /** Hechos del perfil usados (category.key). */
  factsUsed: string[];
  /** Requisitos de la oferta no cubiertos por los hechos — nunca se maquillan. */
  gaps: string[];
}

export function sha256File(path: string): { bytes: number; sha256: string } {
  const buf = readFileSync(path);
  return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

export function buildManifest(opts: {
  generator: string;
  templateVersions: { cv: string; coverLetter: string };
  files: Record<string, string>;
  factsUsed: string[];
  gaps: string[];
}): Manifest {
  const files: Record<string, ManifestFile> = {};
  for (const [key, path] of Object.entries(opts.files)) {
    files[key] = { path, ...sha256File(path) };
  }
  return {
    generator: opts.generator,
    generatedAt: new Date().toISOString(),
    templateVersions: opts.templateVersions,
    files,
    factsUsed: [...new Set(opts.factsUsed)].sort(),
    gaps: opts.gaps,
  };
}

export interface CheckItem {
  check: string;
  ok: boolean;
  detail: string;
}

/** Patrones de texto marcador que nunca deben aparecer en un documento final. */
const PLACEHOLDER_RE = /\b(TODO|FIXME|XXX|lorem ipsum|\[insert|\[your|\[nombre|\[tel[eé]fono)/i;

/** Reivindicaciones prohibidas: Jon no tiene estas credenciales.
 * El "not an official" se excluye con lookbehind: la aclaración honesta
 * del EMBA ("not an official Master's degree in Finance") no es una
 * reivindicación. */
const FORBIDDEN_CLAIMS_RE =
  /\b(ACCA|ACA\b|CPA\b|CMA\b|CIMA)\b.*(certified|qualified|holder)|(?<!not an official )Master'?s degree in Finance/i;

export interface ValidateInputs {
  manifest: Manifest;
  /** Texto plano extraído de cada documento (misma key que en manifest.files). */
  texts: Record<string, string>;
  /** Extractor de texto de PDF (p. ej. pdftotext); en tests se inyecta un stub. */
  extractPdfText: (pdfPath: string) => string;
  /** Contacto esperado: solo se comprueba presencia/patrón, sin volcar valores. */
  expectedContact: { email: string; linkedIn: string; phoneDigits: string | null };
}

export function validateDocuments(inputs: ValidateInputs): CheckItem[] {
  const { manifest, texts, expectedContact } = inputs;
  const checks: CheckItem[] = [];
  const push = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  // 1. Archivos existen, tamaños sanos, hashes cuadran.
  for (const [key, f] of Object.entries(manifest.files)) {
    const exists = existsSync(f.path);
    push(`file.exists:${key}`, exists, exists ? f.path : "no existe");
    if (!exists) continue;
    const st = statSync(f.path);
    const sizeOk = st.size > 1024 && st.size < 20 * 1024 * 1024;
    push(`file.size:${key}`, sizeOk, `${st.size} bytes`);
    const actual = sha256File(f.path);
    push(`file.sha256:${key}`, actual.sha256 === f.sha256, actual.sha256.slice(0, 12) + "…");
  }

  // 2. Sin texto marcador en ningún documento.
  for (const [key, text] of Object.entries(texts)) {
    const m = text.match(PLACEHOLDER_RE);
    push(`no-placeholders:${key}`, !m, m ? `encontrado: ${m[0]}` : "limpio");
  }

  // 3. Sin reivindicaciones prohibidas.
  for (const [key, text] of Object.entries(texts)) {
    const m = text.match(FORBIDDEN_CLAIMS_RE);
    push(`no-forbidden-claims:${key}`, !m, m ? `encontrado: ${m[0]}` : "limpio");
  }

  // 4. El EMBA aparece siempre como título propio.
  for (const [key, text] of Object.entries(texts)) {
    if (!/Executive MBA/i.test(text)) {
      push(`emba-disclosed:${key}`, false, "no menciona el Executive MBA");
      continue;
    }
    const ok = /t[ií]tulo propio|non-official/i.test(text);
    push(`emba-disclosed:${key}`, ok, ok ? "EMBA declarado como título propio" : "EMBA sin aclaración de título propio");
  }

  // 5. Datos de contacto correctos (patrones, sin volcar valores sensibles).
  const allText = Object.values(texts).join("\n");
  push("contact.email", allText.includes(expectedContact.email), "email presente en los documentos");
  push(
    "contact.linkedin",
    allText.includes(expectedContact.linkedIn),
    "LinkedIn presente en los documentos",
  );
  if (expectedContact.phoneDigits) {
    const digits = allText.replace(/\D/g, "");
    push(
      "contact.phone",
      digits.includes(expectedContact.phoneDigits),
      "teléfono presente en los documentos",
    );
  } else {
    push("contact.phone", true, "sin teléfono esperado (perfil versionado)");
  }

  // 6. Texto extraíble del PDF.
  for (const [key, f] of Object.entries(manifest.files)) {
    if (!key.endsWith(".pdf")) continue;
    try {
      const text = inputs.extractPdfText(f.path);
      const ok = text.replace(/\s/g, "").length > 200;
      push(`pdf.extractable:${key}`, ok, ok ? `${text.trim().split(/\s+/).length} palabras extraídas` : "texto insuficiente");
    } catch (e) {
      push(`pdf.extractable:${key}`, false, `extractor falló: ${(e as Error).message}`);
    }
  }

  // 7. Manifest: versiones de plantilla y lista de hechos.
  push(
    "manifest.templates",
    manifest.templateVersions.cv === "cv-template-v1" &&
      manifest.templateVersions.coverLetter === "cover-letter-template-v1",
    JSON.stringify(manifest.templateVersions),
  );
  push("manifest.facts", manifest.factsUsed.length > 10, `${manifest.factsUsed.length} hechos registrados`);
  push("manifest.gaps-field", Array.isArray(manifest.gaps), `${manifest.gaps.length} gaps declarados`);

  return checks;
}

/** true si todos los checks pasaron. */
export function allChecksOk(checks: CheckItem[]): boolean {
  return checks.every((c) => c.ok);
}
