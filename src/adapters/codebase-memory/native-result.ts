import { McpFailure } from "../mcp/failure.js";
import { canonical } from "../mcp/manifest.js";
import type { RepositoryReceipt } from "./collection.js";

type ObjectValue = Record<string, unknown>;
const fail = (): never => { throw new McpFailure("schema_mismatch"); };
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as ObjectValue;
}
export function nativePayload(value: unknown): ObjectValue {
  const result = object(value);
  if (Object.keys(result).some((key) => !["content", "structuredContent", "isError"].includes(key))) throw new McpFailure("unsafe_content");
  if (result.isError) throw new McpFailure("unavailable");
  if (!Array.isArray(result.content) || result.content.length !== 1) throw new McpFailure("unsafe_content");
  const text = object(result.content[0]);
  if (Object.keys(text).some((key) => !["type", "text"].includes(key)) || text.type !== "text" || typeof text.text !== "string") throw new McpFailure("unsafe_content");
  let decoded: unknown;
  try { decoded = JSON.parse(text.text); } catch { return fail(); }
  if (result.structuredContent !== undefined && canonical(decoded) !== canonical(result.structuredContent)) throw new McpFailure("unsafe_content");
  return object(decoded);
}
function table(value: unknown, expected: readonly string[]): ObjectValue[] {
  const data = object(value);
  if (!Array.isArray(data.cols) || canonical(data.cols) !== canonical(expected) || !Array.isArray(data.rows) || data.rows.length > 20) return fail();
  return data.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== expected.length) return fail();
    return Object.fromEntries(expected.map((key, index) => [key, row[index]]));
  });
}
const number = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const text = (value: unknown): string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 16_000 ? value : fail();
function symbol(value: unknown, repository: RepositoryReceipt): string {
  const name = text(value);
  if (!name.startsWith(`${repository.project}.`) || !/^[a-zA-Z_][a-zA-Z0-9_.]{0,255}$/.test(name)) throw new McpFailure("denied");
  return name;
}
function file(value: unknown, repository: RepositoryReceipt): string {
  const name = text(value);
  if (!repository.files.includes(name)) throw new McpFailure("denied");
  return name;
}
function lines(value: unknown): [number, number] {
  if (typeof value !== "string" || !/^[1-9]\d{0,6}-[1-9]\d{0,6}$/.test(value)) return fail();
  const [start, end] = value.split("-").map(Number) as [number, number];
  if (end < start) return fail();
  return [start, end];
}
export interface NativeEvidence {
  readonly repository: RepositoryReceipt;
  readonly locator: string;
  readonly text: string;
}
export interface NativeRead { readonly evidence: NativeEvidence[]; readonly partial: boolean; readonly unknown?: boolean }
export function searchResult(value: unknown, repository: RepositoryReceipt, kind: "source" | "symbol"): NativeRead {
  const data = nativePayload(value);
  const cols = kind === "symbol" ? ["qn", "label", "file", "lines", "rank"]
    : ["qn", "label", "file", "lines", "matches", "matches_omitted", "in", "out", "source"];
  const rows = table(data, cols);
  let partial = data.truncated === true || data.has_more === true || data.total_relation !== "eq";
  if (typeof data.truncated !== "boolean" || typeof data.has_more !== "boolean") return fail();
  if (kind === "source") {
    // Raw non-symbol matches are deliberately not silently discarded/promoted to a complete graph result.
    const raw = object(data.raw_matches);
    if (!Array.isArray(raw.rows)) return fail();
    partial ||= raw.rows.length > 0 || data.raw_has_more !== false || data.directories_has_more !== false || number(data.total_results) !== rows.length;
  } else partial ||= number(data.total) !== rows.length || number(data.returned) !== rows.length;
  const evidence = rows.map((row) => {
    const qn = symbol(row.qn, repository);
    const path = file(row.file, repository);
    const [start, end] = lines(row.lines);
    let source = `Static indexed symbol ${qn}; ${path}:${start}-${end}.`;
    if (kind === "source") {
      const body = object(row.source);
      source += `\n${text(body.source)}`;
      partial ||= number(row.matches_omitted) > 0 || body.truncated === true || body.has_more === true || end - start + 1 > 20;
    }
    return { repository, locator: `${path}:${start}-${end}`, text: source };
  });
  return { evidence, partial };
}
export function snippetResult(value: unknown, repository: RepositoryReceipt, symbolName: string, fileName: string): NativeRead {
  const data = nativePayload(value);
  const qn = symbol(data.qualified_name, repository);
  if (qn !== `${repository.project}.${symbolName}` || data.file_path !== `/repos/${repository.repositoryRef}/${fileName}` ||
    data.source_mode !== "full" || !repository.files.includes(fileName)) throw new McpFailure("version_mismatch");
  const start = number(data.start_line), end = number(data.end_line);
  if (!start || end < start) return fail();
  const source = text(data.source);
  return { evidence: [{ repository, locator: `${fileName}:${start}-${end}`, text: `Static indexed snippet ${qn}.\n${source}` }],
    partial: end - start + 1 > 20 || data.truncated === true || data.has_more === true };
}
export function traceResult(value: unknown, repository: RepositoryReceipt, symbolName: string, direction: "inbound" | "outbound",
  repositories: readonly RepositoryReceipt[], crossService = false): NativeRead {
  const data = nativePayload(value);
  if (data.function !== `${repository.project}.${symbolName}` || data.direction !== direction ||
    (crossService && data.mode !== "cross_service")) return fail();
  const key = direction === "outbound" ? "callees" : "callers";
  const group = object(data[key]);
  if (!Array.isArray(group.groups) || group.groups.length > 20 || canonical(group.cols) !== canonical(["name", "hop", "strategy", "confidence"])) return fail();
  const evidence: NativeEvidence[] = [];
  let unknown = false;
  for (const entry of group.groups) {
    const item = object(entry);
    if (typeof item.qn_prefix !== "string") return fail();
    const rows = table({ cols: group.cols, rows: item.rows }, ["name", "hop", "strategy", "confidence"]);
    for (const row of rows) {
      const qn = `${item.qn_prefix ? `${item.qn_prefix}.` : ""}${text(row.name)}`;
      if (crossService && /^__route__(?:ANY|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)__\/[a-zA-Z0-9_/{}/:-]{1,256}$/.test(qn)) {
        if (number(row.hop) > 2 || row.strategy !== null || row.confidence !== null) return fail();
        unknown = true;
        evidence.push({ repository, locator: `symbol:${qn}`, text: `Static route ${qn}; the native response omits its cross-service destination. No destination or execution is proven.` });
        continue;
      }
      const target = repositories.find((candidate) => qn.startsWith(`${candidate.project}.`));
      if (!target) throw new McpFailure("denied");
      symbol(qn, target);
      if (number(row.hop) > 2 || !["lsp", "ast", "heuristic", "name", "semantic"].includes(String(row.strategy)) ||
        typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1) return fail();
      evidence.push({ repository: target, locator: `symbol:${qn}`, text: `Static possible call relation: ${repository.project}.${symbolName} ${direction} ${qn}; hop ${row.hop}. This does not prove execution.` });
    }
  }
  if (evidence.length > 20) return fail();
  return { evidence, unknown, partial: unknown || data[`${key}_total_relation`] !== "eq" || number(data[`${key}_total`]) !== evidence.length ||
    data.truncated === true || typeof data.next_cursor === "string" || typeof data.next === "string" };
}
