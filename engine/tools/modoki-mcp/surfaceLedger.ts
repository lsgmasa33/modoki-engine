/** The #894 ledger: per-clone, per-day, per-tool CSV of what the MCP tool surface cost.
 *
 *  `DEFINITION_BYTES` (`engine/tests/tools/mcpRegistry.test.ts`) is and stays the gate. It is a
 *  single scalar, so it can say the surface grew but never WHICH tool or WHOSE change grew it: six
 *  clones each stay inside the 4,000-byte headroom alone, and whoever crosses first inherits the
 *  union. `61fccae48` is the pure case — a re-pin after a four-branch merge where no tool changed.
 *
 *  Settled by the owner (2026-09-10): keep the committed pin as the verdict, and add attribution as
 *  DATA beside it. Nothing here is ever consulted for red/green — `npm run verify` and the free
 *  3-OS public CI compute the same result from the same committed number as before. An earlier
 *  sketch put the counter in a machine-local file and was rejected for exactly that reason: CI has
 *  no such file, a fresh clone has no such file, and the Windows clone cannot share the Mac's.
 *
 *  ⚠️ **What a row can and cannot tell you (revised by #1103).** A row says: *on this date, on this
 *  clone, tool X measured N bytes, having moved D since ANYONE last looked at a commit in this
 *  clone's history.* Since #1103 the delta is taken against the whole corpus of CSVs rather than
 *  this clone's own file (`corpusBaseline`), so **work that merely arrived via `git merge` books
 *  nothing** and a clone's column sums to what that lane actually spent.
 *
 *  This paragraph used to say the opposite — *"a delta it observes may be work that arrived from
 *  another clone entirely… do not read the `clone` column as authorship"* — which stated the defect
 *  as a guarantee and left the corpus over-reporting every lane that merges often. Two limits that
 *  DO survive: two clones changing the same tool concurrently still book against whoever runs
 *  second, and **rows dated on or before 2026-09-12 pre-date the fix**, so any sum reaching back
 *  past that date still double-counts every merged change. They were left uncorrected deliberately
 *  — the CSV is automated on purpose, and a hand-edited ledger is worse than a wrong one.
 *
 *  The `sha` column remains what turns an interesting row into an answer (`git log`/`git blame`
 *  from there), and the ledger's job is still to make you look at four rows instead of an
 *  anonymous 4 KB.
 *
 *  ⚠️ **One CSV per clone, never one shared file.** Six writers appending to one file conflict on
 *  every merge; six files never do, and the sum is a glob. Query with sqlite:
 *
 *      sqlite3 :memory: '.import --csv engine/tools/modoki-mcp/ledger/work-ai3.csv l' 'select …'
 *
 *  Rendering and parsing live here so the writer (`gen-surface-ledger.ts`) and its tests drive the
 *  same functions — conventions §9, the same reason `gen-tool-catalog.ts` shares `renderCatalog()`
 *  with its sync guard. */

export const LEDGER_HEADER = 'date,clone,tool,delta_bytes,tool_bytes_after,surface_bytes_after,sha';

export type LedgerRow = {
  date: string;
  clone: string;
  tool: string;
  deltaBytes: number;
  toolBytesAfter: number;
  surfaceBytesAfter: number;
  sha: string;
};

/** Every row already recorded, oldest first. Tolerates a missing/blank file (a clone's first run)
 *  and ignores a trailing newline; anything else malformed throws rather than silently skewing the
 *  baseline, because a dropped row reads as "this tool never changed". */
export function parseLedger(csv: string): LedgerRow[] {
  // ⚠️ Strip a UTF-8 BOM first. A hand-edit on the Windows clone can add one, and it would make
  // `lines[0] !== LEDGER_HEADER` on a file that is otherwise perfectly valid — throwing on every
  // run from then on.
  const lines = csv.replace(/^\uFEFF/, '').split('\n')
    .map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  if (lines[0] !== LEDGER_HEADER) throw new Error(`unexpected ledger header: ${lines[0]}`);
  return lines.slice(1).map((line, i) => {
    const f = line.split(',');
    if (f.length !== 7) throw new Error(`ledger line ${i + 2} has ${f.length} fields, expected 7`);
    const [date, clone, tool, delta, after, surface, sha] = f;
    // ⚠️ Field COUNT is not field TYPE, and checking only the count is how this docblock's promise
    // was broken: a typo of `691` → `69l` keeps seven fields, so it parsed, `Number()` returned
    // `NaN`, and that `NaN` became the tool's baseline. From there every delta against it is `NaN`,
    // which is never `=== 0`, so the "no change appends nothing" skip never fires and the `NaN` is
    // written back into the file on every run — a ledger silently under-reporting one tool forever,
    // with nothing red anywhere.
    // ⚠️ A DECIMAL INTEGER, not merely something `Number()` survives. `Number.isFinite` alone was
    // not enough and the gap is the more plausible input of the two: `Number('') === 0`, finite, so
    // a deleted cell from a hand-edit or a spreadsheet round-trip parses clean as ZERO. The tool's
    // baseline silently becomes 0 and the next run books its whole size as a fresh delta against
    // this clone — exactly the mis-attribution the ledger exists to prevent, with no `NaN` anywhere
    // to notice. (`0x2b3` was likewise accepted as 691.) The writer only ever emits decimal
    // integers, so anything else means the file was edited by something that should not have.
    const raw = { deltaBytes: delta, toolBytesAfter: after, surfaceBytesAfter: surface };
    for (const [key, text] of Object.entries(raw)) {
      if (!/^-?\d+$/.test(text)) {
        throw new Error(`ledger line ${i + 2}: ${key} is not a decimal integer (${JSON.stringify(text)})`);
      }
    }
    return {
      date, clone, tool, sha,
      deltaBytes: Number(delta),
      toolBytesAfter: Number(after),
      surfaceBytesAfter: Number(surface),
    };
  });
}

/** The last size this clone recorded for each tool, reading one file as an append-only log so later
 *  rows win. Kept as the FALLBACK baseline only — see `corpusBaseline`, which is what the writer
 *  actually uses. */
export function lastKnownSizes(rows: readonly LedgerRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.tool, row.toolBytesAfter);
  return out;
}

/** Where each row's commit sits in THIS tree's history: 0 = HEAD, larger = older, absent = not an
 *  ancestor. Keyed by the sha exactly as the CSV spells it, so the pure function never has to know
 *  about abbreviation lengths — resolving that is the writer's job (`gen-surface-ledger.ts`). */
export type ShaRank = ReadonlyMap<string, number>;

/** The baseline the next diff is taken against: the most recent size ANY clone recorded for each
 *  tool, among rows whose commit is in this tree's history (#1103).
 *
 *  ⚠️ **Why the corpus and not this clone's own file.** `lastKnownSizes` above diffs against what
 *  THIS clone last saw, which is correct for local work and wrong across a merge: everything
 *  another clone landed since your last run arrives in your tree at once and is booked again under
 *  you, with the MERGE COMMIT as the sha. Measured on the committed corpus before this fix, the
 *  same 361 B of `modoki_press_key` was booked by THREE clones on one day (`work-ai3` authored it;
 *  `work-ai2` and `work-qa` each merged it), and `modoki_type_text` and `modoki_ota_publish` the
 *  same. Summing a clone's column to ask "what has this lane spent" therefore over-reported every
 *  lane that merges often — which is the question #894 created the ledger to answer.
 *
 *  The fix works because **each clone's CSV travels with its commits**: the merge that brings in
 *  another clone's tool change also brings in the row that booked it, so the information needed to
 *  not re-book is already in the tree when the writer runs.
 *
 *  ⚠️ **Ordered by `git rev-list HEAD` position — which is reverse-CHRONOLOGICAL, not a topological
 *  ancestry order.** An earlier version of this docblock claimed ancestry; that is wrong and the
 *  difference bites exactly where it matters. Within one line of history the two agree. For two rows
 *  on DIVERGENT branches — the only case the corpus really poses — rank is decided by committer
 *  DATE, across machines, including the Windows clone's clock.
 *
 *  What the rank IS still good for: a sha absent from the map is not in this tree at all, so the row
 *  describes a tree this clone does not have and cannot be its baseline. That half is sound.
 *
 *  ⚠️ **The date ordering creates one hazard, and it is NOT guarded — see the paragraph below.** A
 *  clone can book a change at X, another clone can seed later-dated rows at W that predate X's
 *  content, and after a merge rank(W) < rank(X) would revert the baseline BELOW what this clone
 *  already recorded — re-booking its own bytes a second time, the exact double-count #1103 removes.
 *  Measured over the committed corpus at the time of the fix: 543 rows, 17 shas, **zero live
 *  instances** — a structural hazard, not a present miscount.
 *
 *  ⚠️ **Deliberately NOT guarded, and a "floor at this clone's own latest row" is the wrong fix —
 *  it was written, tested and reverted.** The two cases are indistinguishable by rank: #1103's
 *  case is *my row old, their merged row new* and the hazard is *my row new, their later-dated row
 *  old*, and in both the wanted answer is the newer OBSERVATION. Rank is committer date, which
 *  settles the first and inverts the second; a rank floor gets the second right by breaking the
 *  first. Telling them apart needs a real ancestry partial order (`merge-base --is-ancestor`),
 *  which `git rev-list` position is not. Tracked as its own issue rather than half-fixed here.
 *
 *  ⚠️ **An empty `order` falls back to this clone's own file, in file order — the pre-#1103
 *  behaviour.** The point is that a baseline of NOTHING is indistinguishable from a clean tree, so
 *  treating "no ranks" as "nothing is known" would book the entire 150 KB surface against whoever
 *  hit it. Degrading to the old known behaviour is the right failure.
 *
 *  ⚠️ **This function cannot tell WHY the map is empty, and an earlier docblock claimed it could.**
 *  The writer returns an empty map both when `git` throws and when no recorded sha prefix-matches
 *  (a branch cut from an old base, a reset past every recorded sha). The second case is the nastier
 *  one: the fallback then trusts rows describing a tree this clone no longer has, so the next delta
 *  can be measured against a FUTURE measurement and book a spurious negative. The writer warns on
 *  an empty map for exactly this reason — read its stderr before trusting a run that printed one. */
export function corpusBaseline(args: {
  rows: readonly LedgerRow[];
  order: ShaRank;
  fallbackClone: string;
}): Map<string, number> {
  const { rows, order, fallbackClone } = args;
  if (order.size === 0) {
    return lastKnownSizes(rows.filter((r) => r.clone === fallbackClone));
  }
  const best = new Map<string, { rank: number; bytes: number }>();
  for (const row of rows) {
    const rank = order.get(row.sha);
    if (rank === undefined) continue;   // not in this tree at all
    const prev = best.get(row.tool);
    // Strictly-less, so the FIRST row wins a tie. A tie means two clones recorded at the same
    // commit, where the measured size is the same by construction — there is nothing to choose.
    if (prev === undefined || rank < prev.rank) best.set(row.tool, { rank, bytes: row.toolBytesAfter });
  }
  const out = new Map<string, number>();
  for (const [tool, { bytes }] of best) out.set(tool, bytes);
  return out;
}

/** The rows this run should append: one per tool whose size CHANGED, plus one per tool that
 *  appeared or vanished.
 *
 *  ⚠️ A run that changed nothing appends NOTHING. That is load-bearing: hooked into `/close-out`,
 *  an unconditional row per run would add ~105 rows a day of pure noise and make the "by days by
 *  tool" query useless — the thing the ledger exists to answer.
 *
 *  ⚠️ A clone's FIRST run seeds every tool at `delta_bytes: 0`, not at its full size. A baseline is
 *  where this clone started observing, not 152 KB that this clone spent — recording it as a delta
 *  would put a fictional six-figure spend against whichever clone happened to run first. */
export function ledgerDelta(args: {
  perTool: ReadonlyMap<string, number>;
  lastKnown: ReadonlyMap<string, number>;
  date: string;
  clone: string;
  sha: string;
  seeding?: boolean;
}): LedgerRow[] {
  const { perTool, lastKnown, date, clone, sha } = args;
  const seeding = args.seeding ?? lastKnown.size === 0;
  let surfaceBytesAfter = 0;
  for (const bytes of perTool.values()) surfaceBytesAfter += bytes;
  const names = [...new Set([...perTool.keys(), ...lastKnown.keys()])].sort();
  const rows: LedgerRow[] = [];
  for (const tool of names) {
    const after = perTool.get(tool);
    const before = lastKnown.get(tool);
    // A removed tool is recorded at 0 with a negative delta — the surface genuinely shrank, and a
    // silently dropped row would leave its last size standing as the baseline forever.
    const toolBytesAfter = after ?? 0;
    const deltaBytes = seeding ? 0 : toolBytesAfter - (before ?? 0);
    if (!seeding && deltaBytes === 0) continue;
    rows.push({ date, clone, tool, deltaBytes, toolBytesAfter, surfaceBytesAfter, sha });
  }
  return rows;
}

/** CSV text for `rows`, header included only when the file is new. Always ends in a newline so the
 *  next append starts on its own line. */
export function renderLedger(rows: readonly LedgerRow[], opts: { withHeader: boolean }): string {
  const body = rows.map((r) => [
    r.date, r.clone, r.tool, r.deltaBytes, r.toolBytesAfter, r.surfaceBytesAfter, r.sha,
  ].join(','));
  const lines = opts.withHeader ? [LEDGER_HEADER, ...body] : body;
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Whether this branch keeps a ledger at all. `undefined` = write one; a string = skip, and the
 *  string says why.
 *
 *  ⚠️ **INTEGRATION branches do not get a ledger.** `main` is where every worker branch is merged, so
 *  its per-tool deltas are the UNION the five worker CSVs exist to disaggregate — a `main.csv` would
 *  restate the sum `DEFINITION_BYTES` already reports, attributed to nobody, and grow a row on every
 *  integration.
 *
 *  ⚠️ **`release_*` is the same case, and the first version of this guard got it backwards.** That
 *  comment reasoned a `release_*` checkout would happen in a WORKER and stay honestly attributed.
 *  It does not: CLAUDE.md § Dev Workflow is explicit that **the HUB cuts the release branch** and
 *  merges it back at the end of `/release-version`. So `release_0_7_0` is the hub wearing a
 *  different name, its rows would be the same union, and the never-delete rule keeps the file
 *  visible forever.
 *
 *  ⚠️ Lives HERE, not in `gen-surface-ledger.ts`, and that is the point of the extraction: the
 *  branch is unreachable from any clone that could exercise it (a worker cannot be on `main`, and
 *  the only lever it has — `MODOKI_LEDGER_CLONE` — DISABLES the check), so a typo like `'Main'` or
 *  `'origin/main'` would be invisible to `verify`, to CI and to every worker, and would first
 *  execute on the hub, once, seeding the file it exists to prevent. As a pure function it gets a
 *  test instead. Conventions §9, same reason as `renderCatalog()`. */
export function ledgerSkipReason(
  clone: string, env: { MODOKI_LEDGER_CLONE?: string } = {},
): string | undefined {
  if (env.MODOKI_LEDGER_CLONE) return undefined;  // explicit override always wins
  if (clone === 'main') {
    return 'main is the integration branch — its deltas are the union of the worker branches, '
      + 'which the per-clone CSVs exist to separate';
  }
  if (/^release[_-]/.test(clone)) {
    return `${clone} is a release branch, which the HUB cuts and merges back — its deltas are the `
      + 'same union as main\'s';
  }
  return undefined;
}

/** Exactly the text to append to a ledger whose current contents are `existing`.
 *
 *  ⚠️ Heals a missing trailing newline instead of trusting that we wrote the file last.
 *  `renderLedger` always ends in one, so only a hand-edit or a truncated write can leave the last
 *  line bare — but appending onto a bare line CONCATENATES the two rows into one 13-field line,
 *  destroying the EARLIER row as well as the new one, and `parseLedger` then throws on every later
 *  run until somebody repairs the file by hand. Loud, but not local, and not recoverable from the
 *  ledger itself.
 *
 *  Lives here rather than in `gen-surface-ledger.ts` for the usual reason (conventions §9): the
 *  script is a thin shell with no tests, so logic put there is logic nothing can drive. */
export function appendChunk(existing: string, rows: readonly LedgerRow[]): string {
  const body = renderLedger(rows, { withHeader: false });
  if (body.length === 0) return '';
  return existing.length > 0 && !existing.endsWith('\n') ? `\n${body}` : body;
}

/** ⚠️ Rejects anything that would need CSV quoting rather than quoting it. Every field here is a
 *  tool name, a branch name, a date or a sha — none can legally contain a comma or a newline, so a
 *  value that does means the caller is wrong, and writing it would corrupt every later parse. */
export function assertCsvSafe(row: LedgerRow): void {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && /[,\n\r"]/.test(value)) {
      throw new Error(`ledger field ${key} is not CSV-safe: ${JSON.stringify(value)}`);
    }
    // ⚠️ The numeric half matters as much as the quoting half: `NaN` and `Infinity` stringify into
    // seven perfectly well-formed fields, so nothing downstream rejects them and the row is
    // committed. A bad number must not be able to enter the file from EITHER direction.
    //
    // ⚠️ INTEGER, not merely finite, so the two directions agree. `parseLedger` requires
    // `/^-?\d+$/` on the way in; a `Number.isFinite` check here would happily WRITE `1.5`, which
    // that reader then rejects — a file this module produced and cannot read back, failing on
    // every later run. Unreachable today (all three values are sums or differences of
    // `String.length`), and pinned anyway, because the asymmetry is invisible until it fires.
    if (typeof value === 'number' && !Number.isInteger(value)) {
      throw new Error(`ledger field ${key} is not an integer: ${String(value)}`);
    }
  }
}
