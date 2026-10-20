-- 013 — Perfiles por rol SIEMPRE en inglés (decisión de Jon, 20-oct-2026:
-- «quiero que el CV y la carta estén siempre en inglés», porque todas las
-- ofertas a las que aplica están en inglés). Traduce los textos sembrados
-- por la 012. Los perfiles son editables por Jon en /perfil: esta
-- migración solo actualiza las filas que aún conservan el texto semilla.

UPDATE role_profiles SET
  headline = 'Finance Manager / CFO · 15+ years · IFRS · International role with relocation',
  summary = 'Finance professional with over 15 years of experience across Spain, the Netherlands and Peru. CFO of an agro-export company, financial accountant in a multinational shared services centre and accounting team leader for seven years. Seeking his next international challenge.',
  featured = '[
    {"title": "CFO — SurExport Peru Berries SAC", "subtitle": "Lima, Peru · 2023 – 2026", "description": ""},
    {"title": "Financial Accountant — Dufry SSC", "subtitle": "Eindhoven, Netherlands · 2021 – 2023", "description": ""},
    {"title": "General Accountant Team Leader — Bexiflon SL", "subtitle": "Logroño · 2014 – 2021", "description": ""}
  ]'::jsonb,
  skills = '["IFRS", "SAP", "Oracle", "NetSuite", "SQL", "Advanced Excel", "Power BI", "Team management"]'::jsonb,
  education_note = 'Industrial Engineering — Universidad de Navarra · Executive MBA — ICADE'
WHERE name = 'Finance Manager / CFO';

UPDATE role_profiles SET
  headline = 'AI Engineer · Design and build of AI applications and agents',
  summary = 'AI product builder with more than 50 real applications deployed: autonomous agents, software generation studios and tools that combine language models with cloud services. Designs the product, builds it and leaves it running in production.',
  featured = '[
    {"title": "AppForge AI Studio", "subtitle": "", "description": "Studio that generates complete applications from a description: agent, automatic build and deployment"},
    {"title": "JOBFORCE", "subtitle": "", "description": "Agent that automates job search: discovers offers, tailors CVs and cover letters and tracks replies"},
    {"title": "Atlas de Proyectos", "subtitle": "", "description": "Visual, interactive catalogue of his AI application ecosystem"}
  ]'::jsonb,
  skills = '["LLM agents", "OpenRouter · Groq · Mistral", "TypeScript", "AI APIs", "Web automation", "Docker"]'::jsonb
WHERE name = 'AI Engineer';

UPDATE role_profiles SET
  summary = 'Full-stack developer with real published projects: web applications with React and TypeScript, Node.js backends and databases, and original 3D browser games. Complete training in React, Node.js + Express and MySQL, applied across dozens of his own deployments.',
  featured = '[
    {"title": "3D browser games (Three.js)", "subtitle": "", "description": "Open city, football and military FPS, original and playable"},
    {"title": "More than 50 web applications", "subtitle": "", "description": "Deployed on Vercel, with repositories on GitHub"},
    {"title": "Own web ERP", "subtitle": "", "description": "Running in production on his server"}
  ]'::jsonb
WHERE name = 'Full Stack Developer';
