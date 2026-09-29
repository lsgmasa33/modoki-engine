/** #1824 — the ONE rule for "did this reply say the operation did not happen" (`failureDetail`) is shared by the agent
 *  side (`isFailureBody`, `tools/shared/errorCodes.ts`) and the editor client (`readBackendAnswer`, `editorBackend.ts`).
 *
 *  1. **The definition stays a leaf.** `errorCodes.ts` value-imports it, and `errorCodes.ts` is itself value-imported by
 *     both MCP bundles and by `agentBridge` (shipped to devices). An import added to the leaf reaches all three.
 *  2. **The two readers agree, on real bodies.** One definition makes a drift impossible only while both still CALL it;
 *     this runs a corpus of the answers, partial successes and refusal shapes the routes really send through both, so
 *     a reader that stops asking `failureDetail` (and grows its own rule back) disagrees here.
 *
 *  Mutation (1): add `import path from 'node:path';` to failureBody.ts — red. Mutation (2): make `readBackendAnswer`
 *  treat any non-empty `errors` as a refusal regardless of `ok` — the `{ok:true, errors}` row goes red. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isFailureBody } from '../../tools/shared/errorCodes';
import { readBackendAnswer } from '../../packages/modoki/src/editor/backend/editorBackend';
import { readScannedSource } from '@modoki/engine/testing';

const LEAF = path.resolve(__dirname, '../../packages/modoki/src/editor/backend/failureBody.ts');

describe('failureBody.ts is a leaf (#1824)', () => {
  it('imports nothing — the MCP bundles and the device bridge reach it through errorCodes.ts', () => {
    const code = readScannedSource(LEAF).code;
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it('errorCodes.ts takes the rule from the leaf rather than restating it', () => {
    const shared = readScannedSource(path.resolve(__dirname, '../../tools/shared/errorCodes.ts')).code;
    expect(shared).toMatch(/import \{ failureDetail \} from '\.\.\/\.\.\/packages\/modoki\/src\/editor\/backend\/failureBody\.js';/);
    expect(shared).toMatch(/const detail = failureDetail\(body\);/);
  });
});

/** Bodies the routes send at a 2xx — the only place the two verdicts can differ (a non-2xx is a refusal to both). */
const CORPUS: Array<[string, unknown, boolean]> = [
  ['a plain success', { ok: true, path: '/assets/a.json' }, false],
  ['a success with no ok field', { converted: 1 }, false],
  ["/api/reimport's partial bake", { ok: true, converted: 20, errors: ['a.png: bad'] }, false],
  ["/api/delete-asset's partial trash", { ok: true, trashed: 1, failed: ['/assets/b.png'] }, false],
  ["/api/delete-asset's total refusal at 200", { ok: false, trashed: 0, failed: ['/assets/a.png'] }, true],
  ['a C7 refusal: errors with no ok', { errors: ['nothing matched'] }, true],
  ['an error with no ok', { error: 'no project is open' }, true],
  ["the capture ops' ok:false + reason", { ok: false, reason: 'no watch is running' }, true],
  ['an explicit ok:true beats an error string', { ok: true, error: 'ignored note' }, false],
  ['an empty error string is not a failure', { error: '' }, false],
  ['a bare array is not a body', [1, 2], false],
];

describe('the agent and client verdicts agree on real bodies (#1824)', () => {
  it.each(CORPUS)('%s', async (_name, body, failed) => {
    expect(isFailureBody(body) !== null, 'agent side').toBe(failed);
    const answer = await readBackendAnswer(new Response(JSON.stringify(body), { status: 200 }));
    expect(!answer.ok, 'client side').toBe(failed);
  });
});
