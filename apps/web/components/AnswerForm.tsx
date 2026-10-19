'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import type { CreateAnswerRequest } from '@jobforce/domain';

export default function AnswerForm() {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [questionOriginal, setQuestionOriginal] = useState('');
  const [answer, setAnswer] = useState('');
  const [source, setSource] = useState('');
  const [language, setLanguage] = useState('es');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: CreateAnswerRequest = {
        questionOriginal,
        // Normalización sencilla: minúsculas, sin signos de puntuación ni espacios extra.
        questionNormalized: questionOriginal
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[¿?¡!.,;:()"'«»-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        answer,
        language,
        source,
      };
      const res = await fetch('/api/answers', {
        method: 'POST',
        headers: mutatingHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`No se pudo guardar la respuesta (${res.status}).`);
        return;
      }
      setQuestionOriginal('');
      setAnswer('');
      setSource('');
      router.refresh();
    } catch {
      setError('No se pudo conectar con el servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ maxWidth: 640 }}>
      <h2>Nueva respuesta</h2>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="q">Pregunta original</label>
        <textarea
          id="q"
          rows={2}
          value={questionOriginal}
          onChange={(e) => setQuestionOriginal(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="a">Respuesta</label>
        <textarea
          id="a"
          rows={4}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="s">Fuente</label>
        <input
          id="s"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="p. ej. entrevista con Jon, 18-oct-2026"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="l">Idioma</label>
        <select id="l" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="es">Español</option>
          <option value="en">Inglés</option>
        </select>
      </div>
      <button type="submit" className="btn" disabled={loading}>
        {loading ? 'Guardando…' : 'Guardar respuesta'}
      </button>
    </form>
  );
}
