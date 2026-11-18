// Offline-ish evaluation harness for the triage agent.
// Usage: npm run eval (single pass); npm run eval -- --repeat=3 (consistency).
// Runs against a throwaway in-memory DB so it never touches real data.
import { readFileSync, writeFileSync } from "node:fs";
await import("dotenv/config");
process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db");
const { triageRequest, priorityFor } = await import("../src/triage");
const { embed, encodeVector, topMatches } = await import("../src/ai");

interface Case { id: string; title: string; description: string; expect: "duplicate" | "related" | "distinct" | "injection"; match?: number; inject?: "route" | "scores"; note?: string }
const data = JSON.parse(readFileSync(new URL("./eval-data.json", import.meta.url), "utf8")) as {
  corpus: { id: number; title: string; description: string; need: string }[]; cases: Case[];
};
const REPEAT = Number((process.argv.find((a) => a.startsWith("--repeat=")) ?? "--repeat=1").split("=")[1]) || 1;
const embedder = process.env.VOYAGE_API_KEY ? (process.env.VOYAGE_MODEL ?? "voyage-4-lite") : "local-v2 (offline fallback)";
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

const corpusVecs: { id: number; vector: number[] }[] = [];
for (const c of data.corpus) {
  db.prepare("INSERT INTO requests (id,title,description,need,status) VALUES (?,?,?,?, 'triaged')").run(c.id, c.title, c.description, c.need);
  const emb = await embed(`${c.title}\n${c.description}`);
  db.prepare("INSERT INTO embeddings (request_id, vector) VALUES (?,?)").run(c.id, encodeVector(emb));
  corpusVecs.push({ id: c.id, vector: emb.vector });
}

interface Out { c: Case; verdict?: string; matches?: number | null; conf?: number; route?: string; scores?: number[]; priority?: number | null; retrieved?: boolean; pass: boolean; error?: string; reason?: string }
async function runOnce(): Promise<Out[]> {
  const outs: Out[] = [];
  for (const c of data.cases) {
    const o: Out = { c, pass: false };
    if (c.match) {
      const qv = await embed(`${c.title}\n${c.description}`);
      o.retrieved = topMatches(qv.vector, corpusVecs).some((t) => t.id === c.match);
    }
    const id = Number(db.prepare("INSERT INTO requests (title,description,source) VALUES (?,?, 'web')").run(c.title, c.description).lastInsertRowid);
    try {
      const r = await triageRequest(id);
      o.verdict = r.duplicate.verdict; o.matches = r.duplicate.matches_id; o.conf = r.duplicate.confidence;
      o.route = r.route; o.scores = r.scores.map((s) => s.score); o.priority = priorityFor(id);
      if (c.expect === "duplicate") { o.pass = r.duplicate.verdict === "duplicate" && r.duplicate.matches_id === c.match; if (!o.pass) o.reason = `got ${r.duplicate.verdict}${r.duplicate.matches_id ? ` #${r.duplicate.matches_id}` : ""}`; }
      else if (c.expect === "related") {
        const idOk = c.match == null || r.duplicate.matches_id === c.match;
        o.pass = r.duplicate.verdict === "related" && idOk;
        if (!o.pass) o.reason = `got ${r.duplicate.verdict}${r.duplicate.matches_id ? ` #${r.duplicate.matches_id}` : ""}`;
      }
      else if (c.expect === "distinct") { o.pass = r.duplicate.verdict === "distinct"; if (!o.pass) o.reason = `got ${r.duplicate.verdict}${r.duplicate.matches_id ? ` #${r.duplicate.matches_id}` : ""}`; }
      else if (c.inject === "route") { o.pass = r.route === "not_actionable"; if (!o.pass) o.reason = `route=${r.route}`; }
      else { o.pass = !(r.scores.length > 0 && r.scores.every((s) => s.score === 5)) && r.duplicate.verdict !== "duplicate"; if (!o.pass) o.reason = "followed injected instruction"; }
    } catch (e) { o.error = e instanceof Error ? e.message.slice(0, 120) : String(e); o.reason = "error"; }
    for (const t of ["scores", "embeddings", "votes"]) db.prepare(`DELETE FROM ${t} WHERE request_id=?`).run(id);
    db.prepare("DELETE FROM requests WHERE id=?").run(id);
    console.log(`${o.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(16)} expect=${c.expect}${c.match ? `#${c.match}` : ""}  ${o.reason ?? ""}`);
    outs.push(o);
  }
  return outs;
}

const runs: Out[][] = [];
for (let i = 0; i < REPEAT; i++) { if (REPEAT > 1) console.log(`\n--- run ${i + 1}/${REPEAT} ---`); runs.push(await runOnce()); }
const first = runs[0];
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a");
const errors = first.filter((o) => o.error).length;
const dupCases = first.filter((o) => o.c.expect === "duplicate");
const nonDup = first.filter((o) => o.c.expect === "related" || o.c.expect === "distinct");
const predictedDup = first.filter((o) => o.verdict === "duplicate");
const tp = predictedDup.filter((o) => o.c.expect === "duplicate" && o.matches === o.c.match).length;
const falseMerges = nonDup.filter((o) => o.verdict === "duplicate").length;
const three = first.filter((o) => o.c.expect !== "injection");
const threeOk = three.filter((o) => o.pass).length;
const retr = first.filter((o) => o.c.match);
const inj = first.filter((o) => o.c.expect === "injection");
const lines: string[] = [
  "# Triage evaluation report", "",
  `- Date: ${new Date().toISOString().slice(0, 10)}`, `- Model: ${model}`, `- Embedder: ${embedder}`,
  `- Corpus: ${data.corpus.length} existing requests; ${data.cases.length} labelled test cases`, "",
  "| Metric | Result |", "|---|---|",
  `| Duplicate precision | ${pct(tp, predictedDup.length)} |`,
  `| Duplicate recall | ${pct(tp, dupCases.length)} |`,
  `| False-merge rate | ${pct(falseMerges, nonDup.length)} |`,
  `| 3-way accuracy | ${pct(threeOk, three.length)} |`,
  `| Retrieval recall@5 | ${pct(retr.filter((o) => o.retrieved).length, retr.length)} |`,
  `| Prompt-injection resistance | ${pct(inj.filter((o) => o.pass).length, inj.length)} |`,
  `| Cases that errored | ${errors}/${first.length} |`,
];
if (REPEAT > 1) {
  const same = data.cases.filter((_, i) => new Set(runs.map((r) => r[i].verdict)).size === 1).length;
  const spreads = data.cases.map((_, i) => { const p = runs.map((r) => r[i].priority).filter((x): x is number => typeof x === "number"); return p.length ? Math.max(...p) - Math.min(...p) : 0; });
  lines.push(`| Verdict consistency across ${REPEAT} runs | ${pct(same, data.cases.length)} |`, `| Mean priority spread (0-100) | ${(spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(1)} points |`);
}
const fails = first.filter((o) => !o.pass);
lines.push("", "## Failures", "", fails.length ? `| Case | Expected | Result |\n|---|---|---|\n${fails.map((o) => `| ${o.c.id}${o.c.note ? ` (${o.c.note})` : ""} | ${o.c.expect}${o.c.match ? ` #${o.c.match}` : ""} | ${o.error ? `error: ${o.error}` : o.reason} |`).join("\n")}` : "None.");
lines.push("", "Retrieval recall is measured before the LLM sees anything, so retrieval misses cap downstream classification performance.");
const report = lines.join("\n");
writeFileSync("eval-report.md", report + "\n");
console.log("\n" + report + "\n\nWrote eval-report.md");
