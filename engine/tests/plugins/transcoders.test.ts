/** #1586: the KTX2 transcoder pairs ship under fixed names, so each pair carries a content-hash
 *  version the runtime appends as `?v=`. These cover the build half — the version, the copy, the
 *  shared source lookup, the dev backend's URL match and the vite.config wiring. The runtime half is
 *  `engine/tests/assets/transcoderUrls.test.ts`. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRANSCODERS, shipTranscoders, transcoderDefine, transcoderForUrl, transcoderSourceDir, transcoderVersion, transcoderVersions,
} from '../../plugins/transcoders';
import { readScannedSource } from '@modoki/engine/testing';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const repoRoot = path.resolve(__dirname, '../../..');
const tmp = (): string => makeScratchDir('modoki-transcoders-');

/** A root whose node_modules holds both pairs, each file's bytes tagged so roots are distinguishable. */
function rootWithTranscoders(tag: string): string {
  const root = tmp();
  for (const t of Object.values(TRANSCODERS)) {
    fs.mkdirSync(path.join(root, t.src), { recursive: true });
    for (const f of t.files) fs.writeFileSync(path.join(root, t.src, f), `${tag}:${f}`);
  }
  return root;
}

describe('transcoderVersion', () => {
  it('changes when EITHER file of a pair changes — the .js and .wasm URLs always move together', () => {
    const root = rootWithTranscoders('a');
    const before = transcoderVersion('basis', [root]);
    expect(before).toMatch(/^[0-9a-f]{16}$/);

    fs.writeFileSync(path.join(root, TRANSCODERS.basis.src, 'basis_transcoder.wasm'), 'a:new wasm');
    const afterWasm = transcoderVersion('basis', [root]);
    expect(afterWasm).not.toBe(before);

    fs.writeFileSync(path.join(root, TRANSCODERS.basis.src, 'basis_transcoder.js'), 'a:new js');
    expect(transcoderVersion('basis', [root])).not.toBe(afterWasm);
  });

  it('versions the two pairs independently', () => {
    const root = rootWithTranscoders('a');
    const v = transcoderVersions([root]);
    fs.writeFileSync(path.join(root, TRANSCODERS.pixiKtx.src, 'libktx.wasm'), 'bumped');
    const w = transcoderVersions([root]);
    expect(w.basis).toBe(v.basis);
    expect(w.pixiKtx).not.toBe(v.pixiKtx);
  });

  it('is blank when the transcoder is not installed — the runtime then asks for the bare URL', () => {
    expect(transcoderVersions([tmp()])).toEqual({ basis: '', pixiKtx: '' });
  });

  it('hashes the real installed pairs', () => {
    const v = transcoderVersions([repoRoot]);
    expect(v.basis).toMatch(/^[0-9a-f]{16}$/);
    expect(v.pixiKtx).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the copy and the version read the SAME source', () => {
  it('a flat project with no node_modules falls back to the editor root for both', () => {
    const project = tmp();
    const editor = rootWithTranscoders('editor');
    expect(transcoderSourceDir('basis', [project, editor])).toBe(path.join(editor, TRANSCODERS.basis.src));

    const dist = tmp();
    shipTranscoders(dist, [project, editor]);
    expect(fs.readFileSync(path.join(dist, 'basis/basis_transcoder.js'), 'utf8')).toBe('editor:basis_transcoder.js');
    expect(fs.readFileSync(path.join(dist, 'pixi-ktx/libktx.wasm'), 'utf8')).toBe('editor:libktx.wasm');
    expect(transcoderVersion('basis', [project, editor])).toBe(transcoderVersion('basis', [editor]));
  });

  it('a project with its own copy wins over the editor for the copy AND the version', () => {
    const project = rootWithTranscoders('project');
    const editor = rootWithTranscoders('editor');
    const dist = tmp();
    shipTranscoders(dist, [project, editor]);
    expect(fs.readFileSync(path.join(dist, 'basis/basis_transcoder.wasm'), 'utf8')).toBe('project:basis_transcoder.wasm');
    expect(transcoderVersion('basis', [project, editor])).toBe(transcoderVersion('basis', [project]));
    expect(transcoderVersion('basis', [project, editor])).not.toBe(transcoderVersion('basis', [editor]));
  });
});

describe('transcoderForUrl (the dev backend)', () => {
  it.each([
    ['/basis/basis_transcoder.js', 'basis'],
    ['/basis/basis_transcoder.wasm', 'basis'],
    ['/pixi-ktx/libktx.js', 'pixiKtx'],
    ['/pixi-ktx/libktx.wasm', 'pixiKtx'],
  ])('%s → %s', (url, key) => {
    expect(transcoderForUrl(url)).toBe(key);
  });

  it.each(['/basis/libktx.js', '/pixi-ktx/basis_transcoder.js', '/basis/basis_transcoder.jsx', '/x/basis/basis_transcoder.js', '/basis/'])(
    'does not match %s',
    (url) => {
      expect(transcoderForUrl(url)).toBeUndefined();
    },
  );
});

describe('transcoderDefine — which builds get a version', () => {
  it('a published (web/native) build gets the real versions', () => {
    const root = rootWithTranscoders('a');
    const v = transcoderDefine({ editor: false, playable: false }, [root]);
    expect(v).toEqual(transcoderVersions([root]));
    expect(v.basis).not.toBe('');
    expect(v.pixiKtx).not.toBe('');
  });

  it.each([
    [{ editor: true, playable: false }],
    [{ editor: false, playable: true }],
    [{ editor: true, playable: true }],
  ])('%o gets blanks — bare URLs', (build) => {
    expect(transcoderDefine(build, [rootWithTranscoders('a')])).toEqual({ basis: '', pixiKtx: '' });
  });
});

// The functions above are only half of it: dropping the define from vite.config.ts would leave every
// test here green and every published build back on bare, day-cached URLs.
describe('vite.config bakes the versions into the build', () => {
  const cfg = readScannedSource(path.join(repoRoot, 'engine/vite.config.ts')).code;
  it('defines __MODOKI_TRANSCODER_VERSIONS__ through transcoderDefine, with the build kind and the scanner\'s roots', () => {
    expect(cfg.replace(/\s+/g, ' ')).toContain(
      "__MODOKI_TRANSCODER_VERSIONS__: JSON.stringify( transcoderDefine({ editor: isEditorBuild, playable: isPlayable }, [buildProjectRoot, repoRoot]))",
    );
  });
  it('the scanner ships through the same helper, with the project root first', () => {
    const scanner = readScannedSource(path.join(repoRoot, 'engine/plugins/vite-asset-scanner.ts')).code;
    expect(scanner).toContain('shipTranscoders(distDir, [projectRoot, editorRoot])');
  });
});
