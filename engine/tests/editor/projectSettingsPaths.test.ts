/** #394 — the Project Settings warning that says a committed path is machine-local, at the
 *  control that produced it. The dialog renders whatever this returns; the decision is here so it
 *  can be tested without mounting a panel in jsdom (CLAUDE.md § Editor). */
import { describe, it, expect } from 'vitest';
import { committedPathWarning, imagePreviewPath, isNonPortableProjectPath, shouldAcceptSettingsDrop } from '../../packages/modoki/src/editor/panels/projectSettingsPaths';

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

/** Which path fields get a thumbnail (#408 follow-up). Owner's call, 2026-08-29: "every path" —
 *  so the rule is the VALUE's extension, not a per-field opt-in that an eighth field would be
 *  forgotten from. */
describe('imagePreviewPath', () => {
  it('previews an image-valued path field', () => {
    expect(imagePreviewPath(icon, 'art/icon-app-master.png')).toBe('art/icon-app-master.png');
    expect(imagePreviewPath(javaHome, 'vendor/logo.WEBP')).toBe('vendor/logo.WEBP');
  });

  it('previews an image in a per-machine field too — "every path" is not "every committed path"', () => {
    // `someone`, not a real username and not an ad-hoc stand-in either: engine/tests/** ships in
    // the public snapshot, and `verify:publish` hard-fails any `/Users/<name>/` whose name is not
    // in its PLACEHOLDER_USERS list. It caught "placeholder" here. Same spelling as line 16.
    expect(imagePreviewPath(javaHome, '/Users/someone/art/icon.png')).toBe('/Users/someone/art/icon.png');
  });

  it('says nothing for a path field holding something that is not an image', () => {
    expect(imagePreviewPath(javaHome, '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home')).toBeNull();
    expect(imagePreviewPath(javaHome, '~/.modoki/keystores/court-upload.jks')).toBeNull();
    // The extension is what is read, and `.bak` is not one of them — a file merely NAMED after an
    // image is not one. Guessing here would put a permanent "not a readable image" under a field
    // that is behaving correctly.
    expect(imagePreviewPath(javaHome, 'art/icon.png.bak')).toBeNull();
  });

  it('says nothing for an empty or absent value', () => {
    expect(imagePreviewPath(icon, '')).toBeNull();
    expect(imagePreviewPath(icon, '   ')).toBeNull();
    expect(imagePreviewPath(icon, undefined)).toBeNull();
    expect(imagePreviewPath(icon, null)).toBeNull();
  });

  it('says nothing for a NON-path field whose value looks like an image', () => {
    // `app.name` holding "logo.png" is a name, not a file — and the preview would 404 forever.
    expect(imagePreviewPath({ type: 'text' }, 'logo.png')).toBeNull();
  });

  it('trims, so a pasted value with trailing whitespace still previews', () => {
    expect(imagePreviewPath(icon, ' art/icon.png ')).toBe('art/icon.png');
  });
});

/** Whether a path field accepts a drag. Found in this change's own close-out: BOTH inert states in
 *  the dialog are `<fieldset disabled>`, which disables form CONTROLS natively — and a `drop`
 *  handler on a div is not one. The per-field `disabledIf` wrapper also sets
 *  `pointerEvents:'none'` and was safe by accident; the WHOLE-FORM wrapper (used when
 *  `configErrors` says the config file did not parse) does not, so a drop there would copy a file
 *  into the project and edit a draft that cannot be saved. */
describe('shouldAcceptSettingsDrop', () => {
  const FILES = ['Files'];
  const ASSET = ['application/editor-asset', 'application/editor-asset-paths'];

  it('accepts an OS file drag and an Assets-panel drag on a live field', () => {
    expect(shouldAcceptSettingsDrop(false, FILES)).toBe(true);
    expect(shouldAcceptSettingsDrop(false, ASSET)).toBe(true);
  });

  it('REFUSES every drag while the field is inert', () => {
    // The disk write is the reason this matters: accepting here copies a file into the project
    // from a form the dialog has declared untrustworthy.
    expect(shouldAcceptSettingsDrop(true, FILES)).toBe(false);
    expect(shouldAcceptSettingsDrop(true, ASSET)).toBe(false);
  });

  it('ignores a drag it cannot consume, so another payload keeps its own cursor', () => {
    expect(shouldAcceptSettingsDrop(false, ['application/editor-entity'])).toBe(false);
    expect(shouldAcceptSettingsDrop(false, [])).toBe(false);
  });

  it('checks disabled FIRST — an inert field refuses a payload it would otherwise take', () => {
    // The ordering is the whole guard: a types-only check passes for exactly the drags that do
    // damage.
    expect(shouldAcceptSettingsDrop(true, ['Files', 'application/editor-asset'])).toBe(false);
  });
});
