import type { CodeSearchQuery, CodeSnippetQuery, CodeTraceQuery } from "./ports.js";

export type CodeOperation = "search" | "snippet" | "trace";
export type CodeQuery = CodeSearchQuery | CodeSnippetQuery | CodeTraceQuery;
export function codeQuery(operation: CodeOperation, value: unknown): CodeQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  const query = value as Record<string, unknown>;
  const allowed = operation === "search" ? ["repositoryRef", "snapshotRef", "term", "kind"]
    : ["repositoryRef", "snapshotRef", "symbol", "file", ...(operation === "trace" ? ["direction", "targetRepositoryRef"] : [])];
  if (Object.keys(query).some((key) => !allowed.includes(key)) ||
    typeof query.repositoryRef !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(query.repositoryRef) ||
    typeof query.snapshotRef !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(query.snapshotRef)) throw new Error("invalid_request");
  if (operation === "search") {
    if (query.term !== undefined && (typeof query.term !== "string" || !/^[a-zA-Z0-9_ ]{1,128}$/.test(query.term))) throw new Error("invalid_request");
    if (query.kind !== undefined && query.kind !== "source" && query.kind !== "symbol") throw new Error("invalid_request");
  } else {
    if (typeof query.symbol !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.]{0,255}$/.test(query.symbol) ||
      typeof query.file !== "string" || !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(query.file) ||
      query.file.startsWith("/") || query.file.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error("invalid_request");
    if (operation === "trace" && ((query.direction !== "inbound" && query.direction !== "outbound") ||
      (query.targetRepositoryRef !== undefined && (typeof query.targetRepositoryRef !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(query.targetRepositoryRef))))) throw new Error("invalid_request");
  }
  return structuredClone(query) as unknown as CodeQuery;
}
