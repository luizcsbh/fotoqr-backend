-- Ready-made invitation design picked in "Capa & Convite" (logo, background, colors).
-- Also applied at startup by src/config/ensureSchema.ts.
ALTER TABLE events ADD COLUMN IF NOT EXISTS invitation_template varchar(50);
