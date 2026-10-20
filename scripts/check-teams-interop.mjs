import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { metrics, trace } from "@opentelemetry/api";

// Dependency preflight only: no application intake, real tenant, or business investigation.
trace.disable();
metrics.disable();
const { App } = await import("@microsoft/teams.apps");
const { PUBLIC, withOverrides } = await import("@microsoft/teams.api");
const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {}, child() { return this; } };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwt = (payload) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const data = `${header}.${body}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
};
let tokenRequests = 0;
let physicalWrites = 0;
let mode = "success";
const server = createServer(async (request, response) => {
  if (request.url === "/.well-known/keys") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" }] }));
    return;
  }
  if (request.url?.startsWith("/api/usertoken/GetToken?")) {
    tokenRequests++;
    response.writeHead(404).end();
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v3/conversations/synthetic-conversation/activities");
  physicalWrites++;
  let bytes = 0;
  for await (const chunk of request) bytes += chunk.length;
  assert.ok(bytes < 4096);
  if (mode === "reset") { request.socket.destroy(); return; }
  response.setHeader("content-type", "application/json");
  if (mode === "429") { response.writeHead(429, { "retry-after": "0" }).end('{}'); return; }
  response.end('{"id":"synthetic-receipt"}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let route;
const adapter = {
  registerRoute(method, path, handler) { assert.equal(method, "POST"); assert.equal(path, "/api/messages"); route = handler; },
  async start() {}, async stop() {},
};
const app = new App({
  clientId: "synthetic-app", tenantId: "synthetic-tenant", token: async () => jwt({ aud: "synthetic-connector" }),
  serviceUrl: origin, apiClientSettings: { oauthUrl: origin }, logger, httpServerAdapter: adapter,
  cloud: withOverrides(PUBLIC, { openIdMetadataUrl: `${origin}/.well-known/openidconfiguration` }),
  client: { logger, timeout: 1000, middlewares: [{ async invoke(context, next) {
    const url = new URL(context.config.url, context.config.baseURL);
    assert.equal(url.origin, origin);
    assert.ok(["/api/usertoken/GetToken", "/v3/conversations/synthetic-conversation/activities"].includes(url.pathname));
    context.config.maxRedirects = 0; context.config.proxy = false;
    context.config.maxContentLength = 4096; context.config.maxBodyLength = 4096;
    context.config.responseType = "json";
    context.config.transitional = { silentJSONParsing: false, forcedJSONParsing: true };
    return next();
  } }] },
  dangerouslyAllowUnauthenticatedRequests: false, telemetry: { agent365: false }, state: false, plugins: [], oauth: { fetchUserToken: false },
});
const flow = app.addOAuthFlow("synthetic-identity");
let messages = 0;
app.on("message", async (context) => {
  messages++;
  assert.equal(await flow.getToken(context), undefined); // Actual 404 must use the CJS client's expected branch.
});
try {
  await app.start(0);
  assert.equal(typeof route, "function");
  const result = await route({ body: {
    type: "message", id: "synthetic-event", text: "synthetic", channelId: "msteams", serviceUrl: origin,
    from: { id: "synthetic-user", aadObjectId: "synthetic-oid" }, recipient: { id: "synthetic-bot" },
    conversation: { id: "synthetic-conversation", conversationType: "personal", tenantId: "synthetic-tenant" },
  }, headers: { authorization: `Bearer ${jwt({ aud: "synthetic-app", iss: PUBLIC.tokenIssuer, serviceurl: origin })}` } });
  assert.equal(result.status, 200);
  assert.equal(messages, 1);
  assert.equal(tokenRequests, 1);
  assert.equal(physicalWrites, 0);
  for (const outcome of ["success", "429", "reset"]) {
    mode = outcome;
    const before = physicalWrites;
    const send = () => app.send("synthetic-conversation", { type: "message", text: "synthetic sanitized preflight", textFormat: "plain" });
    if (mode === "success") assert.equal((await send()).id, "synthetic-receipt");
    else await assert.rejects(send);
    assert.equal(physicalWrites - before, 1);
  }
  console.log("Teams native preflight: signed service route; plain-client OAuth404; one physical POST per success/429/reset; no real tenant.");
} finally {
  await app.stop();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
assert.equal(server.listening, false);
