import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { db } from "./db";
import { SubmitSchema, DraftUpdateSchema } from "./schemas";
import { enqueueTriage, priorityFor } from "./triage";
import { jsonCall, markdownCall } from "./ai";
import { BRIEF_SYSTEM, UPDATE_SYSTEM, xmlEscape } from "./prompts";
import { HttpError } from "./http";
import { dismissDuplicate, mergeRequests, setCriterionWeight, setStatus, supportRequest } from "./requests";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public")));

const voter = (req: express.Request) => String(req.body?.voter ?? req.header("x-voter") ?? "anonymous");
function sendError(res: express.Response, e: unknown) {
  if (e instanceof z.ZodError) {
    const error = e.issues.map((issue) => issue.message).join("; ") || "Invalid input";
    return res.status(400).json({ error });
  }
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: "Internal error" });
}

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch((e) => sendError(res, e));
  } catch (e) {
    sendError(res, e);
  }
};

const listQuery = `
  SELECT r.*, t.name AS theme_name,
    (SELECT COUNT(*) FROM votes v WHERE v.request_id = r.id) AS votes
  FROM requests r LEFT JOIN themes t ON t.id = r.theme_id`;

function readTriage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function present(row: any) {
  const triage = readTriage(row.triage_json);
  const duplicate = triage && typeof triage.duplicate === "object" ? triage.duplicate : null;
  return {
    ...row,
    triage_json: undefined,
    priority: priorityFor(Number(row.id)),
    duplicate_suggestion: duplicate,
    needs_clarification: triage?.needs_clarification ?? null,
  };
}

app.post("/api/requests", wrap(async (req, res) => {
  const b = SubmitSchema.parse(req.body);
  const info = db.prepare("INSERT INTO requests (title, description, requester, source) VALUES (?, ?, ?, ?)")
    .run(b.title, b.description, b.requester ?? "anonymous", b.source ?? "web");
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO votes (request_id, voter) VALUES (?, ?)").run(id, b.requester ?? "anonymous");
  enqueueTriage(id).catch((e) => console.error(`triage failed for ${id}:`, e instanceof Error ? e.message : e));
  res.status(201).json({ id, status: "new" });
}));

app.get("/api/requests", wrap((req, res) => {
  const { theme, status, sort = "priority" } = req.query as Record<string, string>;
  let rows = (db.prepare(`${listQuery} WHERE r.status != 'merged' ORDER BY r.created_at DESC`).all() as any[]).map(present);
  if (theme) rows = rows.filter((r) => String(r.theme_id) === theme);
  if (status) rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => sort === "votes"
    ? Number(b.votes) - Number(a.votes)
    : (typeof b.priority === "number" ? b.priority : -1) - (typeof a.priority === "number" ? a.priority : -1));
  res.json(rows);
}));

app.get("/api/requests/:id", wrap((req, res) => {
  const row = db.prepare(`${listQuery} WHERE r.id = ?`).get(req.params.id) as any;
  if (!row) throw new HttpError(404, "not found");
  const scores = db.prepare(
    `SELECT s.criterion, c.label, s.score, s.rationale, c.weight, c.invert FROM scores s JOIN criteria c ON c.key = s.criterion WHERE request_id = ?`
  ).all(row.id);
  const triage = readTriage(row.triage_json);
  const duplicate = triage?.duplicate as { matches_id?: unknown } | undefined;
  const matchId = typeof duplicate?.matches_id === "number" ? duplicate.matches_id : null;
  const match = matchId == null ? undefined : db.prepare("SELECT title FROM requests WHERE id = ?").get(matchId) as { title: string } | undefined;
  res.json({ ...present(row), scores, triage, match_title: match?.title ?? null });
}));

app.post("/api/requests/:id/vote", wrap((req, res) => {
  res.json(supportRequest(Number(req.params.id), voter(req)));
}));

app.post("/api/requests/:id/triage", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT status FROM requests WHERE id = ?").get(id) as { status: string } | undefined;
  if (!row) throw new HttpError(404, "not found");
  if (row.status === "merged") throw new HttpError(400, "merged requests are not triaged again");
  res.json(await enqueueTriage(id));
}));

app.post("/api/requests/:id/merge", wrap((req, res) => {
  const into = z.object({ into: z.number().int().positive() }).parse(req.body).into;
  res.json(mergeRequests(Number(req.params.id), into));
}));

app.post("/api/requests/:id/dismiss-duplicate", wrap((req, res) => {
  res.json(dismissDuplicate(Number(req.params.id)));
}));

app.post("/api/requests/:id/status", wrap((req, res) => {
  const status = z.enum(["triaged", "planned", "shipped", "declined"]).parse(req.body?.status);
  res.json(setStatus(Number(req.params.id), status));
}));

app.post("/api/requests/:id/draft-update", wrap(async (req, res) => {
  const row = db.prepare("SELECT r.*, c.title AS merged_title FROM requests r LEFT JOIN requests c ON c.id = r.canonical_id WHERE r.id = ?").get(req.params.id) as any;
  if (!row) throw new HttpError(404, "not found");
  const note = String(req.body?.pm_note ?? "").slice(0, 1000);
  const merged = row.merged_title ? `<merged_into>${xmlEscape(row.merged_title)}</merged_into>` : "";
  const out = await jsonCall(
    UPDATE_SYSTEM,
    `<request requester="${xmlEscape(row.requester)}" status="${xmlEscape(row.status)}"><title>${xmlEscape(row.title)}</title><description>${xmlEscape(row.description)}</description>${merged}</request>\n<pm_note>${xmlEscape(note)}</pm_note>`,
    DraftUpdateSchema,
    "medium",
  );
  res.json({ ...out, requires_human_approval: true });
}));

app.get("/api/themes", wrap((_req, res) => {
  const themes = db.prepare(
    `SELECT t.id, t.name, t.summary, COUNT(r.id) AS requests,
       (SELECT COUNT(*) FROM votes v JOIN requests r2 ON r2.id = v.request_id WHERE r2.theme_id = t.id AND r2.status != 'merged') AS votes,
       SUM(CASE WHEN r.created_at >= datetime('now', '-14 days') THEN 1 ELSE 0 END) AS new_last_14d
     FROM themes t LEFT JOIN requests r ON r.theme_id = t.id AND r.status != 'merged' GROUP BY t.id ORDER BY votes DESC`
  ).all() as { id: number; name: string; summary: string; requests: number; votes: number; new_last_14d: number | null }[];
  res.json(themes.map((t) => {
    const recent = Number(t.new_last_14d ?? 0);
    const total = Number(t.requests ?? 0);
    return { ...t, requests: total, votes: Number(t.votes ?? 0), new_last_14d: recent, emerging: recent >= 3 && total > 0 && recent >= total * 0.6 };
  }));
}));

app.post("/api/themes/:id/brief", wrap(async (req, res) => {
  const theme = db.prepare("SELECT * FROM themes WHERE id = ?").get(req.params.id) as { id: number; name: string; summary: string } | undefined;
  if (!theme) throw new HttpError(404, "not found");
  const reqs = (db.prepare(`${listQuery} WHERE r.theme_id = ? AND r.status != 'merged'`).all(theme.id) as any[]).map(present);
  if (!reqs.length) throw new HttpError(400, "theme has no open requests");
  const avg = db.prepare(
    `SELECT c.label, ROUND(AVG(s.score), 2) AS avg_score, c.weight, c.invert FROM scores s
     JOIN criteria c ON c.key = s.criterion JOIN requests r ON r.id = s.request_id
     WHERE r.theme_id = ? AND r.status != 'merged' GROUP BY c.key`
  ).all(theme.id);
  const priorities = reqs.map((r) => r.priority).filter((p): p is number => typeof p === "number");
  const data = {
    theme: { name: theme.name, summary: theme.summary },
    request_count: reqs.length,
    total_votes: reqs.reduce((sum, r) => sum + Number(r.votes), 0),
    average_priority: priorities.length ? Math.round(priorities.reduce((a, b) => a + b, 0) / priorities.length) : null,
    criteria_averages: avg,
    requests: reqs.map((r) => ({
      id: r.id, title: r.title, description: String(r.description).slice(0, 500),
      source: r.source, need: r.need, votes: r.votes, priority: r.priority, status: r.status,
    })),
  };
  const markdown = await markdownCall(BRIEF_SYSTEM, `<theme_data>\n${JSON.stringify(data, null, 2)}\n</theme_data>`);
  db.prepare("INSERT INTO briefs (theme_id, markdown) VALUES (?, ?)").run(theme.id, markdown);
  res.json({ markdown });
}));

app.get("/api/criteria", wrap((_req, res) => res.json(db.prepare("SELECT * FROM criteria").all())));
app.put("/api/criteria/:key", wrap((req, res) => {
  const weight = z.number().min(0).max(1).parse(req.body?.weight);
  res.json(setCriterionWeight(req.params.key, weight));
}));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError && !(err instanceof z.ZodError)) return res.status(400).json({ error: "Invalid JSON body" });
  sendError(res, err);
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
  console.log(`Feature Intel API on http://localhost:${port} (model ${model})`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set. Add it to .env or triage calls will fail.");
});
server.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
