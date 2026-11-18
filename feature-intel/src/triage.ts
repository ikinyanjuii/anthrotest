import { db } from "./db";
import { embed, encodeVector, decodeVector, jsonCall, topMatches, type Embedding } from "./ai";
import { TRIAGE_SYSTEM, buildTriageUser } from "./prompts";
import { TriageResultSchema, type TriageResult } from "./schemas";
import { HttpError } from "./http";

interface ReqRow { id: number; title: string; description: string; source: string; need: string | null }
interface Criterion { key: string; label: string; description: string; weight: number; invert: number }
interface StoredNeighbor extends ReqRow { vector: string }

/** Weighted 0-100 strategic priority. Computed in code (not by the LLM) so it is auditable and tunable. */
export function priorityFor(requestId: number): number | null {
  const rows = db.prepare(
    `SELECT s.score, c.weight, c.invert FROM scores s JOIN criteria c ON c.key = s.criterion WHERE s.request_id = ?`
  ).all(requestId) as { score: number; weight: number; invert: number }[];
  if (!rows.length) return null;
  const totalW = rows.reduce((s, r) => s + r.weight, 0);
  if (!(totalW > 0)) return null;
  const sum = rows.reduce((s, r) => s + r.weight * (r.invert ? 6 - r.score : r.score), 0);
  const value = ((sum / totalW) / 5) * 100;
  return Number.isFinite(value) ? Math.round(value) : null;
}

function reviewIssues(result: TriageResult, criteria: Criterion[], candidateIds: Set<number>): string[] {
  const issues: string[] = [];
  const got = new Set(result.scores.map((s) => s.criterion));
  for (const c of criteria) if (!got.has(c.key)) issues.push(`missing score for "${c.key}"`);
  const unknown = result.scores.filter((s) => !criteria.some((c) => c.key === s.criterion)).map((s) => s.criterion);
  if (unknown.length) issues.push(`unknown criteria: ${unknown.join(", ")}`);
  const match = result.duplicate.matches_id;
  if (result.duplicate.verdict === "distinct") {
    if (match !== null) issues.push("a distinct verdict must set matches_id to null");
  } else if (match === null || !candidateIds.has(match)) {
    const allowed = [...candidateIds].join(", ") || "none";
    issues.push(`verdict "${result.duplicate.verdict}" requires matches_id to be one of [${allowed}]`);
  }
  return issues;
}

async function vectorFor(row: StoredNeighbor, current: Embedding): Promise<number[]> {
  const decoded = decodeVector(row.vector);
  if (decoded && decoded.model === current.model && decoded.vector.length === current.vector.length) return decoded.vector;
  const fresh = await embed(`${row.title}\n${row.description}`);
  db.prepare("INSERT OR REPLACE INTO embeddings (request_id, vector) VALUES (?, ?)").run(row.id, encodeVector(fresh));
  return fresh.vector;
}

export async function triageRequest(id: number): Promise<TriageResult> {
  const req = db.prepare("SELECT id, title, description, source, need FROM requests WHERE id = ?").get(id) as ReqRow | undefined;
  if (!req) throw new HttpError(404, `request ${id} not found`);

  try {
    db.prepare("UPDATE requests SET triage_error = NULL WHERE id = ?").run(id);
    const emb = await embed(`${req.title}\n${req.description}`);
    db.prepare("INSERT OR REPLACE INTO embeddings (request_id, vector) VALUES (?, ?)").run(id, encodeVector(emb));

    const others = db.prepare(
      `SELECT r.id, r.title, r.description, r.need, e.vector FROM requests r
       JOIN embeddings e ON e.request_id = r.id WHERE r.id != ? AND r.status != 'merged'`
    ).all(id) as StoredNeighbor[];
    const comparable = [];
    for (const other of others) {
      comparable.push({
        id: other.id, title: other.title, description: other.description, need: other.need,
        vector: await vectorFor(other, emb),
      });
    }
    const candidates = topMatches(emb.vector, comparable).map((c) => ({
      id: c.id, title: c.title, description: c.description, need: c.need, similarity: c.similarity,
    }));
    const themes = db.prepare("SELECT id, name, summary FROM themes").all() as { id: number; name: string; summary: string }[];
    const criteria = db.prepare("SELECT key, label, description, weight, invert FROM criteria").all() as Criterion[];
    const candidateIds = new Set(candidates.map((c) => c.id));
    const basePrompt = buildTriageUser({ title: req.title, description: req.description, source: req.source, candidates, themes, criteria });

    let hint = "";
    let result: TriageResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await jsonCall(TRIAGE_SYSTEM, hint ? `${basePrompt}\n\n${hint}` : basePrompt, TriageResultSchema, "high");
      const issues = reviewIssues(result, criteria, candidateIds);
      if (!issues.length) break;
      hint = `Your previous answer was rejected: ${issues.join("; ")}. Fix those fields and return the full JSON object.`;
    }
    if (!result) throw new Error("triage produced no result");

    if (result.duplicate.matches_id !== null && !candidateIds.has(result.duplicate.matches_id)) {
      result.duplicate.matches_id = null;
      result.duplicate.verdict = "distinct";
    }
    if (result.duplicate.verdict === "distinct") result.duplicate.matches_id = null;

    const validCriteria = new Set(criteria.map((c) => c.key));
    result.scores = result.scores.filter((s) => validCriteria.has(s.criterion));
    const scored = new Set(result.scores.map((s) => s.criterion));
    for (const c of criteria) {
      if (!scored.has(c.key)) result.scores.push({
        criterion: c.key, score: 3,
        rationale: "No score was returned for this criterion, so it was defaulted to 3 (unknown).",
      });
    }

    db.transaction(() => {
      let themeId = result!.theme.existing_theme_id;
      if (themeId !== null && !themes.some((t) => t.id === themeId)) themeId = null;
      if (themeId === null && result!.theme.new_theme_name) {
        db.prepare("INSERT OR IGNORE INTO themes (name, summary) VALUES (?, ?)").run(result!.theme.new_theme_name, result!.theme.new_theme_summary ?? "");
        themeId = (db.prepare("SELECT id FROM themes WHERE name = ?").get(result!.theme.new_theme_name) as { id: number }).id;
      }
      db.prepare(
        `UPDATE requests SET need = ?, route = ?, theme_id = ?, triage_json = ?, triage_error = NULL,
         duplicate_dismissed = 0,
         status = CASE WHEN status = 'new' THEN 'triaged' ELSE status END, triaged_at = datetime('now') WHERE id = ?`
      ).run(result!.need, result!.route, themeId, JSON.stringify(result), id);
      db.prepare("DELETE FROM scores WHERE request_id = ?").run(id);
      const ins = db.prepare("INSERT INTO scores (request_id, criterion, score, rationale) VALUES (?, ?, ?, ?)");
      for (const s of result!.scores) ins.run(id, s.criterion, s.score, s.rationale);
    })();
    return result;
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) throw e;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    db.prepare("UPDATE requests SET triage_error = ? WHERE id = ?").run(message, id);
    throw new HttpError(502, message);
  }
}

let tail: Promise<void> = Promise.resolve();

/** Serialise triage so concurrent submissions can see earlier requests as duplicate candidates. */
export function enqueueTriage(id: number): Promise<TriageResult> {
  const job = tail.then(() => triageRequest(id));
  tail = job.then(() => undefined, () => undefined);
  return job;
}
