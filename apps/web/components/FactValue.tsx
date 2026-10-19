/**
 * Renderiza el valor de un hecho del perfil de forma legible.
 *
 * Los hechos guardan valores estructurados (certificaciones, educación,
 * experiencia…) y el formateador genérico los mostraba como JSON en crudo.
 * Este componente conoce las formas reales y las presenta como texto.
 */
export default function FactValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>—</>;
  if (typeof value === 'string') return <>{value}</>;
  if (typeof value === 'number' || typeof value === 'boolean') return <>{String(value)}</>;
  if (Array.isArray(value)) {
    return <>{value.map((v) => String(v)).join(' · ')}</>;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '');
    const periodo = [str(v.start), str(v.end)].filter(Boolean).join('–');

    // Certificación: {date, name, issuer, verify_url, verify_code}
    if (str(v.name) && str(v.issuer)) {
      return (
        <>
          <strong>{str(v.name)}</strong> — {str(v.issuer)}
          {str(v.date) && <span className="muted"> ({str(v.date)})</span>}
          {str(v.verify_url) && (
            <>
              {' '}
              <a href={str(v.verify_url)} target="_blank" rel="noopener noreferrer">
                verificar ↗
              </a>
            </>
          )}
        </>
      );
    }
    // Educación: {start, end, degree, issued, warning}
    if (str(v.degree)) {
      return (
        <>
          <strong>{str(v.degree)}</strong>
          {periodo && <span className="muted"> ({periodo})</span>}
          {str(v.warning) && (
            <>
              <br />
              <span className="muted">{str(v.warning)}</span>
            </>
          )}
        </>
      );
    }
    // Experiencia: {start, end, title, company, location, context}
    if (str(v.title) && str(v.company)) {
      return (
        <>
          <strong>{str(v.title)}</strong> en {str(v.company)}
          {periodo && <span className="muted"> ({periodo})</span>}
          {str(v.location) && (
            <>
              <br />
              <span className="muted">{str(v.location)}</span>
            </>
          )}
        </>
      );
    }
    // Afirmación con nota: {text, note}
    if (str(v.text)) {
      return (
        <>
          {str(v.text)}
          {str(v.note) && (
            <>
              <br />
              <span className="muted">{str(v.note)}</span>
            </>
          )}
        </>
      );
    }
    // Idioma: {language, level}
    if (str(v.language)) {
      return (
        <>
          {str(v.language)}
          {str(v.level) && <> — {str(v.level)}</>}
        </>
      );
    }
    // Genérico: pares clave–valor legibles.
    return (
      <>
        {Object.entries(v).map(([k, val], i) => (
          <span key={k}>
            {i > 0 && <br />}
            <span className="muted">{k}:</span>{' '}
            {val !== null && typeof val === 'object' ? JSON.stringify(val) : String(val ?? '—')}
          </span>
        ))}
      </>
    );
  }
  return <>{String(value)}</>;
}
