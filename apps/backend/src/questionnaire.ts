/**
 * @jobforce/backend — Cuestionario breve de perfil (Fase 1).
 *
 * Contenido estático servido en `GET /api/profile/questionnaire`.
 * Las respuestas al cuestionario se registran como facts del perfil
 * (categoría `questionnaire`, clave = id de la pregunta).
 */

export type QuestionType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'date'
  | 'select'
  | 'boolean';

export interface QuestionnaireQuestion {
  /** Identificador estable (se usa como clave del fact). */
  id: string;
  texto: string;
  tipo: QuestionType;
  obligatoria: boolean;
  /** Opciones cuando tipo === 'select'. */
  opciones?: string[];
  ayuda?: string;
}

export interface QuestionnaireBlock {
  id: string;
  titulo: string;
  descripcion?: string;
  preguntas: QuestionnaireQuestion[];
}

export const QUESTIONNAIRE: QuestionnaireBlock[] = [
  {
    id: 'identidad_contacto',
    titulo: 'Identidad y contacto',
    descripcion: 'Datos básicos para rellenar formularios y cartas de presentación.',
    preguntas: [
      { id: 'nombre_completo', texto: 'Nombre completo', tipo: 'text', obligatoria: true },
      { id: 'email', texto: 'Correo electrónico principal', tipo: 'text', obligatoria: true },
      { id: 'telefono', texto: 'Teléfono (con prefijo internacional)', tipo: 'text', obligatoria: false },
      {
        id: 'ubicacion',
        texto: 'Ciudad y país de residencia actual',
        tipo: 'text',
        obligatoria: true,
        ayuda: 'P. ej. «Logroño, España».',
      },
      { id: 'linkedin', texto: 'URL del perfil de LinkedIn', tipo: 'text', obligatoria: false },
      {
        id: 'permiso_trabajo',
        texto: '¿Tienes permiso de trabajo en la UE?',
        tipo: 'boolean',
        obligatoria: true,
      },
    ],
  },
  {
    id: 'experiencia',
    titulo: 'Experiencia profesional',
    descripcion: 'Resumen de los puestos más relevantes (los últimos 3 bastan).',
    preguntas: [
      {
        id: 'puesto_actual',
        texto: 'Puesto actual o más reciente',
        tipo: 'text',
        obligatoria: true,
      },
      {
        id: 'empresa_actual',
        texto: 'Empresa del puesto actual o más reciente',
        tipo: 'text',
        obligatoria: true,
      },
      {
        id: 'resumen_experiencia',
        texto: 'Resumen de tu experiencia en 3-5 frases',
        tipo: 'longtext',
        obligatoria: true,
        ayuda: 'Sectores, tamaños de empresa, responsabilidades clave, logros cuantificables.',
      },
      {
        id: 'anios_experiencia',
        texto: 'Años de experiencia profesional',
        tipo: 'number',
        obligatoria: true,
      },
      {
        id: 'sectores',
        texto: 'Sectores en los que has trabajado',
        tipo: 'text',
        obligatoria: false,
        ayuda: 'Separados por comas.',
      },
    ],
  },
  {
    id: 'educacion',
    titulo: 'Educación',
    preguntas: [
      {
        id: 'titulacion_maxima',
        texto: 'Titulación más alta',
        tipo: 'text',
        obligatoria: true,
        ayuda: 'P. ej. «Ingeniero Industrial, Universidad de Navarra (2003)».',
      },
      {
        id: 'formacion_adicional',
        texto: 'Formación adicional relevante',
        tipo: 'longtext',
        obligatoria: false,
        ayuda: 'Másteres, certificaciones, cursos con entidad y año.',
      },
    ],
  },
  {
    id: 'competencias',
    titulo: 'Competencias',
    preguntas: [
      {
        id: 'competencias_tecnicas',
        texto: 'Competencias técnicas',
        tipo: 'longtext',
        obligatoria: true,
        ayuda: 'P. ej. ERP (SAP, Oracle, NetSuite), IFRS, SQL, Excel, BI.',
      },
      {
        id: 'competencias_blandas',
        texto: 'Competencias interpersonales',
        tipo: 'longtext',
        obligatoria: false,
      },
    ],
  },
  {
    id: 'idiomas',
    titulo: 'Idiomas',
    preguntas: [
      {
        id: 'idiomas',
        texto: 'Idiomas y nivel',
        tipo: 'longtext',
        obligatoria: true,
        ayuda: 'Un idioma por línea con nivel (p. ej. «Inglés — avanzado (C1)»).',
      },
    ],
  },
  {
    id: 'disponibilidad',
    titulo: 'Disponibilidad y preferencias',
    preguntas: [
      {
        id: 'fecha_disponibilidad',
        texto: 'Fecha a partir de la cual estás disponible',
        tipo: 'date',
        obligatoria: true,
      },
      {
        id: 'dispuesto_reubicarse',
        texto: '¿Dispuesto a reubicarte o expatriarte?',
        tipo: 'boolean',
        obligatoria: true,
      },
      {
        id: 'dispuesto_viajar',
        texto: 'Disponibilidad para viajar',
        tipo: 'select',
        obligatoria: false,
        opciones: ['No', 'Ocasionalmente', 'Frecuentemente', 'Sin restricciones'],
      },
      {
        id: 'salario_objetivo',
        texto: 'Rango salarial objetivo (bruto anual)',
        tipo: 'text',
        obligatoria: false,
        ayuda: 'Solo visible para ti; nunca se envía a terceros sin tu aprobación.',
      },
    ],
  },
];
