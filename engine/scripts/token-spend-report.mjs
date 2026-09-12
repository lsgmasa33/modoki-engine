#!/usr/bin/env node
/** Where the token spend actually goes — measured from Claude Code's own local transcripts (#1104).
 *
 *      node engine/scripts/token-spend-report.mjs              # every modoki clone on this machine
 *      node engine/scripts/token-spend-report.mjs <dir> [...]  # specific transcript directories
 *
 *  ⚠️ **This answers a question `docs/mcp-response-budget.md` declared unanswerable.** That doc's
 *  churn section says the saving "can't be sized from inside a session (no access to
 *  `cache_read_input_tokens`)" — true, and irrelevant: Claude Code writes every turn's usage block
 *  to `~/.claude/projects/<slug>/*.jsonl`, and this script reads them from outside. Every
 *  quantitative claim in that doc downstream of the missing accounting was an estimate; this is the
 *  measurement.
 *
 *  ⚠️ **PRIVACY — this reads the owner's own prompts and pasted file contents.** It must only ever
 *  emit COUNTS, TOKEN TOTALS and TOOL NAMES. No prompt text, no file excerpts, no tool arguments,
 *  no session titles. Tool names are safe (they are a public surface); tool arguments are not (a
 *  `Bash` command line carries paths, and `modoki_eval` carries source). If you extend this, that
 *  is the line: aggregate, never quote. `npm run verify:publish` is a backstop, not the design.
 *
 *  ## What the numbers mean
 *
 *  `cache_creation_input_tokens` is material entering the cached prefix this turn; `cache_read_input
 *  _tokens` is the whole prefix being read back. So a turn's creation is (roughly) the PREVIOUS
 *  turn's tool result plus the model's own output, which is what makes per-tool attribution
 *  possible at all — see `attributeGrowth`.
 *
 *  Spend is reported in **base-input-token equivalents** rather than currency: a cache write costs
 *  1.25x a base input token, a cache read 0.1x, an output token 5x. Those are API mechanics, and
 *  the ratios are what the comparison turns on — quoting a price would date the report and would
 *  need a billed `count_tokens` call to be honest about the tokenizer anyway.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Cache economics, as multiples of one base input token. */
const COST = { create: 1.25, read: 0.1, out: 5, input: 1 };

/** A resume or a context compaction re-lays the whole prefix, so its `cache_creation` is not new
 *  material and attributing it to a tool would swamp every real number. Both land the read back
 *  near the bare-prefix floor while paying a large creation — that shape is the discriminator.
 *
 *  ⚠️ Deliberately does NOT key on the time gap. A compaction can happen back-to-back inside an
 *  active minute (measured: three in one session, 0.1-0.3 min apart), so a gap test would classify
 *  the most expensive ones as ordinary growth. */
function isPrefixReset(prev, cur) {
  return prev.read > 20_000 && cur.read < prev.read * 0.5 && cur.create > 10_000;
}

/** Every assistant turn in one transcript, deduped by message id.
 *
 *  ⚠️ The dedupe is load-bearing, not tidiness: a turn appears once per content block, each copy
 *  carrying the SAME usage object. Summing without it double-counts every turn that made a tool
 *  call — which is most of them — and inflates the totals by roughly 2x. */
function readTurns(path) {
  const seen = new Set();
  const turns = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant') continue;
    const msg = rec.message;
    if (!msg?.usage) continue;
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    turns.push({
      t: Date.parse(rec.timestamp),
      create: msg.usage.cache_creation_input_tokens ?? 0,
      read: msg.usage.cache_read_input_tokens ?? 0,
      input: msg.usage.input_tokens ?? 0,
      out: msg.usage.output_tokens ?? 0,
      tools: (msg.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name),
    });
  }
  return turns;
}

function collect(roots) {
  const sessions = [];
  for (const root of roots) {
    let files;
    try { files = readdirSync(root).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const path = join(root, file);
      if (statSync(path).size === 0) continue;
      const turns = readTurns(path);
      if (turns.length) sessions.push({ clone: root.split('/').pop(), turns });
    }
  }
  return sessions;
}

/** Context growth charged to the tool call that caused it.
 *
 *  Only turns whose predecessor made EXACTLY ONE tool call are attributed: with two parallel calls
 *  in a turn there is no non-guessing way to split the creation between them, and guessing would
 *  quietly bias whichever tool is commonly batched. Prefix resets are skipped for the reason in
 *  `isPrefixReset`. */
function attributeGrowth(sessions) {
  const per = new Map();
  for (const { turns } of sessions) {
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1];
      const cur = turns[i];
      if (isPrefixReset(prev, cur)) continue;
      if (prev.tools.length !== 1) continue;
      const name = prev.tools[0];
      const e = per.get(name) ?? { calls: 0, added: 0, sizes: [] };
      e.calls++;
      e.added += cur.create;
      e.sizes.push(cur.create);
      per.set(name, e);
    }
  }
  return per;
}

const fmt = (n) => Math.round(n).toLocaleString();
const quantile = (sorted, p) => sorted[Math.floor(sorted.length * p)] ?? 0;

function main() {
  let roots = process.argv.slice(2);
  if (roots.length === 0) {
    const base = join(homedir(), '.claude', 'projects');
    roots = existsSync(base)
      ? readdirSync(base).filter((d) => /Projects-modoki/.test(d)).map((d) => join(base, d))
      : [];
  }
  if (roots.length === 0) {
    console.error('no transcript directories found — pass them explicitly');
    process.exit(1);
  }

  const sessions = collect(roots);
  if (sessions.length === 0) {
    console.error('no sessions with usage data in: ' + roots.join(', '));
    process.exit(1);
  }

  let C = 0, R = 0, O = 0, I = 0, turnCount = 0;
  const ctx = [];
  const resets = [];
  for (const { turns } of sessions) {
    turnCount += turns.length;
    let prev = null;
    for (const cur of turns) {
      C += cur.create; R += cur.read; O += cur.out; I += cur.input;
      ctx.push(cur.read + cur.create);
      if (prev && isPrefixReset(prev, cur)) {
        resets.push({ create: cur.create, gapMin: (cur.t - prev.t) / 60_000,
          after: prev.tools.join('+') || '(text)' });
      }
      prev = cur;
    }
  }
  ctx.sort((a, b) => a - b);

  const eq = { create: C * COST.create, read: R * COST.read, out: O * COST.out, input: I * COST.input };
  const total = Object.values(eq).reduce((a, b) => a + b, 0);

  console.log(`transcripts: ${sessions.length} sessions, ${fmt(turnCount)} assistant turns`);
  console.log(`context per turn: median ${fmt(quantile(ctx, 0.5))}  p90 ${fmt(quantile(ctx, 0.9))}  max ${fmt(ctx[ctx.length - 1])}`);
  console.log('\nSHARE OF SPEND (base-input-token equivalents)');
  for (const [k, v] of Object.entries(eq)) {
    console.log(`  ${k.padEnd(8)} ${fmt(v).padStart(15)}  ${(v / total * 100).toFixed(1)}%`);
  }

  const ratio = R / C;
  console.log(`\nRE-READ RATIO: each cached token is read back ${ratio.toFixed(1)}x on average`);
  console.log(`  => one context token costs ${COST.create} + ${ratio.toFixed(1)} x ${COST.read} = ${(COST.create + ratio * COST.read).toFixed(1)}x a base input token`);
  console.log(`  => 1,000 tokens of tool output ~= ${fmt((COST.create + ratio * COST.read) * 1000)} equivalents`);

  const resetCost = resets.reduce((a, r) => a + r.create, 0) * COST.create;
  console.log(`\nPREFIX RESETS (resume / compaction / any tools-block change): ${resets.length}`);
  console.log(`  re-created ${fmt(resets.reduce((a, r) => a + r.create, 0))} tokens = ${(resetCost / total * 100).toFixed(2)}% of spend`);
  const midflow = resets.filter((r) => r.gapMin < 20);
  console.log(`  of which back-to-back (under 20 min idle, so not a session resume): ${midflow.length}`);

  const per = attributeGrowth(sessions);
  const grown = [...per.values()].reduce((a, e) => a + e.added, 0);
  console.log(`\nCONTEXT GROWTH BY TOOL — ${fmt(grown)} tokens over ${fmt([...per.values()].reduce((a, e) => a + e.calls, 0))} single-tool turns`);
  console.log('  tool                                   calls        added   avg/call   share');
  for (const [name, e] of [...per].sort((a, b) => b[1].added - a[1].added).slice(0, 15)) {
    console.log(`  ${name.padEnd(36)} ${String(e.calls).padStart(6)} ${fmt(e.added).padStart(12)} ${fmt(e.added / e.calls).padStart(10)} ${(e.added / grown * 100).toFixed(1).padStart(6)}%`);
  }

  // Is a tool's cost a fat TAIL (a threshold guard helps) or sheer VOLUME (only fewer calls help)?
  // The two want opposite fixes, and the answer differs per tool — see docs/agent-context-cost.md.
  console.log('\n  SHAPE OF THE COST (tail vs volume), tools with >= 100 calls:');
  for (const [name, e] of [...per].filter(([, e]) => e.calls >= 100).sort((a, b) => b[1].added - a[1].added).slice(0, 8)) {
    const s = e.sizes.slice().sort((a, b) => a - b);
    const worst10 = s.slice(Math.floor(s.length * 0.9)).reduce((a, b) => a + b, 0);
    console.log(`  ${name.padEnd(36)} median ${fmt(quantile(s, 0.5)).padStart(6)}  p90 ${fmt(quantile(s, 0.9)).padStart(7)}  worst 10% = ${(worst10 / e.added * 100).toFixed(0).padStart(2)}% of its growth`);
  }
}

main();
