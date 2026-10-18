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
