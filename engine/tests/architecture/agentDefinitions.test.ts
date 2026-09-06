/**
 * Guard: every `.claude/agents/*.md` is well-formed, and every repo-defined agent that
 * `CLAUDE.md` or a skill runbook NAMES actually exists.
 *
 * WHY THIS EXISTS. `CLAUDE.md` § "Model routing" makes the `opus-*` agents load-bearing:
 * the interactive session runs Sonnet and reaches Opus ONLY by spawning one of them. So a
 * definition that fails to register — a typo'd `model:`, a `name:` that disagrees with its
 * filename, a missing frontmatter delimiter — does not fail loudly. It degrades silently to
 * "escalation did not happen", which is indistinguishable from "escalation was not needed",
 * and the whole routing rule quietly stops working. `/close-out` § 2 is the sharpest case:
 * it delegates its adversarial review to `opus-reviewer`, so an unreachable definition means
 * the change gets reviewed by the same model that wrote it, reporting a pass either way.
 *
 * That is this repo's dominant defect shape — a mechanism that cannot fire, with no error —
 * and nothing guarded `.claude/agents/**` at all before this.
 *
 * SCOPE: repo-DEFINED agents only, matched on this repo's `<model>-<role>` naming convention
 * (`opus-planner`, `sonnet-implementer`, …). Built-in agent types (`Explore`, `Plan`,
 * `general-purpose`) are supplied by the harness and have no file, so a guard that demanded
 * a file for every name in `CLAUDE.md` would fail on them.
 *
 * The `.claude/` tree is NOT shipped in the public engine snapshot (see
 * `scripts/publish-engine-oss.sh`), hence the `hasAgentDefinitions()` gate — #159's recipe
 * guard is the standing proof that a `.claude/**` guard which forgets to gate goes red on
 * the public CI legs minutes after a push.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, hasAgentDefinitions } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const AGENT_DIR = path.join(REPO_ROOT, '.claude', 'agents');

/** Models a definition may name. `inherit` is legal and means "the spawning session's model". */
const KNOWN_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);

/** This repo's own agent-naming convention. Deliberately NOT "any backticked word": built-in
 *  agent types have no file, and demanding one for them is a false positive, not a finding. */
const REPO_AGENT_NAME = /\b((?:opus|sonnet|haiku)-[a-z][a-z0-9-]*)\b/g;

interface Def { file: string; name: string; body: string; fm: Record<string, string> }

function parseAgents(): Def[] {
  return fs
    .readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const raw = fs.readFileSync(path.join(AGENT_DIR, file), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
      if (!m) return { file, name: '', body: '', fm: {} };
      const fm: Record<string, string> = {};
      for (const line of m[1].split('\n')) {
        const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
        if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
      return { file, name: fm.name ?? '', body: m[2], fm };
    });
}

/** Every place that may NAME an agent and expect it to be spawnable. */
function referencingFiles(): string[] {
  const out = [path.join(REPO_ROOT, 'CLAUDE.md')];
  // Enumerated through the ONE shared producer (#799/#771/#805), like every other corpus in the
  // repo. `.claude/skills/**` is tracked content, so git can enumerate it — it is not the
  // build-output or scratch-dir case that genuinely cannot use the producer.
  //
  // `floor: 0` because this is module-adjacent and `.claude/` is one of the directories
  // `scripts/publish-engine-oss.sh` does NOT ship: on the public OSS snapshot there are no skills
  // at all, and a throw there would fail collection rather than let the guard scan just CLAUDE.md.
  // The suite gates on `hasAgentDefinitions()` (see the `describe.skipIf` below), and the snapshot
  // ships neither `.claude/agents` nor `.claude/skills` — so an empty result here is an expected
  // state, not a broken enumeration.
  for (const { abs } of repoFiles({ under: '.claude/skills', match: /\.md$/, floor: 0 })) {
    out.push(abs);
  }
  return out.filter((f) => fs.existsSync(f));
}

describe.skipIf(!hasAgentDefinitions())('.claude/agents definitions are reachable', () => {
  it('finds definitions at all — a zero-file sweep would pass every assertion below', () => {
    // The failure this repo has seen twice: a query stops matching and the guard goes quiet
    // while reporting success.
    const defs = parseAgents();
    expect(defs.length).toBeGreaterThanOrEqual(4);
  });

  it('every definition parses and carries the required frontmatter', () => {
    const bad = parseAgents()
      .filter((d) => !d.fm.name || !d.fm.description || !d.fm.model)
      .map((d) => d.file);
    expect(bad, `missing name/description/model frontmatter: ${bad.join(', ')}`).toEqual([]);
  });

  it('every `name:` matches its filename — the harness resolves by name, not by path', () => {
    const mismatched = parseAgents()
      .filter((d) => d.name !== d.file.replace(/\.md$/, ''))
      .map((d) => `${d.file} declares name: ${d.name || '(none)'}`);
    expect(mismatched).toEqual([]);
  });

  it('every `model:` is one the harness understands', () => {
    const unknown = parseAgents()
      .filter((d) => d.fm.model && !KNOWN_MODELS.has(d.fm.model))
      .map((d) => `${d.file}: model: ${d.fm.model}`);
    expect(unknown).toEqual([]);
  });

  it('every `opus-*` definition really is an Opus agent', () => {
    // The silent-degradation case the routing rule cares about: an escalation target that
    // is named like Opus and runs as something cheaper escalates nothing, and says nothing.
    const wrong = parseAgents()
      .filter((d) => d.name.startsWith('opus-') && d.fm.model !== 'opus')
      .map((d) => `${d.file}: model: ${d.fm.model}`);
    expect(wrong).toEqual([]);
  });

  it('every repo-defined agent NAMED by CLAUDE.md or a skill exists as a definition', () => {
    const defined = new Set(parseAgents().map((d) => d.name));
    const dangling: string[] = [];
    let referenced = 0;
    for (const file of referencingFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(REPO_AGENT_NAME)) {
        referenced++;
        if (!defined.has(m[1])) {
          dangling.push(`${path.relative(REPO_ROOT, file)} names \`${m[1]}\``);
        }
      }
    }
    // Non-vacuity: if the pattern stops matching, this guard would pass while checking
    // nothing. CLAUDE.md § Model routing alone names four.
    expect(referenced, 'agent-name scan matched nothing — the pattern is broken').toBeGreaterThanOrEqual(4);
    expect([...new Set(dangling)]).toEqual([]);
  });
});
