/** The editor renderer never opens a NATIVE `confirm` / `alert` / `prompt` (#1594).
 *
 *  WHY. In the Electron renderer those open a native sheet that BLOCKS the renderer, and nothing on
 *  the agent surface can see or answer it: a `modoki_tap` on Skin Editor's Auto-rig returned ok,
 *  then every later call timed out with "is the editor window open?" until a human clicked OK
 *  through macOS System Events. The editor's own modals (`confirmInEditor`, `alertInEditor`,
 *  `openChoiceModal`) are in-DOM, name their buttons, and surface as `get_editor_state.modal`.
 *  `window.prompt` was already gone (it throws in Electron); `confirm` and `alert` do not throw, so
 *  the trap came back silently after the #1470 migration — hence a source guard, not a convention.
 *
 *  What it reads: a call to `confirm`/`alert`/`prompt` as a BARE name with no declaration in its
 *  own file (a global), or through `window.` / `globalThis.` / `self.`. A local binding of the same
 *  name — `unsavedGate.ts`'s injected `confirm` parameter — is not the native one and passes.
 *  What it cannot see: an aliased global (`const ask = window.confirm; ask(…)`), or a call through a
 *  computed key. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { accessPath, declarationOf, findNodes, parseSource, ts } from '@modoki/engine/testing/sourceAst';

const NATIVE = new Set(['confirm', 'alert', 'prompt']);
const GLOBAL_OWNERS = new Set(['window', 'globalThis', 'self']);

/** Every native-dialog call in `code`, as `name@line`. */
function nativeDialogCalls(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const out: string[] = [];
  for (const call of findNodes(sf, ts.isCallExpression)) {
    const path = accessPath(call.expression);
    if (!path) continue;
    const parts = path.split('.');
    const name = parts[parts.length - 1];
    if (!NATIVE.has(name)) continue;
    const native = parts.length === 1
      ? declarationOf(call.expression as ts.Identifier) === undefined
      : parts.length === 2 && GLOBAL_OWNERS.has(parts[0]);
    if (native) out.push(`${path}@${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
  }
  return out;
}

describe('the editor opens no native confirm/alert/prompt (#1594)', () => {
  const files = repoFiles({ under: ['engine/packages/modoki/src/editor', 'engine/app'], match: /\.tsx?$/, floor: 300 });

  it('no editor or app-shell source calls one', () => {
    const hits = files.flatMap(({ abs, rel }) => nativeDialogCalls(readScannedSource(abs).code, rel).map((h) => `${rel} ${h}`));
    expect(hits, 'Use confirmInEditor / alertInEditor (editor/utils/saveDialog.ts) or openChoiceModal — a native sheet blocks the renderer and no agent tool can answer it (#1594).').toEqual([]);
  });

  it('the detector catches every native spelling', () => {
    expect(nativeDialogCalls(`if (!window.confirm('x')) return;`, 'a.ts')).toEqual(['window.confirm@1']);
    expect(nativeDialogCalls(`alert('x');`, 'a.ts')).toEqual(['alert@1']);
    expect(nativeDialogCalls(`const v = prompt('x', 'y');`, 'a.ts')).toEqual(['prompt@1']);
    expect(nativeDialogCalls(`globalThis.alert('x'); self.confirm('y');`, 'a.ts')).toEqual(['globalThis.alert@1', 'self.confirm@1']);
    expect(nativeDialogCalls(`const f = () => { if (x) {\n  window.alert(msg);\n} };`, 'a.tsx')).toEqual(['window.alert@2']);
  });

  it('accept side: a LOCAL binding of the name, a method, and the in-app helpers pass', () => {
    // unsavedGate.ts's shape: `confirm` is an injected parameter, not the global.
    expect(nativeDialogCalls(`async function gate(confirm: (m: string) => Promise<boolean>) { await confirm('m'); }`, 'a.ts')).toEqual([]);
    expect(nativeDialogCalls(`import { alert } from './x'; alert('m');`, 'a.ts')).toEqual([]);
    expect(nativeDialogCalls(`services.alert({ title: 't', message: 'm' }); result.confirm('code');`, 'a.ts')).toEqual([]);
    expect(nativeDialogCalls(`await confirmInEditor('t', 'm', 'OK'); await alertInEditor('t', 'm');`, 'a.ts')).toEqual([]);
  });
});
