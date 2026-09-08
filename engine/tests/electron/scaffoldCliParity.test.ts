// @vitest-environment node
/**
 * #945 B2 — the scaffolder CLI produces the same project as File → New Project.
 *
 * `engine/scripts/scaffold-project.mjs` and `engine/electron/newProject.ts` are TWO independent
 * implementations of one copy-and-substitute contract. The CLI's own header claims "the SAME
 * template + token contract" as File → New Project, and CLAUDE.md tells every session to use the
 * CLI and never hand-write these files — but until now nothing enforced the claim:
 * `newProject.test.ts` correctly drives the OUTPUT, and drives it of the OTHER implementation.
 * Nothing spawned the CLI at all, so it could drift or break outright and stay green.
 *
 * This is the same defect shape as B1 in that issue — a verification aimed at a copy of the code
 * rather than the one a user reaches — with the twist that here BOTH copies are real, so the fix
 * is to assert they agree rather than to pick one.
 *
 * ⚠️ **The scaffolder mints fresh GUIDs on purpose**, so a byte-for-byte diff of the scene is
 * guaranteed to fail. GUIDs are masked before comparing — and the masking is itself asserted
 * (see "the GUIDs really were fresh"), because a mask that swallowed everything would make this
 * whole suite unfalsifiable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldProject, slugify } from '../../electron/newProject';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../scripts/scaffold-project.mjs');
const TEMPLATE_DIR = path.resolve(here, '../../templates/starter');
const NAME = 'My Cool Game';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const tmpdirs: string[] = [];
function tmp(prefix: string): string {
  // `realpathSync.native` because on macOS the temp dir is reached through a symlink, and the
  // scaffolders `path.resolve` their target — an unresolved base would make the two outputs
  // differ by spelling alone.
  const d = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  tmpdirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Every file under `root`, as relative POSIX paths → contents (GUIDs masked). */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8').replace(UUID_RE, '<guid>'));
    }
  };
  walk(root);
  return out;
}

/** Both implementations, run into their own fresh directory, for the same project name. */
function bothScaffolds() {
  const viaCli = path.join(tmp('modoki-scaffold-cli-'), 'proj');
  execFileSync(process.execPath, [CLI, viaCli, NAME], { stdio: 'pipe', encoding: 'utf8' });
  const viaApi = path.join(tmp('modoki-scaffold-api-'), 'proj');
  scaffoldProject(viaApi, { name: NAME, templateDir: TEMPLATE_DIR });
  return { viaCli, viaApi };
}

describe('scaffold-project.mjs (the CLI) matches File → New Project (#945 B2)', () => {
  it('produces the identical file set', () => {
    const { viaCli, viaApi } = bothScaffolds();
    expect([...tree(viaCli).keys()]).toEqual([...tree(viaApi).keys()]);
  });

  it('produces identical contents for every file, once fresh GUIDs are masked', () => {
    const { viaCli, viaApi } = bothScaffolds();
    const a = tree(viaCli);
    const b = tree(viaApi);
    for (const [rel, text] of a) {
      expect(text, `${rel} differs between the CLI and File → New Project`).toBe(b.get(rel));
    }
  });

  it('substituted the tokens rather than copying them through', () => {
    // Without this, a scaffolder that copied the template VERBATIM would satisfy both cases
    // above (both copies would be equally wrong) — the parity assertion alone cannot see it.
    const { viaCli } = bothScaffolds();
    // No token survives ANYWHERE — checked across the whole tree rather than in one file,
    // because which file carries which token is a template detail that moves.
    for (const [rel, text] of tree(viaCli)) {
      for (const token of ['__GAME_ID__', '__GAME_NAME__', '__APP_ID__']) {
        expect(text, `${rel} still carries ${token}`).not.toContain(token);
      }
    }
    // …and the substituted values actually landed. `game.ts` is where the id goes;
    // `project.config.json` carries the name and appId but NOT the id.
    expect(fs.readFileSync(path.join(viaCli, 'game.ts'), 'utf8')).toContain(slugify(NAME));
    const cfg = fs.readFileSync(path.join(viaCli, 'project.config.json'), 'utf8');
    expect(cfg).toContain(NAME);
    expect(cfg).toContain(`com.example.${slugify(NAME).replace(/-/g, '')}`);
  });

  it('the GUIDs really were fresh — so the mask is hiding a difference, not everything', () => {
    // The masking above is load-bearing. If the two scenes happened to be identical the mask
    // would be doing nothing and this suite would still pass, so assert the opposite directly:
    // the two scaffolds must disagree on the raw GUIDs while agreeing on the masked text.
    const { viaCli, viaApi } = bothScaffolds();
    const rel = 'runtime/assets/scenes/main.scene.json';
    const rawA = fs.readFileSync(path.join(viaCli, rel), 'utf8');
    const rawB = fs.readFileSync(path.join(viaApi, rel), 'utf8');
    const guids = (s: string) => [...new Set(s.match(UUID_RE) ?? [])];
    // The TEMPLATE's guids are collected STRUCTURALLY (JSON.parse + the two fields the
    // scaffolders themselves remint), not by regexing the raw file. Two reasons: it matches
    // production's own notion of which guids get reminted rather than "anything UUID-shaped",
    // and `commentStripperIsShared` correctly objects to a test pattern-matching raw REPO source
    // — reading it as parsed DATA is not that defect and is excluded by the guard by design.
    const doc = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8')) as {
      id?: string;
      entities?: { traits?: { EntityAttributes?: { guid?: string } } }[];
    };
    const template = [...new Set([
      ...(typeof doc.id === 'string' && doc.id ? [doc.id] : []),
      ...(doc.entities ?? []).map((e) => e.traits?.EntityAttributes?.guid).filter((g): g is string => Boolean(g)),
    ])];
    expect(template.length, 'the starter scene should carry GUIDs to remint').toBeGreaterThan(0);

    // ⚠️ **Compare each output against the TEMPLATE, not against each other.** "A's guids differ
    // from B's" is the obvious assertion and it is unfalsifiable: if one scaffolder stopped
    // reminting entirely, its output would carry the template's guids and the other's would be
    // fresh — still different, still green. Measured: that mutation passed this case until it
    // was rewritten this way. What actually has to hold is that NEITHER output reuses a
    // template guid, which is what reminting is FOR (two projects must not share entity
    // identity).
    for (const [label, raw] of [['CLI', rawA], ['File → New Project', rawB]] as const) {
      expect(guids(raw).length, `${label}: scene should still carry guids`).toBe(template.length);
      for (const g of guids(raw)) {
        expect(template, `${label} reused the template guid ${g} — it did not remint`).not.toContain(g);
      }
    }
    expect(guids(rawA), 'two scaffolds must not share entity identity either').not.toEqual(guids(rawB));
    expect(rawA.replace(UUID_RE, '<guid>')).toBe(rawB.replace(UUID_RE, '<guid>'));
  });

  it('refuses a non-empty target, like the API does', () => {
    const dir = path.join(tmp('modoki-scaffold-busy-'), 'proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'occupied.txt'), 'x');
    // ⚠️ A bare `toThrow()` on a spawned CLI is satisfied by ANY crash — a syntax error, a bad
    // import, the wrong node — so it would pass on a scaffolder that never got as far as the
    // check. Assert on the refusal MESSAGE, the way the API half does (close-out review).
    let stderr = '';
    expect(() => {
      try {
        execFileSync(process.execPath, [CLI, dir, NAME], { stdio: 'pipe', encoding: 'utf8' });
      } catch (e) {
        stderr = String((e as { stderr?: string }).stderr ?? '');
        throw e;
      }
    }).toThrow();
    expect(stderr, 'the CLI must refuse for the RIGHT reason, not merely crash').toMatch(/exists and is not empty/);
    expect(() => scaffoldProject(dir, { name: NAME, templateDir: TEMPLATE_DIR })).toThrow(/not empty/);
  });
});
