-- 012: perfiles por rol (fase «Perfiles por rol», 2026-10-20).
--
-- El perfil base sigue siendo la versión de hechos verificados
-- (profile_versions/profile_facts): es la fuente interna de la máquina.
-- Encima, `role_profiles` guarda la PRESENTACIÓN editable por objetivo
-- (Finance Manager, AI Engineer, Full Stack Developer...): titular,
-- resumen, bloques destacados, skills y nota de formación. La página
-- /perfil trabaja con esta capa; la tabla clave-valor desaparece de la UI.
--
-- campaigns.role_profile_id: perfil por rol elegido para la campaña
-- (nullable = sin énfasis de rol; la generación se comporta como antes).

CREATE TABLE role_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  headline text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  featured jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  education_note text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Como máximo un perfil por rol marcado como «por defecto».
CREATE UNIQUE INDEX role_profiles_single_default
  ON role_profiles (is_default) WHERE is_default;

ALTER TABLE campaigns
  ADD COLUMN role_profile_id uuid REFERENCES role_profiles(id) ON DELETE SET NULL;

-- Semilla idempotente: los tres perfiles aprobados por Jon (20-oct-2026),
-- con los textos exactos de la maqueta aprobada.
INSERT INTO role_profiles (name, headline, summary, featured, skills, education_note, is_default) VALUES
  (
    'Finance Manager / CFO',
    'Finance Manager / CFO · 15+ años · IFRS · Rol internacional con reubicación',
    'Profesional de finanzas con más de 15 años entre España, Países Bajos y Perú. CFO de una empresa agroexportadora, contable financiero en un centro de servicios compartidos multinacional y líder de equipo contable durante siete años. Busca su próximo reto internacional.',
    '[
      {"title": "CFO — SurExport Peru Berries SAC", "subtitle": "Lima, Perú · 2023 – 2026", "description": ""},
      {"title": "Financial Accountant — Dufry SSC", "subtitle": "Eindhoven, Países Bajos · 2021 – 2023", "description": ""},
      {"title": "General Accountant Team Leader — Bexiflon SL", "subtitle": "Logroño · 2014 – 2021", "description": ""}
    ]'::jsonb,
    '["IFRS", "SAP", "Oracle", "NetSuite", "SQL", "Excel avanzado", "Power BI", "Gestión de equipos"]'::jsonb,
    'Ingeniero Industrial — Universidad de Navarra · Executive MBA — ICADE',
    true
  ),
  (
    'AI Engineer',
    'AI Engineer · Diseño y construcción de aplicaciones y agentes de IA',
    'Constructor de productos de IA con más de 50 aplicaciones reales desplegadas: agentes autónomos, estudios de generación de software y herramientas que combinan modelos de lenguaje con servicios en la nube. Diseña el producto, lo construye y lo deja funcionando en producción.',
    '[
      {"title": "AppForge AI Studio", "subtitle": "", "description": "Estudio que genera aplicaciones completas desde una descripción: agente, compilación y despliegue automáticos"},
      {"title": "JOBFORCE", "subtitle": "", "description": "Agente que automatiza la búsqueda de empleo: descubre ofertas, adapta CV y cartas y hace el seguimiento"},
      {"title": "Atlas de Proyectos", "subtitle": "", "description": "Catálogo visual e interactivo de su ecosistema de aplicaciones de IA"}
    ]'::jsonb,
    '["Agentes LLM", "OpenRouter · Groq · Mistral", "TypeScript", "APIs de IA", "Automatización web", "Docker"]'::jsonb,
    NULL,
    false
  ),
  (
    'Full Stack Developer',
    'Full Stack Developer · React · Node.js · MySQL',
    'Desarrollador full-stack con proyectos reales publicados: aplicaciones web con React y TypeScript, backends con Node.js y bases de datos, y juegos 3D originales para navegador. Formación completa en React, Node.js + Express y MySQL, aplicada en decenas de despliegues propios.',
    '[
      {"title": "Juegos 3D para navegador (Three.js)", "subtitle": "", "description": "Ciudad abierta, fútbol y FPS militar, originales y jugables"},
      {"title": "Más de 50 aplicaciones web", "subtitle": "", "description": "Desplegadas en Vercel, con repositorios en GitHub"},
      {"title": "ERP web propio", "subtitle": "", "description": "En producción en su servidor"}
    ]'::jsonb,
    '["React", "TypeScript", "Node.js + Express", "MySQL", "Vite", "Git / GitHub", "Vercel"]'::jsonb,
    NULL,
    false
  )
ON CONFLICT (name) DO NOTHING;
