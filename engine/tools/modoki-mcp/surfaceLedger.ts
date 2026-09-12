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

/** How many leading characters of a sha the corpus index is keyed on. Git's own default
 *  abbreviation floor, and the shortest prefix `buildAncestry` will attempt to resolve. */
const PREFIX_LEN = 7;

/** Ancestry among the shas the ledger corpus records, resolved against THIS tree.
 *
 *  Replaces #1103's `ShaRank` — a position in `git rev-list HEAD`, which was a TOTAL order by
 *  committer date wearing an ancestry name (#1114). */
export type ShaAncestry = {
  /** Is this sha in this tree at all? One that is not describes a tree we do not have. */
  has(sha: string): boolean;
  /** Is `a` an ancestor of `b`? REFLEXIVE — a sha is its own ancestor. Two shas on divergent
   *  branches are incomparable: FALSE IN BOTH DIRECTIONS, which is the case `corpusBaseline`'s
   *  tie-break exists to handle, and the case that has no "later". */
  isAncestor(a: string, b: string): boolean;
  /** How many recorded shas resolved. Zero means "could not ask git", never "nothing is an
   *  ancestor" — `corpusBaseline` keys its fallback off this and the writer warns on it. */
  readonly size: number;
};

/** Build the ancestry relation for `shas` from the raw text of
 *  `git rev-list --topo-order --parents HEAD`.
 *
 *  Pure: it takes git's OUTPUT, not git. That is the point of #1114. This predicate is the one
 *  tricky piece of #1103 and it shipped inside `gen-surface-ledger.ts` — the thin shell with no
 *  tests, where nothing could drive it. `appendChunk`'s docblock below states the rule it broke
 *  (conventions §9: the script is a thin shell, so logic put there is logic nothing can drive).
 *  The writer now keeps exactly one line of this: the spawn.
 *
 *  ⚠️ **Why the DAG and not `git rev-list` POSITION.** #1103 ranked shas by index in
 *  `git rev-list HEAD` and called it ancestry. It is not. That listing is reverse-CHRONOLOGICAL:
 *  measured on this repo at 8,822 commits, committer date decreases monotonically across the entire
 *  listing, merge commits included, with **zero** inversions. Within one line of history the two
 *  agree. For two rows on DIVERGENT branches — the only case a six-clone corpus really poses —
 *  position is decided by committer DATE, across machines, including the Windows clone's clock.
 *  `--parents` costs one extra flag on a spawn that already happens and yields the real partial
 *  order; the measured alternative was 441 `merge-base --is-ancestor` spawns at 2.01s, growing
 *  O(N²) as the corpus adds shas.
 *
 *  ⚠️ **`--topo-order` is load-bearing, not tidiness.** Default `rev-list` order is by date, so a
 *  commit whose parent carries a LATER timestamp — clock skew across six machines, which this repo
 *  has by construction — can be listed BEFORE that parent. Nothing here reads the order (the walk
 *  below follows parent edges explicitly), but a future edit reaching for "the first line is HEAD"
 *  must not find a listing where that is only usually true.
 *
 *  ⚠️ **Recorded shas are ABBREVIATED and the length is not fixed** (git widens it as a repo
 *  grows), so full shas are indexed by a `PREFIX_LEN` prefix and then prefix-matched. Keying on a
 *  guessed length would silently resolve nothing the day git moves to 10 characters — and a
 *  relation that knows nothing is indistinguishable from a clean tree, so the run would book the
 *  entire ~150 KB surface against whoever hit it. An ambiguous prefix takes the FIRST match in
 *  listing order; measured 0 collisions in 8,822 commits, and a collision would have to fall
 *  between two commits that BOTH appear in the ledger before it could matter. */
export function buildAncestry(args: {
  revListParents: string;
  shas: readonly string[];
}): ShaAncestry {
  const { revListParents, shas } = args;
  const parents = new Map<string, string[]>();
  const byPrefix = new Map<string, string[]>();
  for (const line of revListParents.split('\n')) {
    const ids = line.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) continue;
    const [commit, ...rest] = ids;
    parents.set(commit, rest);
    const key = commit.slice(0, PREFIX_LEN);
    const bucket = byPrefix.get(key);
    if (bucket) bucket.push(commit); else byPrefix.set(key, [commit]);
  }

  // Resolve each recorded sha to a full one. A sha too short to disambiguate is treated as
  // UNKNOWN rather than as a match, so it can never silently resolve to HEAD.
  const full = new Map<string, string>();
  for (const short of new Set(shas)) {
    if (short.length < PREFIX_LEN) continue;
    const hit = (byPrefix.get(short.slice(0, PREFIX_LEN)) ?? []).find((c) => c.startsWith(short));
    if (hit !== undefined) full.set(short, hit);
  }
  // Two recorded spellings can resolve to the SAME commit (different abbreviation lengths across
  // clones), so the reverse index is one-to-many.
  const recordedAt = new Map<string, string[]>();
  for (const [short, f] of full) {
    const b = recordedAt.get(f);
    if (b) b.push(short); else recordedAt.set(f, [short]);
  }

  // Ancestors of each recorded sha, expressed in recorded shas. One parent-edge walk per recorded
  // sha: the corpus holds tens of distinct shas against thousands of commits, so this is linear in
  // practice and needs no bitset. Walking from the row we are asking ABOUT yields its ancestors.
  const ancestorsOf = new Map<string, Set<string>>();
  for (const [short, start] of full) {
    const found = new Set<string>();
    const seen = new Set<string>([start]);
    const stack: string[] = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const s of recordedAt.get(cur) ?? []) found.add(s);
      for (const p of parents.get(cur) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        stack.push(p);
      }
    }
    ancestorsOf.set(short, found);
  }

  return {
    size: full.size,
    has: (sha) => full.has(sha),
    isAncestor: (a, b) => ancestorsOf.get(b)?.has(a) ?? false,
  };
}

/** One tool whose baseline could not be settled by ancestry alone: two or more recorded
 *  observations on divergent branches, disagreeing about the size. Reported so a human sees it —
 *  deliberately NOT a gate, see `corpusBaseline`. */
export type BaselineAmbiguity = {
  tool: string;
  /** The incomparable maxima, sha-sorted so the message is stable across runs. */
  candidates: { sha: string; bytes: number }[];
  /** What the tool measures in THIS tree right now — the tie-break's ground truth. `undefined`
   *  when the tool no longer exists. */
  current: number | undefined;
  chosen: number;
};

/** The baseline the next diff is taken against: for each tool, the size recorded by the LATEST
 *  observation in this tree's history, across every clone's CSV (#1103, corrected by #1114).
 *
 *  ⚠️ **Why the corpus and not this clone's own file.** `lastKnownSizes` above diffs against what
 *  THIS clone last saw, which is correct for local work and wrong across a merge: everything
 *  another clone landed since your last run arrives in your tree at once and is booked again under
 *  you, with the MERGE COMMIT as the sha. Measured on the committed corpus before #1103, the same
 *  361 B of `modoki_press_key` was booked by THREE clones on one day (`work-ai3` authored it;
 *  `work-ai2` and `work-qa` each merged it), and `modoki_type_text` and `modoki_ota_publish` the
 *  same. Summing a clone's column to ask "what has this lane spent" therefore over-reported every
 *  lane that merges often — the question #894 created the ledger to answer.
 *
 *  The fix works because **each clone's CSV travels with its commits**: the merge that brings in
 *  another clone's tool change also brings in the row that booked it, so the information needed to
 *  not re-book is already in the tree when the writer runs.
 *
 *  ## "Latest" is a PARTIAL order, and it can genuinely have no answer
 *
 *  `buildAncestry` gives real ancestry, so "latest" means **maximal**: a row no other row descends
 *  from. In a single line of history there is exactly one, and the tie-break below never runs.
 *
 *  Two rows on divergent branches are incomparable — neither is later — and after a merge they stay
 *  incomparable FOREVER, because a merge never makes two divergent commits ancestors of each other.
 *  So **refusing to choose is not an available answer**: it would stall permanently, and refusing by
 *  omitting the baseline is worse still, because `ledgerDelta` reads `before ?? 0` and would book
 *  the tool's ENTIRE size against whoever ran next.
 *
 *  ⚠️ **#1103's own headline case is one of these.** Its two rows sit on a `work-qa` branch commit
 *  and a `work-ai3` branch commit; after the merge both are ancestors of HEAD and neither descends
 *  from the other. Any design that bails on incomparability bails on the case the ledger was fixed
 *  for.
 *
 *  ## The tie-break: the CURRENT measurement, which is ground truth
 *
 *  Among incomparable maxima, take the one nearest to what the tool measures in this tree RIGHT
 *  NOW. That is the discriminator by construction — the candidate agreeing with what we can measure
 *  is the one whose content is already in our tree, hence already booked. It settles all three
 *  directions with one rule:
 *
 *  | | candidates | current | picks | books |
 *  |---|---|---|---|---|
 *  | #1103's case | qa 2473 (stale), ai3 2834 (merged in) | 2834 | 2834 | 0 |
 *  | #1114's hazard | ai 461 (merged in), win 100 (later-DATED, stale) | 461 | 461 | 0 |
 *  | a shrink | X 100 (merged in), W 461 (stale) | 100 | 100 | 0 |
 *
 *  **Both halves are load-bearing.** Ancestry alone cannot do it (it leaves the ambiguity). Nearest-
 *  to-current alone cannot either: in a LINEAR history 100 → 200 → 150 with current 190, it picks
 *  200, but 150 is simply the latest and the corpus sum breaks. Maxima first, then nearest.
 *
 *  ⚠️ **This makes the baseline depend on the PRESENT, not only the past** — a real semantic shift,
 *  and the thing to check in review. It cannot mask a change: it runs only in the ambiguous branch,
 *  and it only ever chooses BETWEEN observations somebody already recorded. It can never invent a
 *  baseline that was not booked.
 *
 *  ⚠️ **The residual arbitrary choice errs toward UNDER-booking** (owner, 2026-09-12). Equidistant
 *  candidates — or a tool that no longer exists, so there is nothing to be near — take the LARGER
 *  recorded size, which books the smaller delta; sha breaks what is left, only for determinism. The
 *  CSV is automated and never hand-corrected, so whichever way this falls is permanent, and a
 *  permanent OVER-bill is the exact defect #1103 removed.
 *
 *  ⚠️ **An ambiguity WARNS; it is never a gate** (owner, 2026-09-12). `onAmbiguity` fires per tool
 *  and the writer prints it. A canary in `npm run verify` was considered and declined: two clones
 *  diverging is legitimate, so it would redden the gate for whichever clone ran next, over a
 *  condition it did not cause and cannot clear — the ambiguity only resolves when the tool changes
 *  again. The ledger never votes. The consequence, stated plainly rather than papered over: **the
 *  tie-break branch is driven by unit tests and by nothing else**, since zero tools in the committed
 *  corpus are ambiguous today (re-measured 2026-09-12: 550 rows, 21 shas, 105 tools, 18 incomparable
 *  sha pairs, 0 ambiguous tools).
 *
 *  ## Two fixes that do NOT work, so they are not re-proposed
 *
 *  - **A floor at this clone's own latest row** — written, tested and REVERTED in #1103's close-out.
 *    #1103's case is *my row old, their merged row new*; #1114's hazard is *my row new, their
 *    later-dated row old*. Both want the newer OBSERVATION. A rank floor gets the second right by
 *    breaking the first. Rescoping it to only the ambiguous bucket does not help — #1103's case
 *    lives in that bucket.
 *  - **Committer date as the tie-break inside the ambiguous bucket** — settles #1103's case and
 *    inverts #1114's. That is #1103's rank wearing a smaller hat.
 *
 *  ⚠️ **An empty `ancestry` falls back to this clone's own file, in file order — the pre-#1103
 *  behaviour.** A baseline of NOTHING is indistinguishable from a clean tree, so treating "nothing
 *  resolved" as "nothing is known" would book the entire surface against whoever hit it. Degrading
 *  to the old known behaviour is the right failure.
 *
 *  ⚠️ **This function cannot tell WHY the relation is empty.** The writer builds an empty one both
 *  when `git` throws and when no recorded sha prefix-matches (a branch cut from an old base, a reset
 *  past every recorded sha). The second is the nastier: the fallback then trusts rows describing a
 *  tree this clone no longer has, so the next delta can be measured against a FUTURE measurement and
 *  book a spurious negative. The writer warns on it — read its stderr before trusting such a run. */
export function corpusBaseline(args: {
  rows: readonly LedgerRow[];
  ancestry: ShaAncestry;
  current: ReadonlyMap<string, number>;
  fallbackClone: string;
  onAmbiguity?: (a: BaselineAmbiguity) => void;
}): Map<string, number> {
  const { rows, ancestry, current, fallbackClone, onAmbiguity } = args;
  if (ancestry.size === 0) {
    return lastKnownSizes(rows.filter((r) => r.clone === fallbackClone));
  }
  const byTool = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    if (!ancestry.has(row.sha)) continue;   // not in this tree at all
    const bucket = byTool.get(row.tool);
    if (bucket) bucket.push(row); else byTool.set(row.tool, [row]);
  }

  const out = new Map<string, number>();
  for (const [tool, group] of byTool) {
    // Maximal under ancestry: nothing else in the group STRICTLY descends from it.
    //
    // ⚠️ **"Strictly" is load-bearing, and a `sha !==` guard is not enough.** Abbreviation length
    // is not fixed — `git rev-parse --short` picks it from the LOCAL object count — so two clones
    // can spell one commit 9 and 10 characters. Those are different `sha` STRINGS resolving to the
    // same commit, so each is an ancestor of the other; with only the string guard they eliminated
    // each other, `maxima` came out EMPTY, and `ranked[0]` threw a TypeError — in the one
    // sub-case the old comment here claimed to handle, and as an uncaught crash in `/close-out`
    // § 6 now that #1103's catch is gone. Requiring the relation to be one-directional makes
    // same-commit rows incomparable instead, so they both stand and the tie-break settles them.
    const strictlyDescends = (a: string, b: string) =>
      ancestry.isAncestor(a, b) && !ancestry.isAncestor(b, a);
    const maxima = group.filter((r) => !group.some(
      (o) => o.sha !== r.sha && strictlyDescends(r.sha, o.sha),
    ));
    const distinct = [...new Set(maxima.map((m) => m.toolBytesAfter))];
    if (distinct.length === 1) { out.set(tool, distinct[0]); continue; }

    const now = current.get(tool);
    const ranked = [...maxima].sort((a, b) => {
      if (now !== undefined) {
        const byNear = Math.abs(a.toolBytesAfter - now) - Math.abs(b.toolBytesAfter - now);
        if (byNear !== 0) return byNear;
      }
      if (a.toolBytesAfter !== b.toolBytesAfter) return b.toolBytesAfter - a.toolBytesAfter;
      return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
    });
    const chosen = ranked[0].toolBytesAfter;
    out.set(tool, chosen);
    onAmbiguity?.({
      tool,
      candidates: maxima
        .map((m) => ({ sha: m.sha, bytes: m.toolBytesAfter }))
        .sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0)),
      current: now,
      chosen,
    });
  }
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
