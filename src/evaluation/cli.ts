import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { agentInputs, evaluate } from './index.js';

const maxFileBytes = 2 * 1024 * 1024;
async function readJson(path: string): Promise<unknown> {
  // Nonblocking open precedes the regular-file check on this same descriptor (including path swaps).
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxFileBytes) return null;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
  } catch { return null; }
  finally { await handle.close(); }
}

async function main(args: string[]): Promise<void> {
  let output: unknown;
  let valid = false;
  if (args[0] === 'summary' && args.length === 4) {
    // Load independently so a missing controlled-reference file cannot hide an actual safety failure.
    const loaded = await Promise.allSettled(args.slice(1).map(readJson));
    const values = loaded.map(item => item.status === 'fulfilled' ? item.value : null);
    const result = evaluate({ round: values[0], references: values[1], results: values[2] });
    output = result;
    valid = result.valid;
  } else if (args[0] === 'inputs' && args.length === 2) {
    const result = agentInputs(await readJson(args[1]!).catch(() => null));
    output = result;
    valid = result.valid;
  } else output = { valid: false, decision: 'cannot_determine', issues: ['invalid_arguments'], pending: ['invalid_arguments'], stopPaths: [] };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = valid ? 0 : 2;
}

if (import.meta.main) await main(process.argv.slice(2));
