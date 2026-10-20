import { pspRuleSchema } from "../mcp/psp-schema.js";
import type { PspRule } from "../../troubleshooting/domain/psp.js";

// Only the explicit owned synthetic fixture annotation is understood. Missing or
// conflicting annotations stay unknown; this does not interpret arbitrary code.
export function pspRule(source: string): PspRule | undefined {
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("// @bau-psp-rule "));
  if (lines.length !== 1) return undefined;
  try {
    const parsed = pspRuleSchema.safeParse(JSON.parse(lines[0]!.slice("// @bau-psp-rule ".length)));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
