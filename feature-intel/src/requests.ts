import { db } from "./db";
import { HttpError } from "./http";

interface RequestRef { id: number; status: string; canonical_id: number | null }

function requestRef(id: number): RequestRef | undefined {
  return db.prepare("SELECT id, status, canonical_id FROM requests WHERE id = ?").get(id) as RequestRef | undefined;
}

/** Follow confirmed merges to the live request. Rejects loops. */
export function canonicalId(id: number): number {
  const seen = new Set<number>();
  let current = id;
  while (true) {
    if (seen.has(current)) throw new HttpError(400, "merge history contains a cycle");
    seen.add(current);
    const row = requestRef(current);
    if (!row) throw new HttpError(404, "not found");
    if (row.status !== "merged" || row.canonical_id == null) return row.id;
    current = row.canonical_id;
  }
}

export function supportRequest(id: number, voter: string): { request_id: number; votes: number } {
  const target = canonicalId(id);
  const who = voter.trim().slice(0, 100) || "anonymous";
  db.prepare("INSERT OR IGNORE INTO votes (request_id, voter) VALUES (?, ?)").run(target, who);
  const votes = Number((db.prepare("SELECT COUNT(*) AS n FROM votes WHERE request_id = ?").get(target) as { n: number }).n);
  return { request_id: target, votes };
}

/** Human confirms an AI duplicate suggestion. Votes roll up to the live canonical request. */
export function mergeRequests(sourceId: number, intoId: number): { merged: number; into: number } {
  if (!Number.isInteger(sourceId) || !Number.isInteger(intoId)) throw new HttpError(400, "invalid id");
  const source = requestRef(sourceId);
  if (!source) throw new HttpError(404, "not found");
  if (source.status === "merged") throw new HttpError(400, "request is already merged");
  const target = canonicalId(intoId);
  if (target === sourceId) throw new HttpError(400, "cannot merge a request into itself");
  db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO votes (request_id, voter, created_at) SELECT ?, voter, created_at FROM votes WHERE request_id = ?"
    ).run(target, sourceId);
    db.prepare("UPDATE requests SET status = 'merged', canonical_id = ? WHERE id = ?").run(target, sourceId);
  })();
  return { merged: sourceId, into: target };
}

export function setStatus(id: number, status: "triaged" | "planned" | "shipped" | "declined") {
  const row = requestRef(id);
  if (!row) throw new HttpError(404, "not found");
  if (row.status === "merged") throw new HttpError(400, "change status on the canonical request");
  db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(status, id);
  return { id, status };
}

export function dismissDuplicate(id: number) {
  const info = db.prepare("UPDATE requests SET duplicate_dismissed = 1 WHERE id = ?").run(id);
  if (!info.changes) throw new HttpError(404, "not found");
  return { id, duplicate_dismissed: true };
}

export function setCriterionWeight(key: string, weight: number) {
  const info = db.prepare("UPDATE criteria SET weight = ? WHERE key = ?").run(weight, key);
  if (!info.changes) throw new HttpError(404, "unknown criterion");
  return { key, weight };
}
