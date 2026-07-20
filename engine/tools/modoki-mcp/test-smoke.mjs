// Smoke test: spawn the Modoki MCP server over stdio, list tools, call a few
// against the running editor backend (MODOKI_BACKEND). Not a unit test — a
// quick end-to-end check that the server speaks MCP and reaches the backend.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  env: { ...process.env, MODOKI_BACKEND: process.env.MODOKI_BACKEND || 'http://localhost:5173' },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const text = (r) => r.content.map((c) => c.text).join('\n');

const assets = await client.callTool({ name: 'modoki_list_assets', arguments: { type: 'scene' } });
console.log('list_assets(scene) →', text(assets).slice(0, 120).replace(/\n/g, ' '));

// Bare list_traits is summary-first: names by category + traitCount, no field schemas.
const traits = await client.callTool({ name: 'modoki_list_traits', arguments: {} });
const tj = JSON.parse(text(traits));
const categories = Object.keys(tj.byCategory || {}).length;
console.log('list_traits → schemaAvailable:', tj.schemaAvailable, ' traitCount:', tj.traitCount, ` (${categories} categories, no schemas)`);
if (tj.traits) throw new Error('bare list_traits leaked full trait schemas');

// ...and the drill-down returns exactly one schema.
const one = await client.callTool({ name: 'modoki_list_traits', arguments: { name: 'Transform' } });
const oj = JSON.parse(text(one));
console.log('list_traits(name=Transform) → fields:', Object.keys(oj.traits.Transform.fields || {}).join(','));

// Every tool result must be parseable JSON — including a capped one, which is why the
// size cap emits an `{elided:true}` envelope rather than slicing the blob (result.ts).
// Since Phase 3 the bare call is a names-only index and comfortably fits, so the elided
// branch should NOT fire here — but accept it, because that is the point of the envelope:
// a capped answer still parses and still tells you how to narrow.
const state = await client.callTool({ name: 'modoki_get_scene_state', arguments: {} });
const sj = JSON.parse(text(state));
if (sj.elided) {
  console.log(`get_scene_state → ELIDED (${sj.bytes} chars, over cap) — envelope still parsed`);
  const narrowed = await client.callTool({ name: 'modoki_get_scene_state', arguments: { limit: 5 } });
  const nj = JSON.parse(text(narrowed));
  console.log('get_scene_state?limit=5 → scenePath:', nj.scenePath, ' entityCount:', nj.entityCount);
} else {
  console.log('get_scene_state → scenePath:', sj.scenePath, ' entityCount:', sj.entityCount);
}

await client.close();
console.log('SMOKE OK');
process.exit(0);
