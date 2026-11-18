import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-lite";

export type Effort = "low" | "medium" | "high";
export interface Embedding { model: string; vector: number[] }

export const RETRIEVAL_K = 5;
export const RETRIEVAL_MIN = 0.2;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env and restart.");
  }
  return (client ??= new Anthropic());
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
}

function textFrom(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === "text" && block.text ? block.text : "")).join("");
}

/**
 * Claude Sonnet 5.5 rejects temperature / top_p / top_k and thinks unless told otherwise.
 * max_tokens has to cover that thinking plus the answer. Structured output keeps the JSON valid.
 */
export async function jsonCall<T>(system: string, user: string, schema: z.ZodType<T>, effort: Effort = "high"): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYour previous output failed validation: ${lastErr}\nReturn corrected JSON only.`;
    try {
      const res = await getClient().messages.parse({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort, format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") throw new Error("The model refused this request.");
      if (res.stop_reason === "max_tokens") throw new Error("The model stopped because it hit the output limit.");
      if (res.parsed_output != null) return res.parsed_output;
      return schema.parse(extractJson(textFrom(res.content)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof z.ZodError || e instanceof SyntaxError || /Failed to parse structured output|Unexpected token|not valid JSON/i.test(message);
      if (!retryable) throw e instanceof Error ? e : new Error(message);
      lastErr = message.slice(0, 500);
    }
  }
  throw new Error(`LLM output failed validation: ${lastErr}`);
}

export async function markdownCall(system: string, user: string, effort: Effort = "medium"): Promise<string> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("The model refused this request.");
  if (res.stop_reason === "max_tokens") throw new Error("The model stopped because it hit the output limit.");
  const text = textFrom(res.content).trim();
  if (!text) throw new Error("The model returned an empty brief.");
  return text;
}

// Voyage when configured; otherwise a deterministic local index for offline retrieval.
const DIM = 384;
const STOP = new Set(
  "a an the and or for with that this our you your can are was were has have from into when what they them their just like want would could should about over than then also only all but who how its not too way out before after we my me please thanks need needs needed per via onto within without very really been being will dont don't it's".split(/\s+/),
);
const CONCEPTS: [string, string[]][] = [
  ["auth", ["login", "signin", "signon", "sso", "saml", "okta", "oauth", "oidc", "auth", "authentication", "identity", "password", "sign"]],
  ["tabular", ["csv", "excel", "spreadsheet", "xlsx", "xls"]],
  ["nightmode", ["dark", "darkmode", "night", "nightmode", "eyestrain", "brightness"]],
  ["notify", ["slack", "notify", "notification", "alert", "ping"]],
  ["mobile", ["offline", "ios", "android", "phone", "cellphone", "connectivity", "signal"]],
  ["twofactor", ["2fa", "mfa", "totp", "twofactor"]],
  ["audit", ["audit", "soc2", "compliance"]],
  ["api", ["webhook", "webhooks", "rest", "api"]],
  ["recur", ["recurring", "recur", "repeat"]],
  ["timeline", ["gantt", "timeline", "dependency"]],
  ["bulk", ["bulk", "multiselect", "reassign"]],
  ["digest", ["digest", "rundown", "summary", "summariz"]],
];

function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/\bsign[\s-]?in\b/g, " signin ")
    .replace(/\blog[\s-]?in\b/g, " login ")
    .replace(/\bsign[\s-]?on\b/g, " signon ")
    .replace(/\btwo[\s-]?factor\b/g, " twofactor ")
    .replace(/\bdark[\s-]?mode\b/g, " darkmode ")
    .replace(/\bnight[\s-]?mode\b/g, " nightmode ")
    .replace(/\bmulti[\s-]?select\b/g, " multiselect ")
    .replace(/\b([a-z]{3,})is(ing|ed)\b/g, "$1iz$2");
}

function stem(token: string): string {
  let t = token;
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && t.endsWith("es") && !t.endsWith("ss")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

function features(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (feature: string, weight: number) => weights.set(feature, (weights.get(feature) ?? 0) + weight);
  const content: string[] = [];
  for (const raw of normalizeText(text).match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    const token = stem(raw);
    if (token.length < 2 || STOP.has(token)) continue;
    content.push(token);
    add(token, 1);
  }
  for (let i = 0; i < content.length - 1; i++) add(`${content[i]}_${content[i + 1]}`, 0.8);
  const hit = new Set<string>();
  for (const token of content) {
    for (const [name, members] of CONCEPTS) if (members.includes(token)) hit.add(name);
  }
  for (const name of hit) add(`~${name}`, 3);
  return weights;
}

function hashFeature(feature: string): number {
  let h = 2166136261;
  for (let i = 0; i < feature.length; i++) h = Math.imul(h ^ feature.charCodeAt(i), 16777619);
  return Math.abs(h) % DIM;
}

function localEmbed(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  for (const [feature, weight] of features(text)) vector[hashFeature(feature)] += weight;
  return normalize(vector);
}
const normalize = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

export async function embed(text: string): Promise<Embedding> {
  const key = process.env.VOYAGE_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: VOYAGE_MODEL, input: [text.slice(0, 32000)], input_type: "document" }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { embedding?: number[] }[] };
        const vector = data.data?.[0]?.embedding;
        if (vector?.length) return { model: VOYAGE_MODEL, vector: normalize(vector) };
      }
    } catch (e) {
      console.error("Voyage embeddings failed, using the local index:", e instanceof Error ? e.message : e);
    }
  }
  return { model: "local-v2", vector: localEmbed(text) };
}

export function encodeVector(emb: Embedding): string {
  return JSON.stringify({ model: emb.model, vector: emb.vector });
}

export function decodeVector(raw: string): Embedding | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) return { model: "legacy", vector: parsed };
    if (!parsed || typeof parsed !== "object" || !("vector" in parsed)) return null;
    const vector = (parsed as { vector: unknown }).vector;
    const model = (parsed as { model?: unknown }).model;
    if (!Array.isArray(vector) || !vector.every((n) => typeof n === "number")) return null;
    return { model: typeof model === "string" ? model : "legacy", vector };
  } catch {
    return null;
  }
}

export const cosine = (a: number[], b: number[]) => {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function topMatches<T extends { vector: number[] }>(
  query: number[],
  items: T[],
  k = RETRIEVAL_K,
  min = RETRIEVAL_MIN,
): (T & { similarity: number })[] {
  return items
    .map((item) => ({ ...item, similarity: cosine(query, item.vector) }))
    .filter((item) => item.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}
