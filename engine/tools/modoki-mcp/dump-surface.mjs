// Dump the modoki MCP tool surface to a compact fixture: name, sorted param names,
// required params, and a SHA-256 of the description. Ground truth for proving the E1
// split is behaviour-neutral (no tool lost, no schema or description changed).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: dump-tools.mjs <out.json>');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  // No backend needed: listTools never touches it.
  env: { ...process.env, MODOKI_BACKEND: 'http://127.0.0.1:1' },
});
const client = new Client({ name: 'dump', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const rows = tools
  .map((t) => {
    const props = t.inputSchema?.properties ?? {};
    return {
      name: t.name,
      params: Object.keys(props).sort(),
      required: (t.inputSchema?.required ?? []).slice().sort(),
      descSha: sha(t.description ?? ''),
      descLen: (t.description ?? '').length,
      // PER-PARAM descriptions. Without these the dump cannot see a documentation change at all:
      // adding `.describe()` to 25 params left every field above byte-identical, so a diff reported
      // "nothing changed" about the very work that had just been done. A verification tool blind to
      // the thing being verified is worse than none.
      paramDocs: Object.fromEntries(
        Object.keys(props).sort().map((k) => [k, (props[k]?.description ?? '').length]),
      ),
      // Strictness is part of the advertised contract (conventions §1) — it shows up here as
      // `additionalProperties: false`, so a silent revert is visible in the diff.
      strict: t.inputSchema?.additionalProperties === false,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(out, JSON.stringify({ toolCount: rows.length, tools: rows }, null, 2) + '\n');
console.log(`wrote ${rows.length} tools → ${out}`);
await client.close();
process.exit(0);
