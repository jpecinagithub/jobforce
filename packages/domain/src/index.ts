/**
 * @jobforce/domain — Modelo de dominio de JOBFORCE (Fase 1).
 *
 * Tipos de las entidades de negocio y del contrato de la API REST que
 * implementará el backend. Solo tipos y constantes: sin lógica ni dependencias.
 */

// ---------------------------------------------------------------------------
// Constantes compartidas entre backend y frontend
// ---------------------------------------------------------------------------

/** Nombre de la cookie de sesión. */
export const SESSION_COOKIE_NAME = 'jobforce_session';

/** Cabecera exigida en las operaciones mutadoras (POST/PUT/PATCH/DELETE). */
export const CSRF_HEADER_NAME = 'x-csrf-token';

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

/**
 * Usuario administrador (monousuario).
 * El hash de la contraseña existe en la base de datos pero NUNCA se expone
 * en ningún tipo de la API.
 */
export interface AdminUser {
  id: string;
  username: string;
  createdAt: string; // ISO 8601
  lastLoginAt: string | null; // ISO 8601
}

export interface UserSession {
  id: string;
  userId: string;
  createdAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  ip: string | null;
  userAgent: string | null;
}

export type ValidationStatus = 'confirmed' | 'unconfirmed' | 'preference' | 'unknown';

export type Sensitivity = 'normal' | 'sensitive' | 'highly_sensitive';

export interface ProfileFact {
  category: string;
  key: string;
  value: unknown;
  source: string;
  sourceDetail?: string;
  validationStatus: ValidationStatus;
  sensitivity: Sensitivity;
}

export type ProfileVersionStatus = 'draft' | 'active' | 'archived';

export interface ProfileVersion {
  id: string;
  versionNo: number;
  status: ProfileVersionStatus;
  source: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: string; // ISO 8601
}

export type AnswerScopeType = 'general' | 'country' | 'company' | 'position' | 'application';

export type ReuseRule = 'reuse' | 'ask_first' | 'never';

export interface AnswerMemory {
  questionOriginal: string;
  questionNormalized: string;
  answer: string;
  language: string;
  source: string;
  validFrom?: string | null; // fecha ISO (YYYY-MM-DD)
  validUntil?: string | null; // fecha ISO (YYYY-MM-DD)
  scopeType: AnswerScopeType;
  scopeValue?: string | null;
  reuseRule: ReuseRule;
  needsContext: boolean;
}

export interface ConfigurationVersion {
  id: string;
  versionNo: number;
  /** Contenido libre de la configuración (sin secretos). */
  config: Record<string, unknown>;
  note: string | null;
  createdBy: string | null;
  createdAt: string; // ISO 8601
}

export interface AuditEvent {
  id: string;
  occurredAt: string; // ISO 8601
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
}

// ---------------------------------------------------------------------------
// Contrato de la API REST (lo implementa apps/backend)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface ApiErrorBody {
  error: string;
}

export interface SetupRequest {
  username: string;
  password: string;
}

export interface SetupResponse {
  id: string;
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  username: string;
  csrfToken: string;
}

export interface MeResponse {
  username: string;
}

export interface ProfileResponse {
  version: ProfileVersion;
  facts: ProfileFact[];
}

export interface CreateProfileVersionRequest {
  source: string;
  notes?: string;
}

export interface CreateProfileVersionResponse {
  id: string;
  versionNo: number;
  status: ProfileVersionStatus;
}

export interface CreateProfileFactRequest {
  category: string;
  key: string;
  value: unknown;
  source: string;
  sourceDetail?: string;
  validationStatus?: ValidationStatus;
  sensitivity?: Sensitivity;
}

export interface CreateAnswerRequest {
  questionOriginal: string;
  questionNormalized: string;
  answer: string;
  language?: string;
  source: string;
  scopeType?: AnswerScopeType;
  scopeValue?: string;
  reuseRule?: ReuseRule;
}

// ---------------------------------------------------------------------------
// Fase 2 — Campañas de búsqueda y evaluación
// ---------------------------------------------------------------------------

/** Tipos de requisito obligatorio en los criterios de una campaña. */
export type MandatoryKind = 'role' | 'language' | 'location' | 'seniority' | 'keyword';

/** Estado de un requisito obligatorio tras evaluar una oferta. */
export type MandatoryState = 'cumple' | 'incumple' | 'sin_evidencia';

/** Dimensiones de preferencia ponderada (pesos del plan de Fase 2). */
export type PreferenceKey =
  | 'funciones'
  | 'competencias'
  | 'seniority'
  | 'ubicacion'
  | 'condiciones'
  | 'empresa';

/** Requisito obligatorio de una campaña. `params` depende de `kind`:
 *  role: { roles: string[] } · language: { languages: string[] }
 *  location: { mode: 'remote_ok'|'onsite'|'any', countries: string[] }
 *  seniority: { levels: string[] } · keyword: { any_of: string[], none_of?: string[] } */
export interface MandatoryRequirement {
  id: string;
  kind: MandatoryKind;
  description: string;
  params: Record<string, unknown>;
}

/** Dimensión de preferencia: peso 0..100, descripción y palabras clave de evidencia. */
export interface PreferenceDim {
  weight: number;
  description: string;
  keywords: string[];
}

/** Criterios editables de una campaña (definidos en el front, por campaña). */
export interface CampaignCriteria {
  roles: string[];
  mandatory: MandatoryRequirement[];
  preferences: Record<PreferenceKey, PreferenceDim>;
  queries: string[];
  unknown_policy: 'conservative';
}

/** Campaña de búsqueda. */
export interface Campaign {
  id: string;
  name: string;
  criteria: CampaignCriteria;
  exa_budget_cap_usd: number;
  exa_spent_usd: number;
  status: 'draft' | 'active' | 'archived';
  created_at: string;
  updated_at: string;
  searches_count?: number;
  offers_count?: number;
}

/** Criterios por defecto derivados del perfil de Jon (Fase 2). */
export const DEFAULT_CRITERIA: CampaignCriteria = {
  roles: ['CFO', 'Finance Manager', 'Controller'],
  mandatory: [
    {
      id: 'rol',
      kind: 'role',
      description: 'Puesto senior en finanzas: CFO, Finance Manager, Controller o equivalente',
      params: {
        roles: ['cfo', 'finance manager', 'controller', 'finance director', 'head of finance'],
      },
    },
    {
      id: 'ingles',
      kind: 'language',
      description: 'Inglés como idioma de trabajo o requisito',
      params: { languages: ['english', 'inglés', 'ingles'] },
    },
    {
      id: 'ubicacion',
      kind: 'location',
      description: 'Remoto o con base en España/UE; expatriación valorada',
      params: {
        mode: 'remote_ok',
        countries: [
          'spain', 'españa', 'netherlands', 'germany', 'france', 'portugal',
          'ireland', 'remote', 'remoto',
        ],
      },
    },
  ],
  preferences: {
    funciones: {
      weight: 30,
      description: 'Contabilidad, reporting IFRS, consolidación, tesorería, control de gestión',
      keywords: ['accounting', 'contabilidad', 'ifrs', 'reporting', 'consolidation', 'consolidación', 'treasury', 'tesorería', 'controlling', 'forecast', 'budget'],
    },
    competencias: {
      weight: 25,
      description: 'ERP (SAP, Oracle, NetSuite), Power BI, Excel avanzado, SQL',
      keywords: ['sap', 'oracle', 'netsuite', 'erp', 'power bi', 'excel', 'sql'],
    },
    seniority: {
      weight: 15,
      description: 'Nivel senior / dirección',
      keywords: ['senior', 'director', 'head', 'vp', 'vice president', 'c-level', 'lead'],
    },
    ubicacion: {
      weight: 15,
      description: 'Remoto o España; expatriación valorada',
      keywords: ['remote', 'remoto', 'spain', 'españa', 'relocation', 'expat'],
    },
    condiciones: {
      weight: 10,
      description: 'Salario, contrato indefinido',
      keywords: ['salary', 'salario', 'permanent', 'indefinido', 'compensation'],
    },
    empresa: {
      weight: 5,
      description: 'Multinacional, sector industrial o servicios',
      keywords: ['multinational', 'multinacional', 'group', 'global'],
    },
  },
  queries: [],
  unknown_policy: 'conservative',
};

/** Copia profunda de los criterios por defecto (para nuevas campañas). */
export function defaultCriteria(): CampaignCriteria {
  return JSON.parse(JSON.stringify(DEFAULT_CRITERIA)) as CampaignCriteria;
}
