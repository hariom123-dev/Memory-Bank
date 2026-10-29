-- Migration 002: Schema for Epoch Summaries (dense historical decision compression)
CREATE TABLE IF NOT EXISTS EpochSummaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_decisions TEXT NOT NULL,
  impacted_files TEXT NOT NULL,
  decision_count INTEGER NOT NULL,
  first_decision_at INTEGER NOT NULL,
  last_decision_at INTEGER NOT NULL,
  embedding TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES Sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_epoch_summaries_session ON EpochSummaries(session_id);
CREATE INDEX IF NOT EXISTS idx_epoch_summaries_agent ON EpochSummaries(agent_id);
CREATE INDEX IF NOT EXISTS idx_epoch_summaries_created ON EpochSummaries(created_at);
