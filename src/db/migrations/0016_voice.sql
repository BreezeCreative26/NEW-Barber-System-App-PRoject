-- AI receptionist (ElevenLabs Conversational AI). Each shop is its own entity: its own agent,
-- its own bearer secret, its own call log. voice_json = {enabled, agent_id, secret, greeting, notes}.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS voice_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS voice_calls (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  caller TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  booking_id TEXT,
  duration_s INTEGER NOT NULL DEFAULT 0,
  started_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_calls_shop ON voice_calls(shop_id, started_at DESC);
