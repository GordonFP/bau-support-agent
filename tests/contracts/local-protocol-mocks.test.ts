import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { localProtocolMock } from "../fixtures/local-protocol-mock.js";

test("Kibana synthetic HTTP applies inclusive lower and exclusive upper time bounds before totals and pagination", async () => {
  const mock = await localProtocolMock("kibana");
  try {
    for (const [psp, from, to, expected] of [
      [false, "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z", []],
      [false, "2026-10-18T23:00:00.000Z", "2026-10-19T00:00:00.000Z", ["e0001"]],
      [false, "2026-10-18T22:00:00.000Z", "2026-10-18T23:00:00.000Z", []],
      [true, "2026-10-18T12:00:00.000Z", "2026-10-18T12:00:02.000Z", ["first-match", "combination-support"]],
    ] as const) {
      for (const offset of [0, 100]) {
        const result = await fetch(mock.baseUrl + "/internal/search/es", { method: "POST", headers: { "content-type": "application/json", authorization: "ApiKey owned-synthetic-key", "kbn-xsrf": "1" }, body: JSON.stringify({ params: { index: psp ? "synthetic-psp" : "synthetic-simulator", body: {
          query: { bool: { filter: [{ term: { application_id: "SYNTHETIC-SECRET-APPLICATION" } }, ...(psp ? [{ term: { shop_id: "SYNTHETIC-SECRET-SHOP" } }, { term: { binding_id: "SYNTHETIC-SECRET-BINDING" } }] : []), { range: { event_time: { gte: from, lt: to } } }] } },
          size: 100, from: offset, sort: [{ event_time: "asc" }, { event_id: "asc" }],
        } } }) });
        assert.equal(result.status, 200);
        const { rawResponse } = await result.json() as { rawResponse: { hits: { total: { value: number }; hits: { _id: string }[] } } };
        assert.equal(rawResponse.hits.total.value, expected.length);
        assert.deepEqual(rawResponse.hits.hits.map((item) => item._id), offset ? [] : expected);
      }
    }
  } finally { await mock.close(); }
});

test("Responses synthetic HTTP preserves Chinese split inside a multibyte UTF-8 character", async () => {
  const mock = await localProtocolMock("responses");
  const text = "合成诊断中文";
  const body = Buffer.from(JSON.stringify({ model: "gpt6.1-sol", max_output_tokens: 4_000, stream: true, store: false,
    tools: ["logs_read", "code_search"].map((name) => ({ type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: false } })),
    input: [...["logs_read", "code_search"].map((name) => ({ type: "function_call", name })), { content: [{ text: JSON.stringify({ draft: { text } }) }] }],
  }));
  const split = body.indexOf(Buffer.from("中")) + 1;
  try {
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = request(mock.baseUrl + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", "content-length": body.length } }, (response) => {
        const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.once("error", reject); outgoing.write(body.subarray(0, split)); setTimeout(() => outgoing.end(body.subarray(split)), 30);
    });
    assert.equal(result.status, 200); assert.ok(result.text.includes(text)); assert.equal(result.text.includes("�"), false);
  } finally { await mock.close(); }
});

test("Responses synthetic upstream bounds the actual escaped assistant content before generation", async () => {
  const mock = await localProtocolMock("responses");
  try {
    // Independent literal: escaping the candidate text in an assistant text block has explicit framing bytes.
    const framing = Buffer.byteLength('{"content":[{"type":"text","text":"{\\"text\\":\\"\\"}"}],"reasoning":""}');
    for (const excess of [0, 1]) {
      const response = await fetch(mock.baseUrl + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt6.1-sol", max_output_tokens: 4_000, stream: true, store: false,
        tools: ["logs_read", "code_search"].map((name) => ({ type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: false } })),
        input: [...["logs_read", "code_search"].map((name) => ({ type: "function_call", name })), { content: [{ text: JSON.stringify({ draft: { text: "x".repeat(8_000 - framing + excess) } }) }] }],
      }) });
      assert.equal(response.status, excess === 0 ? 200 : 400); const output = await response.text();
      assert.equal(output.includes("response.output_text.delta"), excess === 0);
    }
  } finally { await mock.close(); }
});
