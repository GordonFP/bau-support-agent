import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const SKILL_BYTES = 16_384;

export async function reviewedSkill(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let body: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > SKILL_BYTES) throw new Error();
      const bounded = Buffer.alloc(SKILL_BYTES + 1);
      let bytes = 0;
      while (bytes <= SKILL_BYTES) {
        const read = await file.read(bounded, bytes, bounded.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > SKILL_BYTES) throw new Error();
      body = bounded.subarray(0, bytes);
    } finally { await file.close(); }
    if (createHash("sha256").update(body).digest("hex") !== REVIEWED_SKILL_SHA256) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch { throw new Error("contract_unverified"); }
}
export const REVIEWED_SKILL_SHA256 = "27b86d3f62c99d366999fd07cb0651f04b9477206d0d204255f3f7680ae0258e";
