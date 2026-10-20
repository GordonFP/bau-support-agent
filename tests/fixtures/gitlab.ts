import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execute = promisify(execFile);
const git = async (args: string[]) => (await execute("/usr/bin/git", args, { env: { LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" }, timeout: 5000, maxBuffer: 16_384 })).stdout.trim();

// Owned local GitLab REST + actual Git smart-HTTP backend. No requests are proxied.
export async function syntheticGitLab() {
  const root = await mkdtemp(join(tmpdir(), "bau-gitlab-synthetic-"));
  const commits = new Map<number, string>();
  const events: string[] = [];
  const children = new Set<ReturnType<typeof spawn>>();
  const backend = join(await git(["--exec-path"]), "git-http-backend");
  const definitions = [
    { repositoryRef: "simulator-source", project: "simulator", projectId: 1, branch: "main" as const },
    { repositoryRef: "estimate-source", project: "estimate", projectId: 2, branch: "master" as const },
    { repositoryRef: "psp-source", project: "psp", projectId: 3, branch: "main" as const },
  ];
  const sources = [
    "export function collectHistory(): number[] { return [3, 4]; }\nexport function calculateEstimate(values: number[]): number { return values.reduce((a,b) => a+b, 0); }\nexport function runSimulator(): number { return calculateEstimate(collectHistory()); }\nexport function requestEstimate(): unknown { return fetch('/api/estimate'); }\n",
    "import express from 'express';\nconst app = express();\nexport function verifyEstimate(value: number): boolean { return value > 0; }\nexport function estimate(): boolean { return verifyEstimate(7); }\napp.get('/api/estimate', estimate);\n",
    "export function verifyPsp(): boolean { return false; }\n",
  ];
  for (const [index, repository] of definitions.entries()) {
    const path = join(root, `work-${repository.projectId}`);
    await mkdir(path);
    await git(["init", "--initial-branch", repository.branch, path]);
    await writeFile(join(path, `${repository.project}.ts`), sources[index]!);
    await git(["-C", path, "add", "."]);
    await git(["-C", path, "commit", "-m", "Synthetic source"]);
    commits.set(repository.projectId, await git(["-C", path, "rev-parse", "HEAD"]));
    await git(["clone", "--bare", path, join(root, `${repository.projectId}.git`)]);
  }
  let invalidMetadata = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    events.push(`${request.method} ${url.pathname}`);
    const branch = /^\/api\/v4\/projects\/([1-3])\/repository\/branches\/(main|master)$/.exec(url.pathname);
    if (branch) {
      const repository = definitions.find((item) => item.projectId === Number(branch[1]) && item.branch === branch[2]);
      if (!repository) { response.writeHead(404).end(); return; }
      const body = JSON.stringify({ name: repository.branch, commit: { id: invalidMetadata ? "0".repeat(40) : commits.get(repository.projectId) } });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body); return;
    }
    if (!/^\/repos\/[1-3]\.git\/(info\/refs|git-upload-pack)$/.test(url.pathname) || !["GET", "POST"].includes(request.method ?? "")) { response.writeHead(501).end(); return; }
    const child = spawn(backend, [], { env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin", GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname.replace("/repos", ""), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!,
      CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: request.headers["content-length"] ?? "", REMOTE_ADDR: "127.0.0.1" }, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("close", () => { clearTimeout(timer); children.delete(child); });
    child.on("error", () => { response.writeHead(500).end(); });
    child.stderr.on("data", () => {});
    let header = Buffer.alloc(0), started = false, received = 0;
    request.on("data", (chunk: Buffer) => { received += chunk.length; if (received > 1_048_576) { child.kill("SIGKILL"); request.destroy(); } });
    request.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) { response.write(chunk); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) { if (header.length > 16_384) child.kill("SIGKILL"); return; }
      const headers = Object.fromEntries(header.subarray(0, end).toString().split("\r\n").map((line) => {
        const split = line.indexOf(":"); return [line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()];
      }));
      response.writeHead(Number(headers.status?.split(" ")[0] ?? 200), Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "status")));
      response.write(header.subarray(end + 4)); header = Buffer.alloc(0); started = true;
    });
    child.stdout.on("end", () => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_start_failed");
  return { root, url: `http://127.0.0.1:${address.port}/`, repositories: definitions, events,
    setInvalidMetadata: (invalid: boolean) => { invalidMetadata = invalid; },
    async replaceSource(projectId: number, source: string) {
      const repository = definitions.find((item) => item.projectId === projectId);
      if (!repository) throw new Error("invalid_fixture_project");
      const path = join(root, `work-${projectId}`);
      await writeFile(join(path, `${repository.project}.ts`), source);
      await git(["-C", path, "add", "."]); await git(["-C", path, "commit", "-m", "Synthetic change"]);
      await git(["-C", path, "push", join(root, `${projectId}.git`), repository.branch]);
      commits.set(projectId, await git(["-C", path, "rev-parse", "HEAD"]));
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const child of children) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); } };
}
