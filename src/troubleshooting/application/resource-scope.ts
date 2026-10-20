// A trusted bootstrap value. Never populated from a user, tool or model message.
export function caseResources(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || !value.includes("simulator-source") ||
    value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(item)) || new Set(value).size !== value.length) throw new Error("invalid_request");
  return Object.freeze([...value] as string[]);
}
