/**
 * Modelo de contenido compartido: la plantilla v1 construye un modelo puro
 * (secciones, titulares, items) y los renderers lo convierten a HTML o DOCX.
 * Así ambos formatos contienen exactamente el mismo texto.
 */
import type { CandidateProfile } from "../profile.js";

export interface CvAdaptation {
  /** Titular bajo el nombre (derivado de hechos, p. ej. énfasis multi-entidad). */
  headline: string;
  /** Párrafos del resumen (solo hechos del perfil, reordenados/enfatizados). */
  summary: string[];
  /**
   * Selección de bullets por rol: mapa key de experiencia -> índices de
   * bullets del perfil a incluir, en el orden deseado. Si falta una key,
   * se incluyen todos los bullets del perfil para ese rol.
   */
  roleBullets?: Record<string, number[]>;
  /** Orden de visualización de skills (keys de profile.skills). */
  skillOrder?: string[];
}

export interface CvSection {
  heading: string;
  kind: "paragraphs" | "experience" | "education" | "skills" | "languages" | "certifications";
}

export interface CvModel {
  templateVersion: "cv-template-v1";
  name: string;
  headline: string;
  contactLine: string[];
  summary: string[];
  experience: {
    title: string;
    company: string;
    meta: string;
    bullets: string[];
  }[];
  education: { title: string; institution: string; period: string; note: string }[];
  skills: string[];
  languages: string[];
  certifications: { title: string; issuer: string; date: string }[];
  /** Hechos del perfil usados (category.key), para el manifest. */
  factKeys: string[];
}

const CV_FACT_KEYS = [
  "identity.fullName",
  "identity.email",
  "identity.linkedIn",
  "identity.location",
  "profile.experienceClaim",
];

/** Plantilla cv-template-v1: función pura y determinista, sin LLM. */
export function buildCvModel(profile: CandidateProfile, adapt: CvAdaptation): CvModel {
  const factKeys = [...CV_FACT_KEYS];
  if (profile.identity.phone) factKeys.push("identity.phone");

  const contactLine = [profile.identity.location, profile.identity.email, profile.identity.linkedIn];
  if (profile.identity.phone) contactLine.splice(1, 0, profile.identity.phone);

  const experience = profile.experience.map((e) => {
    factKeys.push(`${e.key}.title`, `${e.key}.company`, `${e.key}.location`, `${e.key}.period`);
    const idxs = adapt.roleBullets?.[e.key] ?? e.bullets.map((_, i) => i);
    const bullets = idxs.map((i) => {
      factKeys.push(`${e.key}.bullets[${i}]`);
      return e.bullets[i];
    });
    return {
      title: e.title,
      company: e.company,
      meta: `${e.location} | ${e.start} – ${e.end}`,
      bullets,
    };
  });

  const education = profile.education.map((ed) => {
    factKeys.push(`${ed.key}.title`, `${ed.key}.institution`, `${ed.key}.period`, `${ed.key}.note`);
    return { title: ed.title, institution: ed.institution, period: ed.period, note: ed.note };
  });

  const orderedSkills = adapt.skillOrder
    ? adapt.skillOrder
        .map((k) => profile.skills.find((s) => s.key === k))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
    : profile.skills;
  const skills = orderedSkills.map((s) => {
    factKeys.push(s.key);
    return s.label;
  });

  const languages = profile.languages.map((l) => {
    factKeys.push(l.key);
    return l.label;
  });

  const certifications = profile.certifications.map((c) => {
    factKeys.push(`${c.key}.title`, `${c.key}.issuer`, `${c.key}.date`);
    return { title: c.title, issuer: c.issuer, date: c.date };
  });

  return {
    templateVersion: "cv-template-v1",
    name: profile.identity.fullName,
    headline: adapt.headline,
    contactLine,
    summary: adapt.summary,
    experience,
    education,
    skills,
    languages,
    certifications,
    factKeys,
  };
}

/** Escapa HTML. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renderer HTML del CV (base para PDF y preview PNG). ATS-legible: sin tablas. */
export function renderCvHtml(model: CvModel): string {
  const contact = model.contactLine.map(esc).join(" &nbsp;•&nbsp; ");
  const summary = model.summary.map((p) => `<p>${esc(p)}</p>`).join("\n");
  const exp = model.experience
    .map(
      (e) => `<div class="job">
  <div class="job-head"><strong>${esc(e.title)}</strong> — ${esc(e.company)}</div>
  <div class="job-meta">${esc(e.meta)}</div>
  <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
</div>`,
    )
    .join("\n");
  const edu = model.education
    .map(
      (e) => `<div class="edu">
  <div><strong>${esc(e.title)}</strong></div>
  <div>${esc(e.institution)} • ${esc(e.period)}</div>
  <div class="note">${esc(e.note)}</div>
</div>`,
    )
    .join("\n");
  const skills = `<ul class="inline">${model.skills.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  const langs = `<p>${model.languages.map(esc).join(" &nbsp;•&nbsp; ")}</p>`;
  const certs = `<ul>${model.certifications
    .map((c) => `<li><strong>${esc(c.title)}</strong> — ${esc(c.issuer)} (${esc(c.date)})</li>`)
    .join("")}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CV — ${esc(model.name)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #111; line-height: 1.35; margin: 0; padding: 32px 40px; max-width: 210mm; }
  h1 { font-size: 22pt; margin: 0 0 2px; }
  .headline { font-size: 12pt; color: #333; margin: 0 0 6px; }
  .contact { font-size: 10pt; color: #444; margin: 0 0 14px; }
  h2 { font-size: 12.5pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1.5px solid #333; padding-bottom: 3px; margin: 16px 0 8px; }
  p { margin: 4px 0; }
  .job { margin-bottom: 10px; }
  .job-head { font-size: 11.5pt; }
  .job-meta { font-size: 10pt; color: #555; margin-bottom: 4px; }
  .edu { margin-bottom: 8px; }
  .note { font-size: 10pt; color: #555; font-style: italic; }
  ul { margin: 4px 0 8px; padding-left: 20px; }
  li { margin-bottom: 2px; }
  ul.inline { list-style: none; padding: 0; }
  ul.inline li { display: inline; }
  ul.inline li::after { content: " • "; color: #777; }
  ul.inline li:last-child::after { content: ""; }
</style>
</head>
<body>
<h1>${esc(model.name)}</h1>
<p class="headline">${esc(model.headline)}</p>
<p class="contact">${contact}</p>
<h2>Summary</h2>
${summary}
<h2>Work Experience</h2>
${exp}
<h2>Education</h2>
${edu}
<h2>Core Skills</h2>
${skills}
<h2>Languages</h2>
${langs}
<h2>Certifications</h2>
${certs}
</body>
</html>`;
}
