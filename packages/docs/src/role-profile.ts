/**
 * Perfiles por rol — énfasis de presentación sobre el perfil base.
 *
 * El perfil base (hechos verificados) es la única fuente de verdad para el
 * CONTENIDO de los documentos. Un perfil por rol NO añade hechos: solo
 * aporta un bloque de énfasis (titular, resumen y skills del rol) que se
 * ANTEPONE al contexto construido desde los hechos cuando la campaña tiene
 * un perfil por rol elegido. Sin perfil por rol, la generación es idéntica
 * a la de siempre.
 */
import type { CvAdaptation } from "./templates/cv-template-v1.js";
import type { LetterAdaptation } from "./templates/cover-letter-template-v1.js";

/** Bloque de énfasis de un perfil por rol (tal como vive en la BD). */
export interface RoleProfileEmphasis {
  /** Etiqueta del rol («Finance Manager / CFO», «AI Engineer»...). */
  name: string;
  headline: string;
  summary: string;
  skills: string[];
}

/**
 * Líneas del bloque de contexto del rol, en orden de énfasis:
 * titular, resumen y línea de skills del rol. Los campos vacíos se omiten;
 * un rol sin contenido útil produce un bloque vacío.
 */
export function buildRoleProfileContext(role: RoleProfileEmphasis): string[] {
  const lines: string[] = [];
  const headline = role.headline.trim();
  if (headline) lines.push(headline);
  const summary = role.summary.trim();
  if (summary) lines.push(summary);
  const skills = role.skills.map((s) => s.trim()).filter((s) => s.length > 0);
  if (skills.length > 0) lines.push(`Role focus skills: ${skills.join(", ")}.`);
  return lines;
}

/**
 * Antepone el bloque del rol a las adaptaciones de CV y carta.
 * Sin rol (o con un rol sin contenido) devuelve las adaptaciones intactas:
 * el comportamiento sin perfil por rol es exactamente el anterior.
 * No muta los argumentos.
 */
export function applyRoleProfileEmphasis(
  cv: CvAdaptation,
  carta: LetterAdaptation,
  role: RoleProfileEmphasis | null | undefined,
): { cv: CvAdaptation; carta: LetterAdaptation } {
  if (!role) return { cv, carta };
  const block = buildRoleProfileContext(role);
  if (block.length === 0) return { cv, carta };
  return {
    cv: { ...cv, summary: [...block, ...cv.summary] },
    carta: { ...carta, body: [...block, ...carta.body] },
  };
}
