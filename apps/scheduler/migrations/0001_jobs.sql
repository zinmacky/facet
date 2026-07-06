-- ジョブの永続ストア。DO はここを唯一の真実として読み書きする。
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  caption TEXT,
  publish_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ig_container_id TEXT,
  ig_media_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 公開時刻スキャン(status='pending' AND publish_at <= now)を効かせる複合インデックス。
CREATE INDEX idx_due ON jobs(status, publish_at);
