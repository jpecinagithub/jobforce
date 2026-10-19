/**
 * Plantilla cover-letter-template-v1: función pura y determinista, sin LLM.
 * La carta enmarca honestamente el perfil de Jon frente a la oferta:
 * NUNCA atribuye certificaciones (ACCA/CPA/...) ni un máster en finanzas.
 */
import type { CandidateProfile } from "../profile.js";

export interface JobPosting {
  title: string;
  location: string;
  sourceName: string;
  sourceUrl: string;
  /** Nota sobre el empleador (p. ej. "employer not named in the posting"). */
  employerNote: string;
}

export interface LetterAdaptation {
  /** Párrafos del cuerpo, redactados solo con hechos del perfil. */
  body: string[];
  closing: string;
}

export interface CoverLetterModel {
  templateVersion: "cover-letter-template-v1";
  date: string;
  name: string;
  contactLine: string[];
  greeting: string;
  subject: string;
  body: string[];
  closing: string;
  signature: string;
  factKeys: string[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildCoverLetterModel(
  profile: CandidateProfile,
  job: JobPosting,
  adapt: LetterAdaptation,
  date: string,
): CoverLetterModel {
  const factKeys = [
    "identity.fullName",
    "identity.email",
    "identity.linkedIn",
    "identity.location",
    "profile.experienceClaim",
    "experience.surexport.title",
    "experience.surexport.company",
    "experience.surexport.location",
    "experience.surexport.period",
    "experience.dufry.title",
    "experience.dufry.company",
    "experience.dufry.location",
    "experience.dufry.period",
    "experience.bexiflon.title",
    "experience.bexiflon.company",
    "experience.bexiflon.period",
    "education.industrial.title",
    "education.industrial.institution",
    "education.emba.title",
    "education.emba.institution",
    "education.emba.note",
    "skills.ifrs",
    "skills.internal-controls",
    "skills.erp",
    "skills.team-leadership",
    "languages.english",
  ];
  if (profile.identity.phone) factKeys.push("identity.phone");

  const contactLine = [profile.identity.location, profile.identity.email, profile.identity.linkedIn];
  if (profile.identity.phone) contactLine.splice(1, 0, profile.identity.phone);

  return {
    templateVersion: "cover-letter-template-v1",
    date,
    name: profile.identity.fullName,
    contactLine,
    greeting: "Dear Hiring Manager,",
    subject: `Application for the position of ${job.title} — ${job.location} (via ${job.sourceName})`,
    body: adapt.body,
    closing: adapt.closing,
    signature: profile.identity.fullName,
    factKeys,
  };
}

export function renderCoverLetterHtml(model: CoverLetterModel): string {
  const contact = model.contactLine.map(esc).join(" &nbsp;•&nbsp; ");
  const body = model.body.map((p) => `<p>${esc(p)}</p>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cover letter — ${esc(model.name)}</title>
<style>
  @page { size: A4; margin: 25mm 20mm; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11.5pt; color: #111; line-height: 1.5; margin: 0; padding: 40px 48px; max-width: 210mm; }
  .head { margin-bottom: 24px; }
  .head .name { font-size: 16pt; font-weight: bold; }
  .head .contact { font-size: 10pt; color: #444; }
  .date { margin-bottom: 18px; }
  .subject { font-weight: bold; margin-bottom: 14px; }
  p { margin: 8px 0; }
  .sign { margin-top: 20px; }
</style>
</head>
<body>
<div class="head">
  <div class="name">${esc(model.name)}</div>
  <div class="contact">${contact}</div>
</div>
<div class="date">${esc(model.date)}</div>
<p class="subject">${esc(model.subject)}</p>
<p>${esc(model.greeting)}</p>
${body}
<p>${esc(model.closing)}</p>
<div class="sign">
  <p>Kind regards,</p>
  <p><strong>${esc(model.signature)}</strong></p>
</div>
</body>
</html>`;
}
