// Owned synthetic internal-proxy subset; no upstream forwarding or deployment claim.
const http = require("node:http");
const fail = (response, status) => response.writeHead(status, { "content-type": "application/json" }).end('{"error":"synthetic_contract_rejected"}');
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || new URL(request.url, "http://localhost").pathname !== "/internal/search/es") return fail(response, 501);
    let body = request.body;
    if (body === undefined) { let raw = ""; for await (const chunk of request) { raw += String(chunk); if (Buffer.byteLength(raw) > 65_536) return fail(response, 413); } body = JSON.parse(raw); }
    if (typeof body === "string") body = JSON.parse(body);
    const params = body?.params, search = params?.body, filter = search?.query?.bool?.filter;
    const psp = params?.index === "synthetic-psp", rangeFilter = filter?.[psp ? 3 : 1];
    if (request.headers.authorization !== "ApiKey owned-synthetic-key" || !request.headers["kbn-xsrf"] ||
      !keys(body, ["params"]) || !keys(params, ["index", "body"]) || !["synthetic-simulator", "synthetic-psp"].includes(params.index) ||
      !keys(search, ["query", "size", "from", "sort"]) || search.size !== 100 || !Number.isSafeInteger(search.from) || search.from < 0 || search.from > 400 ||
      !keys(search.query, ["bool"]) || !keys(search.query.bool, ["filter"]) || !Array.isArray(filter) || filter.length !== (psp ? 4 : 2) ||
      JSON.stringify(search.sort) !== '[{"event_time":"asc"},{"event_id":"asc"}]' ||
      !keys(filter[0], ["term"]) || !keys(filter[0].term, ["application_id"]) || filter[0].term.application_id !== "SYNTHETIC-SECRET-APPLICATION" ||
      psp && (!keys(filter[1], ["term"]) || !keys(filter[1].term, ["shop_id"]) || filter[1].term.shop_id !== "SYNTHETIC-SECRET-SHOP" ||
        !keys(filter[2], ["term"]) || !keys(filter[2].term, ["binding_id"]) || filter[2].term.binding_id !== "SYNTHETIC-SECRET-BINDING") ||
      !keys(rangeFilter, ["range"]) || !keys(rangeFilter.range, ["event_time"]) || !keys(rangeFilter.range.event_time, ["gte", "lt"])) return fail(response, 400);
    const range = rangeFilter.range.event_time, span = Date.parse(range.lt) - Date.parse(range.gte);
    if (!Number.isFinite(span) || span <= 0 || span > 86_400_000) return fail(response, 400);
    const row = { _id: "e0001", _index: "synthetic-simulator", _score: null, _source: { event_id: "e0001", event_time: "2026-10-18T23:00:00.000Z",
      application_id: "SYNTHETIC-SECRET-APPLICATION", customer_id: "SYNTHETIC-SECRET-CUSTOMER", submitted_at: "2026-10-18T10:00:00.000Z", business_timezone: "Asia/Singapore",
      submitted_shops: [{ shop_id: "shop-1", authorization: "active", coverage_start: "2026-10-01", coverage_through: "2026-10-18", continuous_coverage: true }] } };
    let rows = [row];
    if (psp) {
      const value = { kind: "psp_observation", applicationRef: "SYNTHETIC-SECRET-APPLICATION", customerRef: "SYNTHETIC-SECRET-CUSTOMER",
        target: { shopRef: "SYNTHETIC-SECRET-SHOP", bindingRef: "SYNTHETIC-SECRET-BINDING", platformRef: "synthetic-platform", pspRef: "synthetic-psp", recordRef: "synthetic-verification", boundAt: "2026-10-18T10:00:00.000Z" },
        first: { status: "passed", eventRef: "first-match", observedAt: "2026-10-18T12:00:00.000Z" },
        support: { status: "unsupported", basis: "synthetic-combination-register", version: "synthetic-capabilities-1", effectiveAt: "2026-10-01T00:00:00.000Z", eventRef: "combination-support", observedAt: "2026-10-18T12:00:01.000Z" },
        second: { transaction: { status: "unknown", eventRef: null, observedAt: null }, tailThree: { status: "unknown", eventRef: null, observedAt: null } },
        final: { status: "controlled", eventRef: "source-final", observedAt: "2026-10-18T12:00:02.000Z" }, linkedShops: [] };
      rows = [{ eventRef: value.target.recordRef, observedAt: value.target.boundAt }, value.first, value.support, value.final].map((point) => ({
        _id: point.eventRef, _index: "synthetic-psp", _score: null, _source: { event_id: point.eventRef, event_time: point.observedAt,
          application_id: value.applicationRef, customer_id: value.customerRef, shop_id: value.target.shopRef, binding_id: value.target.bindingRef, verification: value } }));
    }
    rows = rows.filter((row) => Date.parse(range.gte) <= Date.parse(row._source.event_time) && Date.parse(row._source.event_time) < Date.parse(range.lt));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
      hits: { total: { value: rows.length, relation: "eq" }, hits: rows.slice(search.from, search.from + search.size) } } }));
  } catch { if (!response.headersSent) fail(response, 400); else response.end(); }
}).listen(process.env.PORT || 4501);
