import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadKibanaProfile, verifyModules } from "./profile.js";
// No reference entrypoint, dotenv, environment credentials, discovery or raw diagnostics.
for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) console[name] = () => {};
try {
  const profile = await loadKibanaProfile({ path: process.argv[2]!, sha256: process.argv[3]! });
  await verifyModules(profile);
  const configuredAxios = pathToFileURL(profile.value.axios).href;
  const root = pathToFileURL(dirname(profile.value.factory.path) + "/").href;
  const axiosRoot = pathToFileURL(dirname(profile.value.packages.axios.path) + "/").href;
  const sdkRoot = pathToFileURL(dirname(profile.value.packages.sdk.path) + "/").href;
  const pinned = new Map(profile.value.modules.map((item) => [pathToFileURL(item.path).href, item.sha256]));
  if (createRequire(profile.value.factory.path).resolve("axios/package.json") !== profile.value.packages.axios.path) throw new Error();
  for (const [name, entry] of Object.entries(profile.value.packages)) {
    const info = JSON.parse(await readFile(entry.path, "utf8"));
    if (info.name !== (name === "sdk" ? "@modelcontextprotocol/sdk" : "axios") || info.version !== entry.version) throw new Error();
  }
  // Public Node loader guard: the reviewed bare import must resolve to the SAME
  // Axios ESM module whose defaults are set, before its factory creates an instance.
  registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (specifier === "axios" && result.url !== configuredAxios) throw new Error();
    return result;
  }, load(url, context, next) {
    if (profile.value.profile === "local-candidate-1" && url.startsWith("file:") && (!pinned.has(url) || createHash("sha256").update(readFileSync(fileURLToPath(url))).digest("hex") !== pinned.get(url))) throw new Error();
    if ((url.startsWith(root) || profile.value.profile === "local-candidate-1" && (url.startsWith(axiosRoot) || url.startsWith(sdkRoot))) && !pinned.has(url)) throw new Error();
    if (/\/(?:dotenv|express)\//.test(url)) throw new Error();
    if (profile.value.profile === "local-candidate-1" && url.startsWith(sdkRoot) && ![
      "dist/esm/server/index.js", "dist/esm/server/stdio.js", "dist/esm/shared/protocol.js", "dist/esm/shared/stdio.js", "dist/esm/types.js",
    ].some((suffix) => url === sdkRoot + suffix)) throw new Error();
    return next(url, context);
  } });
  const axios = (await import(pathToFileURL(profile.value.axios).href)).default;
  Object.assign(axios.defaults, { adapter: "http", responseType: "json", maxContentLength: 1_048_576,
    maxBodyLength: 65_536, maxRedirects: 0, proxy: false });
  axios.defaults.transitional = { ...axios.defaults.transitional, silentJSONParsing: false, forcedJSONParsing: true };
  const module = await import(pathToFileURL(profile.value.factory.path).href);
  const factory = module[profile.value.factory.export];
  if (typeof factory !== "function") throw new Error();
  const server = factory({ kibana: { url: profile.value.backend.url, apiKey: profile.value.backend.apiKey }, logLevel: "error" });
  const { StdioServerTransport } = await import(pathToFileURL(profile.value.stdio).href);
  await server.connect(new StdioServerTransport());
} catch { process.exitCode = 1; }
