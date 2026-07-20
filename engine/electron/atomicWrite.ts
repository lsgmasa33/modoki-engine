import fs from 'node:fs';
import path from 'node:path';

/** Write `data` to `filePath` ATOMICALLY (temp sibling + rename). A plain writeFileSync
 *  truncates in place, so a crash / power loss / ENOSPC mid-write would leave the user's
 *  file truncated — and when the buffer is a MERGED config, that destroys the parts we
 *  merged onto (their other MCP servers, a sibling editor's tokens). rename is atomic
 *  within one filesystem, so a fault leaves either the old file intact or the new one
 *  complete. The temp MUST be a sibling (same dir) to avoid a cross-device EXDEV rename.
 *
 *  A LEAF module on purpose: both connectClaude.ts and instanceToken.ts need it, and
 *  instanceToken owns the token policy that connectClaude must consult (isMcpStale) — so
 *  homing this in either of them would make that pair import each other in a cycle. */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
}
