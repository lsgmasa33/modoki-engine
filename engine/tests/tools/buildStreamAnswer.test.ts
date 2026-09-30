/** #1900 — `modoki_build`'s answer is summary-first. The backend sends each stdout/stderr pipe CHUNK as one SSE `message`
 *  frame, and the answer used to be the last 40 of them: a web build of a freshly scaffolded project measured 72,902
 *  chars (one 60,535-char Vite asset-listing frame), over the 60k cap, so the agent got `log: "array(40)"` and nothing
 *  about the build (OBSERVED by work-qa at 71.7KB, and on work-ai3 by streaming `/api/build` directly). Now: a bounded
 *  tail of LINES, the count of them all, and a local file with the whole log.
 *
 *  Mutations, each measured red here and restored: the tail taken from chunks instead of lines (`log.slice(-40)`) →
 *  "fits the cap"; the per-line cut removed → "a single huge line"; the file not written → "the whole log"; the failure
 *  `got` built from raw chunks → "a failure". */
import fs from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createToolContext } from '../../tools/modoki-mcp/src/context';
import { buildLogLines, buildLogTail, BUILD_TAIL_LINES, BUILD_LINE_CHARS } from '../../tools/modoki-mcp/src/buildLog';
import { MAX_PAYLOAD_CHARS } from '../../tools/shared/mcpResult';

const STUB = 'http://stub.modoki.test';
const written: string[] = [];

/** The build stream: `chunks` as message frames, then `status`. */
function stub(chunks: string[], status: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const path = String(input).slice(STUB.length);
    if (path === '/api/identity') {
      return new Response(JSON.stringify({ repoRoot: process.cwd(), projectRoot: '/p', backendPort: 1, pid: 1, branch: 'x', packaged: false }));
    }
    const frames = [...chunks.map((c) => `event: message\ndata: ${JSON.stringify(c)}\n\n`), `event: status\ndata: ${JSON.stringify(status)}\n\n`].join('');
    return new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  return createToolContext({ backend: STUB });
}

const payload = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('');
const parsed = (r: { content: { text: string }[] }) => JSON.parse(r.content[r.content.length - 1].text);

/** A Vite-style build: many modest chunks, then one asset listing far over the cap by itself. */
function viteLikeChunks(): string[] {
  const chunks = Array.from({ length: 60 }, (_, i) => `\u001b[32m✓\u001b[39m transformed module ${i}\n  another line ${i}`);
  chunks.push(Array.from({ length: 800 }, (_, i) => `dist/assets/chunk-${i}-0123456789abcdef.js   ${i * 3}.12 kB │ gzip: ${i}.01 kB`).join('\n'));
  chunks.push('✓ built in 12.34s');
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const f of written.splice(0)) fs.rmSync(f, { force: true });
});

describe('buildLogLines / buildLogTail', () => {
  it('splits chunks into lines, drops blanks and colour codes', () => {
    expect(buildLogLines(['\u001b[32ma\u001b[39m\n\nb', 'c\r\n'])).toEqual(['a', 'b', 'c']);
  });

  it('a single huge line is cut, and says by how much', () => {
    const [line] = buildLogTail(['x'.repeat(BUILD_LINE_CHARS + 50)]);
    expect(line.startsWith('x'.repeat(BUILD_LINE_CHARS))).toBe(true);
    expect(line.endsWith('… (+50 chars)')).toBe(true);
  });
});

describe('consumeBuildStream answers summary-first (#1900)', () => {
  it('a successful build fits the cap, ends on the verdict line, and counts every line', async () => {
    const chunks = viteLikeChunks();
    // The old answer, for contrast: the last 40 chunks were over the cap on their own.
    expect(JSON.stringify({ ok: true, log: chunks.slice(-40) }).length).toBeGreaterThan(MAX_PAYLOAD_CHARS);
    const r = await stub(chunks, 'DONE').consumeBuildStream('/api/build?platform=web', 5_000);
    expect(payload(r).length).toBeLessThan(20_000);
    const body = parsed(r);
    if (body.logPath) written.push(body.logPath);
    expect(body.ok).toBe(true);
    expect(body.log).toHaveLength(BUILD_TAIL_LINES);
    expect(body.log.at(-1)).toBe('✓ built in 12.34s');
    expect(body.logLines).toBe(buildLogLines(chunks).length);
  });

  it('the whole log is in a local file, colour codes stripped', async () => {
    const chunks = viteLikeChunks();
    const body = parsed(await stub(chunks, 'DONE').consumeBuildStream('/api/build?platform=web', 5_000));
    written.push(body.logPath);
    expect(body.logPath).toMatch(/modoki-build-build-web-\d+\.log$/);
    const file = fs.readFileSync(body.logPath, 'utf8');
    expect(file).toContain('transformed module 0');
    expect(file).toContain('dist/assets/chunk-799-');
    expect(file).not.toContain('\u001b[');
  });

  it('a failure: the tail in `got`, bounded, and the file named in the options', async () => {
    const chunks = [...viteLikeChunks(), 'error TS2304: Cannot find name "x".'];
    const r = await stub(chunks, 'FAILED: web compile\nexit 1').consumeBuildStream('/api/build?platform=web', 5_000);
    expect(r.isError).toBe(true);
    const { error } = JSON.parse(payload(r));
    const file = error.options.find((o: string) => o.startsWith('read the whole log'));
    written.push(file.match(/\((.*)\)/)[1]);
    expect(error.got.split('\n')).toHaveLength(BUILD_TAIL_LINES);
    expect(error.got.endsWith('error TS2304: Cannot find name "x".')).toBe(true);
    expect(file).toMatch(/modoki-build-build-web-\d+\.log/);
  });
});
