import Database from "better-sqlite3";

export const db = new Database(process.env.DB_PATH ?? "data.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requester TEXT NOT NULL DEFAULT 'anonymous',
  source TEXT NOT NULL DEFAULT 'web',
  status TEXT NOT NULL DEFAULT 'new',
  canonical_id INTEGER REFERENCES requests(id),
  theme_id INTEGER REFERENCES themes(id),
  need TEXT,
  route TEXT,
  triage_json TEXT,
  triage_error TEXT,
  duplicate_dismissed INTEGER NOT NULL DEFAULT 0,
  triaged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS votes (
  request_id INTEGER NOT NULL REFERENCES requests(id),
  voter TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (request_id, voter)
);
CREATE TABLE IF NOT EXISTS embeddings (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id),
  vector TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS criteria (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  weight REAL NOT NULL,
  invert INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scores (
  request_id INTEGER NOT NULL REFERENCES requests(id),
  criterion TEXT NOT NULL REFERENCES criteria(key),
  score INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  PRIMARY KEY (request_id, criterion)
);
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES themes(id),
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const requestCols = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
if (!requestCols.some((c) => c.name === "duplicate_dismissed")) {
  db.exec("ALTER TABLE requests ADD COLUMN duplicate_dismissed INTEGER NOT NULL DEFAULT 0");
}

const hasCriteria = db.prepare("SELECT COUNT(*) AS n FROM criteria").get() as { n: number };
if (hasCriteria.n === 0) {
  const ins = db.prepare("INSERT INTO criteria (key,label,description,weight,invert) VALUES (?,?,?,?,?)");
  ins.run("reach", "Reach", "How many customers/users plausibly benefit. 1 = a single account, 5 = most of the user base.", 0.3, 0);
  ins.run("strategic_fit", "Strategic fit", "Alignment with product strategy and positioning. 1 = off-strategy, 5 = core to strategy.", 0.3, 0);
  ins.run("revenue_risk", "Revenue impact", "Revenue at risk or opportunity unlocked (churn, expansion, deal blockers). 1 = none, 5 = major.", 0.25, 0);
  ins.run("effort", "Effort", "Estimated build cost. 1 = days, 5 = multi-quarter. Higher is worse.", 0.15, 1);
}
