import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";

export async function teamsServices() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { privateKey: wrongKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = (claims: Record<string, unknown>, forged = false) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-key" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })).toString("base64url");
    const value = `${header}.${body}`;
    return `${value}.${sign("RSA-SHA256", Buffer.from(value), forged ? wrongKey : privateKey).toString("base64url")}`;
  };
  const waiters: { count: number; resolve: () => void }[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let tokenMode = "valid", writeMode = "success", tokenRequests = 0;
  let fixedReceipt: string | undefined;
  let beforeToken: (() => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/.well-known/keys") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" }] })); return;
    }
    if (request.url?.startsWith("/api/usertoken/GetToken?")) {
      tokenRequests++; await beforeToken?.();
      if (tokenMode === "revoked") { response.writeHead(404).end(); return; }
      const token = jwt({ aud: "synthetic-user-app", iss: "https://identity.synthetic.invalid/tenant/v2.0", tid: tokenMode === "wrong-tenant" ? "other-tenant" : "synthetic-tenant",
        oid: tokenMode === "wrong-user" ? "other-oid" : new URL(request.url!, "http://localhost").searchParams.get("userId") === "synthetic-user-2" ? "synthetic-oid-2" : "synthetic-oid", scp: tokenMode === "wrong-scope" ? "unrelated" : "access_as_user",
        ...(tokenMode === "expired" ? { exp: 1 } : {}) }, tokenMode === "forged");
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ channelId: "msteams", connectionName: "synthetic-identity", token })); return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/v3/conversations/")) { response.writeHead(501).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    writes.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
    for (const waiter of waiters) if (writes.length >= waiter.count) waiter.resolve();
    if (writeMode === "reset") { request.socket.destroy(); return; }
    response.setHeader("content-type", "application/json");
    if (writeMode === "429") { response.writeHead(429).end('{}'); return; }
    response.end(writeMode === "malformed" ? '{bad' : writeMode === "missing-id" ? '{}' : JSON.stringify({ id: fixedReceipt ?? `synthetic-receipt-${writes.length}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mapping = { tenantId: "synthetic-tenant", oid: "synthetic-oid", userId: "synthetic-user", conversationId: "synthetic-conversation",
    actor: { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1" } };
  const configuration = { profile: "local_protocol" as const, clientId: "synthetic-app", tenantId: "synthetic-tenant", botId: "synthetic-bot",
    serviceUrl: origin, tokenUrl: origin, serviceMetadataUrl: `${origin}/.well-known/openidconfiguration`,
    user: { audience: "synthetic-user-app", issuer: "https://identity.synthetic.invalid/tenant/v2.0", jwksUrl: `${origin}/.well-known/keys`, connectionName: "synthetic-identity" },
    mappings: [mapping], token: async () => jwt({ aud: "synthetic-connector" }) };
  const activity = (text = JSON.stringify({ action: "investigate", applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "Why?" })) => ({
    type: "message", id: "synthetic-event-1", text, channelId: "msteams", serviceUrl: origin,
    from: { id: "synthetic-user", aadObjectId: "synthetic-oid" }, recipient: { id: "synthetic-bot" },
    conversation: { id: "synthetic-conversation", conversationType: "personal", tenantId: "synthetic-tenant" },
  });
  return { configuration, mapping, activity, writes,
    async waitForWrites(count: number) {
      if (writes.length >= count) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([new Promise<void>((resolve) => waiters.push({ count, resolve })), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("synthetic_write_not_observed")), 2_000); })]); }
      finally { clearTimeout(timer); }
    },
    serviceToken: (forged = false, claims: Record<string, unknown> = {}) => jwt({ aud: "synthetic-app", iss: "https://api.botframework.com", serviceurl: origin, ...claims }, forged),
    setReceiptId: (value?: string) => { fixedReceipt = value; },
    setTokenMode: (mode: string) => { tokenMode = mode; }, setWriteMode: (mode: string) => { writeMode = mode; },
    beforeToken: (callback?: () => Promise<void>) => { beforeToken = callback; }, tokenRequests: () => tokenRequests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
