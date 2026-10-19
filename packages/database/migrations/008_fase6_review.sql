-- 008_fase6_review.sql — Fase 6 (revisión con mínima fricción).
--
-- `applications.reviewed_at` / `applications.reviewed_by`: marca de quién
-- (admin_users) y cuándo aprobó o retiró una candidatura que estaba en
-- `ready_for_review`. Los revisores los fijan los endpoints de revisión
-- (POST /api/applications/:id/approve y :id/reject).

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_applications_reviewed_at ON applications (reviewed_at);
