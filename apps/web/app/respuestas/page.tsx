import { apiGet } from '@/lib/api';
import AnswerForm from '@/components/AnswerForm';
import type { AnswerMemory } from '@jobforce/domain';

export const dynamic = 'force-dynamic';

interface AnswerRecord extends AnswerMemory {
  id?: string;
}

export default async function RespuestasPage() {
  const answers = await apiGet<AnswerRecord[]>('/api/answers');

  return (
    <>
      <h1>Respuestas</h1>
      <p className="muted">
        Memoria de respuestas reutilizables (preguntas de formularios, entrevistas, etc.).
      </p>

      {!answers.ok ? (
        <div className="error" role="alert">{answers.message}</div>
      ) : answers.data.length === 0 ? (
        <div className="notice">Todavía no hay respuestas guardadas.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Pregunta</th>
              <th>Respuesta</th>
              <th>Fuente</th>
              <th>Ámbito</th>
            </tr>
          </thead>
          <tbody>
            {answers.data.map((a, i) => (
              <tr key={a.id ?? `${a.questionNormalized}-${i}`}>
                <td>{a.questionOriginal}</td>
                <td>{a.answer}</td>
                <td className="muted">{a.source}</td>
                <td>
                  <span className="badge">{a.scopeType}</span>
                  {a.scopeValue ? <span className="muted"> · {a.scopeValue}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AnswerForm />
    </>
  );
}
