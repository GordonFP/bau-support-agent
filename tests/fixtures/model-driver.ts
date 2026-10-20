import type { MockOptions } from "../../src/adapters/mock/troubleshooting.js";
import type { ModelMessage, ModelResponse, ModelTool } from "../../src/troubleshooting/application/model-contract.js";

// Synthetic runtime driver only. Actual Pi AgentSession belongs to #23.
export const modelDrivenSimulator: NonNullable<MockOptions["agent"]> = async (_context, request) => {
  const tools: ModelTool[] = ["logs_read", "code_search"].map((name) => ({ name: name as "logs_read" | "code_search",
    description: `Approved synthetic ${name}.`, parameters: { type: "object", properties: {}, additionalProperties: false } }));
  const messages: ModelMessage[] = [{ role: "system", content: "Synthetic tool selection and deterministic report only.", toolsAdded: tools }, { role: "user", content: request.question }];
  for (let turn = 0; turn < 6; turn++) {
    messages.push({ role: "user", content: JSON.stringify({ draft: request.diagnose() }) });
    const response = await request.generate({ schemaVersion: 1, messages: structuredClone(messages) }) as ModelResponse;
    messages.push({ role: "assistant", content: response.message.content });
    if (response.message.stopReason === "stop") return response.candidate;
    for (const part of response.message.content) if (part.type === "toolCall") {
      const result = await request.invoke(part.name === "logs_read" ? "logs.read" : "code.search", null);
      messages.push({ role: "toolResult", toolCallId: part.id, toolName: part.name, content: JSON.stringify(result), isError: false });
    }
  }
  throw new Error("budget_exhausted");
};
