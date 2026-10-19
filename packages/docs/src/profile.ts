/**
 * Perfil de Jon Peciña Iturbe — única fuente de verdad para las plantillas.
 *
 * REGLA DE ORO: solo hechos de esta lista. Nada de lo que no esté aquí
 * puede aparecer en un documento generado.
 *
 * NOTA DE PRIVACIDAD: el teléfono NO se commitea. `identity.phone` queda a
 * `null` en el perfil versionado y se inyecta en el momento de generar
 * (variable de entorno), de modo que solo existe dentro de los documentos
 * generados, nunca en el código, los informes ni los logs.
 */

export interface ExperienceEntry {
  key: string;
  title: string;
  company: string;
  location: string;
  start: string;
  end: string;
  /** Bullets literales del CV de Jon (se pueden seleccionar/reordenar, no reescribir). */
  bullets: string[];
}

export interface EducationEntry {
  key: string;
  title: string;
  institution: string;
  period: string;
  /** Nota obligatoria: el EMBA es título propio, NUNCA máster oficial. */
  note: string;
}

export interface Certification {
  key: string;
  title: string;
  issuer: string;
  date: string;
  verifyUrl: string;
}

export interface Skill {
  key: string;
  label: string;
}

export interface CandidateProfile {
  identity: {
    fullName: string;
    email: string;
    /** null en el perfil versionado; se inyecta al generar. */
    phone: string | null;
    linkedIn: string;
    location: string;
  };
  /** Afirmación literal del CV: "over 15 years of experience". */
  experienceClaim: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: Skill[];
  languages: { key: string; label: string }[];
  certifications: Certification[];
}

export const JON_PROFILE: CandidateProfile = {
  identity: {
    fullName: "Jon Peciña Iturbe",
    email: "jpecina@gmail.com",
    phone: null,
    linkedIn: "linkedin.com/in/jpecina",
    location: "Logroño, Spain",
  },
  experienceClaim: "over 15 years of experience",
  experience: [
    {
      key: "experience.surexport",
      title: "CFO",
      company: "SurExport Peru Berries SAC",
      location: "Lima, Peru",
      start: "11/2023",
      end: "06/2026",
      bullets: [
        "Lead administrative, financial, legal, and HR operations with strong emphasis on financial reconciliation accuracy and internal controls.",
        "Ensure compliance with corporate policies and diverse regulatory landscapes.",
        "Direct strategic planning, budgeting, and contract management for executive decision-making.",
        "Oversee financial processes ensuring attention to detail, audit readiness, and operational efficiency.",
        "Cultivate relationships with financial institutions to support international growth.",
      ],
    },
    {
      key: "experience.dufry",
      title: "Financial Accountant",
      company: "DUFRY SSC (Multinational Environment)",
      location: "Eindhoven, Netherlands",
      start: "04/2021",
      end: "09/2023",
      bullets: [
        "Performed high-volume financial reconciliations across multiple business units in a multinational structure.",
        "Maintained precise financial records while ensuring adherence to global accounting standards (IFRS).",
        "Streamlined accounting operations using ERP systems (SAP) and reconciliation platforms.",
        "Prepared financial reports and forecasts enabling data-driven decision-making.",
      ],
    },
    {
      key: "experience.bexiflon",
      title: "General Accountant Team Leader",
      company: "BEXIFLON SL",
      location: "Logroño, Spain",
      start: "01/2014",
      end: "03/2021",
      bullets: [
        "Managed and trained a global accounting team, ensuring accuracy and timely reconciliations.",
        "Oversaw financial accounts, budgets, cash flow, and P&L with strong analytical capability.",
        "Built robust balance sheets and liquidity analyses aligned with reconciliation controls.",
        "Prepared financial reports and variance analyses for senior management.",
      ],
    },
    {
      key: "experience.unibano",
      title: "General Accountant",
      company: "UNIBAÑO SL",
      location: "Logroño, Spain",
      start: "2005",
      end: "2013",
      bullets: [
        "Supervised finance team of three and managed end-to-end accounting operations.",
        "Conducted account reconciliations, tax declarations, payroll, and billing.",
        "Analysed monthly results and variances supporting strategic and operational decisions.",
        "Maintained compliance with national regulations and audit requirements.",
      ],
    },
    {
      key: "experience.mercedes",
      title: "Assistant Accountant",
      company: "Mercedes-Benz AG",
      location: "Vitoria, Spain",
      start: "2004",
      end: "2004",
      bullets: [
        "Supported budgeting, financial reporting, account reconciliation, and process optimization.",
        "Assisted audits through documentation gathering and accuracy verification.",
      ],
    },
  ],
  education: [
    {
      key: "education.industrial",
      title: "Bachelor's Degree — Industrial Engineering",
      institution: "Universidad de Navarra",
      period: "1997–2003",
      note: "Título oficial (official degree), expedido el 28-jun-2003.",
    },
    {
      key: "education.emba",
      title: "Executive MBA — Business Administration & Management",
      institution: "ICADE Business School / Universidad Pontificia Comillas",
      period: "2012–2013",
      note: "Título propio (non-official degree); not an official Master's degree in Finance.",
    },
  ],
  skills: [
    { key: "skills.reconciliation", label: "Financial Reconciliation" },
    { key: "skills.team-leadership", label: "Global Team Leadership" },
    { key: "skills.multinational", label: "Multinational & Fintech Environments" },
    { key: "skills.accounting-principles", label: "Accounting Principles & Financial Systems" },
    { key: "skills.reconciliation-tools", label: "Reconciliation Tools" },
    { key: "skills.erp", label: "ERP Systems: SAP, Oracle, NetSuite" },
    { key: "skills.analytical", label: "Analytical Skills & Attention to Detail" },
    { key: "skills.remote-teams", label: "Remote Team Management" },
    { key: "skills.digital-transformation", label: "Digital Transformation" },
    { key: "skills.internal-controls", label: "Internal Controls & Compliance" },
    { key: "skills.ifrs", label: "IFRS | Financial Reporting" },
    { key: "skills.sql-excel-bi", label: "SQL | Excel | BI Tools" },
  ],
  languages: [
    { key: "languages.spanish", label: "Spanish — Native" },
    { key: "languages.english", label: "English — Advanced" },
  ],
  certifications: [
    {
      key: "cert.accounting-analysis",
      title: "Accounting Analysis I",
      issuer: "University of Illinois (Coursera)",
      date: "17-Apr-2023",
      verifyUrl: "https://coursera.org/verify/CMPDY4JYMNG6",
    },
    {
      key: "cert.power-bi",
      title: "Power BI Desktop",
      issuer: "Coursera",
      date: "21-May-2021",
      verifyUrl: "https://coursera.org/verify",
    },
    {
      key: "cert.excel-advanced",
      title: "Excel Skills for Business: Advanced",
      issuer: "Macquarie University (Coursera)",
      date: "27-Aug-2021",
      verifyUrl: "https://coursera.org/verify",
    },
    {
      key: "cert.ai-for-everyone",
      title: "AI For Everyone",
      issuer: "DeepLearning.AI (Coursera)",
      date: "16-May-2024",
      verifyUrl: "https://coursera.org/verify",
    },
  ],
};

/** Claves de hechos (category.key) disponibles en el perfil. */
export function listProfileFactKeys(profile: CandidateProfile): string[] {
  const keys: string[] = [
    "identity.fullName",
    "identity.email",
    "identity.linkedIn",
    "identity.location",
    "profile.experienceClaim",
  ];
  if (profile.identity.phone) keys.push("identity.phone");
  for (const e of profile.experience) {
    keys.push(`${e.key}.title`, `${e.key}.company`, `${e.key}.location`, `${e.key}.period`);
    e.bullets.forEach((_, i) => keys.push(`${e.key}.bullets[${i}]`));
  }
  for (const ed of profile.education) {
    keys.push(`${ed.key}.title`, `${ed.key}.institution`, `${ed.key}.period`, `${ed.key}.note`);
  }
  for (const s of profile.skills) keys.push(s.key);
  for (const l of profile.languages) keys.push(l.key);
  for (const c of profile.certifications) {
    keys.push(`${c.key}.title`, `${c.key}.issuer`, `${c.key}.date`, `${c.key}.verifyUrl`);
  }
  return keys;
}
