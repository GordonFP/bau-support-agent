// Owned Connector subset. Native signed service/user authentication runs in the separate local host.
// No real Teams service, tenant, credentials, upstream forwarding, update, streaming or retry route.
const http = require("node:http");
let receipts = 0;
const fail = (response, code) => { response.writeHead(code, { "content-type": "application/json" }); response.end('{"status":"synthetic_contract_rejected"}'); };
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/v3/conversations/synthetic-conversation/activities") return fail(response, 501);
    let body = request.body;
    if (body === undefined) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 24576) return fail(response, 413); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || Object.keys(body).sort().join() !== "conversation,from,text,textFormat,type" || body.type !== "message" || body.textFormat !== "plain" ||
      typeof body.text !== "string" || Buffer.byteLength(JSON.stringify(body)) > 24576 || body.from?.id !== "synthetic-app" || body.from?.role !== "bot" ||
      Object.keys(body.from).sort().join() !== "id,role" || body.conversation?.id !== "synthetic-conversation" || Object.keys(body.conversation).join() !== "id") return fail(response, 400);
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: `synthetic-postman-receipt-${++receipts}` }));
  } catch { if (!response.headersSent) fail(response, 400); else response.end(); }
});
server.listen(process.env.PORT || 4501);
