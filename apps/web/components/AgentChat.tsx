'use client';

/**
 * Chat del Agente: el usuario pega la URL de una oferta y el agente
 * aplica por él (ingesta → documentos → aprobación → envío), contando
 * cada paso como mensajes. Polling cada 3 s mientras haya un encargo
 * en curso.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import {
  fetchConversation,
  sendAgentMessage,
  type AgentJob,
  type AgentMessage,
} from '@/lib/agent';

const STEP_LABELS: Record<string, string> = {
  ingesta: 'Leyendo la oferta',
  preparacion: 'Preparando la candidatura',
  documentos: 'Generando documentos',
  aprobacion_envio: 'Aprobando y solicitando el envío',
  enviada: 'Enviada',
  envio_en_curso: 'Envío en curso',
  envio_bloqueado: 'Envío bloqueado',
  envio_fallido: 'Envío fallido',
  preparada_sin_driver: 'Preparada (envío manual)',
  enlace_roto: 'Enlace roto',
  sin_contenido: 'Sin contenido legible',
  sin_candidatura: 'Sin candidatura',
  ya_existia: 'Ya existía',
  error: 'Error',
};

export default function AgentChat() {
  const { mutatingHeaders } = useAuth();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const conv = await fetchConversation();
      setMessages(conv.messages);
      setJobs(conv.jobs);
      setRunning(conv.running);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando la conversación');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await sendAgentMessage(value, mutatingHeaders());
      setText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el mensaje');
    } finally {
      setSending(false);
    }
  }

  const activeJob = jobs.find((j) => j.status === 'running');

  return (
    <div>
      {error && <div className="notice">⚠️ {error}</div>}

      <div
        className="card"
        style={{ maxHeight: '55vh', overflowY: 'auto', padding: '1rem', marginBottom: '1rem' }}
      >
        {messages.length === 0 && (
          <p style={{ opacity: 0.8 }}>
            Todavía no hay conversación. Escribe abajo: «aplica a esta oferta:» seguido del
            enlace, y me encargo de todo.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
              marginBottom: '0.5rem',
            }}
          >
            <div
              style={{
                maxWidth: '85%',
                padding: '0.55rem 0.8rem',
                borderRadius: '12px',
                background: m.role === 'user' ? 'var(--accent, #2563eb)' : 'rgba(127,127,127,0.16)',
                color: m.role === 'user' ? '#fff' : 'inherit',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {activeJob && (
          <p style={{ opacity: 0.85 }}>
            ⏳ Trabajando en tu encargo: {STEP_LABELS[activeJob.step ?? ''] ?? activeJob.step ?? '…'}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSend} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="aplica a esta oferta: https://…"
          style={{ flex: 1, padding: '0.6rem 0.8rem', borderRadius: '8px' }}
          disabled={sending}
        />
        <button type="submit" className="btn" disabled={sending || !text.trim()}>
          {sending ? 'Enviando…' : 'Enviar'}
        </button>
      </form>

      {jobs.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <h3>Encargos recientes</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Oferta</th>
                <th>Estado</th>
                <th>Resultado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td style={{ wordBreak: 'break-all' }}>
                    <a href={j.url} target="_blank" rel="noreferrer">
                      {j.url}
                    </a>
                  </td>
                  <td>{j.status}</td>
                  <td>{j.step ? (STEP_LABELS[j.step] ?? j.step) : '—'}</td>
                  <td>
                    {j.applicationId && <Link href="/historico">Ver en Histórico</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
