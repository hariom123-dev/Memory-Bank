-- Migration 001: Initial schema for Memory Bus
CREATE TABLE IF NOT EXISTS Sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  role TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ArchitecturalDecisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  file_paths TEXT NOT NULL,
  embedding TEXT,
  branch_name TEXT DEFAULT 'main',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES Sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS CodeSnapshots (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  ast_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES ArchitecturalDecisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_decisions_agent ON ArchitecturalDecisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON ArchitecturalDecisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_branch ON ArchitecturalDecisions(branch_name);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON ArchitecturalDecisions(created_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_decision ON CodeSnapshots(decision_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_filepath ON CodeSnapshots(file_path);
