-- Migration: 0011_add_user_token_version
-- Versão da sessão: incrementada a cada troca/redefinição de senha para derrubar logins antigos
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
