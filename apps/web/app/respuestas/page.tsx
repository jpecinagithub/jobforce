import { apiGet } from '@/lib/api';
import AnswerForm from '@/components/AnswerForm';
import AnswersClient from '@/components/AnswersClient';
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
        <AnswersClient answers={answers.data} />
      )}

      <AnswerForm />
    </>
  );
}
