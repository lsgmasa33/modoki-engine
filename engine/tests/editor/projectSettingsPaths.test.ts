/** #394 — the Project Settings warning that says a committed path is machine-local, at the
 *  control that produced it. The dialog renders whatever this returns; the decision is here so it
 *  can be tested without mounting a panel in jsdom (CLAUDE.md § Editor). */
import { describe, it, expect } from 'vitest';
import { committedPathWarning, isNonPortableProjectPath } from '../../packages/modoki/src/editor/panels/projectSettingsPaths';

const icon = { type: 'path', committedPath: true } as const;
const javaHome = { type: 'path' } as const;

describe('committedPathWarning (#394)', () => {
  it('warns on an absolute POSIX path in a committed field', () => {
    // The exact shape Browse… produces for a file outside the project — it HAS no relative form,
    // so the picker legitimately returns it absolute and the dialog stores it.
    // A PLACEHOLDER username on purpose: `engine/tests/**` ships in the public snapshot, and
    // `scan-publish-safety.mjs` hard-fails on this machine's real one (it caught this line).
    expect(committedPathWarning(icon, '/Users/someone/Pictures/icon.png')).toMatch(/tracked project\.config\.json/);
  });

  it.each([
    '~/Pictures/icon.png',
    'C:\\art\\icon.png',
    'C:/art/icon.png',
    '\\\\nas\\art\\icon.png',
    // A backslash spelling with no drive letter: what a `win` clone produces by hand, and there the
    // text box is the ONLY route in — /api/pick-path answers `unsupported` off darwin.
    'art\\icon.png',
    // Escapes the project — legal on this machine, dead in a copied-out game (#29).
    '../shared/icon.png',
    'art/../../shared/icon.png',
  ])('warns on the non-portable path %s', (v) => expect(committedPathWarning(icon, v)).not.toBeNull());

  it('says nothing about a project-relative path', () => {
    expect(committedPathWarning(icon, 'art/icon-app-master.png')).toBeNull();
  });

  it('says nothing about an empty or whitespace value', () => {
    // Empty is the scaffolder's default (= the bundled Modoki icon), not a mistake.
    expect(committedPathWarning(icon, '')).toBeNull();
    expect(committedPathWarning(icon, '   ')).toBeNull();
    expect(committedPathWarning(icon, undefined)).toBeNull();
  });

  it('says nothing about an absolute path in a per-machine field', () => {
    // `user.sdk.javaHome` round-trips to the gitignored project.user.json, where absolute is the
    // only useful value. Warning there would train the owner to ignore the warning.
    expect(committedPathWarning(javaHome, '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home')).toBeNull();
  });

  it('says nothing about a non-path field that happens to hold a slash', () => {
    expect(committedPathWarning({ type: 'text', committedPath: true }, '/court/')).toBeNull();
  });

  it('does not read a directory whose NAME begins with two dots as an escape', () => {
    // `..art` is inside the project; only a `..` SEGMENT leaves it. The relativiser makes the same
    // distinction (see plugins/projectPaths.test.ts) — this is the warning's half of it.
    expect(isNonPortableProjectPath('..art/icon.png')).toBe(false);
    expect(isNonPortableProjectPath('art/..icon.png')).toBe(false);
  });
});
