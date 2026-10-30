-- Owner's QR code / table card design, shared across devices
ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_customization jsonb;
