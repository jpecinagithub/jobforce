'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal de confirmación con el estilo del panel (Atlas).
 * Sustituye al `window.confirm` nativo, que no se puede estilizar.
 */
export interface Confirmacion {
  titulo: string;
  cuerpo: React.ReactNode;
  textoConfirmar?: string;
  onConfirm: () => void;
}

export default function ConfirmModal({
  confirmacion,
  onClose,
}: {
  confirmacion: Confirmacion | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!confirmacion) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmacion, onClose]);

  if (!confirmacion) return null;

  // Portal a <body>: el modal puede nacer dentro de una tabla (p. ej.
  // la papelera de ofertas vive en un <td> con white-space: nowrap) y
  // heredaría su contexto — el texto no envolvía y se salía del panel.
  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={confirmacion.titulo}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{confirmacion.titulo}</h3>
        <div className="modal-body">{confirmacion.cuerpo}</div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const fn = confirmacion.onConfirm;
              onClose();
              fn();
            }}
          >
            {confirmacion.textoConfirmar ?? 'Confirmar'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
