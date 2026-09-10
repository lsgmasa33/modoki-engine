/** The bundled app-icon default must EXIST, and must sit where the packaged editor ships it (#991
 *  close-out, finding F3).
 *
 *  ⚠️ This is not a paranoid file-exists check; it pins the exact defect the #1027 review found.
 *  The default was `build/icon.png`, and `electron-builder.yml`'s `files:` ships `engine/**` +
 *  `dist/**` + `package.json` and nothing else — `build/` reaches the package only as `build/bin`
 *  via `extraResources`. So in the PACKAGED editor `bundledIconPath()` resolved to nothing,
 *  `iconStep` passed `--icon ""`, and `generate-icons.mjs` took its "no icon named anywhere"
 *  branch: nothing generated, exit 0, silently. Three answers for one project — dev editor and CLI
 *  generate the default, packaged editor generates nothing — which is the opposite of what moving
 *  the default into a shared module was for.
 *
 *  `vite-asset-scanner.ts` already carries the identical scar for the splash BADGE art, moved out
 *  of `build/` after a packaged-editor build produced title-less, badge-less splashes. Two assets,
 *  one trap, and nothing executed the rule until this file. */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_ICON_REL, bundledIconPath } from '../../scripts/iconAssets.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the bundled icon default is reachable where it is used', () => {
  it('resolves to a real file from the repo root', () => {
    expect(bundledIconPath(repoRoot), `${BUNDLED_ICON_REL} is missing from the checkout`).toBeTruthy();
  });

  it('lives under a directory the PACKAGED editor actually ships', () => {
    // ⚠️ The globs are READ OUT of electron-builder.yml, not restated here. Hard-coding them would
    // be a shadowing constant of exactly the kind this whole commit is atoning for: change `files:`
    // and this guard keeps passing while being wrong about the only thing it checks.
    // ⚠️ Through `readScannedSource`, not a raw `fs.readFileSync` (#812) — and the reason bites
    // here rather than being ceremony: a COMMENTED-OUT `# - engine/assets/**` line would otherwise
    // satisfy the include match and vouch for a path electron-builder does not ship. Comments
    // stripped, so only live YAML entries count.
    const yml = readScannedSource(path.join(repoRoot, 'electron-builder.yml')).code;
    const filesBlock = /^files:\n((?:\s*(?:#.*)?\n|\s+- .*\n)+)/m.exec(yml);
    expect(filesBlock, 'could not find the `files:` block in electron-builder.yml').not.toBeNull();
    // ⚠️ Strip the YAML quotes BEFORE testing for `!`. electron-builder's exclusions are written
    // `- "!engine/tests/**"`, so a `(?!!)` applied to the raw entry sees `"` and lets every
    // exclusion through as an include. The first cut of this guard did exactly that — visible in
    // its own failure message, which listed `"!node_modules/**` among the "include globs".
    const entries = [...filesBlock![1].matchAll(/^\s+- (\S+)/gm)]
      .map((m) => m[1].replace(/^["']|["']$/g, ''));
    const includes = entries.filter((g) => !g.startsWith('!'));
    const excludes = entries.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    expect(includes.length, 'parsed no include globs — the regex or the yml shape changed').toBeGreaterThan(0);
    // ⚠️ A real glob match, not a prefix test. Truncating at the first wildcard turns
    // `engine/**/.vite/**` into the prefix `engine/`, which "matches" every engine path — so the
    // first cut of this reported the real, shipped asset as EXCLUDED and blamed the wrong glob in
    // the message. Only the subset electron-builder actually uses is handled (`**`, `*`, `{a,b}`),
    // which is all `files:` contains; anything richer would need a matcher dependency.
    const matches = (g: string) => {
      const rx = g
        .replace(/[.+^$()|[\]\\]/g, '\\$&')
        .replace(/\{([^}]*)\}/g, (_m, alts: string) => `(?:${alts.split(',').join('|')})`)
        .replace(/\*\*\//g, '@@GLOBSTARSLASH@@')
        .replace(/\*\*/g, '@@GLOBSTAR@@')
        .replace(/\*/g, '[^/]*')
        .replace(/@@GLOBSTARSLASH@@/g, '(?:.*/)?')
        .replace(/@@GLOBSTAR@@/g, '.*');
      return new RegExp(`^${rx}$`).test(BUNDLED_ICON_REL);
    };
    // ⚠️ An include is not enough — `engine/**/*` ships the tree but `!engine/tests/**` carves a
    // hole in it, so an asset parked there would satisfy the include and still be absent from the
    // package. Both halves, or the guard vouches for a path electron-builder drops.
    const excludedBy = excludes.find(matches);
    expect(
      excludedBy,
      `${BUNDLED_ICON_REL} is EXCLUDED from the package by files: "!${excludedBy}" — it will not `
        + 'exist in the packaged editor even though an include glob matches it.',
    ).toBeUndefined();
    expect(
      includes.some(matches),
      `${BUNDLED_ICON_REL} matches none of electron-builder's include globs (${includes.join(', ')}), `
        + 'so it will not exist in the packaged editor and iconStep will silently pass --icon "".',
    ).toBe(true);
  });

  it('is TRACKED, so a fresh clone has it', () => {
    // `bundledIconPath` existing on THIS machine says nothing about a clone: an untracked or
    // gitignored master would pass the first test here and be absent everywhere else — which is
    // how a per-machine fact becomes a repo claim.
    //
    // ⚠️ Via `repoFiles({ includeUntracked: false })`, NOT a direct `git ls-files` — #799/#771/#805
    // make `repoCorpus.mjs` the one sanctioned caller, and `corpusProducerIsShared.test.ts` fails
    // the gate on a second one. (It caught this file on its first run.)
    //
    // `floor: 1` and not 3. The floor exists so a silently-empty enumeration fails as a broken
    // QUERY rather than as "not tracked" — one file is all this assertion needs. Pinning it to the
    // exact current count (3) would make deleting either splash badge redden THIS file, sending the
    // next reader to an asset that has nothing to do with the subject.
    // `repoFiles` yields `{ rel, abs }` records, not bare strings — asserting `toContain` on the
    // raw list passes never, whatever is tracked.
    const tracked = (repoFiles({ under: 'engine/assets', includeUntracked: false, floor: 1 }) as
      { rel: string }[]).map((f) => f.rel);
    expect(tracked).toContain(BUNDLED_ICON_REL);
  });

  it('is a real PNG of the size app-icon generation needs', () => {
    // 1024² because that is what `@capacitor/assets` wants as a source: it downsamples into every
    // iOS AppIcon and Android mipmap bucket, and the largest it emits is 1024. A truncated or
    // placeholder file would otherwise satisfy every check above.
    // ⚠️ NOT the KTX2/Adreno multiple-of-4 rule, which an earlier draft of this comment cited: this
    // asset is a generator SOURCE, never a runtime texture, so that constraint does not apply to
    // it. The check is an exact 1024, which is a stronger and different claim.
    const buf = fs.readFileSync(bundledIconPath(repoRoot)!);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect({ width, height }).toEqual({ width: 1024, height: 1024 });
  });
});
