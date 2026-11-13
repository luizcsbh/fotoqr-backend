-- Migration: 0010_add_password_reset_tokens
-- Tabela de tokens para recuperação de senha
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS pwd_reset_token_hash_idx ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS pwd_reset_user_id_idx ON password_reset_tokens(user_id);
