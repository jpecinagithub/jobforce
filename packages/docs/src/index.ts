export { JON_PROFILE, listProfileFactKeys } from "./profile.js";
export { applyRoleProfileEmphasis, buildRoleProfileContext } from "./role-profile.js";
export type { RoleProfileEmphasis } from "./role-profile.js";
export type {
  CandidateProfile,
  Certification,
  EducationEntry,
  ExperienceEntry,
  Skill,
} from "./profile.js";
export { buildCvModel, renderCvHtml } from "./templates/cv-template-v1.js";
export type { CvAdaptation, CvModel } from "./templates/cv-template-v1.js";
export { buildCoverLetterModel, renderCoverLetterHtml } from "./templates/cover-letter-template-v1.js";
export type {
  CoverLetterModel,
  JobPosting,
  LetterAdaptation,
} from "./templates/cover-letter-template-v1.js";
export { coverLetterModelToDocxBuffer, cvModelToDocxBuffer, extractDocxText } from "./docx-render.js";
export { extractPdfTextWithPdftotext, renderHtmlToPdfAndPng } from "./browser.js";
export { allChecksOk, buildManifest, sha256File, validateDocuments } from "./manifest.js";
export type { CheckItem, Manifest, ManifestFile, ValidateInputs } from "./manifest.js";
