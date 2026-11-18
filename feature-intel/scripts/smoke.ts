// Offline checks: retrieval recall, priority math, and merge rules. No API key required.
await import("dotenv/config");
process.env.DB_PATH = ":memory:";
process.env.VOYAGE_API_KEY = "";

import { readFileSync } from "node:fs";
const { embed, encodeVector, decodeVector, cosine, topMatches } = await import("../src/ai");
const { db } = await import("../src/db");
const { priorityFor } = await import("../src/triage");
const { dismissDuplicate, mergeRequests, setCriterionWeight, setStatus, supportRequest } = await import("../src/requests");
const { HttpError } = await import("../src/http");
const { xmlEscape } = await import("../src/prompts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const data = JSON.parse(readFileSync(new URL("./eval-data.json", import.meta.url), "utf8")) as {
  corpus: { id: number; title: string; description: string }[];
  cases: { id: string; title: string; description: string; match?: number }[];
};

const corpus = [];
for (const item of data.corpus) {
  const emb = await embed(`${item.title}\n${item.description}`);
  corpus.push({ id: item.id, vector: emb.vector });
}
let missed = 0;
for (const item of data.cases) {
  if (!item.match) continue;
  const query = await embed(`${item.title}\n${item.description}`);
  const top = topMatches(query.vector, corpus);
  const ok = top.some((hit) => hit.id === item.match);
  console.log(`${ok ? "HIT " : "MISS"} ${item.id.padEnd(16)} #${item.match}  ${top.map((hit) => `${hit.id}:${hit.similarity.toFixed(2)}`).join(" ")}`);
  if (!ok) missed++;
}
assert(missed === 0, `${missed} labelled matches were missing from retrieval top 5`);

const roundTrip = await embed("dark mode at night");
const decoded = decodeVector(encodeVector(roundTrip));
assert(decoded?.model === roundTrip.model && decoded.vector.length === roundTrip.vector.length, "vector codec");
assert(cosine(decoded.vector, roundTrip.vector) > 0.999, "vector round trip");
assert(cosine([1, 0], [1, 0, 0]) === 0, "mismatched vector lengths score 0");
assert(decodeVector("[1,2,3]")?.model === "legacy", "legacy vectors still decode");
assert(xmlEscape(`<b a="x">`) === "&lt;b a=&quot;x&quot;&gt;", "xml escape");

function insert(title: string) {
  return Number(db.prepare("INSERT INTO requests (title, description) VALUES (?, ?)").run(title, "A description of the request.").lastInsertRowid);
}
const a = insert("Alpha");
const b = insert("Beta");
const c = insert("Gamma");
const score = db.prepare("INSERT INTO scores (request_id, criterion, score, rationale) VALUES (?, ?, ?, ?)");
score.run(a, "reach", 5, "broad");
score.run(a, "effort", 5, "large");
assert(priorityFor(a) === 73, `expected priority 73, got ${priorityFor(a)}`);
db.prepare("UPDATE criteria SET weight = 0").run();
assert(priorityFor(a) === null, "all-zero weights should not produce NaN");
db.prepare("UPDATE criteria SET weight = 0.3 WHERE key = 'reach'").run();
db.prepare("UPDATE criteria SET weight = 0.3 WHERE key = 'strategic_fit'").run();
db.prepare("UPDATE criteria SET weight = 0.25 WHERE key = 'revenue_risk'").run();
db.prepare("UPDATE criteria SET weight = 0.15 WHERE key = 'effort'").run();

const vote = db.prepare("INSERT INTO votes (request_id, voter) VALUES (?, ?)");
vote.run(a, "alice");
vote.run(a, "bob");
vote.run(b, "bob");
vote.run(b, "cara");
assert(mergeRequests(a, b).into === b, "merge target");
assert(Number((db.prepare("SELECT COUNT(*) AS n FROM votes WHERE request_id = ?").get(b) as { n: number }).n) === 3, "votes roll up without double counting");

assert((() => { try { mergeRequests(b, a); return false; } catch (e) { return e instanceof HttpError && e.status === 400; } })(), "merging into your own merged child is rejected");
assert(mergeRequests(c, a).into === b, "merging into an already-merged request follows the canonical id");
assert(supportRequest(a, "dave").request_id === b && supportRequest(b, "dave").votes === 4, "support on a merged request counts once on the canonical");

assert((() => { try { setStatus(a, "planned"); return false; } catch (e) { return e instanceof HttpError && e.status === 400; } })(), "status change on a merged request is rejected");
assert(setStatus(b, "planned").status === "planned", "status change");
assert((() => { try { mergeRequests(99, b); return false; } catch (e) { return e instanceof HttpError && e.status === 404; } })(), "missing merge source");
assert((() => { try { setCriterionWeight("nope", 0.2); return false; } catch (e) { return e instanceof HttpError && e.status === 404; } })(), "unknown criterion");
assert(dismissDuplicate(b).duplicate_dismissed === true, "dismiss");
assert((() => { try { dismissDuplicate(4040); return false; } catch (e) { return e instanceof HttpError && e.status === 404; } })(), "dismiss missing");

console.log("\nSmoke checks passed.");
