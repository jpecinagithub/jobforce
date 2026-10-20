'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import type { CreateAnswerRequest, UpdateAnswerRequest } from '@jobforce/domain';

export interface AnswerFormInitial {
  id: string;
  questionOriginal: string;
  answer: string;
  source: string;
  language: string;
}

/** Normalización sencilla: minúsculas, sin puntuación ni espacios extra. */
function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:()"«»-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Formulario de respuesta reutilizable. Sin `initial` crea una respuesta
 * nueva (POST); con `initial` edita la existente (PATCH) y avisa con
 * `onSaved` al guardar.
 */
export default function AnswerForm({
  initial,
  onSaved,
}: {
  initial?: AnswerFormInitial;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [questionOriginal, setQuestionOriginal] = useState(initial?.questionOriginal ?? '');
  const [answer, setAnswer] = useState(initial?.answer ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'es');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fid = initial ? `e-${initial.id}` : 'n';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: CreateAnswerRequest = {
        questionOriginal,
        questionNormalized: normalizeQuestion(questionOriginal),
        answer,
        language,
        source,
      };
      const res = initial
        ? await fetch(`/api/answers/${encodeURIComponent(initial.id)}`, {
            method: 'PATCH',
            headers: mutatingHeaders(),
            body: JSON.stringify(body satisfies UpdateAnswerRequest),
          })
        : await fetch('/api/answers', {
            method: 'POST',
            headers: mutatingHeaders(),
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        setError(`No se pudo guardar la respuesta (${res.status}).`);
        return;
      }
      if (initial) {
        onSaved?.();
      } else {
        setQuestionOriginal('');
        setAnswer('');
        setSource('');
      }
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ maxWidth: 640 }}>
      <h2>{initial ? 'Editar respuesta' : 'Nueva respuesta'}</h2>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor={`${fid}-q`}>Pregunta original</label>
        <textarea
          id={`${fid}-q`}
          rows={2}
          value={questionOriginal}
          onChange={(e) => setQuestionOriginal(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-a`}>Respuesta</label>
        <textarea
          id={`${fid}-a`}
          rows={4}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-s`}>Fuente</label>
        <input
          id={`${fid}-s`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="p. ej. entrevista con Jon, 18-oct-2026"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={`${fid}-l`}>Idioma</label>
        <select id={`${fid}-l`} value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="es">Español</option>
          <option value="en">Inglés</option>
        </select>
      </div>
      <button type="submit" className="btn" disabled={loading}>
        {loading ? 'Guardando…' : initial ? 'Guardar cambios' : 'Guardar respuesta'}
      </button>
    </form>
  );
}
