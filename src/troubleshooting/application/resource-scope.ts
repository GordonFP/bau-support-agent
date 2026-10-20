// A trusted bootstrap value. Never populated from a user, tool or model message.
export function caseResources(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || !value.some((item) => item === "simulator-source" || item === "psp-log-source") ||
    value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(item)) || new Set(value).size !== value.length) throw new Error("invalid_request");
  if (caseRepositories(value).length < 1 || caseRepositories(value).length > 3) throw new Error("invalid_request");
  return Object.freeze([...value] as string[]);
}

// The legacy Simulator alias identifies both its log source and linked repository.
// PSP has a separate, fixed log-only alias; every remaining trusted resource is a repository.
export function caseRepositories(resources: readonly string[]): readonly string[] {
  return Object.freeze(resources.filter((resource) => resource !== "psp-log-source"));
}
