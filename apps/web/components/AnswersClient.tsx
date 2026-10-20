'use client';

import { Fragment, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import AnswerForm from '@/components/AnswerForm';
import ConfirmModal, { type Confirmacion } from '@/components/ConfirmModal';

export interface AnswerListItem {
  id?: string;
  questionOriginal: string;
  answer: string;
  source: string;
  language: string;
  scopeType: string;
  scopeValue?: string | null;
}

/**
 * Tabla de respuestas guardadas con edición en la propia página y borrado
 * con confirmación (petición de Jon, 20-oct-2026: «quiero que las respuestas
 * se puedan actualizar»). La edición reutiliza AnswerForm en modo PATCH.
 */
export default function AnswersClient({ answers }: { answers: AnswerListItem[] }) {
  const router = useRouter();
  const { mutatingHeaders } = useAuth();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function borrar(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/answers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: mutatingHeaders(),
      });
      if (!res.ok) {
        setError(`No se pudo borrar la respuesta (${res.status}).`);
        return;
      }
      if (editingId === id) setEditingId(null);
      router.refresh();
    } catch {
      setError('No se pudo contactar con el servidor. Inténtalo de nuevo.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {error && (
        <div className="error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      <table className="data">
        <thead>
          <tr>
            <th>Pregunta</th>
            <th>Respuesta</th>
            <th>Fuente</th>
            <th>Ámbito</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {answers.map((a, i) => (
            <Fragment key={a.id ?? `${a.questionOriginal}-${i}`}>
              <tr>
                <td>{a.questionOriginal}</td>
                <td>{a.answer}</td>
                <td className="muted">{a.source}</td>
                <td>
                  <span className="badge">{a.scopeType}</span>
                  {a.scopeValue ? <span className="muted"> · {a.scopeValue}</span> : null}
                </td>
                <td>
                  {a.id ? (
                    <span style={{ display: 'inline-flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setEditingId(editingId === a.id ? null : (a.id ?? null))}
                      >
                        {editingId === a.id ? 'Cerrar' : 'Editar'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={deletingId === a.id}
                        onClick={() =>
                          setConfirmacion({
                            titulo: 'Borrar respuesta',
                            cuerpo: (
                              <>
                                <p>
                                  Vas a borrar la respuesta a <strong>{a.questionOriginal}</strong>.
                                </p>
                                <p className="muted">No se puede deshacer.</p>
                              </>
                            ),
                            textoConfirmar: 'Borrar respuesta',
                            onConfirm: () => void borrar(a.id!),
                          })
                        }
                      >
                        {deletingId === a.id ? 'Borrando…' : 'Borrar'}
                      </button>
                    </span>
                  ) : null}
                </td>
              </tr>
              {a.id && editingId === a.id ? (
                <tr>
                  <td colSpan={5}>
                    <AnswerForm
                      initial={{
                        id: a.id,
                        questionOriginal: a.questionOriginal,
                        answer: a.answer,
                        source: a.source,
                        language: a.language,
                      }}
                      onSaved={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      <ConfirmModal confirmacion={confirmacion} onClose={() => setConfirmacion(null)} />
    </>
  );
}
