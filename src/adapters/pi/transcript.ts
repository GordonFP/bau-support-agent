import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelContent, ModelMessage, ModelTurn } from "../../troubleshooting/application/model-contract.js";
import type { DiagnosticReport } from "../../troubleshooting/domain/simulator.js";
import { validateModelTurn } from "../../troubleshooting/application/model-envelope.js";

const text = (value: string | readonly { type: string; text?: string }[]): string => {
  if (typeof value === "string") return value;
  if (value.some((part) => part.type !== "text" || typeof part.text !== "string")) throw new Error("schema_mismatch");
  return value.map((part) => part.text).join("\n");
};
export function modelTurn(context: TranscriptContext, draft: DiagnosticReport): ModelTurn {
  const messages: ModelMessage[] = context.messages.map((item): ModelMessage => {
    if (item.role === "system") return { role: "system", content: text(item.content),
      ...(item.sections ? { sections: structuredClone(item.sections) } : {}),
      ...(item.toolsAdded ? { toolsAdded: item.toolsAdded.map((tool) => ({ name: tool.name as "logs_read" | "code_search", description: tool.description,
        parameters: structuredClone(tool.parameters) as { type: "object"; properties: Record<string, never>; additionalProperties: false } })) } : {}),
      ...(item.toolsRemoved ? { toolsRemoved: item.toolsRemoved.map((tool) => tool.name) } : {}) };
    if (item.role === "user") return { role: "user", content: text(item.content) };
    if (item.role === "toolResult") return { role: "toolResult", toolCallId: item.toolCallId, toolName: item.toolName as "logs_read" | "code_search",
      content: item.details === undefined ? text(item.content) : JSON.stringify({ content: text(item.content), details: item.details }), isError: item.isError };
    return { role: "assistant", content: item.content.map((part): ModelContent => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "toolCall") return { type: "toolCall", id: part.id, name: part.name as "logs_read" | "code_search", arguments: structuredClone(part.arguments) };
      throw new Error("schema_mismatch");
    }) };
  });
  messages.push({ role: "user", content: JSON.stringify({ draft }) });
  const turn = { schemaVersion: 1 as const, messages };
  validateModelTurn(turn);
  return turn;
}
