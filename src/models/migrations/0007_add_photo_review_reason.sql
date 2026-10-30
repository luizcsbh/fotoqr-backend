-- Why automatic moderation sent a photo to manual review (flagged content or provider failure)
ALTER TABLE photos ADD COLUMN IF NOT EXISTS review_reason text;
