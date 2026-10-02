/** Known OPEN prefab bugs the fuzzer finds (#1789), and how verify mode lives with each until it is fixed.
 *
 *  `stops`: a seed whose first failure this predicate matches ends there as a pass (its prefix was checked). The
 *  predicate names the check AND the op shape that reaches it, so it cannot swallow an unrelated failure of the same
 *  check. (A second kind, a normalization verify mode applied while its issue was open, had one user — #1796's node-list
 *  order — and went with its fix.)
 *
 *  Every entry carries a minimized repro. The self-test in prefabFuzz.test.ts runs it and
 *  asserts it still fails as described: once the bug is fixed that test goes red, which forces the entry out. Keep an
 *  entry only while its issue is open — or, for a finding the hub RECORDED as not worth fixing under the Unity line, while
 *  that ruling stands (the entry quotes it). */

import type { Op } from './ops';
import type { StepFailure } from './runner';
import { type Failure, RULING_R } from './checks';

export interface KnownOpen {
  issue: number;
  what: string;
  repro: Op[];
  /** The failure the repro must still produce (with this entry's tolerance off). */
  reproduces: (f: StepFailure) => boolean;
  stops?: (f: StepFailure, ops: readonly Op[]) => boolean;
  /** A failure this predicate matches is TOLERATED (the runner's `tolerate`): set aside, and the run goes on. For a check
   *  that fires at a step in the middle of lists that test something else (REGRESSIONS included), where stopping there
   *  would stop them testing it. */
  tolerates?: (f: Failure) => boolean;
}


// Retired by #1869, whose refusals (a supplied object is not moved, reordered, detached out of its instance or saved as
// a prefab of its own — Unity's rule) left their only route unreachable, and which a 300-seed hunt with the re-aimed ops
// and a sweep of legal variants did not re-find: #1792 (every route refused; closed), #1808, #1826 (later re-found through a
// legal copy/paste route and fixed: REGRESSIONS), #1829, #1851, and one
// route each of #1796 (two: Create Prefab on a member), #1809 (Create Prefab on a member, then the directed Apply) and
// #1820 (Create Prefab's undo, on a member). Also a route #1796's fix unmasked (outsideEdit → reparent → createPrefab: its
// redo tagged, then a template-added node row read removed): with #1869 merged one of its draws lands on a refused gesture
// and it no longer reproduces.
// Retired by #1873 R1 (owner ruling 2026-09-30: an outside prefab change re-imports in place and keeps the undo stack):
// #1872's ORPHAN-PIN route (hunt seed 6112; #1872's other entries below still reproduce) ran through an `outsideEdit` whose disk-wins reload dropped the stack, so
// the walk back stopped short of the Replace's undo, and the orphan member-row pins it recorded were the undone scene's.
// With the stack kept, that walk undoes the whole list and the scene comes back exact; a 200-seed hunt (1000-1199) did not
// re-find the orphan pin. The mechanism the hub ruled on (#1872, 2026-09-30: pins kept as R2 orphans after a Replace's
// undo) is NOT shown fixed — only this route to it is gone (confirmed: with R1's branch switched off, the repro reproduced). A re-found pin is a new failure again, and re-enters here
// with a repro that reaches it without the reload.

// Retired by #1880 F6d (drift, not a fix): #1891's seed 1233 list diverges at its 15th pick once the entry rebuild
// renumbers ids, and no longer reaches the case. The case is stated id-free, from the run's own documents, in
// prefabWholeListRebuild.test.ts (passing since F6e).
/** #1951: the rebuild an outside edit makes lacks an entity the reload of the same bytes has (`<guid>: undefined vs {…}`):
 *  a member a changed prefab gained, under its instance inside a kept frame. Only after an outside edit, never an Apply or
 *  a reverse diff (an entity the rebuild has and the reload lacks). */
const keptFrameStale = (f: StepFailure): boolean =>
  f.check === 'a rebuild is not a reload' && f.op.startsWith('outsideEdit') && /^\/[0-9a-f-]{36}: undefined vs \{/.test(f.detail);

/** #1829's shape: across a save→reload, the marks of ONE component differ by a field the reload added (the save wrote a
 *  partially stated added component whole). Only a mark list, never a value: `<guid>/marks/<n>: "T.a" vs "T.b"` within
 *  one trait, or a mark the reload added at the end. */
const partialAddedWidened = (f: StepFailure): boolean => {
  if (f.check !== 'save→reload is not the identity') return false;
  const m = /^\/([0-9a-f-]{36})\/marks\/\d+: (?:"(\w+)\.\w+"|undefined) vs "(\w+)\.\w+"$/.exec(f.detail);
  // On the entry a file-direct write wrote, never just after one ran (review: a mark gained anywhere was claimed).
  // Never a core trait: Transform, EntityAttributes and PrefabInstance are never a partially stated ADDED component.
  return !!m && (m[2] === undefined || m[2] === m[3]) && !['Transform', 'EntityAttributes', 'PrefabInstance'].includes(m[3]!)
    && (f.touched?.fileDirect ?? []).includes(m[1]!);
};

/** #2010's shape: an undo or redo of a composite (one agent call's entry) where some subs REFUSED beside subs that applied —
 *  never one that threw for another reason. */
const compositeHalfApplied = (f: StepFailure): boolean => {
  // From the end walk (`undo threw`, the detail led by the entry's label) or an `undo`/`redo` op (`op threw`, the
  // message then ` | ` and the stack) — the same mechanism either way (review: the op form went unclaimed).
  if (!/^(undo|redo) threw$/.test(f.check) && f.check !== 'op threw') return false;
  const m = /(\d+) of (\d+) sub-action\(s\) failed during (?:undo|redo): (.*?)(?: \| |$)/.exec(f.detail);
  if (!m || Number(m[1]) >= Number(m[2])) return false;
  // Each failed sub REFUSED under ruling R; a throw, or a refusal for any other reason (a guard's), is not #2010.
  const subs = m[3]!.split(/; (?=")/);
  return subs.every((s) => new RegExp(String.raw`^"[^"]*" refused \((?:"[^"]*"(?: \([^)]*\))? )?(?:${RULING_R})`).test(s));
};

/** #1820's paste assertion after a trash (seed 1012): the pasted frame is still expanded from an older document. */
const pastedFrameStale = (f: StepFailure): boolean =>
  f.check === 'op threw' && /^harness: pasted frame "[^"]*" is still expanded from an older \S+ when the paste returns \(#1820\)/.test(f.detail);

/** #2013: today's load keeps a member's `removed` in its orphan store AND applies it — the fold removed that member too,
 *  which the oracle marks `(applied)`. Every divergence line of the step must be one (`foldCheck` reports them all). The
 *  `own` rows first waived here were NOT this: the fold keeps those in neither its anchors nor its unused (#2009 review). */
const orphanBookedTwice = (f: StepFailure): boolean => {
  if (f.check !== 'P1 the live instance is not the fold of its record') return false;
  const lines = f.detail.replace(/^\S+ /, '').split(' ; ');
  return lines.every((l) => /^kept-only unused \S+ removed \(applied\)$/.test(l));
};

export const KNOWN_OPEN: KnownOpen[] = [
  {
    issue: 1951,
    what: "#1951 (hunt seed 1027, pre-existing; low, parked): an instance of H placed inside a live frame of a TRASHED prefab keeps H's old members after H changes outside — the entry's rebuild keeps that frame whole (#1862), so nothing in it is re-expanded, and the reload shows H's new member",
    repro: [
      {kind: 'trashPrefab', u: [0.693313981872052, 0.4887022376060486, 0.2338455079589039, 0.8015267017763108, 0.9982616631314158, 0.9926003257278353, 0.17166399210691452, 0.9857021998614073]},
      {kind: 'instantiate', u: [0.15538944560103118, 0.7801780079025775, 0.3371633195783943, 0.10732766333967447, 0.4623966992367059, 0.23334859986789525, 0.8244502916932106, 0.8450959715992212]},
      {kind: 'instantiate', u: [0.5373735958710313, 0.4927500218618661, 0.011030459310859442, 0.30226651718840003, 0.12471751752309501, 0.7305856866296381, 0.10899202013388276, 0.4397963718511164]},
      {kind: 'outsideEdit', u: [0.12397644645534456, 0.004915807629004121, 0.7699898227583617, 0.8006252702325583, 0.9029005409684032, 0.8947316522244364, 0.4904838753864169, 0.833778610220179], check: 'rebuild-reload'},
    ],
    reproduces: (f) => keptFrameStale(f),
    stops: (f, ops) => keptFrameStale(f) && ops.slice(0, f.step).some((o) => o.kind === 'trashPrefab'),
  },
  {
    issue: 1829,
    what: "#1829's mechanism by a LEGAL route (#2009 verify seed 8): an agent's file-direct `/api/scene-mutate` (no renderer) states an added component PARTIALLY on an instance root (`overrides[1].Rotate3D = {speed: 2}`); the load marks `speed` only, the save writes the added component whole, so the reload marks `axis` too. The second save is byte-identical and no value changes. RECORDED, not fixed: hub ruling on #1829 (2026-09-29), \"closed under the Unity rule … nothing reads the difference … if an M2-shaped divergence ever gets a reader, option C (Unity's recorded-list model) is the recorded direction\" — which #2001 rule 4 (save writes the list, load → save verbatim) builds",
    repro: [
      {kind: 'createPrefab', u: [0.7522407586220652, 0.37439649226143956, 0.25634062057361007, 0.9831468125339597, 0.8870674234349281, 0.8410391425713897, 0.5883639119565487, 0.6700334628112614]},
      {kind: 'fileMutate', u: [0.9580224296078086, 0.1352244857698679, 0.2825196594931185, 0.5995694634038955, 0.8785156579688191, 0.5761606062296778, 0.8552941682282835, 0.6788817942142487]},
    ],
    reproduces: (f) => partialAddedWidened(f),
    stops: (f, ops) => partialAddedWidened(f) && ops.slice(0, f.step).some((o) => o.kind === 'fileMutate'),
  },  {
    issue: 2010,
    what: "#2010 (hunt seed 1153, #2009): an agent call's ONE undo entry (a composite) HALF-applies when one sub's target is gone (ruling R) and another's is not — a CompositeStepError, the entry dropped from both stacks. Hub ruling 2026-10-02: a composite refuses WHOLE before any change (rule 8, ruling R, Unity's undo groups, Create Prefab's W5); not patched on the old model, an acceptance criterion of S7's undo step",
    repro: [
      {kind: 'duplicate', u: [0.06184223503805697, 0.016401618951931596, 0.4260118736419827, 0.9952845550142229, 0.754150097258389, 0.933946989942342, 0.10883641964755952, 0.8018948379904032]},
      {kind: 'instantiate', u: [0.5674041979946196, 0.5850283564068377, 0.48810928617604077, 0.5204959260299802, 0.6030646823346615, 0.04302460653707385, 0.17528071580454707, 0.20929821371100843]},
      {kind: 'agentSceneOps', u: [0.15362343448214233, 0.38407423673197627, 0.23320098500698805, 0.7974971465300769, 0.9292557146400213, 0.9054889436811209, 0.26010975521057844, 0.33315321896225214]},
      {kind: 'editField', u: [0.5271977682132274, 0.5825724361930043, 0.2588861286640167, 0.05811204249039292, 0.2129378216341138, 0.6562503795139492, 0.47226678184233606, 0.3576792587991804]},
      {kind: 'prefabEdit', u: [0.7204824090003967, 0.5535659797023982, 0.2216329409275204, 0.8557709041051567, 0.1865801983512938, 0.9647123455069959, 0.690936912316829, 0.6503027405124158], inner: [{kind: 'delete', u: [0.4812680569011718, 0.6051278768572956, 0.5707945781759918, 0.35522824386134744, 0.0693927661050111, 0.15888829249888659, 0.9739731524605304, 0.6058842276688665]}]},
      {kind: 'undo', u: [0.9296851067338139, 0.5846737751271576, 0.049499761778861284, 0.42648099130019546, 0.8821541699580848, 0.15550759225152433, 0.961956514744088, 0.30397607292979956]},
    ],
    reproduces: (f) => compositeHalfApplied(f),
    stops: (f, ops) => compositeHalfApplied(f) && ops.slice(0, f.step + 1).some((o) => o.kind === 'agentSceneOps' || o.kind === 'agentSetTraits'),
  },
  {
    issue: 2013,
    what: "#2013 (hunt seed 1062; #2009's P1 by the fold): today's load keeps a member's `removed` in its orphan store AND applies it, and the fold applies it too (the oracle marks it `(applied)`). Hub ruling 2026-10-02: a record is projected or unused, never both, so today is wrong; not patched on the old model, retired by #2001 S6 (save writes the record). Its `own` rows, first waived here, are #2018",
    repro: [
      {kind: 'delete', u: [0.5590389100834727, 0.7655044347047806, 0.44698118744418025, 0.02311297389678657, 0.09444080153480172, 0.98244315572083, 0.09199919365346432, 0.6827896372415125]},
      {kind: 'apply', u: [0.6550896638073027, 0.3299250395502895, 0.3501399699598551, 0.08212947798892856, 0.8875960973091424, 0.30393532454036176, 0.4322215639986098, 0.8733348441310227], check: 'rebuild-reload'},
      {kind: 'delete', u: [0.49076773901470006, 0.7339670513756573, 0.055244994116947055, 0.0027172567788511515, 0.8681969207245857, 0.6704316781833768, 0.3613628263119608, 0.6404079920612276]},
      {kind: 'prefabEdit', u: [0.3152803545817733, 0.567811144515872, 0.8239632099866867, 0.25013977638445795, 0.11105125187896192, 0.500013978453353, 0.2667005807161331, 0.17943121818825603], inner: [{kind: 'delete', u: [0.5138724439311773, 0.41784890461713076, 0.45937095978297293, 0.8747622228693217, 0.01600198890082538, 0.9851582634728402, 0.42914512171410024, 0.8725892039947212]}]},
    ],
    reproduces: (f) => orphanBookedTwice(f),
    // Tolerated, not a stop: frequent and benign (the save writes the row once), so the run goes on past it.
    tolerates: (f) => orphanBookedTwice(f as StepFailure),
  },
  {
    issue: 2001,
    what: "#2001 § 3.2's paste row, S7 (hunt seed 1012, #2009; no agent op): copy a subtree holding a nested Q frame inside P, Apply a change to Q, trash P, paste — the pasted Q frame is still expanded from the PRE-Apply Q when the paste returns, with Q cached (#1820's assertion). Hub ruling 2026-10-02: RECORD, don't fix on the model being replaced; this repro is part of S7's record-based paste acceptance test",
    repro: [
      {kind: 'delete', u: [0.5590389100834727, 0.7655044347047806, 0.44698118744418025, 0.02311297389678657, 0.09444080153480172, 0.98244315572083, 0.09199919365346432, 0.6827896372415125]},
      {kind: 'copy', u: [0.793059557909146, 0.07850893028080463, 0.8062161759007722, 0.8035517330281436, 0.2764330352656543, 0.8323238401208073, 0.26245217374525964, 0.47499521006830037]},
      {kind: 'apply', u: [0.6550896638073027, 0.3299250395502895, 0.3501399699598551, 0.08212947798892856, 0.8875960973091424, 0.30393532454036176, 0.4322215639986098, 0.8733348441310227], check: 'rebuild-reload'},
      {kind: 'trashPrefab', u: [0.5543728081975132, 0.558105546515435, 0.80344816041179, 0.12341438280418515, 0.40858249459415674, 0.5091396970674396, 0.03132167900912464, 0.12620670325122774]},
      {kind: 'paste', u: [0.8836326005402952, 0.804022109368816, 0.46664451458491385, 0.7002741650212556, 0.33111054403707385, 0.6519596504513174, 0.19220631150528789, 0.19979474716819823]},
    ],
    reproduces: (f) => pastedFrameStale(f),
    stops: (f, ops) => pastedFrameStale(f) && ops.slice(0, f.step).some((o) => o.kind === 'trashPrefab'),
  },
];

/** Fixed bugs the fuzzer found: each repro must now PASS. A KNOWN_OPEN entry moves here when its issue is fixed, so
 *  the minimized failure stays a regression test (#1789: "every minimized failure becomes a normal regression test").
 *  Also a harness gap closed: a by-design refusal whose console line the allow-list lacked (#1738's entry, seed 6136). */
// Retired by #1933 K1 (2026-10-01; each one's op no longer reached its case, and each case's directed test was shown red
// on its mechanism's mutation first):
// - #1880 hunt seed 1127 (F3a, B′): its Apply is a noop since F6 renumbered ids. F3a's code went with F7d; the case is
//   nestedRowFieldSave.test.ts "hunt seed 1127's shape" (red with prefabMembers' kept-orphan merge dropped).
// - #1880 hunt seed 6141 (rotation is one mark): its final Apply is a noop and no prefab states a rotation; the case is
//   rotationOneValue.test.ts (red with `groupOf` returning `[key]`).
// - #1820 "the same missing rebase, through Create Prefab's undo": the undo is now REFUSED (`createdFrameRebuiltRefusal`),
//   so the rebase never ran; five sibling #1820 entries go red with Create Prefab's undo rebase removed (assetOps.ts).
// - #1877 3b S1: its second Apply is a noop and Save All flushes no park; the case is localIdCounter.test.ts "Apply E1,
//   Apply E2, undo, Save, undo, undo, Apply E3" (red with the park landing's mark taken from `p.from` alone).
// - #1853 hunt seeds 6087, 6109, 6166 (Detach's undo after a rebuild keeps a nested member's overrides): an outside edit
//   keeps the undo stack since #1873 R1, so it taints the segment and the walk checks that measured the case are skipped.
//   Each passed for that reason alone. The case is overrideMarkUndo.test.ts "Detach's undo after a rebuild keeps a
//   NESTED member's overrides" (red, alone, with prefabLink's mark restore limited to the instance root).
// - #1880 T4 hunt seed 1044 (instantiate, outside edit): the same shape — its outside edit taints the walk whose redo was
//   the case, so it stayed green with the redo handed no root guid. The case is instantiateUndoSiblingIdentity.test.ts
//   (red with `opts.respawn(undefined)`); win's seed 5785, which reaches the same redo without the taint, goes red too.

/** What a REGRESSIONS entry must still REACH, besides passing (#1933 K1). A repro that no longer reaches its case passes
 *  for that reason alone: three #1853 entries kept passing once an outside edit started tainting their segment
 *  (#1873 R1), which turned off the very checks that measured them. So each entry states an op and how that op must end,
 *  and the checks a taint may skip in its run; the loop fails an entry whose op ends otherwise, or whose run skips a check
 *  it does not list (`prefabFuzz.test.ts`). The op was first measured as the repro's LAST op, since a minimized repro
 *  ends on the op that failed; where the mechanism sits earlier the entry names that op instead (seed 5104's Apply).
 *  Re-measure with `MODOKI_PREFAB_FUZZ_REACH_DUMP=<file>` after a deliberate change (it reads each entry's declared op),
 *  and READ what moved: an entry that stopped reaching its case is deleted or re-derived, never re-declared to match. */
export interface Reach {
  /** The op index (0-based) that carries the entry's mechanism. */
  op: number;
  /** How that op must end, as the trace prints it. */
  outcome: 'done' | 'noop' | 'refused';
  /** `<taint cause>: <check>` keys a taint may skip in this run. Absent: none. */
  skips?: string[];
}

export const REGRESSIONS: { issue: number; what: string; reaches: Reach; repro: Op[] }[] = [
  {
    issue: 1939,
    what: "#1939 (hunt seed 1012, #1934 F4/M-b): Create Prefab on a member makes a scene-added reference node of the new prefab; the prefab trashed, the save carries its copy; the reload restores the node from it (its frame listed live at the save), where it gave its empty Missing Prefab placeholder",
    reaches: { op: 1, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      {kind: 'createPrefab', u: [0.07576225162483752, 0.4839742570184171, 0.18013141467235982, 0.984006108250469, 0.7422482529655099, 0.5091050690971315, 0.9696242799982429, 0.537708398886025]},
      {kind: 'trashPrefab', u: [0.6900484366342425, 0.5306535325944424, 0.7126782101113349, 0.8273992876056582, 0.3369053485803306, 0.45967397396452725, 0.8177091341931373, 0.2302168474998325]},
    ],
  },
  {
    issue: 1939,
    what: "#1939 (hunt seed 1027, #1934 F4/M-b): the same node, live after the trash, through an Apply's rebuild\u2261reload: the rebuild keeps it expanded (#1862), and the reload now restores it from the copy too",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      {kind: 'trashPrefab', u: [0.9199938054662198, 0.23703388520516455, 0.35904134321026504, 0.5552934117149562, 0.4747692556120455, 0.17824304103851318, 0.2595838194247335, 0.14314630953595042]},
      {kind: 'apply', u: [0.013209617463871837, 0.7259964346885681, 0.41166331013664603, 0.3558924614917487, 0.569496892625466, 0.45171762513928115, 0.633732000598684, 0.7274762492161244], check: 'rebuild-reload'},
    ],
  },
  {
    issue: 1939,
    what: "#1939 (hunt seeds 3266, 1269, #1934 C1): a template reference node of a trashed prefab; a detach of the instance holding it makes its frame an ENTRY. A placeholder entry stays one across the reload and an expanded one comes back expanded, as the copy's list says",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      {kind: 'prefabEdit', u: [0.2832771616522223, 0.07422894821502268, 0.7528395308181643, 0.3064988814294338, 0.2902603386901319, 0.7280649025924504, 0.5037771083880216, 0.8082152912393212], inner: [{kind: 'instantiate', u: [0.13935406086966395, 0.8303816181141883, 0.6744375759735703, 0.2890225602313876, 0.2257074019871652, 0.9767554379068315, 0.2289160017389804, 0.8437706183176488]}]},
      {kind: 'trashPrefab', u: [0.21610835962928832, 0.40136740216985345, 0.25969059206545353, 0.9192028611432761, 0.3998060973826796, 0.17308109835721552, 0.8394311657175422, 0.928628564812243]},
      {kind: 'saveReload', u: [0.6892608145717531, 0.4650746730621904, 0.21657891012728214, 0.23295434354804456, 0.3015429456718266, 0.5181264781858772, 0.30148910149000585, 0.7050725878216326]},
      {kind: 'detach', u: [0.4603799900505692, 0.20984725933521986, 0.8734895254019648, 0.8137040538713336, 0.9327120224479586, 0.7904459990095347, 0.9528898776043206, 0.3289412825834006]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (hunt seeds 3064, 1264): a prefab edit deletes a node of a NESTED frame and the scene row into it was still dropped: the fold marked the row (`isUntargetedRow`), then its descent into the removed member's frame folded the same row object, found nothing removed there and CLEARED the mark. A fold now only sets a mark (seed 3064)",
    reaches: { op: 0, outcome: 'done' },
    repro: [
      {kind: 'prefabEdit', u: [0.29432611004449427, 0.031063986709341407, 0.2494483154732734, 0.24975245539098978, 0.5106361019425094, 0.8061630304437131, 0.9653874023351818, 0.001554569462314248], inner: [{kind: 'delete', u: [0.6875782522838563, 0.06673813634552062, 0.14483149349689484, 0.3717561939265579, 0.9077709359116852, 0.727183788549155, 0.6393199590966105, 0.2742575346492231]}]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (hunt seeds 3064, 1264): a prefab edit deletes a node of a NESTED frame and the scene row into it was still dropped: the fold marked the row (`isUntargetedRow`), then its descent into the removed member's frame folded the same row object, found nothing removed there and CLEARED the mark. A fold now only sets a mark (seed 1264)",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      {kind: 'prefabEdit', u: [0.6179743281099945, 0.0004878533072769642, 0.59079449926503, 0.07714249030686915, 0.8441942906938493, 0.5158490885514766, 0.35551391285844147, 0.07251628977246583], inner: []},
      {kind: 'prefabEdit', u: [0.3843952363822609, 0.009538050275295973, 0.3598720761947334, 0.5283824163489044, 0.8296141603495926, 0.15444855275563896, 0.546853695763275, 0.09496363182552159], inner: [{kind: 'delete', u: [0.6082228999584913, 0.43535389844328165, 0.5193573050200939, 0.8788518323563039, 0.05521734454669058, 0.888298267731443, 0.03155454574152827, 0.14485785155557096]}]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (hunt seeds 3121, 3189, 3256): a removal record an Apply made unused (the template stopped adding the component), then the member, or the nested frame root above it, deleted by the instance. The save after the delete put the load's kept unused part back for the gone member and the reload kept none, so save→reload→save differed. `withKeptUnused` now writes a kept part only for a member still live: the instance's delete takes the records with it (seed 3121)",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      {kind: 'removeComponent', u: [0.8717832013498992, 0.4098781473003328, 0.35788252600468695, 0.36732389219105244, 0.5757638479117304, 0.2722287985961884, 0.7606130202766508, 0.5879398272372782]},
      {kind: 'apply', u: [0.12957373447716236, 0.9488546960055828, 0.2579235783778131, 0.11606695386581123, 0.33177433838136494, 0.4228519485332072, 0.8507518453989178, 0.9463782901875675], check: 'rebuild-reload'},
      {kind: 'duplicate', u: [0.36783416103571653, 0.010957932332530618, 0.2110859325621277, 0.8144237170927227, 0.790566390613094, 0.7907619748730212, 0.14855014812201262, 0.6125487142708153]},
      {kind: 'instantiate', u: [0.3521233794745058, 0.2691156845539808, 0.018800137797370553, 0.3352938797324896, 0.34232723666355014, 0.43310883757658303, 0.4790084436535835, 0.9312082757242024]},
      {kind: 'delete', u: [0.22344316472299397, 0.36142275016754866, 0.2664233713876456, 0.838094659615308, 0.7899125413969159, 0.4119450675789267, 0.338629053439945, 0.27819647127762437]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (hunt seeds 3121, 3189, 3256): a removal record an Apply made unused (the template stopped adding the component), then the member, or the nested frame root above it, deleted by the instance. The save after the delete put the load's kept unused part back for the gone member and the reload kept none, so save→reload→save differed. `withKeptUnused` now writes a kept part only for a member still live: the instance's delete takes the records with it (seed 3256)",
    reaches: { op: 4, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      {kind: 'reparent', u: [0.9342352186795324, 0.11151574295945466, 0.07972302683629096, 0.08700698404572904, 0.7305098192300647, 0.7869342488702387, 0.9138896428048611, 0.2776011188980192]},
      {kind: 'prefabEdit', u: [0.08834935235790908, 0.09308103565126657, 0.4133092381525785, 0.3553751688450575, 0.24236628646031022, 0.903978100977838, 0.9964446187950671, 0.5883963548112661], inner: []},
      {kind: 'removeComponent', u: [0.7504100219812244, 0.28676798823289573, 0.2697774099651724, 0.8844480465631932, 0.3383792843669653, 0.3801882080733776, 0.9408184948842973, 0.7043623812496662]},
      {kind: 'apply', u: [0.5786718802992254, 0.4298649502452463, 0.3088082866743207, 0.5883651657495648, 0.36159273446537554, 0.5484274630434811, 0.34868973633274436, 0.253928188001737]},
      {kind: 'delete', u: [0.4189444489311427, 0.1839420038741082, 0.231367806205526, 0.3093746695667505, 0.29710966954007745, 0.3075379265937954, 0.06625717645511031, 0.7331758630461991]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (hunt seeds 3121, 3189, 3256): a removal record an Apply made unused (the template stopped adding the component), then the member, or the nested frame root above it, deleted by the instance. The save after the delete put the load's kept unused part back for the gone member and the reload kept none, so save→reload→save differed. `withKeptUnused` now writes a kept part only for a member still live: the instance's delete takes the records with it (seed 3189)",
    reaches: { op: 7, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      {kind: 'removeComponent', u: [0.4861626385245472, 0.6464858329854906, 0.34910731529816985, 0.42416101857088506, 0.08656954485923052, 0.35927806072868407, 0.05044971057213843, 0.6291338850278407]},
      {kind: 'instantiate', u: [0.3123783548362553, 0.6733002103865147, 0.7999966023489833, 0.743864813586697, 0.6836235476657748, 0.3055039597675204, 0.6400983028579503, 0.19995113159529865]},
      {kind: 'delete', u: [0.6171004557982087, 0.11244413629174232, 0.7994146842975169, 0.7786812505219132, 0.8358998373150826, 0.4654822468291968, 0.831301347585395, 0.775125412736088]},
      {kind: 'reparent', u: [0.6612211077008396, 0.36423021648079157, 0.8306678279768676, 0.9014782046433538, 0.5403791549615562, 0.9499576559755951, 0.07358550862409174, 0.8051375725772232]},
      {kind: 'prefabEdit', u: [0.720051659969613, 0.7637799391523004, 0.3195983173791319, 0.30892571224831045, 0.7253201364073902, 0.8296465713065118, 0.864294558763504, 0.7305023816879839], inner: []},
      {kind: 'apply', u: [0.3384947697632015, 0.21068303030915558, 0.03546632663346827, 0.13016873761080205, 0.7914254546631128, 0.47165850386954844, 0.7441818702500314, 0.5235970462672412]},
      {kind: 'delete', u: [0.18507975689135492, 0.9658291882369667, 0.215555232251063, 0.969783240230754, 0.9964298885315657, 0.3786157723516226, 0.16863925498910248, 0.8317088421899825]},
      {kind: 'prefabEdit', u: [0.3679075175896287, 0.6148035586811602, 0.14671684545464814, 0.18833275302313268, 0.9373481653165072, 0.4391358729917556, 0.8935777256265283, 0.8203818462789059], inner: []},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (F5, hunt seeds 1093, 1137, 3064): a prefab edit deletes a node of a NESTED frame, and the scene's member row for it was dropped by the next save — the node is still in its document, so R2's document test called the row backed, yet nothing spawned it. The fold now marks a writer's row whose member a lower layer removed (`isUntargetedRow`), and the load keeps it whole as R2 keeps an orphan",
    reaches: { op: 1, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      {kind: 'createPrefab', u: [0.435588832013309, 0.2762597321998328, 0.12515294109471142, 0.245185089064762, 0.4700245594140142, 0.8224645780865103, 0.13726249430328608, 0.7340349089354277]},
      {kind: 'prefabEdit', u: [0.3278416288085282, 0.609664051560685, 0.5566149714868516, 0.1540981107391417, 0.44334901473484933, 0.8064463592600077, 0.8669428001157939, 0.22461966588161886], inner: [{kind: 'delete', u: [0.9654197648633271, 0.7895073282998055, 0.51585115166381, 0.16490537859499454, 0.42432313086465, 0.23471593647263944, 0.1432494781911373, 0.6390993660315871]}]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R4 (F5, hunt seeds 1163, 1288, 3217, 3275): a prefab edit removes a component from a template member, and the scene's removal record for it (`traitRemovals`) was dropped by the next save. The fold now records a writer's removal statement whose component the member's base lacks (`unusedRemovalsOf`), the load keeps it as an unused override, and every save writes it back (`withKeptUnused`)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      {kind: 'createPrefab', u: [0.05658840108662844, 0.4995983433909714, 0.7227386357262731, 0.09445394272916019, 0.47334896260872483, 0.47485498804599047, 0.9995071166194975, 0.4058611218351871]},
      {kind: 'removeComponent', u: [0.5755348766688257, 0.7295827695634216, 0.8786985180340707, 0.9863484944216907, 0.35958082042634487, 0.7607480988372117, 0.46375742135569453, 0.2527841767296195]},
      {kind: 'prefabEdit', u: [0.5113919565919787, 0.12006665416993201, 0.3376664996612817, 0.49116666661575437, 0.8020475080702454, 0.09260820224881172, 0.9066430435050279, 0.08031481644138694], inner: [{kind: 'removeComponent', u: [0.0923295000102371, 0.8708034825976938, 0.36576784984208643, 0.4654491492547095, 0.9902781879063696, 0.11898729344829917, 0.34272964112460613, 0.18487766687758267]}]},
    ],
  },
  {
    issue: 1913,
    what: "hunt seed 3066: a Paste of a copy taken before an Apply, after that Apply was undone. The undo keeps the #1774 mark it raised (version 8, nextLocalId) on the same rows, so the pasted frame is current under #1892's one \"same document\" rule and nothing rebases it. The #1820 paste check compared raw JSON and read it as stale; it now compares content without the mark and the version",
    reaches: { op: 6, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.09484180947765708, 0.42850814457051456, 0.9910836778581142, 0.44680791860446334, 0.6759011175017804, 0.2814236788544804, 0.601917487801984, 0.4636768940836191] },
      { kind: 'instantiate', u: [0.1374225493054837, 0.5400660415180027, 0.3437578836455941, 0.1232674173079431, 0.7499900374095887, 0.9724785936996341, 0.6178272974211723, 0.32715358678251505] },
      { kind: 'prefabEdit', u: [0.28322699200361967, 0.8333327248692513, 0.0684905571397394, 0.6176799486856908, 0.7738619239535183, 0.44571892032399774, 0.6433682369533926, 0.9507702726405114], inner: [] },
      { kind: 'reparent', u: [0.5185867443215102, 0.9025393356569111, 0.7728170431219041, 0.45462952414527535, 0.05682112672366202, 0.6795169685501605, 0.7645600726827979, 0.3142650849185884] },
      { kind: 'apply', u: [0.23766510700806975, 0.03287525731138885, 0.19914947147481143, 0.004267196403816342, 0.04567374777980149, 0.7845990906935185, 0.47620489448308945, 0.5257858119439334] },
      { kind: 'undo', u: [0.8857593168504536, 0.23443350242450833, 0.622052836464718, 0.5814989935606718, 0.5170310474932194, 0.1567833845037967, 0.4998121790122241, 0.05712961032986641] },
      { kind: 'paste', u: [0.364863223163411, 0.5309305356349796, 0.06996219558641315, 0.03358817892149091, 0.023151569068431854, 0.17860745289362967, 0.9888399969786406, 0.22902356274425983] },
    ],
  },
  {
    issue: 1908,
    what: "#1880 F7d close-out reviewer's hunt seed 7035: Create Prefab of Plain swallowed the Leaf instance, a prefab-edit save then added N368 under Leaf's nested Q row (a template-keyed node, derived through the new prefab's frame), and the walk undid the create. The undo reversed only the renames its stamp recorded, so N368 kept a guid of the removed frame, and T4's no-op rebuild derived it from Leaf. The undo now re-derives what the rename did not put back (`rederiveUntaggedTree`)",
    reaches: { op: 14, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'delete', u: [0.9922234723344445, 0.25419696839526296, 0.9724069777876139, 0.02157533122226596, 0.8052881832700223, 0.635680423816666, 0.21592384902760386, 0.03853950975462794] },
      { kind: 'duplicate', u: [0.5128551761154085, 0.3704429541248828, 0.8398871638346463, 0.27259831805713475, 0.10714971576817334, 0.2681458839215338, 0.28937951964326203, 0.7071443223394454] },
      { kind: 'duplicate', u: [0.44347771094180644, 0.7516779908910394, 0.8279188156593591, 0.7128648075740784, 0.7334057167172432, 0.3092420408502221, 0.1351795664522797, 0.04367826017551124] },
      { kind: 'duplicate', u: [0.2906466955319047, 0.6999254215043038, 0.684055763296783, 0.46166856307536364, 0.4662518159020692, 0.20644749351777136, 0.9519286109134555, 0.9016196748707443] },
      { kind: 'addChild', u: [0.9158923369832337, 0.14369138306938112, 0.5217877929098904, 0.552900938084349, 0.8617593767121434, 0.30767782498151064, 0.45726604433730245, 0.499938894296065] },
      { kind: 'reparent', u: [0.0831343992613256, 0.30519177368842065, 0.20855004177428782, 0.6858711536042392, 0.7577791549265385, 0.5839720091316849, 0.40913962107151747, 0.36408074758946896] },
      { kind: 'prefabEdit', u: [0.3309700924437493, 0.6569233764894307, 0.030095250345766544, 0.3292503939010203, 0.03182138688862324, 0.31310038454830647, 0.5246154351625592, 0.5637344394344836], inner: [] },
      { kind: 'reparent', u: [0.4849080129060894, 0.8767765865195543, 0.14639284345321357, 0.1775893692392856, 0.5844973872881383, 0.7068577264435589, 0.4774774038232863, 0.42278118222020566] },
      { kind: 'apply', u: [0.22712836740538478, 0.056918145855888724, 0.2091925849672407, 0.5579740430694073, 0.20300210802815855, 0.4581769125070423, 0.18550380668602884, 0.7533313976600766], check: 'rebuild-reload' },
      { kind: 'createPrefab', u: [0.8319152330514044, 0.4240915672853589, 0.774081488372758, 0.6779571161605418, 0.18596812221221626, 0.8411178649403155, 0.5994577289093286, 0.39294355921447277] },
      { kind: 'createPrefab', u: [0.36320690135471523, 0.5803163331001997, 0.11267186934128404, 0.14586856472305954, 0.5242130625993013, 0.14677568222396076, 0.5161585139576346, 0.4315425059758127] },
      { kind: 'detach', u: [0.568952620960772, 0.4017728406470269, 0.46309781284071505, 0.9847642516251653, 0.34594010980799794, 0.31427668663673103, 0.48893765080720186, 0.6272090403363109] },
      { kind: 'undo', u: [0.19944138010032475, 0.6802376955747604, 0.41905965260230005, 0.7516806568019092, 0.724098558537662, 0.8392475042492151, 0.8702961588278413, 0.10933272331021726] },
      { kind: 'createPrefab', u: [0.2597604226320982, 0.8615618792828172, 0.2960950138512999, 0.24999517458491027, 0.017052290262654424, 0.8436013632453978, 0.7143359621986747, 0.4162361358758062] },
      { kind: 'prefabEdit', u: [0.4067807160317898, 0.6054713339544833, 0.7841467321850359, 0.8712482710834593, 0.9773289314471185, 0.14972905116155744, 0.39789173658937216, 0.4414561924058944], inner: [{ kind: 'addChild', u: [0.6456879598554224, 0.4813439839053899, 0.36877071065828204, 0.60108273755759, 0.8653484499081969, 0.13433217024430633, 0.1667198808863759, 0.8725880493875593] }] },
    ],
  },
  {
    issue: 1822,
    what: "hunt seed 1002: Remove Component, then Add Component, of a Rotate3D an enclosing row (O's template row) states on a nested member: the add's `reconcileOverrideMarks` left `axis` unmarked for equalling the effective base, while a load marks every field an enclosing row states (I2). Closed under the Unity rule with no reader; #1893's walk was one, and the reconcile now marks what the enclosing row states",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'removeComponent', u: [0.5, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addComponent', u: [0.38, 0.1, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1893,
    what: "#1880 F6 precondition hunt seed 1294: addComponent, Create Prefab (HR's row for QR now states the added Rotate3D), an outside edit of HR, and an undo it refuses. The end-of-run walk undoes and REDOES the Add Rotate3D, and the redo's `reconcileOverrideMarks` unmarked every field equal to the effective base, which HR's row now supplies. A load marks what an enclosing row states whatever its value (I2), so T4's no-op rebuild put the marks back. The reconcile now marks what the enclosing row states, as `takeUnmarkedFromBase` already did",
    reaches: { op: 3, outcome: 'refused', skips: ['outsideEdit: redo to the end identity', 'outsideEdit: undo op refusal forgiven', 'outsideEdit: undo to the start identity'] },
    repro: [
      { kind: 'addComponent', u: [0.9362869369797409, 0.44597287848591805, 0.2419073861092329, 0.062128879595547915, 0.2224271954037249, 0.8683678451925516, 0.7178896840196103, 0.7713594404049218] },
      { kind: 'createPrefab', u: [0.4144869849551469, 0.4089658232405782, 0.20890062884427607, 0.9231097148731351, 0.3927326067350805, 0.41872269148007035, 0.3743586875498295, 0.5361575500573963] },
      { kind: 'outsideEdit', u: [0.31801428459584713, 0.24425062886439264, 0.08957791281864047, 0.5608493906911463, 0.010221707867458463, 0.9444657859858125, 0.38045233697630465, 0.8559809618163854], check: 'rebuild-reload' },
      { kind: 'undo', u: [0.33416790375486016, 0.11875490262173116, 0.21718760346993804, 0.011441385140642524, 0.756048726150766, 0.6167072555981576, 0.6525275206658989, 0.4093857652042061] },
    ],
  },
  {
    issue: 1892,
    what: "hunt seed 3097: an Apply after a Create Prefab, undone on the way back, restores the template with its #1774 mark raised (version 8, nextLocalId) on the same rows. staleFrames compared by raw JSON, read the frame the create's undo re-linked as stale and rebased it, and the create's redo refused (\"The tree changed since it was saved\") in a clean segment. One \"same document\" rule now (`documentContentKey`), which leaves the mark and the version out",
    reaches: { op: 8, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.08305942406877875, 0.5127813585568219, 0.33668679813854396, 0.29134805290959775, 0.04606970283202827, 0.6994702997617424, 0.7973081469535828, 0.8558187852613628] },
      { kind: 'removeComponent', u: [0.8884330119471997, 0.10277236229740083, 0.46051879064179957, 0.07925234036520123, 0.6844077315181494, 0.02518709097057581, 0.3248041793704033, 0.551607099827379] },
      { kind: 'delete', u: [0.13102866895496845, 0.31086081732064486, 0.750175739871338, 0.42185700964182615, 0.35874674771912396, 0.2673363380599767, 0.045505442190915346, 0.7950462235603482] },
      { kind: 'apply', u: [0.5542727666907012, 0.9195215618237853, 0.3982940942514688, 0.6734568581450731, 0.5898221214301884, 0.316782349254936, 0.16543398541398346, 0.34312310721725225] },
      { kind: 'undo', u: [0.692610566271469, 0.608316556783393, 0.2731552547775209, 0.118228311650455, 0.725551359821111, 0.49553341837599874, 0.1927620843052864, 0.13829107326455414] },
      { kind: 'createPrefab', u: [0.24938192474655807, 0.28929753159172833, 0.39347980613820255, 0.7267137633170933, 0.06174082471989095, 0.5819875418674201, 0.29204655648209155, 0.41593156452290714] },
      { kind: 'paste', u: [0.8302914018277079, 0.514023075113073, 0.21629563276655972, 0.5112984701991081, 0.9802664720918983, 0.6129663849715143, 0.35419818270020187, 0.37987144477665424] },
      { kind: 'reparent', u: [0.1703200212214142, 0.6847647691611201, 0.284667911240831, 0.15500733256340027, 0.17932445579208434, 0.7033987145405263, 0.29029784305021167, 0.9917256725020707] },
      { kind: 'apply', u: [0.2317333840765059, 0.7318516878876835, 0.27845529932528734, 0.9824815569445491, 0.9847806878387928, 0.03567962977103889, 0.2998678144067526, 0.5110596420709044] },
    ],
  },
  {
    issue: 1884,
    what: "#1880 T hunt seed 1021: Create Prefab's capture keyed a scene-added node under a nested instance (M, duplicated under a Q root), and the create's undo left the key on the now-plain node, which the save drops (live and reloaded disagreed). The tag's undo now takes off the keys the create put on (`tagCreatedPrefab`, `unkeyed`)",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      { kind: 'apply', u: [0.29802523739635944, 0.3361613943707198, 0.945519546745345, 0.4103981079533696, 0.5934181711636484, 0.4925757374148816, 0.5362330467905849, 0.5182884733658284] },
      { kind: 'duplicate', u: [0.9487128253094852, 0.538364575477317, 0.6694632838480175, 0.7329504431691021, 0.6781804847996682, 0.14568979712203145, 0.22980895987711847, 0.1802657439839095] },
      { kind: 'duplicate', u: [0.1251957667991519, 0.2849409447517246, 0.7024342324584723, 0.6058721421286464, 0.9169318166095763, 0.032831143820658326, 0.99941546167247, 0.837961915647611] },
      { kind: 'createPrefab', u: [0.3009951172862202, 0.5536507710348815, 0.2304738739039749, 0.0306045722682029, 0.4852274665609002, 0.7178316684439778, 0.785573696019128, 0.1073915520682931] },
      { kind: 'undo', u: [0.30228502908721566, 0.22505678399465978, 0.18138680350966752, 0.05093478667549789, 0.5482559408992529, 0.39591905171982944, 0.2582702897489071, 0.42935578618198633] },
    ],
  },
  {
    issue: 1880,
    what: "lane T seed 1099: an outside edit added a row without raising the stated mark, and the next editor write (an Apply) kept the stale mark — the file broke v8's contract and the validator's promise that the next write corrects the mark was false. contentFor now restates a stated mark that is not above the highest row",
    reaches: { op: 6, outcome: 'done', skips: ['outsideEdit: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'reparent', u: [0.47770910640247166, 0.8178041507489979, 0.6369340941309929, 0.6863702349364758, 0.9003703948110342, 0.18058545305393636, 0.8215817357413471, 0.04941198998130858] },
      { kind: 'delete', u: [0.499067502329126, 0.9298342380207032, 0.2906979222316295, 0.49646617053076625, 0.1884565125219524, 0.16665405174717307, 0.5789271560497582, 0.9049758883193135] },
      { kind: 'editField', u: [0.669916127808392, 0.3902909515891224, 0.9860278882551938, 0.48131254594773054, 0.6519258550833911, 0.9486431477125734, 0.07681132107973099, 0.8623189509380609] },
      { kind: 'apply', u: [0.33203068375587463, 0.058042194694280624, 0.09917373978532851, 0.3739689118228853, 0.44026124267838895, 0.1452095932327211, 0.13624857971444726, 0.546543656848371] },
      { kind: 'outsideEdit', u: [0.7314007196109742, 0.11507661105133593, 0.0136238110717386, 0.5275846724398434, 0.34810297144576907, 0.8702871620189399, 0.2778983840253204, 0.748940470861271], check: "rebuild-reload" },
      { kind: 'addChild', u: [0.6768837794661522, 0.8782731993123889, 0.015208997298032045, 0.12011798354797065, 0.21936977189034224, 0.9705852677579969, 0.5143393226899207, 0.16034760931506753] },
      { kind: 'apply', u: [0.8724295785650611, 0.4672330424655229, 0.643474405631423, 0.3496431359089911, 0.013759419322013855, 0.6665663898456842, 0.04928848030976951, 0.8362166373990476], check: "rebuild-reload" },
    ],
  },
  {
    issue: 1881,
    what: "seed 1012 (Duplicate, Create Prefab, trash a prefab nested in the tree, then the walk's undo): Create Prefab's undo put its links back after the change and counted 2 it could not; #1880 W5's `requireLinks` refuses before any change",
    reaches: { op: 2, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.793059557909146, 0.07850893028080463, 0.8062161759007722, 0.8035517330281436, 0.2764330352656543, 0.8323238401208073, 0.26245217374525964, 0.47499521006830037] },
      { kind: 'createPrefab', u: [0.07576225162483752, 0.4839742570184171, 0.18013141467235982, 0.984006108250469, 0.7422482529655099, 0.5091050690971315, 0.9696242799982429, 0.537708398886025] },
      { kind: 'trashPrefab', u: [0.6900484366342425, 0.5306535325944424, 0.7126782101113349, 0.8273992876056582, 0.3369053485803306, 0.45967397396452725, 0.8177091341931373, 0.2302168474998325] },
    ],
  },
  {
    issue: 1830,
    what: "Create Prefab's redo minted a fresh TemplateAddedKey for a node an undone Duplicate had respawned without its marker, instead of the key the file holds (#1830's own repro; the redo now puts the written keys back)",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.97, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'createPrefab', u: [0.14, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1830,
    what: "Windows hunt seed 5881's two-op list (Duplicate, Create Prefab): the same minted key, showing as #1854's signature, a template-added key's {removed:true} record lost across the redo",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.5963568142615259, 0.8849396670702845, 0.6458703870885074, 0.6016285156365484, 0.4876746661029756, 0.15752911334857345, 0.3674554496537894, 0.12655106629244983] },
      { kind: 'createPrefab', u: [0.03326389635913074, 0.6116315200924873, 0.12370068859308958, 0.26712705474346876, 0.04323147865943611, 0.9797979812137783, 0.9593758592382073, 0.6386072726454586] },
    ],
  },
  {
    issue: 1830,
    what: "#1831 hunt seed 7233 (Duplicate, Create Prefab, a field edit): the minted key re-derived the node's guid, so the field edit's redo refused \"M is no longer in the scene\"",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.977625418221578, 0.10981691116467118, 0.8696209718473256, 0.07155231852084398, 0.5348184262402356, 0.0396548924036324, 0.3063154264818877, 0.43074198695831] },
      { kind: 'createPrefab', u: [0.32201413507573307, 0.8158542171586305, 0.5061640609055758, 0.6455502198077738, 0.46572459978051484, 0.30121782794594765, 0.7006634974386543, 0.9674662773031741] },
      { kind: 'editField', u: [0.966237222077325, 0.6521248209755868, 0.8099878376815468, 0.8283290637191385, 0.46284840046428144, 0.4721653030719608, 0.40968819498084486, 0.44078236212953925] },
    ],
  },
  {
    issue: 1830,
    what: "Windows hunt seed 5244 (Instantiate, Create Prefab, Add Child): the minted key, as \"Extra is no longer in the scene\" on the Add Child's redo",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'instantiate', u: [0.26984861749224365, 0.857217205921188, 0.5417404866311699, 0.6520530749112368, 0.27365411608479917, 0.06802519364282489, 0.2010678865481168, 0.10494927037507296] },
      { kind: 'createPrefab', u: [0.031088791321963072, 0.8898211200721562, 0.4956407188437879, 0.5259370838757604, 0.3480511426459998, 0.6040984797291458, 0.5115663693286479, 0.821438854560256] },
      { kind: 'addChild', u: [0.5326266644988209, 0.9753338638693094, 0.751311041880399, 0.2873122403398156, 0.9126396756619215, 0.15535532915964723, 0.675605678698048, 0.07076598913408816] },
    ],
  },
  {
    issue: 1830,
    what: "Create Prefab on O's root, then a saved prefab edit adding a child to the nested P, then Cmd+Z: the undo put the nested frame's create-time record back over the frame the save had rebased, and its rebase respawned the child beside itself (I7). The undo now restores only what the tag overwrote",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'createPrefab', u: [0, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.61, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.45, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1830,
    what: "#1831 hunt seed 7137 (Create Prefab, a saved prefab edit deleting a member of a nested frame): the undo was asked to relink the deleted member, which the tag never wrote, and reported a lost link",
    reaches: { op: 1, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'createPrefab', u: [0.047634169925004244, 0.610289781820029, 0.11021222011186182, 0.7074943124316633, 0.40937073971144855, 0.21729625179432333, 0.002168258186429739, 0.5071092371363193] },
      { kind: 'prefabEdit', u: [0.9690003884024918, 0.06597855570726097, 0.6092434453312308, 0.6823969944380224, 0.6381569232326001, 0.6950476826168597, 0.9112842523027211, 0.9077273816801608], inner: [{ kind: 'delete', u: [0.28125073038972914, 0.5679815823677927, 0.9654117312747985, 0.1948673736769706, 0.08424057275988162, 0.278156612534076, 0.8821839834563434, 0.003483220236375928] }] },
    ],
  },
  {
    issue: 1830,
    what: "Windows hunt seed 5354: I7 on the undo walk, from the same create-time nested frame records",
    reaches: { op: 4, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.6963883680291474, 0.9425665645394474, 0.8681900694500655, 0.9644319310318679, 0.8393072879407555, 0.9496176526881754, 0.5431543777231127, 0.6081813441123813] },
      { kind: 'detach', u: [0.7872956683859229, 0.40090060187503695, 0.7127918475307524, 0.9570385066326708, 0.0032037843484431505, 0.6652133502066135, 0.6525406290311366, 0.7110467322636396] },
      { kind: 'createPrefab', u: [0.02270437264814973, 0.3694461004342884, 0.6758084241300821, 0.9498452744446695, 0.9478365711402148, 0.8077748452778906, 0.08220607950352132, 0.16558049619197845] },
      { kind: 'createPrefab', u: [0.4561503136064857, 0.40720081282779574, 0.13428969937376678, 0.8261703141033649, 0.04716356145218015, 0.42683183890767395, 0.04437782894819975, 0.8018280963879079] },
      { kind: 'prefabEdit', u: [0.8095252434723079, 0.16822834499180317, 0.5719397112261504, 0.6995144600514323, 0.3714845951180905, 0.7725116177462041, 0.04039384517818689, 0.7935558205936104], inner: [{ kind: 'instantiate', u: [0.11733893770724535, 0.8894950586836785, 0.12409552745521069, 0.38069786550477147, 0.7777354796417058, 0.02062457730062306, 0.5780926090665162, 0.292934522498399] }] },
    ],
  },
  {
    issue: 1830,
    what: "#1831 hunt seed 6376 (Detach, Create Prefab, a prefab edit, an outside edit): Create Prefab's redo re-planned a tree the Detach's undo had rebased onto the edited template, logged \"6 rows now vs 5 written\", left it unlinked and reported success. It now refuses",
    reaches: { op: 3, outcome: 'done', skips: ['prefabEditSave: redo refusal forgiven (rest of the walk not run)', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'detach', u: [0.131138457916677, 0.03025388065725565, 0.16239675809629261, 0.02427092124707997, 0.23535011988133192, 0.6762105983216316, 0.331267784582451, 0.491535049630329] },
      { kind: 'createPrefab', u: [0.07974131079390645, 0.61921744979918, 0.8827914723660797, 0.814963303739205, 0.11848264816217124, 0.7384613386821002, 0.6724770395085216, 0.9046368224080652] },
      { kind: 'prefabEdit', u: [0.6151660135947168, 0.08909262414090335, 0.6475611277855933, 0.15453396714292467, 0.6684619230218232, 0.04004926327615976, 0.07897007511928678, 0.5703308735974133] },
      { kind: 'outsideEdit', u: [0.4955225696321577, 0.5475801357533783, 0.4016699972562492, 0.7284062763210386, 0.17238674825057387, 0.9416410464327782, 0.7055809462908655, 0.4237301112152636] },
    ],
  },
  {
    issue: 1830,
    what: "#1831 hunt seed 7062: a Detach left override marks on the plain tree, and Create Prefab's redo linked them as overrides equal to the template's values. The tag now clears the marks of what it links, and its undo restores them",
    reaches: { op: 8, outcome: 'done' },
    repro: [
      { kind: 'addChild', u: [0.3149684425443411, 0.5195810534060001, 0.23953052354045212, 0.9728077817708254, 0.11790635576471686, 0.12733556679449975, 0.990328834624961, 0.7928611556999385] },
      { kind: 'apply', u: [0.6018423652276397, 0.3286145585589111, 0.889105669921264, 0.1708408643025905, 0.9766480689868331, 0.9332218661438674, 0.21935313660651445, 0.27238739375025034] },
      { kind: 'reparent', u: [0.9503660832997411, 0.2899808743968606, 0.6874415180645883, 0.6880770085845143, 0.011967694852501154, 0.9092594424728304, 0.3530650103930384, 0.4704747630748898] },
      { kind: 'detach', u: [0.8597701750695705, 0.0603654021397233, 0.34584561991505325, 0.6911473139189184, 0.7360344079788774, 0.4908128157258034, 0.23907885188236833, 0.021343653090298176] },
      { kind: 'saveReload', u: [0.8564406603109092, 0.701155444374308, 0.3244916482362896, 0.9722273021470755, 0.44977816264145076, 0.3314992734231055, 0.31690627872012556, 0.5629932114388794] },
      { kind: 'detach', u: [0.681957570835948, 0.8124798578210175, 0.12105117668397725, 0.0973592484369874, 0.4919206916820258, 0.814731955062598, 0.749281405704096, 0.6496201597619802] },
      { kind: 'saveReload', u: [0.7401411707978696, 0.27528235455974936, 0.19733069115318358, 0.3697264895308763, 0.9189415869768709, 0.07987727038562298, 0.7075915231835097, 0.08189732511527836] },
      { kind: 'apply', u: [0.053308817790821195, 0.5723371666390449, 0.8925435731653124, 0.17998747318051755, 0.6573338292073458, 0.9314077515155077, 0.8248182635288686, 0.6315945165697485] },
      { kind: 'createPrefab', u: [0.4934964864514768, 0.6956504574045539, 0.8385598394088447, 0.3917850435245782, 0.24555502086877823, 0.2637817175127566, 0.19915034319274127, 0.07720904238522053] },
    ],
  },
  {
    issue: 1830,
    what: "Windows hunt seed 6874 (Create Prefab, a field edit, Create Prefab replacing it): the Replace's undo restored the first document in memory only (#1868), and the first create's redo read the file, still holding the Replace's bytes, and refused as \"changed on disk\". It reads the parked document first",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'createPrefab', u: [0.35482500214129686, 0.7939310185611248, 0.9346682026516646, 0.7842025875579566, 0.6883090001065284, 0.48073346936143935, 0.26965042925439775, 0.026049146428704262] },
      { kind: 'editField', u: [0.17994162859395146, 0.1491128816269338, 0.6467705767136067, 0.8391306621488184, 0.10253269993700087, 0.7723070946522057, 0.24937461921945214, 0.48834813036955893] },
      { kind: 'createPrefab', u: [0.13982705818489194, 0.3522340760100633, 0.623425422469154, 0.3912985196802765, 0.13050302886404097, 0.10667726094834507, 0.8669430015143007, 0.061126263346523046] },
    ],
  },
  {
    issue: 1830,
    what: "Windows hunt seed 6409 (Create Prefab, Instantiate x2, Apply): the same, through an Apply's in-memory undo",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'createPrefab', u: [0.5980798900127411, 0.5542913048993796, 0.8380707998294383, 0.7950446989852935, 0.3749640053138137, 0.3903450327925384, 0.1789306893479079, 0.5110339599195868] },
      { kind: 'instantiate', u: [0.2975576678290963, 0.973259056918323, 0.17457714094780385, 0.5449914857745171, 0.17879209714010358, 0.6274365580175072, 0.6519286704715341, 0.8233920186758041] },
      { kind: 'instantiate', u: [0.5373392198234797, 0.7409823008347303, 0.12965819146484137, 0.5993281197734177, 0.43376305885612965, 0.12345235841348767, 0.6472075902856886, 0.2611759507562965] },
      { kind: 'apply', u: [0.29788372991606593, 0.8901947310660034, 0.8465813612565398, 0.9081029477529228, 0.4242454443592578, 0.1325376844033599, 0.22037539444863796, 0.17715892824344337] },
    ],
  },
  {
    issue: 1796,
    what: "#1831 hunt seed 1069 (revert, duplicate x2, Create Prefab): the redo walk's member rows differed while Create Prefab's tree was written in ECS query order \u2014 fixed by #1796 (658df5534, sibling order), bisected",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'revert', u: [0.36641955841332674, 0.08149117766879499, 0.9617084681522101, 0.44420404895208776, 0.756865281611681, 0.8165764443110675, 0.4238444927614182, 0.8908999681007117] },
      { kind: 'duplicate', u: [0.5996283309068531, 0.32666391250677407, 0.325518402736634, 0.7077659852802753, 0.7930500628426671, 0.6214979814831167, 0.6834883925039321, 0.10020231083035469] },
      { kind: 'duplicate', u: [0.2270508122164756, 0.2401702085044235, 0.4263769411481917, 0.9362518028356135, 0.4567351574078202, 0.8353149758186191, 0.3655522831249982, 0.2305873390287161] },
      { kind: 'createPrefab', u: [0.06612525298260152, 0.7814346549566835, 0.5872286099474877, 0.592794910306111, 0.616452349582687, 0.3320590464863926, 0.1061059741768986, 0.6822938877157867] },
    ],
  },
  {
    issue: 1796,
    what: "#1831 hunt seed 359 (prefab edit, Create Prefab, delete): the redo walk's member rows differed for the same reason \u2014 fixed by #1796 (658df5534), bisected",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.39004969387315214, 0.24013883457519114, 0.26316954917274415, 0.010693528223782778, 0.9826868220698088, 0.702365490840748, 0.12593856640160084, 0.7091992110945284], inner: [{ kind: 'instantiate', u: [0.03353284439072013, 0.4334984472952783, 0.14991809939965606, 0.9671524497680366, 0.7129811008926481, 0.820170289138332, 0.6099342810921371, 0.8764234778936952] }, { kind: 'addChild', u: [0.49247090169228613, 0.10570000880397856, 0.4752523510251194, 0.44194735679775476, 0.8685307304840535, 0.3591187277343124, 0.6084623169153929, 0.09803118603304029] }] },
      { kind: 'createPrefab', u: [0.07454202533699572, 0.7899746645707637, 0.7684827533084899, 0.43322544265538454, 0.9261072254739702, 0.2004493970889598, 0.4495796498376876, 0.7930119957309216] },
      { kind: 'delete', u: [0.7340365257114172, 0.5857334374450147, 0.13503238558769226, 0.4924648106098175, 0.5409339000470936, 0.9089662889018655, 0.14609448960982263, 0.9783521823119372] },
    ],
  },
  {
    issue: 1663,
    what: "an ADDED component's Revert: it is one row and removes the component whole — a field's Revert used to drop that field's mark while the save wrote the component whole, so the reload re-seeded it (win hunt seed 4518)",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'instantiate', u: [0.6856837454251945, 0.6130752910394222, 0.9647802303079516, 0.5524996344465762, 0.20222525345161557, 0.6711691836826503, 0.9302660641260445, 0.7276771860197186] },
      { kind: 'addComponent', u: [0.048257316928356886, 0.9017342755105346, 0.3389153329189867, 0.7868645421694964, 0.12486484530381858, 0.2077573158312589, 0.7518443982116878, 0.6349454706069082] },
      { kind: 'revert', u: [0.18059522239491343, 0.795128625119105, 0.32536525279283524, 0.09314298769459128, 0.5334634217433631, 0.6214699102565646, 0.28351180418394506, 0.9262692916672677] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review, residual) Delete's undo of a ROW of a frame that survives the delete, after a saved edit of that frame's template VALUE: the row is translated onto the current document (the template's new value, not the old one frozen as its own)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.7, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'editField', u: [0.15, 0.5, 0.9, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review, residual) the same, where the saved edit dropped the respawned member's row: the undo REFUSES before anything respawns (the entity was lost on reload)",
    reaches: { op: 2, outcome: 'refused', skips: ['prefabEditSave: undo op refusal forgiven'] },
    repro: [
      { kind: 'delete', u: [0.4, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review, residual) the same, where the respawned row is an owned nested root whose row the saved edit dropped: the undo REFUSES (its parent link reverted on reload)",
    reaches: { op: 2, outcome: 'refused', skips: ['prefabEditSave: undo op refusal forgiven'] },
    repro: [
      { kind: 'delete', u: [0.3, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review) Create Prefab, a saved edit of the tree's template (a member added), undo, redo: the redo is REFUSED, not a re-link to stale rows",
    reaches: { op: 3, outcome: 'refused', skips: ['prefabEditSave: redo op refusal forgiven'] },
    repro: [
      { kind: 'createPrefab', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out review) Create Prefab, a saved edit of the tree's template (only a VALUE changed (the shape-only check missed it)), undo, redo: the redo is REFUSED, not a re-link to stale rows",
    reaches: { op: 3, outcome: 'refused', skips: ['prefabEditSave: redo op refusal forgiven'] },
    repro: [
      { kind: 'createPrefab', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'editField', u: [0.15, 0.9, 0.9, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (duplicate) respawns the deleted instance on the current template",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (addChild) respawns the deleted instance on the current template",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Delete's undo after a SAVED prefab edit (delete) respawns the deleted instance on the current template",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (duplicate) respawns the copy on the current template",
    reaches: { op: 3, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (addChild) respawns the copy on the current template",
    reaches: { op: 3, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "(close-out sweep) Duplicate's redo after a SAVED prefab edit (delete) respawns the copy on the current template",
    reaches: { op: 3, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'redo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree gains the member the saved edit duplicated (a legal route, after #1869)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'duplicate', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree gains the child the saved edit added (a legal route, after #1869)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'addChild', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "Create Prefab over a tree holding a prefab instance (a legal pick after #1869), a SAVED prefab edit, then the create's undo re-links: the live tree loses the member the saved edit deleted (a legal route, after #1869)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'createPrefab', u: [0.02, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.5, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "a paste of an instance copied before its template changed respawns the stale frame, and nothing rebases it",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.003, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'editField', u: [0.656, 0.0, 0.75, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.2, 0.1, 0, 0.9, 0, 0.9, 0, 0] },
      { kind: 'paste', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1820,
    what: "the same, through Paste's redo: the walk undoes and redoes a paste made before the template changed",
    reaches: { op: 6, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'instantiate', u: [0.611175028141588, 0.6514599523507059, 0.2609965375158936, 0.13653228152543306, 0.08117494895122945, 0.229994123801589, 0.19415682554244995, 0.2312458292581141] },
      { kind: 'prefabEdit', u: [0.0025320895947515965, 0.5545158837921917, 0.3194682211615145, 0.6602701237425208, 0.8647226733155549, 0.30973603832535446, 0.06382799847051501, 0.20962068950757384], inner: [] },
      { kind: 'reparent', u: [0.05289468914270401, 0.5114942493382841, 0.9024173587094992, 0.7742977037560195, 0.22715402184985578, 0.8201705161482096, 0.34489292302168906, 0.49780966504476964] },
      { kind: 'copy', u: [0.27074809931218624, 0.14453188236802816, 0.6524580360855907, 0.7346509259659797, 0.5130745004862547, 0.6953973234631121, 0.5576475753914565, 0.6048628408461809] },
      { kind: 'paste', u: [0.2788585058879107, 0.6411802317015827, 0.13857184490188956, 0.7241594886872917, 0.5755924703553319, 0.21859576366841793, 0.999815168324858, 0.40587658691219985] },
      { kind: 'prefabEdit', u: [0.6, 0.6434368717018515, 0.49586298945359886, 0.5223652205895633, 0.1734591640997678, 0.8727238741703331, 0.5582645458634943, 0.7902071727439761], inner: [{ kind: 'duplicate', u: [0.2632118870969862, 0.7401458392851055, 0.20006573991850019, 0.8598092638421804, 0.1768859124276787, 0.5392143279314041, 0.14166608965024352, 0.4079057138878852] }] },
      { kind: 'revert', u: [0.2899708952754736, 0.8689476081635803, 0.3784734313376248, 0.317490870365873, 0.01880230032838881, 0.8135771653614938, 0.9818330009002239, 0.4641318661160767] },
    ],
  },
  {
    issue: 1820,
    what: "a paste after an Apply removed a member of the copied instance keeps the member out (the body's member-lost repro)",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'delete', u: [0.831,  0,  0,  0,  0,  0,  0,  0] },
      { kind: 'copy', u: [0.003,  0,  0,  0,  0,  0,  0,  0] },
      { kind: 'apply', u: [0.78,  0.1,  0,  0.9,  0,  0.9,  0,  0] },
      { kind: 'paste', u: [0.577,  0.746,  0.068,  0.977,  0,  0,  0,  0] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 4483) copy, paste, Apply, paste: the second paste takes the nodes the Apply added",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.14698627777397633,  0.8868070221506059,  0.6764130680821836,  0.12952746218070388,  0.9193068437743932,  0.6101939009968191,  0.5648398445919156,  0.9099759007804096] },
      { kind: 'paste', u: [0.37339868303388357,  0.44922571652568877,  0.5820887528825551,  0.49615396675653756,  0.9435655698180199,  0.13738775975070894,  0.12296006875112653,  0.7920071498956531] },
      { kind: 'apply', u: [0.8779937496874481,  0.456387547776103,  0.8912423599977046,  0.7217436714563519,  0.495892170118168,  0.6126101936679333,  0.787758517311886,  0.608392120571807] },
      { kind: 'paste', u: [0.04270838829688728,  0.0985837762709707,  0.7681965220253915,  0.36397526366636157,  0.6696740563493222,  0.19381232536397874,  0.8067189394496381,  0.904827953549102] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3166) a paste after a saved prefab-edit Duplicate takes the node it added",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.04884834960103035,  0.9628134244121611,  0.6216103117913008,  0.943275434197858,  0.3188887434080243,  0.49192826147191226,  0.01156065403483808,  0.1593283291440457] },
      { kind: 'prefabEdit', u: [0.6315673277713358,  0.14461058238521218,  0.11123886378481984,  0.7670094554778188,  0.8188522597774863,  0.0583918709307909,  0.013477355008944869,  0.12268179678358138], inner: [{ kind: 'duplicate', u: [0.2379663127940148, 0.45252525829710066, 0.1845254492945969, 0.7645223236177117, 0.5730074837338179, 0.899197322782129, 0.7565395457204431, 0.7873528709169477] }] },
      { kind: 'paste', u: [0.9393777602817863,  0.099418064346537,  0.08656460558995605,  0.9402495534159243,  0.2995231195818633,  0.0953779045958072,  0.24812181666493416,  0.1979106201324612] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 4174) a stale paste's parentId",
    reaches: { op: 7, outcome: 'done' },
    repro: [
      { kind: 'instantiate', u: [0.817225489532575,  0.6150298537686467,  0.43410562071949244,  0.8474213990848511,  0.6080710273236036,  0.3496287034358829,  0.8644047558773309,  0.6105031108018011] },
      { kind: 'delete', u: [0.7614817498251796,  0.6651264014653862,  0.30778774223290384,  0.6466251155361533,  0.7594433417543769,  0.3746901412960142,  0.2749748737551272,  0.4335338482633233] },
      { kind: 'delete', u: [0.4055223378818482,  0.785919364541769,  0.9767264937981963,  0.07617654372006655,  0.9242184786126018,  0.44334669318050146,  0.9296723406296223,  0.5644315637182444] },
      { kind: 'copy', u: [0.08672260493040085,  0.0018634560983628035,  0.5823962264694273,  0.045332242269068956,  0.43199025304056704,  0.18286233744584024,  0.08787737437523901,  0.23212941782549024] },
      { kind: 'reparent', u: [0.8342625887598842,  0.4582651359960437,  0.7787502971477807,  0.6373671570327133,  0.9003852005116642,  0.5240210210904479,  0.5465208550449461,  0.62540562893264] },
      { kind: 'paste', u: [0.7858088326174766,  0.14560177107341588,  0.7896528092678636,  0.3082289642188698,  0.8933009491302073,  0.5416892601642758,  0.6897593471221626,  0.8406567722558975] },
      { kind: 'apply', u: [0.1184677709825337,  0.4642320699058473,  0.25585719337686896,  0.2426652645226568,  0.11545071564614773,  0.204954867484048,  0.5391937966924161,  0.16870146454311907] },
      { kind: 'paste', u: [0.21386439935304224,  0.6408156936522573,  0.15152453840710223,  0.8387568793259561,  0.10223349533043802,  0.4221818440128118,  0.686126304557547,  0.35632232297211885] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3097) a stale paste's override marks",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'editField', u: [0.44951570802368224,  0.344752277713269,  0.999486313899979,  0.2983108488842845,  0.5319882414769381,  0.9581097902264446,  0.5708246517460793,  0.9445934095419943] },
      { kind: 'copy', u: [0.08305942406877875,  0.5127813585568219,  0.33668679813854396,  0.29134805290959775,  0.04606970283202827,  0.6994702997617424,  0.7973081469535828,  0.8558187852613628] },
      { kind: 'apply', u: [0.5542727666907012,  0.9195215618237853,  0.3982940942514688,  0.6734568581450731,  0.5898221214301884,  0.316782349254936,  0.16543398541398346,  0.34312310721725225] },
      { kind: 'paste', u: [0.8655595844611526,  0.11952090612612665,  0.3953531668521464,  0.2899504494853318,  0.147352792089805,  0.3629837108310312,  0.20817722426727414,  0.7508443302940577] },
    ],
  },
  {
    issue: 1820,
    what: "(win seed 3356) a stale paste's added component",
    reaches: { op: 6, outcome: 'done' },
    repro: [
      { kind: 'addChild', u: [0.6022028226871043,  0.4916789522394538,  0.5374829324427992,  0.7261641579680145,  0.3992758134845644,  0.12593218218535185,  0.4906459131743759,  0.3929682292509824] },
      { kind: 'copy', u: [0.29138847370631993,  0.34229610906913877,  0.5704484961461276,  0.27208092506043613,  0.9787884801626205,  0.2521947417408228,  0.88076506042853,  0.6224663273897022] },
      { kind: 'reparent', u: [0.4728145166300237,  0.250552580691874,  0.9423649744130671,  0.6085743457078934,  0.5756158044096082,  0.7312585986219347,  0.18250082153826952,  0.6265484702307731] },
      { kind: 'addComponent', u: [0.08710776804946363,  0.0006227344274520874,  0.8525324119254947,  0.4319694945588708,  0.7389313839375973,  0.4417040063999593,  0.30046098539605737,  0.21890126774087548] },
      { kind: 'revert', u: [0.4148508314974606,  0.1469713319092989,  0.0740816555917263,  0.5004145568236709,  0.15684673166833818,  0.8724640819709748,  0.6221436758060008,  0.5350111455190927] },
      { kind: 'apply', u: [0.35009047063067555,  0.8993905920069665,  0.5499130950774997,  0.28416696353815496,  0.09081994113512337,  0.5930697214789689,  0.9242638661526144,  0.09549329965375364] },
      { kind: 'paste', u: [0.1993531279731542,  0.8867862697225064,  0.02726888144388795,  0.8469348920043558,  0.6183840627782047,  0.9696976784616709,  0.34751853812485933,  0.0024959484580904245] },
    ],
  },
  {
    issue: 1820,
    what: "(#1859, hunt seed 250) copy, outside edit, paste: the reload gains no entity",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.07701369072310627,  0.7822557620238513,  0.4572561925742775,  0.28865382075309753,  0.7458809961099178,  0.5401038848794997,  0.2584418347105384,  0.8851113333366811] },
      { kind: 'outsideEdit', u: [0.9907738657202572,  0.8173439735546708,  0.17939582420513034,  0.874272549059242,  0.2045294945128262,  0.5903447051532567,  0.7981432392261922,  0.7445750313345343] },
      { kind: 'paste', u: [0.22224835772067308,  0.7978167883120477,  0.6313734378200024,  0.970457072602585,  0.4196247239597142,  0.7648493445012718,  0.1068376547191292,  0.39006769354455173] },
    ],
  },
  {
    issue: 1796,
    what: "a Duplicate inside an instance: save → reload → save is byte-identical (nested node lists in sibling order)",
    reaches: { op: 0, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.38699243287555873, 0.5160500674974173, 0.7015982300508767, 0.7498073864262551, 0.12323614209890366, 0.09115325007587671, 0.3395281918346882, 0.4878639730159193] },
    ],
  },
  {
    issue: 1796,
    what: "Create Prefab's redo after a reload re-tags the tree it rewrote (collectTree in sibling order, as the write was)",
    reaches: { op: 3, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.0005, 0.7639, 0.1438, 0.6678, 0.7747, 0.344, 0.5285, 0.0697] },
      { kind: 'saveReload', u: [0.9055, 0.5241, 0.2558, 0.4764, 0.7382, 0.6179, 0.362, 0.2463] },
      { kind: 'createPrefab', u: [0.2822, 0.0907, 0.9868, 0.1901, 0.0497, 0.3445, 0.7354, 0.5284] },
      { kind: 'prefabEdit', u: [0.7606, 0.2686, 0.3478, 0.6593, 0.9336, 0.4852, 0.8874, 0.3418], inner: [] },
    ],
  },
  {
    issue: 1796,
    what: "the same redo, where the walk's scene diff showed the tree's added node missing",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.033303552540019155, 0.6072016530670226, 0.17860231618396938, 0.36060059955343604, 0.24519648379646242, 0.01585288904607296, 0.7660753296222538, 0.0734335642773658] },
      { kind: 'createPrefab', u: [0.20849957410246134, 0.6444018911570311, 0.005679936148226261, 0.3887866751756519, 0.5991325152572244, 0.022242528619244695, 0.49629448540508747, 0.33016981394030154] },
    ],
  },
  {
    issue: 1796,
    what: "the same redo after an outside edit and a reparent: Create Prefab's redo re-tags instead of refusing",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'outsideEdit', u: [0.6936206261161715, 0.17782395984977484, 0.5137411751784384, 0.7149697851855308, 0.9969790095929056, 0.16907001845538616, 0.6203795957844704, 0.5160340690053999] },
      { kind: 'reparent', u: [0.315277598798275, 0.917392787989229, 0.9138918148819357, 0.2863043069373816, 0.8894691378809512, 0.4289656088221818, 0.22244959813542664, 0.5512217737268656] },
      { kind: 'createPrefab', u: [0.9434425951912999, 0.18627188983373344, 0.7050830235239118, 0.7845574729144573, 0.4535193827468902, 0.8970362835098058, 0.007119981572031975, 0.06791658839210868] },
      { kind: 'reparent', u: [0.926001786487177, 0.07603803905658424, 0.059589676558971405, 0.6357310710009187, 0.21650824113748968, 0.9080651458352804, 0.8035988812334836, 0.2351431674323976] },
    ],
  },
  {
    issue: 1831,
    what: "(G1 M2) a prefab dropped under a Missing Prefab placeholder in prefab edit is refused, where the save wrote it as a row every expansion re-homed outside the instance (hunt seed 315, #1861)",
    reaches: { op: 2, outcome: 'done', skips: ['assetDelete: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'apply', u: [0.3908089795149863, 0.03656577807851136, 0.12329709646292031, 0.19279956631362438, 0.7911372233647853, 0.42535790032707155, 0.9330323494505137, 0.2303955622483045] },
      { kind: 'trashPrefab', u: [0.8698484501801431, 0.9432446954306215, 0.7018947280012071, 0.41346723260357976, 0.47552838386036456, 0.08532690536230803, 0.5476820175535977, 0.7256320039741695] },
      { kind: 'prefabEdit', u: [0.2880415425170213, 0.275979372439906, 0.6388688392471522, 0.8064999668858945, 0.21602211706340313, 0.5039041882846504, 0.6194102934096009, 0.3749129925854504], inner: [{ kind: 'instantiate', u: [0.7795347538776696, 0.9812039197422564, 0.2718967793043703, 0.26789398794062436, 0.5382205301430076, 0.8254823936149478, 0.9744059327058494, 0.8570319171994925] }] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1) trash P, then instantiate O, which nests P: the live world holds kept P frames beside O's unexpanded P row, and the restored comparison lets that row come back expanded (hunt seed 351, #1856)",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'trashPrefab', u: [0.6031674689147621, 0.32979793287813663, 0.8048893548548222, 0.19987819739617407, 0.7723878214601427, 0.4218790833838284, 0.6704246983863413, 0.05371444392949343] },
      { kind: 'instantiate', u: [0.6069244958925992, 0.263748875586316, 0.16720971977338195, 0.9911824848968536, 0.17673206329345703, 0.3720341839361936, 0.936112288152799, 0.7757013773079962] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1) the same two ops (hunt seed 6030)",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'trashPrefab', u: [0.5406942241825163, 0.39389731688424945, 0.8374803350307047, 0.07660906296223402, 0.9091866982635111, 0.5265559710096568, 0.9305080221965909, 0.61383136222139] },
      { kind: 'instantiate', u: [0.4133435436524451, 0.964117540512234, 0.26380765507929027, 0.9943990514148027, 0.7428998670075089, 0.7959617732558399, 0.21524300938472152, 0.7997799264267087] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, G1 M1/M5) a kept frame's reparent and Apply before the round trip, which then failed as M1 (hunt seed 5104)",
    reaches: { op: 7, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'prefabEdit', u: [0.8762713158503175, 0.03239666367881, 0.11954150861129165, 0.9196045729331672, 0.3753566930536181, 0.5589897979516536, 0.26667742733843625, 0.9626793242059648], inner: [{kind: 'delete', u: [0.4095847448334098, 0.32432481413707137, 0.2858915913384408, 0.7823276342824101, 0.36225294740870595, 0.9154196181334555, 0.005848549073562026, 0.35622050357051194]}, {kind: 'undo', u: [0.33388770720921457, 0.572215726133436, 0.012769023422151804, 0.13426355132833123, 0.418521893909201, 0.9623553154524416, 0.28858965658582747, 0.18201336916536093]}, {kind: 'redo', u: [0.5351214946713299, 0.5260254153981805, 0.0020173119846731424, 0.6366104746703058, 0.5911289998330176, 0.2582283711526543, 0.41223555197939277, 0.9923461589496583]}, {kind: 'redo', u: [0.7061207813676447, 0.712686057202518, 0.991152907256037, 0.697692945599556, 0.8350388244725764, 0.9191796996165067, 0.3809151416644454, 0.5443655350245535]}] },
      { kind: 'editField', u: [0.045991167426109314, 0.5878017456270754, 0.21571285114623606, 0.3114997963421047, 0.5819835742004216, 0.6850799140520394, 0.12637460720725358, 0.4519760166294873] },
      { kind: 'duplicate', u: [0.10059353895485401, 0.006679050391539931, 0.9929867913015187, 0.7155979296658188, 0.25997596280649304, 0.6217055763117969, 0.1602286531124264, 0.2099366073962301] },
      { kind: 'prefabEdit', u: [0.4946770647075027, 0.08963554375804961, 0.11988005670718849, 0.47806615428999066, 0.4943670672364533, 0.8456591481808573, 0.1978523787111044, 0.09641737351194024], inner: [{kind: 'addChild', u: [0.3295794085133821, 0.06753006344661117, 0.441060084849596, 0.97918571671471, 0.05289382766932249, 0.9141601929441094, 0.14959009736776352, 0.3073970442637801]}, {kind: 'editField', u: [0.9809581849258393, 0.4730609059333801, 0.7414809055626392, 0.2291955396067351, 0.3539408487267792, 0.977658994263038, 0.6914279204793274, 0.1953741475008428]}] },
      { kind: 'trashPrefab', u: [0.927127564093098, 0.10882858303375542, 0.22725477372296154, 0.06697932770475745, 0.8154001981019974, 0.6902474502567202, 0.020950040547177196, 0.6087567145004869] },
      { kind: 'cut', u: [0.5244958435650915, 0.35751769761554897, 0.6128346233163029, 0.5644878861494362, 0.9633544192183763, 0.9416227822657675, 0.2057135368231684, 0.3308452139608562] },
      { kind: 'reparent', u: [0.9881515316665173, 0.8432085886597633, 0.5545131105463952, 0.5713310174178332, 0.1701910716947168, 0.638417094014585, 0.023642008658498526, 0.31924578291364014] },
      { kind: 'apply', u: [0.07893647789023817, 0.6977124519180506, 0.8717663588467985, 0.20421823859214783, 0.30533649236895144, 0.28544130153022707, 0.782807320356369, 0.5060831271111965] },
      { kind: 'apply', u: [0.4923210346605629, 0.9308039348106831, 0.45492127956822515, 0.7001701316330582, 0.2540940591134131, 0.9144125154707581, 0.6177542523946613, 0.628542261198163] },
    ],
  },
  {
    issue: 1794,
    what: "Detach's undo after a rebuild (a save and reopen) puts the override marks back with the links",
    reaches: { op: 5, outcome: 'done' },
    repro: [
      { kind: 'editField', u: [0.7083940990269184, 0.0169174384791404, 0.2565192203037441, 0.03183711925521493, 0.5653642797842622, 0.1326391918119043, 0.5866110895294696, 0.39626767858862877] },
      { kind: 'revert', u: [0.3251578959170729, 0.8732641767710447, 0.649110505823046, 0.5803064578212798, 0.13768295058980584, 0.8408704535104334, 0.08907407149672508, 0.48194432351738214] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'detach', u: [0.15888716746121645, 0.28360947174951434, 0.40143896848894656, 0.5929380359593779, 0.02723632473498583, 0.1597168450243771, 0.8716024786699563, 0.2872234331443906] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1794,
    what: "the same, where the rebuild is a prefab-edit visit (discarded)",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'detach', u: [0.7311645969748497, 0.13434822508133948, 0.6695735612884164, 0.40467609371989965, 0.8146500582806766, 0.3963876867201179, 0.7728581817355007, 0.15376638155430555] },
      { kind: 'prefabEdit', u: [0.6097711462061852, 0.9679968729615211, 0.8896497702226043, 0.6608014917001128, 0.03871827572584152, 0.6533970246091485, 0.7404179510194808, 0.898593342397362], inner: [] },
      { kind: 'undo', u: [0.7791260068770498, 0.4710204261355102, 0.7423416944220662, 0.9686100308317691, 0.6743511268869042, 0.028107878752052784, 0.8965767938643694, 0.07950291177257895] },
    ],
  },
  {
    issue: 1800,
    what: "Remove Component's undo after a rebuild puts the trait's override marks back with its data",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      { kind: 'addComponent', u: [0.04622375639155507, 0.8679626227822155, 0.5392347774468362, 0.8630144654307514, 0.9499282059259713, 0.10872479528188705, 0.9486257375683635, 0.5012652326840907] },
      { kind: 'saveReload', u: [0.5743842197116464, 0.5823324527591467, 0.9513287632726133, 0.561390912393108, 0.5752703219186515, 0.47487166756764054, 0.751958251465112, 0.3308712081052363] },
      { kind: 'removeComponent', u: [0.00905785127542913, 0.22686874470673501, 0.2879236890003085, 0.24362082383595407, 0.6656269864179194, 0.9177013242151588, 0.7928349012508988, 0.6064457197207958] },
      { kind: 'saveReload', u: [0.3872559634037316, 0.8000171624589711, 0.39061477268114686, 0.859410464996472, 0.5958437048830092, 0.22173328371718526, 0.04321353812702, 0.29053033818490803] },
      { kind: 'undo', u: [0.1, 0.8564995671622455, 0.028990152990445495, 0.40797109180130064, 0.27484340965747833, 0.013096533715724945, 0.5823551893699914, 0.8294616998173296] },
    ],
  },
  {
    issue: 1831,
    what: "(= #1794) seed 63 with a save, a reopen and the Detach's undo appended: the next round trip keeps the marks",
    reaches: { op: 6, outcome: 'done', skips: ['outsideEdit: redo to the end identity', 'outsideEdit: undo to the start identity'] },
    repro: [
      { kind: 'duplicate', u: [0.021626295056194067, 0.9448791488539428, 0.5488163251429796, 0.2074153374414891, 0.09146336675621569, 0.6330600001383573, 0.05427237902767956, 0.5054511388298124] },
      { kind: 'saveReload', u: [0.8530344092287123, 0.9759107395075262, 0.6467963447794318, 0.452473109588027, 0.5527505369391292, 0.907866015098989, 0.9856647453270853, 0.163215727545321] },
      { kind: 'renamePrefab', u: [0.39797093835659325, 0.9346814232412726, 0.19760007015429437, 0.4643807352986187, 0.25796109274961054, 0.020594365429133177, 0.717780799837783, 0.28149340650998056] },
      { kind: 'outsideEdit', u: [0.26882588444277644, 0.8606790986377746, 0.5751630233135074, 0.5883123665116727, 0.6345254555344582, 0.5665456287097186, 0.9513689226005226, 0.15337868151254952] },
      { kind: 'detach', u: [0.1446664254181087, 0.9234078116714954, 0.3712811500299722, 0.3836844807956368, 0.8891595841851085, 0.5820841509848833, 0.07788186823017895, 0.7306096281390637] },
      { kind: 'saveReload', u: [0.24, 0.98, 0.29, 0.02, 0.96, 0.42, 0.4, 0.54] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1831,
    what: "(= #1794) seed 107 with a save, a reopen and the Detach's undo appended: the next round trip keeps the marks",
    reaches: { op: 8, outcome: 'done', skips: ['outsideEdit: redo to the end identity', 'outsideEdit: undo to the start identity'] },
    repro: [
      { kind: 'copy', u: [0.32529376936145127, 0.3525210786610842, 0.8291352614760399, 0.1429842715151608, 0.5948686129413545, 0.5451861249748617, 0.08171302964910865, 0.22260460956022143] },
      { kind: 'paste', u: [0.6029266156256199, 0.9945501068141311, 0.9572499892674387, 0.6824461920186877, 0.1936525320634246, 0.15427791187539697, 0.6963595051784068, 0.6199092876631767] },
      { kind: 'saveReload', u: [0.816602504812181, 0.9164635692723095, 0.9323501212056726, 0.78107467177324, 0.04326618672348559, 0.2757718206848949, 0.0005588340573012829, 0.8054400233086199] },
      { kind: 'renamePrefab', u: [0.009989902377128601, 0.1960589555092156, 0.3518118236679584, 0.9397004882339388, 0.9010002051945776, 0.7113523299340159, 0.7163461239542812, 0.18047817121259868] },
      { kind: 'outsideEdit', u: [0.8484079877380282, 0.2949926636647433, 0.007929783314466476, 0.673268812475726, 0.489887161180377, 0.19081966672092676, 0.6642701874952763, 0.6880893129855394] },
      { kind: 'duplicate', u: [0.337531310506165, 0.9653639036696404, 0.45448930794373155, 0.17932283855043352, 0.3504884091671556, 0.7672032655682415, 0.9019996160641313, 0.4930025930516422] },
      { kind: 'detach', u: [0.5541364219971001, 0.36246725684031844, 0.8192624447401613, 0.3963077152147889, 0.7086152834817767, 0.35569064202718437, 0.16836523916572332, 0.20946468762122095] },
      { kind: 'saveReload', u: [0.24, 0.98, 0.29, 0.02, 0.96, 0.42, 0.4, 0.54] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1795,
    what: "(harness) Create Prefab's undo refused after a prefab-edit save, in its tree-check wording: expected, and forgiven in the tainted segment (hunt seed 6103)",
    reaches: { op: 1, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'createPrefab', u: [0.24430793477222323, 0.5578774318564683, 0.44810137269087136, 0.10805997927673161, 0.10153932473622262, 0.8677448665257543, 0.9063538603950292, 0.1537257907912135] },
      { kind: 'prefabEdit', u: [0.21278736181557178, 0.1596795073710382, 0.2053778253030032, 0.339336343575269, 0.7885611937381327, 0.17296946281567216, 0.45481607667170465, 0.247781571932137], inner: [{ kind: 'addComponent', u: [0.2794236254412681, 0.437290902948007, 0.19698106171563268, 0.22118132980540395, 0.048200189135968685, 0.9753480581566691, 0.8320993515662849, 0.2162562918383628] }] },
    ],
  },
  {
    issue: 1837,
    what: "a Replace over a prefab from a different tree keeps localId 1 bound to the old root's node (I4), and the walk back through it passes (hunt seed 4980, Mac; it was #1821 route 2's repro until #1795 left the create's file in place)",
    reaches: { op: 6, outcome: 'done' },
    repro: [
      { kind: 'detach', u: [0.24958215770311654, 0.44152918620966375, 0.8984461007639766, 0.7383312478195876, 0.5952132367528975, 0.7539820002857596, 0.7765414610039443, 0.2380422039423138] },
      { kind: 'reparent', u: [0.31711865961551666, 0.9896594546735287, 0.9932775064371526, 0.6025639378931373, 0.96449003694579, 0.06188184628263116, 0.9392736088484526, 0.22530514118261635] },
      { kind: 'duplicate', u: [0.6615225882269442, 0.2622203284408897, 0.5295452964492142, 0.9772655258420855, 0.8154521533288062, 0.8149651174899191, 0.37671069288626313, 0.9834790374152362] },
      { kind: 'duplicate', u: [0.3719844911247492, 0.3338841567747295, 0.46974579221569, 0.7407463123090565, 0.8855832503177226, 0.9122256592381746, 0.5009035964030772, 0.8939542740117759] },
      { kind: 'undo', u: [0.37838583951815963, 0.8508917058352381, 0.4453392345458269, 0.06471602735109627, 0.8773009078577161, 0.5875511111225933, 0.07360643381252885, 0.17861990840174258] },
      { kind: 'createPrefab', u: [0.8534675752744079, 0.015578718390315771, 0.9201763307210058, 0.44044428248889744, 0.736804960295558, 0.7156405262649059, 0.14698713622055948, 0.43389102374203503] },
      { kind: 'createPrefab', u: [0.9554856207687408, 0.0850175938103348, 0.9533656612038612, 0.9244284078013152, 0.7588050169870257, 0.5099546790588647, 0.520374397514388, 0.08186750300228596] },
    ],
  },
  {
    issue: 1849,
    what: "(harness) a swap that leaves a nested frame of a trashed prefab UNEXPANDED taints as ruling R — its members are gone, not placeholders (work-ai3 hunt seed 6191; #1849's seeds under prune). With the loader's delete eviction (#1834) the swap and the refusal fall in ONE `undo` op — the Apply's undo reloads, the next undo in the op refuses — so the taint is taken before the op's refusal is judged (#1862)",
    reaches: { op: 8, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'instantiate', u: [0.5197782325558364, 0.8788099023513496, 0.7218048402573913, 0.38950273185037076, 0.49659334821626544, 0.4644296036567539, 0.8073571014683694, 0.3525339278858155] },
      { kind: 'instantiate', u: [0.8885502920020372, 0.03978240699507296, 0.5181071648839861, 0.01798194320872426, 0.6372697676997632, 0.9517800977919251, 0.43241823813878, 0.5862065297551453] },
      { kind: 'trashPrefab', u: [0.5265531395561993, 0.37663424806669354, 0.6686670721974224, 0.4929392503108829, 0.6694031935185194, 0.0497262105345726, 0.9948387288022786, 0.4772849741857499] },
      { kind: 'addComponent', u: [0.44360926025547087, 0.2595970721449703, 0.6613509301096201, 0.8240651376545429, 0.5745828275103122, 0.27813824848271906, 0.13981691538356245, 0.9998946678824723] },
      { kind: 'detach', u: [0.45435963617637753, 0.11783441039733589, 0.7403156065847725, 0.474913319805637, 0.8912695015314966, 0.032363265519961715, 0.588015757733956, 0.0006292278412729502] },
      { kind: 'addChild', u: [0.2904052436351776, 0.22452195966616273, 0.4735311917029321, 0.24861586512997746, 0.6931021737400442, 0.4886781834065914, 0.7541276377160102, 0.19028105004690588] },
      { kind: 'apply', u: [0.21978989453054965, 0.5785240884870291, 0.895742590771988, 0.681806655600667, 0.5302156871184707, 0.1434090519323945, 0.16105769434943795, 0.7953095901757479] },
      { kind: 'undo', u: [0.5353207942098379, 0.513355860253796, 0.39604073972441256, 0.6545602204278111, 0.41435385402292013, 0.18229086161591113, 0.2827563155442476, 0.43774443259462714] },
      { kind: 'prefabEdit', u: [0.05231025302782655, 0.7457796058151871, 0.10294174845330417, 0.30545185203664005, 0.5674001208972186, 0.936231005936861, 0.7218729241285473, 0.39920026273466647], inner: [] },
    ],
  },
  {
    issue: 1856,
    what: 'prune on: trash → addChild → Apply — the Apply\'s fan-out no longer drops the trashed prefab\'s live nested frame (#1862\'s keep), so the comparison reload with the prefab restored gains nothing',
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'trashPrefab', u: [0.9616053267382085, 0.8986614316236228, 0.8458665194921196, 0.10550301731564105, 0.36948610469698906, 0.10419670818373561, 0.14534811885096133, 0.3606053702533245] },
      { kind: 'addChild', u: [0.45433683576993644, 0.06991623109206557, 0.36247888510115445, 0.32349463854916394, 0.9636948064435273, 0.36620242870412767, 0.7672389638610184, 0.7997816174756736] },
      { kind: 'apply', u: [0.16332965740002692, 0.7464540000073612, 0.7259030696004629, 0.022606123005971313, 0.05862882686778903, 0.1499764914624393, 0.42986090295016766, 0.5521558525506407] },
    ],
  },
  {
    issue: 1850,
    what: 'a Missing Prefab placeholder of an entry that states its root\'s sortOrder as a root OVERRIDE loads with that sortOrder, so save→reload→save keeps the top-level order (prune on, after a trash)',
    reaches: { op: 4, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'addChild', u: [0.9957377251703292, 0.12976732291281223, 0.2103715562261641, 0.9275979360099882, 0.43928383802995086, 0.07324382080696523, 0.19927202980034053, 0.8402995807118714] },
      { kind: 'duplicate', u: [0.21626306232064962, 0.5490222787484527, 0.789051380706951, 0.16266263229772449, 0.5332405406516045, 0.12282868777401745, 0.042075154604390264, 0.1445559342391789] },
      { kind: 'addChild', u: [0.05152462935075164, 0.5596237492281944, 0.8935148431919515, 0.7301778043620288, 0.6726450177375227, 0.650408998830244, 0.8924802078399807, 0.5835450873710215] },
      { kind: 'duplicate', u: [0.049044220708310604, 0.3174614568706602, 0.8419715336058289, 0.9428341283928603, 0.7418814767152071, 0.5696394266560674, 0.8156659172382206, 0.15937778376974165] },
      { kind: 'trashPrefab', u: [0.6920298747718334, 0.7770941411145031, 0.7189049804583192, 0.4385903417132795, 0.2771018666680902, 0.34832038450986147, 0.43116552801802754, 0.15858133602887392] },
    ],
  },
  {
    issue: 1866,
    what: "an Apply promoting a live instance of a TRASHED prefab P into Q, which P nests, is refused: I16's reader falls back to the document P's live frame was expanded from, so Q → P → Q is never written (work-ai3 hunt seed 6031)",
    reaches: { op: 4, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'addChild', u: [0.4305641388054937, 0.46192985004745424, 0.9784602834843099, 0.21986035979352891, 0.9370753238908947, 0.33278186176903546, 0.1576756751164794, 0.07622262183576822] },
      { kind: 'renamePrefab', u: [0.4414735846221447, 0.24768190551549196, 0.7650708560831845, 0.8969545839354396, 0.78997323801741, 0.6095375462900847, 0.037518877536058426, 0.5313502037897706] },
      { kind: 'reparent', u: [0.09773839451372623, 0.4438950384501368, 0.8722896345425397, 0.9020806809421629, 0.11434697802178562, 0.6160023778211325, 0.45054174098186195, 0.5362555251922458] },
      { kind: 'trashPrefab', u: [0.4194636051543057, 0.9646944224368781, 0.330843408126384, 0.766133475350216, 0.5438984320499003, 0.3454324014019221, 0.15978657128289342, 0.37498119473457336] },
      { kind: 'apply', u: [0.9597498264629394, 0.5389002638403326, 0.10009014303795993, 0.33395626582205296, 0.46827784134075046, 0.47006455273367465, 0.577250886708498, 0.6762503273785114] },
    ],
  },
  {
    issue: 1795,
    what: "create, rename it, create at the freed name, walk: the first create's redo finds its document by guid (hunt seed 6029)",
    reaches: { op: 7, outcome: 'done' },
    repro: [
      { kind: 'addChild', u: [0.47438800777308643, 0.6849050319287926, 0.018786048982292414, 0.41438902798108757, 0.01898742886260152, 0.7009683928918093, 0.10380097082816064, 0.5749734076671302] },
      { kind: 'saveReload', u: [0.9517920373473316, 0.6275642085820436, 0.6845347550697625, 0.034205432049930096, 0.9466571100056171, 0.9330003669019789, 0.9431702268775553, 0.853209639666602] },
      { kind: 'createPrefab', u: [0.954957535257563, 0.8790208585560322, 0.1273031032178551, 0.39226157404482365, 0.8768407960887998, 0.5753853456117213, 0.1393283517099917, 0.7638483592309058] },
      { kind: 'copy', u: [0.0819199294783175, 0.9390344275161624, 0.504217367619276, 0.8227947673294693, 0.1901625671889633, 0.71554422727786, 0.8023586187046021, 0.9949959618970752] },
      { kind: 'paste', u: [0.5775616799946874, 0.951425006147474, 0.29634487093426287, 0.9946444493252784, 0.8024187004193664, 0.6370631060563028, 0.5748223115224391, 0.7400542183313519] },
      { kind: 'delete', u: [0.2557223727926612, 0.6671593459323049, 0.3221927627455443, 0.3245999552309513, 0.780588896246627, 0.012352550867944956, 0.43838050751946867, 0.6093167993240058] },
      { kind: 'renamePrefab', u: [0.29367014579474926, 0.838569869985804, 0.744370064465329, 0.9900823086500168, 0.14166604191996157, 0.6773370199371129, 0.3684174786321819, 0.5982422344386578] },
      { kind: 'createPrefab', u: [0.33827525400556624, 0.7544570425525308, 0.698528251843527, 0.44618354621343315, 0.48049078905023634, 0.0021756314672529697, 0.017819779692217708, 0.9753832877613604] },
    ],
  },
  {
    issue: 1839,
    what: "(harness) outsideEdit wrote a plain row under a REFERENCE row, a shape no editor write produces — a false I7 (win's seed 3130)",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.31428628764115274, 0.3164791292510927, 0.8148758122697473, 0.44748169742524624, 0.9601324021350592, 0.8578238422051072, 0.6915884613990784, 0.03476591291837394], inner: [{ kind: 'duplicate', u: [0.12071382580325007, 0.9100820466410369, 0.5026753153651953, 0.5419060399290174, 0.20003260928206146, 0.6299601232167333, 0.03211430087685585, 0.5577229368500412] }] },
      { kind: 'outsideEdit', u: [0.36192806623876095, 0.3773991058114916, 0.6150501875672489, 0.5344666172750294, 0.6948157059960067, 0.4617444567847997, 0.43642105208709836, 0.91876904014498] },
      { kind: 'instantiate', u: [0.315802268916741, 0.5779164917767048, 0.9913183939643204, 0.28238313808105886, 0.5831954493187368, 0.08192095602862537, 0.1403615267481655, 0.9752809575293213] },
    ],
  },
  {
    issue: 1821,
    what: "Create Prefab's undo after an Apply into the new prefab was undone (fixed with #1795: the undo leaves the file, so there is no trash for a #1774 mark to refuse)",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'createPrefab', u: [0.2059, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addChild', u: [0.5, 0.2059, 0.1, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.4375, 0.1, 0, 0.9, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.9, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1835,
    what: "Apply's undo after a Rename (not undoable, #1868 D2) reads the prefab where it is: the move route pushes the renderer's manifest before its repair, as the editor's does (#1828's second route, harness-shaped)",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'apply', u: [0.3302737674675882, 0.2567235822789371, 0.6868790478911251, 0.7366894891019911, 0.12275128113105893, 0.10771414311602712, 0.646984655642882, 0.9300033883191645] },
      { kind: 'renamePrefab', u: [0.2094005134422332, 0.4872707976028323, 0.2897710604593158, 0.9391268761828542, 0.4600680246949196, 0.9581016609445214, 0.701076986733824, 0.585580583428964] },
      { kind: 'detach', u: [0.16811815183609724, 0.4063933831639588, 0.7856829706579447, 0.2869127383455634, 0.6659100251272321, 0.9365419009700418, 0.5917436527088284, 0.9570457476656884] },
    ],
  },
  {
    issue: 1828,
    what: "the Hierarchy drop's redo after a Rename (not undoable, #1868 D2) finds the prefab by the document's guid (`placedPrefabPath`) and tags the instance by it, never a path (setPrefabSource takes the document)",
    reaches: { op: 5, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'instantiate', u: [0.12306458246894181, 0.659326083259657, 0.3238855139352381, 0.3017094286624342, 0.7389431328047067, 0.6331829989794642, 0.8944360001478344, 0.3325171605683863] },
      { kind: 'createPrefab', u: [0.15510661457665265, 0.9943042399827391, 0.9856164292432368, 0.310858246171847, 0.6426518538501114, 0.3538553356193006, 0.2786709980573505, 0.9714844699483365] },
      { kind: 'addChild', u: [0.5799607739318162, 0.2170702046714723, 0.5558724678121507, 0.6893410694319755, 0.011181237641721964, 0.44485651864670217, 0.8736847601830959, 0.8628021879121661] },
      { kind: 'renamePrefab', u: [0.09707820601761341, 0.14232445927336812, 0.9031931138597429, 0.3121798960492015, 0.3815521625801921, 0.3378106460440904, 0.31110939756035805, 0.10088769742287695] },
      { kind: 'prefabEdit', u: [0.5217692020814866, 0.24212318868376315, 0.6475640579592437, 0.7428316583391279, 0.8591179379727691, 0.2987568259704858, 0.37442863010801375, 0.12064710608683527], inner: [] },
      { kind: 'revert', u: [0.4475659942254424, 0.4263928036671132, 0.892479837173596, 0.5712739205919206, 0.016539404401555657, 0.49129072832874954, 0.5349354806821793, 0.03838557889685035] },
    ],
  },
  {
    issue: 1817,
    what: 'a prefab-edit drop of the edited prefab under a nested member is refused, and the save writes no self-containing file',
    reaches: { op: 0, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.7, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1817,
    what: 'the same, under a layer-added node',
    reaches: { op: 0, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.95, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1836,
    what: 'a prefab-edit reparent of the root is refused, so the delete after it cannot take the root out (seed 4535)',
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'renamePrefab', u: [0.6519922227598727, 0.2114757765084505, 0.018607930978760123, 0.30942356470040977, 0.8359362620394677, 0.67055669776164, 0.9231131041888148, 0.44708462059497833] },
      { kind: 'prefabEdit', u: [0.6905049616470933, 0.5051443385891616, 0.16762249427847564, 0.8142847665585577, 0.8068818023893982, 0.18743133172392845, 0.5548743580002338, 0.7678781691938639], inner: [{ kind: 'reparent', u: [0.08123077405616641, 0.6606571737211198, 0.837768564466387, 0.4680335680022836, 0.47950352635234594, 0.8769256870727986, 0.06606265692971647, 0.9000267873052508] }, { kind: 'delete', u: [0.08093803143128753, 0.029633563244715333, 0.4261932633817196, 0.4423936535604298, 0.4413971840403974, 0.8836731656920165, 0.1854370052460581, 0.35569544485770166] }] },
    ],
  },
  {
    issue: 1836,
    what: 'the same in one prefab-edit op (seed 3884)',
    reaches: { op: 0, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.0952886319719255, 0.1324546616524458, 0.7667984003201127, 0.040486402809619904, 0.38836244866251945, 0.164681785274297, 0.0033743923995643854, 0.9235746308695525], inner: [{ kind: 'reparent', u: [0.11242076917551458, 0.3747843843884766, 0.34736537211574614, 0.746526314644143, 0.02761491690762341, 0.7988603033591062, 0.11750280298292637, 0.11291002365760505] }, { kind: 'delete', u: [0.056537609081715345, 0.7215519584715366, 0.9376734544057399, 0.17930406494997442, 0.7820167003665119, 0.6088943409267813, 0.12121632206253707, 0.8013442442752421] }] },
    ],
  },
  {
    issue: 1807,
    what: "Create Prefab's undo right after its file was renamed (not undoable, #1868 D2) untags through the manifest's new path",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'createPrefab', u: [0.2, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'renamePrefab', u: [0.7, 0.564, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.4, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1812,
    what: "a save writes a nested frame the load could not expand as removed once the editor cache holds its prefab",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'trashPrefab', u: [0.974, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
    ],
  },
  {
    issue: 1812,
    what: 'the same, where the world swap is the final save→reload (baseline seed 246)',
    // #1869: this Apply first moved a member within its frame (the fuzzer's retired directed branch), then applied every
    // key. A member no longer moves, so the repro applies every key (`u[1] = 0`) without the move.
    reaches: { op: 11, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'renamePrefab', u: [0.29216481326147914, 0.1476494751404971, 0.18551874696277082, 0.07410656800493598, 0.41970898350700736, 0.4152033708523959, 0.13034801022149622, 0.09932499984279275] },
      { kind: 'createPrefab', u: [0.5039114304818213, 0.255739972461015, 0.09370358125306666, 0.7442081868648529, 0.380464835325256, 0.46510340296663344, 0.25256184837780893, 0.05835147784091532] },
      { kind: 'apply', u: [0.34238993865437806, 0.8626079652458429, 0.7433561105281115, 0.5390893309377134, 0.11274192971177399, 0.7927570475731045, 0.18178777326829731, 0.45353098190389574] },
      { kind: 'delete', u: [0.06625497713685036, 0.47400090959854424, 0.5515744984149933, 0.7681468736846, 0.9731338797137141, 0.23174102697521448, 0.8072744118981063, 0.29941663425415754] },
      { kind: 'instantiate', u: [0.20119513431563973, 0.5657289137598127, 0.7211238443851471, 0.49647562275640666, 0.6243061849381775, 0.26464452408254147, 0.3661036011762917, 0.5965113013517112] },
      { kind: 'saveReload', u: [0.0573893568944186, 0.7971355733461678, 0.14437886117957532, 0.3072776247281581, 0.9758012674283236, 0.8816886597778648, 0.9357743547298014, 0.19664020952768624] },
      { kind: 'delete', u: [0.0669010104611516, 0.11636064387857914, 0.5872549663763493, 0.6053570182994008, 0.006638948572799563, 0.7421369452495128, 0.9577205339446664, 0.015151593368500471] },
      { kind: 'delete', u: [0.7079145491588861, 0.5272478302940726, 0.4790234782267362, 0.44434544374234974, 0.36253262870013714, 0.09312379360198975, 0.05239138635806739, 0.6635237485170364] },
      { kind: 'instantiate', u: [0.29211976029910147, 0.15278238710016012, 0.25975321140140295, 0.7465326695237309, 0.994651313405484, 0.5035853921435773, 0.6328171074856073, 0.6932727838866413] },
      { kind: 'prefabEdit', u: [0.3292363465297967, 0.798240183852613, 0.011706580873578787, 0.7644205500837415, 0.3508245141711086, 0.12864016951061785, 0.8345876485109329, 0.7216439375188202], inner: [] },
      { kind: 'trashPrefab', u: [0.4036154255736619, 0.43466546991840005, 0.38601681031286716, 0.2412711256183684, 0.09834549622610211, 0.639129497576505, 0.9453888835851103, 0.30100506939925253] },
      { kind: 'apply', u: [0.7839175323024392,  0,  0.42464192933402956,  0.6151037919335067,  0.8330991917755455,  0.19254334270954132,  0.9538525966927409,  0.8849528867285699] },
    ],
  },
  {
    issue: 1797,
    what: "Apply's write into an enclosing prefab states nextLocalId",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'reparent', u: [0.19745544902980328, 0.9284775732085109, 0.5860603547189385, 0.22611782955937088, 0.25675307563506067, 0.33752377540804446, 0.4600350330583751, 0.8438367047347128] },
      { kind: 'saveReload', u: [0.4955816750880331, 0.3304008231498301, 0.0743095432408154, 0.34028684766963124, 0.5970875050406903, 0.020840930752456188, 0.5537212470080703, 0.47318257577717304] },
      { kind: 'editField', u: [0.33866258268244565, 0.3408757250290364, 0.588245488004759, 0.5010231542401016, 0.12284281710162759, 0.16788704600185156, 0.06966154696419835, 0.14767667441628873] },
      { kind: 'apply', u: [0.6356004311237484, 0.23566313600167632, 0.1354613231960684, 0.24098156881518662, 0.43663930892944336, 0.9642775468528271, 0.4479197319597006, 0.6394356489181519] },
    ],
  },
  {
    issue: 1798,
    what: "the validator reads a compact entry's top-level guid (a child of a placeholder is not an orphan)",
    reaches: { op: 9, outcome: 'refused', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'addChild', u: [0.8400129179935902, 0.47072196402586997, 0.8546695783734322, 0.5384382756892592, 0.7912890370935202, 0.9474262788426131, 0.8190620134118944, 0.5476701280567795] },
      { kind: 'duplicate', u: [0.08395724813453853, 0.5124020783696324, 0.0963418607134372, 0.3281203443184495, 0.6479879403486848, 0.0661356458440423, 0.3539451723918319, 0.9203498638235033] },
      { kind: 'delete', u: [0.3295891438610852, 0.6135888085700572, 0.5509396453853697, 0.4743896157015115, 0.5522417859174311, 0.7724654111079872, 0.03640387789346278, 0.3493649570737034] },
      { kind: 'duplicate', u: [0.12155674444511533, 0.3277325502131134, 0.8389609975274652, 0.7390714895445853, 0.4445467295590788, 0.6392863090150058, 0.4210883176419884, 0.6225011721253395] },
      { kind: 'trashPrefab', u: [0.031023554038256407, 0.8245022257324308, 0.3186694555915892, 0.4563527626451105, 0.0613121057394892, 0.6499785373453051, 0.7239432781934738, 0.2701634771656245] },
      { kind: 'addChild', u: [0.6957742967642844, 0.8604045836254954, 0.07128276745788753, 0.18332914565689862, 0.7442217774223536, 0.29817889304831624, 0.11375536606647074, 0.666205374756828] },
      { kind: 'delete', u: [0.9611131520941854, 0.5665881847962737, 0.99388741934672, 0.460568786598742, 0.4869730786886066, 0.4556502182967961, 0.1847134509589523, 0.4171289815567434] },
      { kind: 'delete', u: [0.11628153058700264, 0.2649255837313831, 0.9578696116805077, 0.2690436909906566, 0.48442695336416364, 0.6176841715350747, 0.8843859378248453, 0.29651732300408185] },
      { kind: 'prefabEdit', u: [0.08550754911266267, 0.17580716568045318, 0.49992706114426255, 0.3379638863261789, 0.5116101503372192, 0.6086981182452291, 0.6506540169939399, 0.689351754495874], inner: [] },
      { kind: 'reparent', u: [0.9714701315388083, 0.3523273344617337, 0.239267619792372, 0.6411985631566495, 0.8462079679593444, 0.059414628660306334, 0.5331373307853937, 0.8278629719279706] },
    ],
  },
  {
    issue: 1800,
    what: "(owner ruling 2026-09-30) a field edit, a SAVED prefab edit of that field's template row, undo: the undo showed the OLD template's value until a reload — an undo's restore takes unmarked fields from the CURRENT template (`takeUnmarkedFromBase`)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'editField', u: [0.4712959008757025, 0.8275178000330925, 0.49121224926784635, 0.6212974642403424, 0.6975932624191046, 0.6728624103125185, 0.8947997391223907, 0.08667013049125671] },
      { kind: 'prefabEdit', u: [0.8681810274720192, 0.16749268909916282, 0.8161069231573492, 0.7876874704379588, 0.7893141158856452, 0.44569642562419176, 0.6906714315991849, 0.05036597326397896], inner: [{ kind: 'editField', u: [0.1645703201647848, 0.8275178000330925, 0.14484930993057787, 0.48502749227918684, 0.6760991597548127, 0.7643051715567708, 0.5208719258662313, 0.6525644455105066] }] },
      { kind: 'undo', u: [0.0969133417820558, 0.30508144618943334, 0.9463921885471791, 0.4158526905812323, 0.7782247490249574, 0.8955092879477888, 0.17722644214518368, 0.5369507833383977] },
    ],
  },
  {
    issue: 1800,
    what: "the same through an ENCLOSING row: the saved edit makes the outer prefab's row state the nested root's field, and the undo left it unmarked where a load marks a layer's value (I2)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'editField', u: [0.7775587996002287, 0.7326254746876657, 0.24811475281603634, 0.5405777848791331, 0.5890987715683877, 0.1245007747784257, 0.17447392200119793, 0.7227780562825501] },
      { kind: 'prefabEdit', u: [0.5342796836048365, 0.27897502868436275, 0.41922668390907347, 0.552948132622987, 0.9571981730405241, 0.7823126642033458, 0.8997691958211362, 0.8628490304108709], inner: [{ kind: 'editField', u: [0.5282992697320879, 0.7326254746876657, 0.5962505836505443, 0.4514295852277428, 0.575614883331582, 0.41894231853075325, 0.7594635649584234, 0.8456736030057073] }] },
      { kind: 'undo', u: [0.10251698791980743, 0.4206185501534492, 0.03915440826676786, 0.6158307667355984, 0.6126558044925332, 0.9276149801444262, 0.9547831232193857, 0.27511594723910093] },
    ],
  },
  {
    issue: 1800,
    what: "#1831 seed 6246's shape (its recorded list no longer reaches it): delete a nested root inside a surviving frame, a saved prefab edit changes the row its frame states for it, undo: the respawn kept the snapshot's values and marks, which #1820's rebase does not reach",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.5070224402006716, 0.8619485697709024, 0.9757728257682174, 0.7284992127679288, 0.6041558503638953, 0.1483250679448247, 0.03138847346417606, 0.4043525764718652] },
      { kind: 'prefabEdit', u: [0.4734922975767404, 0.4044426974840462, 0.4575305092148483, 0.1505803307518363, 0.750539373839274, 0.7956425442826003, 0.6967292746994644, 0.018803290789946914], inner: [{ kind: 'editField', u: [0.7382535547949374, 0.35838567093014717, 0.4302390110678971, 0.7400455579627305, 0.9051126441918314, 0.4006013742182404, 0.19499290431849658, 0.3320545495953411] }] },
      { kind: 'undo', u: [0.2607048003701493, 0.7443551570177078, 0.5766629322897643, 0.34468370163813233, 0.22727112332358956, 0.44970121374353766, 0.604482646798715, 0.3479374977760017] },
    ],
  },
  {
    issue: 1831,
    what: "(#1831 class 5, default overrides) duplicate an instance (its root takes sortOrder 1, marked), rename the prefab, add a nested instance in prefab edit, Apply All, trash it: Apply All wrote the root's sortOrder into the template, so every instance reordered and the save\u2192reload\u2192save moved scene entries (hunt seed 7078b). Unity leaves a root's rootOrder out of Apply All",
    reaches: { op: 4, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'duplicate', u: [0.1578344590961933, 0.24375593406148255, 0.7935338299721479, 0.13648637919686735, 0.7001325930468738, 0.7577490815892816, 0.08583897724747658, 0.7946478647645563] },
      { kind: 'renamePrefab', u: [0.15260522859171033, 0.9074937796685845, 0.5885363011620939, 0.992758194450289, 0.3320654600393027, 0.9268944833893329, 0.7965489362832159, 0.5056572745088488] },
      { kind: 'prefabEdit', u: [0.408173335948959, 0.2903472015168518, 0.08049957547336817, 0.9836733096744865, 0.7093852632679045, 0.31604166934266686, 0.5591177130118012, 0.11229971726424992], inner: [{ kind: 'instantiate', u: [0.95360201690346, 0.8874173355288804, 0.4442296118941158, 0.5774526081513613, 0.89203717187047, 0.014723481610417366, 0.1876573828049004, 0.13132071518339217] }] },
      { kind: 'apply', u: [0.30113657494075596, 0.048860794166103005, 0.3124886667355895, 0.6841271475423127, 0.35076097887940705, 0.30353412753902376, 0.43169230152852833, 0.01736728218384087] },
      { kind: 'trashPrefab', u: [0.8926981235854328, 0.877595646539703, 0.7812122902832925, 0.9172592479735613, 0.9443073831498623, 0.025683170882984996, 0.7273388302419335, 0.8678379745688289] },
    ],
  },
  {
    issue: 1831,
    what: "(harness) the same prefab renamed, then trashed: the restored comparison put it back at its PRE-rename path with pre-rename bytes, so an entity was lost. It is restored at the last path it had (hunt seed 7078a)",
    reaches: { op: 4, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'duplicate', u: [0.1578344590961933, 0.24375593406148255, 0.7935338299721479, 0.13648637919686735, 0.7001325930468738, 0.7577490815892816, 0.08583897724747658, 0.7946478647645563] },
      { kind: 'renamePrefab', u: [0.15260522859171033, 0.9074937796685845, 0.5885363011620939, 0.992758194450289, 0.3320654600393027, 0.9268944833893329, 0.7965489362832159, 0.5056572745088488] },
      { kind: 'prefabEdit', u: [0.408173335948959, 0.2903472015168518, 0.08049957547336817, 0.9836733096744865, 0.7093852632679045, 0.31604166934266686, 0.5591177130118012, 0.11229971726424992], inner: [{ kind: 'editField', u: [0.8104759207926691, 0.48442328115925193, 0.7918606013990939, 0.36312339385040104, 0.998306782450527, 0.8185179363936186, 0.27459856076166034, 0.9246579294558614] }, { kind: 'instantiate', u: [0.95360201690346, 0.8874173355288804, 0.4442296118941158, 0.5774526081513613, 0.89203717187047, 0.014723481610417366, 0.1876573828049004, 0.13132071518339217] }] },
      { kind: 'apply', u: [0.30113657494075596, 0.048860794166103005, 0.3124886667355895, 0.6841271475423127, 0.35076097887940705, 0.30353412753902376, 0.43169230152852833, 0.01736728218384087] },
      { kind: 'trashPrefab', u: [0.8926981235854328, 0.877595646539703, 0.7812122902832925, 0.9172592479735613, 0.9443073831498623, 0.025683170882984996, 0.7273388302419335, 0.8678379745688289] },
    ],
  },
  {
    issue: 1831,
    what: "(harness) an Apply's undo is memory-only since #1868, then the prefab is trashed: the restored comparison put back its FILE (the applied z = 2), not the document the live world was built on (z = 0). It restores what the editor held (hunt seed 7023)",
    reaches: { op: 10, outcome: 'done', skips: ['assetDelete: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'duplicate', u: [0.647779816063121, 0.8219792027957737, 0.29855182068422437, 0.6044678448233753, 0.09461582102812827, 0.1366605330258608, 0.6094130617566407, 0.927808380452916] },
      { kind: 'instantiate', u: [0.36860530264675617, 0.7499569500796497, 0.7490200535394251, 0.08746740291826427, 0.9738392268773168, 0.06819606386125088, 0.40939240902662277, 0.322063458384946] },
      { kind: 'renamePrefab', u: [0.11921973223797977, 0.6677256901748478, 0.3972973704803735, 0.02879378292709589, 0.8565406815614551, 0.23200723063200712, 0.3135092130396515, 0.0614908030256629] },
      { kind: 'renamePrefab', u: [0.08595340000465512, 0.4139995537698269, 0.3895259923301637, 0.9545069655869156, 0.13117212383076549, 0.925211570225656, 0.17355820816010237, 0.49910776945762336] },
      { kind: 'addChild', u: [0.28278589248657227, 0.6771312530618161, 0.5974755955394357, 0.3944992658216506, 0.24109443207271397, 0.6170475881081074, 0.18164523877203465, 0.3164018578827381] },
      { kind: 'apply', u: [0.13190499017946422, 0.6293569221161306, 0.4083241184707731, 0.7749711794313043, 0.5196833307854831, 0.6275985727552325, 0.2270456508267671, 0.4419883864466101] },
      { kind: 'saveReload', u: [0.12344127730466425, 0.8261572825722396, 0.9232081398367882, 0.7329055424779654, 0.9358599742408842, 0.31205685483291745, 0.6832538694143295, 0.8957450836896896] },
      { kind: 'editField', u: [0.9353783011902124, 0.5003702833782881, 0.6039692114572972, 0.5763863434549421, 0.3473860970698297, 0.07745053363032639, 0.5117622409015894, 0.5764460877981037] },
      { kind: 'apply', u: [0.15120297786779702, 0.4092398507054895, 0.5241000116802752, 0.7471678545698524, 0.6773686071392149, 0.4791547318454832, 0.7477727117948234, 0.7124238025862724] },
      { kind: 'undo', u: [0.61813282687217, 0.257685229415074, 0.997010983293876, 0.3102067520376295, 0.035096414387226105, 0.24458888242952526, 0.1629161403980106, 0.1488716104067862] },
      { kind: 'trashPrefab', u: [0.019153482746332884, 0.27225136500783265, 0.8426550636067986, 0.6012319817673415, 0.7483199837151915, 0.4522188405971974, 0.8256277092732489, 0.7094620510470122] },
    ],
  },
  {
    issue: 1831,
    what: "(harness) Instantiate, undo, trash the prefab, redo: #308's documented \"file deleted\" redo message is expected, not a finding (hunt seed 7293)",
    reaches: { op: 3, outcome: 'done', skips: ['assetDelete: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'instantiate', u: [0.7297261725179851, 0.8431389695033431, 0.3086627044249326, 0.9838097677566111, 0.9265915586147457, 0.7662471178919077, 0.8639055562671274, 0.25600842176936567] },
      { kind: 'undo', u: [0.49273139308206737, 0.48945848969742656, 0.30339407664723694, 0.6943983982782811, 0.253624603850767, 0.3927691818680614, 0.059129673056304455, 0.7362781490664929] },
      { kind: 'trashPrefab', u: [0.729973612818867, 0.2833421279210597, 0.09125652466900647, 0.8874531721230596, 0.16194705362431705, 0.5596772648859769, 0.6948852005880326, 0.7293691348750144] },
      { kind: 'redo', u: [0.9483624764252454, 0.705181025667116, 0.38583859661594033, 0.939787067938596, 0.0182990541215986, 0.9201007711235434, 0.5913940297905356, 0.010015198262408376] },
    ],
  },
  {
    issue: 1831,
    what: "(harness, ruling R) a scene entity moved under an instance of a trashed prefab; the instance deleted: the delete's undo respawns it in the SAME world as a Missing Prefab placeholder that swallows the entity, so the next undo on it refuses by ruling R. The runner taints that segment (`swallowedRecorded`) (hunt seed 6356)",
    reaches: { op: 6, outcome: 'done' },
    repro: [
      { kind: 'trashPrefab', u: [0.2729424652643502, 0.4098491012118757, 0.29578961874358356, 0.0715752353426069, 0.3902849357109517, 0.5432256888598204, 0.14779127156361938, 0.7190025397576392] },
      { kind: 'instantiate', u: [0.5839928763452917, 0.6164563843049109, 0.8372499893885106, 0.1193005929235369, 0.3928135307505727, 0.07510777679271996, 0.6468799393624067, 0.9758125292137265] },
      { kind: 'instantiate', u: [0.9178969538770616, 0.05191261856816709, 0.9469316492322832, 0.3597495590802282, 0.4123583035543561, 0.8422741163522005, 0.1534926772583276, 0.5350515025202185] },
      { kind: 'reparent', u: [0.06773523986339569, 0.29443418327718973, 0.3553683429490775, 0.5264732516370714, 0.6650587907060981, 0.4142718880902976, 0.7284529597964138, 0.8327693839091808] },
      { kind: 'addComponent', u: [0.07627140008844435, 0.7827790067531168, 0.40170716238208115, 0.3061293624341488, 0.2677302942611277, 0.6483881562016904, 0.9803187360521406, 0.7246397191192955] },
      { kind: 'apply', u: [0.10244770138524473, 0.7300383383408189, 0.5696746739558876, 0.06330077606253326, 0.6680648103356361, 0.5124142579734325, 0.8370073803234845, 0.5396201724652201] },
      { kind: 'delete', u: [0.036498465575277805, 0.042304785223677754, 0.4129279023036361, 0.6311721648089588, 0.4325354811735451, 0.039276400581002235, 0.29011039971373975, 0.29810293670743704] },
    ],
  },
  {
    issue: 1872,
    what: "Windows hunt seed 6053: a template-added REFERENCE node re-anchored to its frame root (P's prefab edit deleted its anchor), edited inside by a scene delete, pinned the whole list at the root; the load's fold replaced only the nodes whose own anchor was the root, so the template's copies spawned beside the pinned ones (I7 duplicate guid on the next reload)",
    reaches: { op: 14, outcome: 'done', skips: ['prefabEditSave: undo refusal forgiven (rest of the walk not run)'] },
    repro: [
      { kind: 'instantiate', u: [0.6727333776652813, 0.03602659655734897, 0.6944148486945778, 0.7366161625832319, 0.040293456986546516, 0.30280971992760897, 0.260529940482229, 0.5547153684310615] },
      { kind: 'duplicate', u: [0.23169829766266048, 0.4410246934276074, 0.8222101412247866, 0.3506382517516613, 0.6698429598473012, 0.6916433696169406, 0.6952236338984221, 0.20826734835281968] },
      { kind: 'instantiate', u: [0.6082416258286685, 0.3922657244838774, 0.35303167859092355, 0.6436697214376181, 0.668862575897947, 0.5312209650874138, 0.0540543629322201, 0.04668264742940664] },
      { kind: 'reparent', u: [0.6502893504220992, 0.47112358920276165, 0.7188535134773701, 0.2169447394553572, 0.4893360927235335, 0.5293548754416406, 0.8961892125662416, 0.09683129144832492] },
      { kind: 'prefabEdit', u: [0.6752093727700412, 0.48999632708728313, 0.1664101337082684, 0.3519437697250396, 0.9695968751329929, 0.541721326764673, 0.19388855854049325, 0.141506714746356], inner: [] },
      { kind: 'apply', u: [0.0887219572905451, 0.7974996655248106, 0.7777760927565396, 0.7506156349554658, 0.7280220629181713, 0.8423147306311876, 0.4382405795622617, 0.9358075894415379] },
      { kind: 'duplicate', u: [0.8536271995399147, 0.5478534940630198, 0.9882300053723156, 0.45068583777174354, 0.4275446659885347, 0.6499504465609789, 0.17712222854606807, 0.6391849115025252] },
      { kind: 'addChild', u: [0.8861947644036263, 0.3740362850949168, 0.6131360183935612, 0.5300964876078069, 0.5953033079858869, 0.43441235669888556, 0.9592510822694749, 0.4432985186576843] },
      { kind: 'saveReload', u: [0.5821434087119997, 0.6170384893193841, 0.5426212782040238, 0.6075585458893329, 0.598365475423634, 0.5460347866173834, 0.07424886478111148, 0.16196894622407854] },
      { kind: 'reparent', u: [0.2691115913912654, 0.7177944688592106, 0.3226120152976364, 0.42646927130408585, 0.7878745435737073, 0.9163731141015887, 0.5520495988894254, 0.8863208296243101] },
      { kind: 'createPrefab', u: [0.42128309258259833, 0.7291045738384128, 0.3913924724329263, 0.8703403077088296, 0.8042178256437182, 0.7335473310668021, 0.11902031418867409, 0.4835782435256988] },
      { kind: 'prefabEdit', u: [0.6768674780614674, 0.5850495675113052, 0.036219006637111306, 0.4407619808334857, 0.6837912634946406, 0.4771320461295545, 0.5534138723742217, 0.7143814351875335], inner: [{ kind: 'delete', u: [0.27599901403300464, 0.5311330147087574, 0.21392283774912357, 0.4606079605873674, 0.8785075128544122, 0.323012778069824, 0.46160522871650755, 0.7822509927209467] }, { kind: 'reparent', u: [0.15744089521467686, 0.5380053559783846, 0.38548832666128874, 0.5302761339116842, 0.8363188181538135, 0.40198767371475697, 0.3032138596754521, 0.4694216903299093] }, { kind: 'instantiate', u: [0.3857515521813184, 0.6117347273975611, 0.9937147260643542, 0.288557460764423, 0.7372464118525386, 0.8324874786194414, 0.45630949968472123, 0.2181201062630862] }] },
      { kind: 'createPrefab', u: [0.754655567696318, 0.9903104931581765, 0.85263856430538, 0.014787685824558139, 0.012711717747151852, 0.7945738902781159, 0.22637150320224464, 0.47174792527221143] },
      { kind: 'delete', u: [0.8748915053438395, 0.556681145215407, 0.7585619639139622, 0.4336816961877048, 0.9701537557411939, 0.9024638626724482, 0.7584799681790173, 0.25685738073661923] },
      { kind: 'prefabEdit', u: [0.9416578407399356, 0.13801936781965196, 0.054412305587902665, 0.19675762369297445, 0.19520224956795573, 0.5733210209291428, 0.23114062659442425, 0.39696667110547423], inner: [] },
    ],
  },
  {
    issue: 1872,
    what: "hunt seed 6018 (Apply, undo, Apply): the undo parked the pre-Apply document with its OLD localId mark, and the second Apply minted over the park, giving a new row the number the undone row held (I4 localId re-bound; the close-out review's F2 — the restore now states the mark the file holds)",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'apply', u: [0.3251761158462614, 0.7442192495800555, 0.7713342877104878, 0.16702440893277526, 0.4877705464605242, 0.4157228539697826, 0.6191448420286179, 0.6907118388917297] },
      { kind: 'undo', u: [0.6909999179188162, 0.029866117285564542, 0.14964473526924849, 0.8444509881082922, 0.10568741662427783, 0.5086566116660833, 0.2739753045607358, 0.9196435029152781] },
      { kind: 'apply', u: [0.3219535604584962, 0.8672106517478824, 0.028542581014335155, 0.31881513609550893, 0.421314514009282, 0.8669111975468695, 0.3148637036792934, 0.38400822319090366] },
    ],
  },
  {
    issue: 1826,
    what: "win hunt seed 6068 (copy O, paste under P1, paste again under the copy's deep M, a field edit, Revert on P1): the rebuild respawned the scene-added reference node from its legacy channels, whose nested slot owned M's frame and dropped O's member-row value (y 8 → 0 live, the mark gone; a reload brought it back). Since #1880 F7d a rebuild IS the load of the outermost scene entry, so the respawn form that diverged is gone; this now guards that Revert's rebuild of that nested paste keeps O's member-row value, through the per-step world checks and the round trip (its rebuild≡reload compares the loader with itself) (text updated #1933)",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.04764881054870784, 0.778251877753064, 0.9165127624291927, 0.8202143374364823, 0.5160739088896662, 0.30105136916972697, 0.3395586118567735, 0.5821117775049061] },
      { kind: 'paste', u: [0.829431097721681, 0.6632490910124034, 0.9748543882742524, 0.2753764765802771, 0.4062094173859805, 0.5706668577622622, 0.02846250729635358, 0.8327327019069344] },
      { kind: 'paste', u: [0.4971544926520437, 0.9697078519966453, 0.09374690637923777, 0.7177969496697187, 0.6884505900088698, 0.12698264233767986, 0.8254657676443458, 0.6463707357179374] },
      { kind: 'editField', u: [0.05857755406759679, 0.23396126460283995, 0.6570560841355473, 0.9813611928839236, 0.3386081038042903, 0.37557874084450305, 0.8002111616078764, 0.41747555905021727] },
      { kind: 'revert', u: [0.10300773940980434, 0.9459807516541332, 0.23588446504436433, 0.0745482372585684, 0.41630160971544683, 0.058943358482792974, 0.7195065701380372, 0.8164950597565621] },
    ],
  },
  {
    issue: 1826,
    what: "win hunt seed 6068 in full (40 ops, shrunk to 17: pastes, a detach and its undo, a prefab edit, an Apply, a Revert): the same loss through the nested re-apply's THIRD respawn channel, a node row's own (the scene's nodes under a template node the diff matched), which the first two swaps missed. The side-effect hunt of the review's rework found it, as the close-out re-review's F1 did",
    reaches: { op: 16, outcome: 'done' },
    repro: [
      { kind: 'copy', u: [0.04764881054870784, 0.778251877753064, 0.9165127624291927, 0.8202143374364823, 0.5160739088896662, 0.30105136916972697, 0.3395586118567735, 0.5821117775049061] },
      { kind: 'paste', u: [0.829431097721681, 0.6632490910124034, 0.9748543882742524, 0.2753764765802771, 0.4062094173859805, 0.5706668577622622, 0.02846250729635358, 0.8327327019069344] },
      { kind: 'instantiate', u: [0.9183149840682745, 0.25740785943344235, 0.7204851771239191, 0.7574727605096996, 0.6275560890790075, 0.7380500256549567, 0.0380500394385308, 0.24560596933588386] },
      { kind: 'duplicate', u: [0.45867150952108204, 0.8889311312232167, 0.6553237270563841, 0.8826946287881583, 0.08209927892312407, 0.7391018280759454, 0.9387767997104675, 0.5417016015853733] },
      { kind: 'paste', u: [0.41638570884242654, 0.914155691396445, 0.7395338155329227, 0.9473394879605621, 0.8580705944914371, 0.11697058798745275, 0.269566950853914, 0.47782232123427093] },
      { kind: 'cut', u: [0.44964234763756394, 0.20451960456557572, 0.5099765381310135, 0.7369749115314335, 0.19381901831366122, 0.7945801829919219, 0.3911868389695883, 0.7333693311084062] },
      { kind: 'reparent', u: [0.17587015801109374, 0.6001306856051087, 0.4154316142667085, 0.6931810271926224, 0.7908522996585816, 0.5230817971751094, 0.5271925355773419, 0.292957806494087] },
      { kind: 'reparent', u: [0.4868444362655282, 0.3777251096908003, 0.7665910834912211, 0.2440586043521762, 0.803527171490714, 0.32019355427473783, 0.33175959484651685, 0.47970069688744843] },
      { kind: 'undo', u: [0.5613775083329529, 0.48646922945044935, 0.8626521269325167, 0.02826634724624455, 0.09759986284188926, 0.7997445240616798, 0.07392809446901083, 0.4688339759595692] },
      { kind: 'paste', u: [0.4971544926520437, 0.9697078519966453, 0.09374690637923777, 0.7177969496697187, 0.6884505900088698, 0.12698264233767986, 0.8254657676443458, 0.6463707357179374] },
      { kind: 'instantiate', u: [0.7205920538399369, 0.15561190876178443, 0.18718173122033477, 0.260292504215613, 0.529160360340029, 0.473796131554991, 0.2679348874371499, 0.23611482419073582] },
      { kind: 'detach', u: [0.6561402042862028, 0.6178482088726014, 0.10798417637124658, 0.5458981564734131, 0.7687317614909261, 0.7641601394861937, 0.20470329094678164, 0.28006004402413964] },
      { kind: 'undo', u: [0.016805007588118315, 0.5074693711940199, 0.7533267114777118, 0.43860757700167596, 0.8679894364904612, 0.2775770090520382, 0.38356187217868865, 0.4358381812926382] },
      { kind: 'editField', u: [0.4026855924166739, 0.77651690505445, 0.9000584019813687, 0.33512756414711475, 0.005659426562488079, 0.1459284103475511, 0.29845964605920017, 0.35923183034174144] },
      { kind: 'prefabEdit', u: [0.6602060906589031, 0.7722903699614108, 0.046306394739076495, 0.4354018848389387, 0.6383797195740044, 0.00757620926015079, 0.27335057221353054, 0.9655297582503408], inner: [{kind: 'editField', u: [0.2723894009832293, 0.3440808386076242, 0.38849525479599833, 0.34643942350521684, 0.2939225498121232, 0.4980644138995558, 0.7235275397542864, 0.5455082601401955]}] },
      { kind: 'apply', u: [0.9444699522573501, 0.9697569771669805, 0.6445089119952172, 0.01745554292574525, 0.2604943821206689, 0.2058720807544887, 0.09563729888759553, 0.6979681747034192] },
      { kind: 'revert', u: [0.10300773940980434, 0.9459807516541332, 0.23588446504436433, 0.0745482372585684, 0.41630160971544683, 0.058943358482792974, 0.7195065701380372, 0.8164950597565621] },
    ],
  },
  {
    issue: 1738,
    what: "win hunt seed 6136 (instantiate, Create Prefab, trash, a saved prefab edit): the save's by-design #1738 refusal of a reference node whose prefab is missing failed the step as console.error \u2014 its wording was not in EXPECTED_ERRORS",
    reaches: { op: 3, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'instantiate', u: [0.4431566004641354, 0.7968979061115533, 0.40783188841305673, 0.5022549307905138, 0.19927031104452908, 0.6920147859491408, 0.2723008228931576, 0.9618998144287616] },
      { kind: 'createPrefab', u: [0.0038380103651434183, 0.591657679527998, 0.6498477926943451, 0.16832039435394108, 0.2952046236023307, 0.20283732656389475, 0.14619030989706516, 0.46976823825389147] },
      { kind: 'trashPrefab', u: [0.366121573606506, 0.12152830720879138, 0.5724751548841596, 0.37606001063250005, 0.03529732837341726, 0.28352958406321704, 0.45296140434220433, 0.5870168737601489] },
      { kind: 'prefabEdit', u: [0.301515509840101, 0.43780972715467215, 0.667069936171174, 0.5753587565850466, 0.6484025486279279, 0.15705850371159613, 0.9615241875872016, 0.1484056394547224], inner: [] },
    ],
  },
  {
    issue: 1809,
    what: "Delete's undo after a saved prefab edit dropped the anchor row: the rebase re-anchored the keyed node and kept its guid, the reload derived another (was KNOWN_OPEN; fixed by deriving a keyed node from its frame root, the Unity way)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.02, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.55, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.15, 0.5, 0.5, 0, 0, 0, 0, 0] }] },
      { kind: 'undo', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1809,
    what: "Detach's undo after a prefab-edit save deleted the anchor row: the same rebase (was KNOWN_OPEN)",
    reaches: { op: 2, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      { kind: 'detach', u: [0.025726123247295618, 0.6438882742077112, 0.055156498216092587, 0.2290809666737914, 0.325337108457461, 0.7244618884287775, 0.937406157143414, 0.4990142297465354] },
      { kind: 'prefabEdit', u: [0.5476142126135528, 0.18346081534400582, 0.2778930668719113, 0.278214025311172, 0.27691279095597565, 0.6830818050075322, 0.0016407903749495745, 0.34888543910346925], inner: [{ kind: 'delete', u: [0.19734677020460367, 0.22199939331039786, 0.5219223950989544, 0.29861879511736333, 0.49865362676791847, 0.32312997709959745, 0.16570315975695848, 0.15814896672964096] }] },
      { kind: 'undo', u: [0.47763126995414495, 0.6631570672616363, 0.7647192350123078, 0.0125291314907372, 0.2069809422828257, 0.5996168968267739, 0.4597687148489058, 0.01827254961244762] },
    ],
  },
  {
    issue: 1809,
    what: "#1831 hunt seed 52: a Delete inside an instance, then an Apply, dropped the row a keyed node hangs under; its guid changed on reload",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      { kind: 'delete', u: [0.6995459569152445, 0.4692440126091242, 0.925465441076085, 0.14738976070657372, 0.1254213151987642, 0.2452597978990525, 0.8375669901724905, 0.2795277084223926] },
      { kind: 'apply', u: [0.18453670502640307, 0.07353104162029922, 0.8836200351361185, 0.9087016845587641, 0.13220753101632, 0.7051906674169004, 0.17632998549379408, 0.44616461638361216] },
    ],
  },
  {
    issue: 1809,
    what: "#1831 hunt seed 208 (editField, Apply, delete, save\u2192reload, Apply): the same",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      { kind: 'editField', u: [0.43252027384005487, 0.30455148313194513, 0.12510684435255826, 0.35393382515758276, 0.5243591470643878, 0.6808256064541638, 0.34482107195071876, 0.9128175110090524] },
      { kind: 'apply', u: [0.5401981819886714, 0.9833217167761177, 0.6220702491700649, 0.7820049456786364, 0.7201114508789033, 0.5151209577452391, 0.6677789050154388, 0.1101147923618555] },
      { kind: 'delete', u: [0.09509853785857558, 0.1733004874549806, 0.7537630847655237, 0.24513555597513914, 0.2605592079926282, 0.9342146618291736, 0.05207347613759339, 0.9333211013581604] },
      { kind: 'saveReload', u: [0.18028137739747763, 0.4548219458665699, 0.4665694765280932, 0.34894793829880655, 0.3701279640663415, 0.34367631655186415, 0.10366322263143957, 0.7963432953692973] },
      { kind: 'apply', u: [0.21407024026848376, 0.13395719486288726, 0.3858836283907294, 0.870954223908484, 0.957652852172032, 0.6814525281079113, 0.03478979133069515, 0.39107713918201625] },
    ],
  },
  {
    issue: 1809,
    what: "work-ai's hunt seed 7018 (instantiate, delete, Apply): the same",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      { kind: 'instantiate', u: [0.5719347195699811, 0.8136770059354603, 0.5990205884445459, 0.739400121383369, 0.25479283300228417, 0.9134822161868215, 0.43771372525952756, 0.5492035846691579] },
      { kind: 'delete', u: [0.8338866247795522, 0.7534691514447331, 0.31723364163190126, 0.4215981762390584, 0.42713380814529955, 0.5028764205053449, 0.9942377656698227, 0.809980405960232] },
      { kind: 'apply', u: [0.8177705984562635, 0.16685707564465702, 0.39900506334379315, 0.41232000361196697, 0.527749179629609, 0.2596365693025291, 0.5486904385033995, 0.21155882999300957] },
    ],
  },
  {
    issue: 1809,
    what: "win's hunt seed 6858 (a saved prefab-edit reparent, instantiate, delete, Apply): the same",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'prefabEdit', u: [0.5173346495721489, 0.08749266993254423, 0.8221204644069076, 0.18406294146552682, 0.3249459487851709, 0.8549291610252112, 0.2693206842523068, 0.9086369727738202], inner: [{ kind: 'reparent', u: [0.22139877150766551, 0.8194225707557052, 0.8731111134402454, 0.3676116168498993, 0.9742902971338481, 0.127988196676597, 0.6087110303342342, 0.1887473629321903] }] },
      { kind: 'instantiate', u: [0.7440747111104429, 0.43991357320919633, 0.6826722382102162, 0.4947671240661293, 0.6600351938977838, 0.9901851266622543, 0.6497153099626303, 0.006117034703493118] },
      { kind: 'delete', u: [0.6108392698224634, 0.46971312118694186, 0.05811715195886791, 0.6591711670625955, 0.9784175350796431, 0.0649864545557648, 0.2063837342429906, 0.6221727712545544] },
      { kind: 'apply', u: [0.21948481863364577, 0.29272619541734457, 0.5293124683666974, 0.5085932151414454, 0.07048665941692889, 0.9514830820262432, 0.5172908876556903, 0.5575136966072023] },
    ],
  },
  {
    issue: 1831,
    what: "win's hunt seed 5785 (outside edit, instantiate, reload, Create Prefab, outside edit, instantiate): Instantiate's redo stamped two same-named, same-sortOrder siblings' captured guids on each other — `subtreePaths` broke the tie by ECS id; since #1880 T4 the redo restores the root guid alone and the members derive from it",
    reaches: { op: 5, outcome: 'done', skips: ['outsideEdit: redo to the end identity', 'outsideEdit: undo to the start identity'] },
    repro: [
      { kind: 'outsideEdit', u: [0.5804205713793635, 0.3449911961797625, 0.3660748016554862, 0.5420442717149854, 0.16340817837044597, 0.4051378946751356, 0.857144245877862, 0.6200678029563278] },
      { kind: 'instantiate', u: [0.4052014930639416, 0.5435688749421388, 0.020824921317398548, 0.5509664637502283, 0.11242570425383747, 0.977078641531989, 0.39850156800821424, 0.37629526830278337] },
      { kind: 'saveReload', u: [0.5659961933270097, 0.2859741149004549, 0.9333900331985205, 0.9689326591324061, 0.7757892911322415, 0.23743034177459776, 0.7279235208407044, 0.6892111517954618] },
      { kind: 'createPrefab', u: [0.45945963938720524, 0.14096670248545706, 0.28122900100424886, 0.9242792420554906, 0.1517205114942044, 0.14161666529253125, 0.6635911040939391, 0.8539897622540593] },
      { kind: 'outsideEdit', u: [0.7732202366460115, 0.43073028279468417, 0.23759453860111535, 0.6381725699175149, 0.1748367955442518, 0.7444138263817877, 0.9588372244033962, 0.9275012211874127] },
      { kind: 'instantiate', u: [0.2953082164749503, 0.41264479514211416, 0.8145114372018725, 0.6844961079768836, 0.833091844804585, 0.2344624507240951, 0.8496560871135443, 0.025714685209095478] },
    ],
  },
  {
    issue: 1882,
    what: "hunt seed 1044, 16 ops (#1873 R1's side-effect hunt): Create Prefab of a P instance kept its members' P-era guids (B = R|2.3) while numbering R's rows by position (B = 4); an Apply adding row 3 to Q derived R|2.3 inside R's nested Q at step 2 — I7, two entities on B's guid. Fixed at the numbering (M2 a: a Create of an instance root keeps each member's step) and at the collision (M2 b: the derivation yields to the pin)",
    reaches: { op: 15, outcome: 'done' },
    repro: [
      { kind: 'createPrefab', u: [0.634666639380157, 0.3174730681348592, 0.7355833407491446, 0.19407839910127223, 0.9235845222137868, 0.34193338244222105, 0.6516128715593368, 0.02848117519170046] },
      { kind: 'instantiate', u: [0.369677901500836, 0.14730516378767788, 0.5732436503749341, 0.6488885758444667, 0.6533301493618637, 0.7522978920023888, 0.5997006171382964, 0.31304718973115087] },
      { kind: 'createPrefab', u: [0.05334129952825606, 0.7526920889504254, 0.5037239580415189, 0.8514982794877142, 0.43039503367617726, 0.563083395594731, 0.2284891288727522, 0.206626697210595] },
      { kind: 'saveReload', u: [0.4293057145550847, 0.3353775723371655, 0.22831196803599596, 0.2265761666931212, 0.5992750311270356, 0.6865353158209473, 0.3167659007012844, 0.8698408603668213] },
      { kind: 'addChild', u: [0.49866046058014035, 0.8871587731409818, 0.9561562158633024, 0.36384842079132795, 0.9443478977773339, 0.521283179987222, 0.27259606891311705, 0.6941438028588891] },
      { kind: 'instantiate', u: [0.041748500894755125, 0.47918692347593606, 0.7297227901872247, 0.4976612089667469, 0.9440350525546819, 0.4430330106988549, 0.001947255339473486, 0.08308386290445924] },
      { kind: 'duplicate', u: [0.6666788682341576, 0.04839487583376467, 0.3305956188123673, 0.5106028800364584, 0.08256420865654945, 0.31239129533059895, 0.08394767553545535, 0.4379582467954606] },
      { kind: 'reparent', u: [0.3140938216820359, 0.34216171340085566, 0.5187386262696236, 0.8466534896288067, 0.20524846692569554, 0.9345775407273322, 0.49453562893904746, 0.9528217972256243] },
      { kind: 'undo', u: [0.3257399934809655, 0.899480054853484, 0.5600920186843723, 0.724329340737313, 0.547793026547879, 0.1230935042258352, 0.6685438824351877, 0.3582190426532179] },
      { kind: 'removeComponent', u: [0.2317351740784943, 0.5922968902159482, 0.6268885363824666, 0.26227352302521467, 0.918341345153749, 0.058655548142269254, 0.47246233467012644, 0.40614194492809474] },
      { kind: 'saveReload', u: [0.024945680052042007, 0.9109774697571993, 0.3602384044788778, 0.1661211922764778, 0.03377426043152809, 0.9353294756729156, 0.38180076656863093, 0.7485042053740472] },
      { kind: 'undo', u: [0.8820494378451258, 0.5041857762262225, 0.12974683661013842, 0.4631980445701629, 0.44862883700989187, 0.007046703714877367, 0.6566884631756693, 0.9630365180782974] },
      { kind: 'duplicate', u: [0.5922000030986965, 0.8918080008588731, 0.37653653300367296, 0.40761015261523426, 0.8997404808178544, 0.31068998854607344, 0.4899208969436586, 0.7036074330098927] },
      { kind: 'duplicate', u: [0.11618616664782166, 0.4094626458827406, 0.7335912869311869, 0.8117183623835444, 0.36512333364225924, 0.3593670935370028, 0.49200560501776636, 0.6176302251406014] },
      { kind: 'addComponent', u: [0.775519015500322, 0.54315011552535, 0.3673243827652186, 0.23754397220909595, 0.3031806906219572, 0.20069602387957275, 0.4418669273145497, 0.3267574228812009] },
      { kind: 'apply', u: [0.9029043486807495, 0.6226571027655154, 0.09409046894870698, 0.16338107455521822, 0.8167720201890916, 0.8933723263908178, 0.3984716364648193, 0.7467096587643027] },
    ],
  },
  {
    issue: 1880,
    what: "F6 precondition hunt seed 1171 (3090 is the same mechanism): a TEMPLATE-added node (O's row N adds Extra under P's member A) under a member an Apply drops from P. F3a's `withoutGoneMemberNodes` dropped it with the scene's own nodes, while a reload re-anchors it at N's frame root (\"anchor missing → root\"): rebuild ≠ reload. Since #1880 F7d the rebuild is the load of the outermost entry, so both sides re-anchor through the loader (`withoutGoneMemberNodes` and `layerAuthoredNodeGuids` went with the old route); this now guards that an Apply dropping the member leaves the template-added node re-anchored at N's frame root, through I23 and the round trip (text updated #1933)",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'reparent', u: [0.03160661831498146, 0.6695412455592304, 0.913755728630349, 0.3830101368948817, 0.9675972813274711, 0.8822341142222285, 0.0629757174756378, 0.5305535295046866] },
      { kind: 'prefabEdit', u: [0.13717939867638052, 0.7131396168842912, 0.18489172449335456, 0.6059518004767597, 0.20130644855089486, 0.16419226513244212, 0.33560820668935776, 0.010541375959292054], inner: [] },
      { kind: 'delete', u: [0.25035141315311193, 0.7507564211264253, 0.9290105449035764, 0.8282686581369489, 0.5362858024891466, 0.8408432477153838, 0.30600635055452585, 0.9304315994959325] },
      { kind: 'apply', u: [0.06982092093676329, 0.6507889749482274, 0.9688183201942593, 0.8480763635598123, 0.7799043250270188, 0.9346878521610051, 0.5688009855803102, 0.9248915063217282], check: 'rebuild-reload' },
    ],
  },
  {
    issue: 1891,
    what: "#1880 F6 precondition hunt seed 3265 (T4; 3292 is the same mechanism): a reference node the scene hung in a NODE ROW's own (under template node Extra) lost its members' pinned guids on a no-op rebuild — the old rebuild's pin walk never reached node-row own. Fixed by #1880 F6c: the rebuild settles through the loader's own post-pass (`settleEntryRows`), whose reference-row walk covers every channel",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.14981729490682483, 0.5979397119954228, 0.5348868125583977, 0.5220310764852911, 0.096922472352162, 0.8983463814947754, 0.36227904772385955, 0.8295183572918177] },
      { kind: 'addChild', u: [0.7338485296349972, 0.24986214167438447, 0.14688554708845913, 0.4074539050925523, 0.10735217505134642, 0.005733222933486104, 0.9680708202067763, 0.22049151291139424] },
      { kind: 'reparent', u: [0.1585476107429713, 0.7742696758359671, 0.48420550394803286, 0.8099868271965533, 0.9923207000829279, 0.9547602660022676, 0.5826827390119433, 0.8156926503870636] },
      { kind: 'createPrefab', u: [0.3763056464958936, 0.30700652580708265, 0.8074927234556526, 0.7040917878039181, 0.6436235592700541, 0.44129140488803387, 0.17668788298033178, 0.4260172820650041] },
    ],
  },
  {
    issue: 1896,
    what: "hunt seed 1286: save→reload→save rewrote an instance root's Transform override {rx,x,ry,rz} as {rx,ry,rz,x}, values equal. The capture appended marked fields equal to their base in mark-set insertion order, and a reload re-seeds marks in file order with a rotation mark pulling in its whole group. The capture now writes each trait's fields in schema order (`inCanonicalOrder`)",
    reaches: { op: 7, outcome: 'done' },
    repro: [
      { kind: 'duplicate', u: [0.47179811680689454, 0.5361906290054321, 0.45847699232399464, 0.970015165861696, 0.9514494312461466, 0.6894133083987981, 0.9133780209813267, 0.9591480705421418] },
      { kind: 'delete', u: [0.3955101245082915, 0.2073646194767207, 0.2521001184359193, 0.7691139227245003, 0.3056975929066539, 0.7484040216077119, 0.5129559764172882, 0.1141097224317491] },
      { kind: 'instantiate', u: [0.29314925032667816, 0.8060806528665125, 0.2299345824867487, 0.600198240717873, 0.7820273176766932, 0.843088585184887, 0.8476436485070735, 0.18949251668527722] },
      { kind: 'editField', u: [0.04541659774258733, 0.7074924686457962, 0.9998251996003091, 0.9558091170620173, 0.10606249864213169, 0.5112339758779854, 0.034641468431800604, 0.663360723759979] },
      { kind: 'reparent', u: [0.04389688209630549, 0.9625714612193406, 0.7999080924782902, 0.1876900875940919, 0.21735200146213174, 0.2413864633999765, 0.9149042987264693, 0.5204655202105641] },
      { kind: 'apply', u: [0.07125281449407339, 0.6572538097389042, 0.5309010487981141, 0.8569293210748583, 0.18330736574716866, 0.4384826102759689, 0.3433154025115073, 0.2811720366589725] },
      { kind: 'instantiate', u: [0.8096777715254575, 0.10962936142459512, 0.9470734349451959, 0.5054131706710905, 0.26287622773088515, 0.024724331917241216, 0.9913043545093387, 0.9360132687725127] },
      { kind: 'reparent', u: [0.8227990865707397, 0.014032450970262289, 0.24443837092258036, 0.22992625273764133, 0.27803528727963567, 0.3375412884633988, 0.2763173363637179, 0.06756221572868526] },
    ],
  },
  {
    issue: 1895,
    what: "hunt seed 3129: a live instance of a TRASHED prefab, whose root sortOrder equalled its template row's (a Create Prefab copies it) and so was stated nowhere, reloaded as a Missing Prefab placeholder at sortOrder 0 and save→reload→save reordered /entities. The save now states the root's unstated, non-default sortOrder/isActive on the entry's own traits (`placementForMissing`)",
    reaches: { op: 3, outcome: 'done', skips: ['assetDelete: redo to the end identity', 'assetDelete: undo to the start identity'] },
    repro: [
      { kind: 'delete', u: [0.9129093873780221, 0.48112353729084134, 0.6681748542468995, 0.03234542463906109, 0.11518862145021558, 0.9136989440303296, 0.6377161764539778, 0.3317907089367509] },
      { kind: 'addChild', u: [0.2458805199712515, 0.21558656124398112, 0.11938353115692735, 0.8148526235017926, 0.8918901064898819, 0.5355975485872477, 0.9143984671682119, 0.23446833714842796] },
      { kind: 'createPrefab', u: [0.8380175959318876, 0.653672066051513, 0.47205331991426647, 0.8653421129565686, 0.5434760409407318, 0.10925909434445202, 0.8066154445987195, 0.009585820604115725] },
      { kind: 'trashPrefab', u: [0.317435038741678, 0.30858678580261767, 0.5941915709991008, 0.2919786865822971, 0.29372866079211235, 0.6846848397981375, 0.6610678271390498, 0.7737833959981799] },
    ],
  },
  {
    issue: 1914,
    what: "#1914 R6 (F7, hunt seed 3297): a scene-added reference node under a nested instance, its root's sibling order recorded (F7) and STORED by the load, then Create Prefab of the tree around it: the capture writes the node as the new template's added node, so its place is the template's, but the stored mark stayed, and a reload read no record of it — save→reload not the identity on its marks. `clearLinkedMarks` takes the order mark off every node the create makes a row of the new template (a stamped nested root, a node the capture keyed)",
    reaches: { op: 4, outcome: 'done' },
    repro: [
      {kind: 'createPrefab', u: [0.5647250155452639, 0.7322422140277922, 0.5925946598872542, 0.9539343614596874, 0.8941584592685103, 0.13060407782904804, 0.2914976538158953, 0.5755810237023979]},
      {kind: 'reparent', u: [0.559150512330234, 0.9203874953091145, 0.7028837632387877, 0.27266549435444176, 0.33850584807805717, 0.1155760451219976, 0.8029564535245299, 0.5240372212138027]},
      {kind: 'delete', u: [0.947865794878453, 0.8264669892378151, 0.04216664214618504, 0.13456679321825504, 0.16424766671843827, 0.5911478030029684, 0.25022500078193843, 0.2244842287618667]},
      {kind: 'prefabEdit', u: [0.8511868303176016, 0.7825485856737942, 0.8417859778273851, 0.016778396675363183, 0.3947117901407182, 0.7655478697270155, 0.0176009947899729, 0.9518902481067926], inner: []},
      {kind: 'createPrefab', u: [0.20812105340883136, 0.2722668503411114, 0.8273136392235756, 0.6546014659106731, 0.5901248534210026, 0.5198992555961013, 0.2167833847925067, 0.6119422912597656]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R6 (hunt seed 1130, found by R7): a top-level instance whose prefab is missing, made by a detach after a copy-restored reload, its root sortOrder in both `overrides` and `traits.EntityAttributes`. The live save wrote EntityAttributes {parentId, sortOrder}; the placeholder's save (`asSceneEntry`: delete parentId, then assign the placement) wrote {sortOrder, parentId}, so save→reload→save differed in key order only. `asSceneEntry` now rebuilds the attributes in the order the record was read",
    reaches: { op: 7, outcome: 'done', skips: ['prefabEditSave: redo to the end identity', 'prefabEditSave: undo to the start identity'] },
    repro: [
      {kind: 'trashPrefab', u: [0.7666114093735814, 0.472519604023546, 0.07488158065825701, 0.6996986435260624, 0.9371706352103502, 0.32567527424544096, 0.610981714213267, 0.6603487117681652]},
      {kind: 'saveReload', u: [0.3863253442104906, 0.46820511482656, 0.873514065053314, 0.4368473864160478, 0.12880094349384308, 0.6978627098724246, 0.4603831691201776, 0.37973754992708564]},
      {kind: 'delete', u: [0.40811298973858356, 0.8343129050917923, 0.4778442697133869, 0.7833234032150358, 0.9427052445244044, 0.6505767519120127, 0.1900414323899895, 0.48937250091694295]},
      {kind: 'prefabEdit', u: [0.3213348041754216, 0.33489613607525826, 0.5814856521319598, 0.3717763789463788, 0.6585922543890774, 0.4757909474428743, 0.688395669683814, 0.7225606176070869], inner: []},
      {kind: 'duplicate', u: [0.656027221120894, 0.09189945342950523, 0.5954421046189964, 0.8142631119117141, 0.24448653892613947, 0.03998970263637602, 0.8112325128167868, 0.7392266013193876]},
      {kind: 'trashPrefab', u: [0.8447021951433271, 0.6163068830501288, 0.43396420287899673, 0.4315458170603961, 0.6991244701202959, 0.5703514523338526, 0.2954710773192346, 0.5064308326691389]},
      {kind: 'saveReload', u: [0.27336938586086035, 0.11184713058173656, 0.08590331650339067, 0.7244886038824916, 0.7911488167010248, 0.6832870058715343, 0.10035089682787657, 0.08540555369108915]},
      {kind: 'detach', u: [0.843608878320083, 0.7100989113096148, 0.05380742368288338, 0.3025078058708459, 0.24595744046382606, 0.05102222436107695, 0.5646660507190973, 0.8500855907332152]},
    ],
  },
  {
    issue: 1914,
    what: "#1914 R7 merge (hunt seed 1212): P trashed, so a reload expands O's nested P frame from the scene's copy (#1867), and an edit of O's added node Extra (Transform.sx) recorded on O's row. The load's R2 orphan test read the runtime cache alone, so that row was kept as an orphan as well as applied; once the edit was undone the save wrote the stale row back under the capture, and a rebuild (a load of the entry) restored the undone value. The load's `settleEntryRows` now reads `runtimeReaderFor(world)`, as its expansion did",
    reaches: { op: 7, outcome: 'done', skips: ['prefabEditSave: redo refusal forgiven (rest of the walk not run)', 'prefabEditSave: undo to the start identity'] },
    repro: [
      {kind: 'addChild', u: [0.18742664926685393, 0.30426382343284786, 0.4212738615460694, 0.6239593659993261, 0.2947947233915329, 0.010036298539489508, 0.41152178030461073, 0.17663234402425587]},
      {kind: 'addChild', u: [0.3059104988351464, 0.22330826637335122, 0.022554441587999463, 0.36423116619698703, 0.8034015789162368, 0.7359053157269955, 0.2862185603007674, 0.30399635271169245]},
      {kind: 'instantiate', u: [0.41425019851885736, 0.41949908528476954, 0.8198150887619704, 0.5009014976676553, 0.7101776718627661, 0.24246580502949655, 0.6293186328839511, 0.6637837775051594]},
      {kind: 'instantiate', u: [0.682760683586821, 0.23417703504674137, 0.23791141714900732, 0.8996143848635256, 0.7226784345693886, 0.9287783119361848, 0.18742431001737714, 0.9367894739843905]},
      {kind: 'prefabEdit', u: [0.7446035209577531, 0.3859414167236537, 0.6997692608274519, 0.0950489912647754, 0.9314346078317612, 0.9088398423045874, 0.8197905987035483, 0.18571023805998266], inner: []},
      {kind: 'trashPrefab', u: [0.5404355542268604, 0.5151440387126058, 0.6613279248122126, 0.05741006275638938, 0.4387426197063178, 0.6551276780664921, 0.207692809170112, 0.2339963351842016]},
      {kind: 'duplicate', u: [0.6788823308888823, 0.11165008111856878, 0.26789365289732814, 0.974938336526975, 0.9443847392685711, 0.6941596660763025, 0.6266552766319364, 0.5655335278715938]},
      {kind: 'editField', u: [0.9644791164901108, 0.8071997140068561, 0.42465037712827325, 0.19177420157939196, 0.11331431730650365, 0.5367793280165642, 0.6067988821305335, 0.31811966467648745]},
    ],
  },
  {
    issue: 2014,
    what: "#2014 S4 (hunt seed 1005): an agent's set-traits puts back a component an enclosing layer REMOVED; the door records a restore (`traitRemovals[T]: false`) and the fields that differ, as the capture states it, not a component the instance adds",
    reaches: { op: 3, outcome: 'done' },
    repro: [
      {kind: 'addChild', u: [0.6922517050988972,  0.5468205728102475,  0.5669520171359181,  0.694243309320882,  0.33182028704322875,  0.24866433558054268,  0.11778678861446679,  0.9075356665998697]},
      {kind: 'addChild', u: [0.22051735990680754,  0.3324856483377516,  0.21317670191638172,  0.38022109726443887,  0.32375428499653935,  0.6179181120824069,  0.032232911325991154,  0.5146166984923184]},
      {kind: 'agentSetTraits', u: [0.38824472250416875,  0.2928518436383456,  0.6567801497876644,  0.351059626089409,  0.44983259961009026,  0.4025829469319433,  0.870726082706824,  0.8944284224417061]},
      {kind: 'editField', u: [0.415877717314288,  0.4565550945699215,  0.7187263399828225,  0.7227734001353383,  0.8012984527740628,  0.5892220288515091,  0.38101820601150393,  0.9569070984143764]},
    ],
  },
  {
    issue: 2014,
    what: "#2014 S4 (hunt seed 1028): a duplicate of a PLAIN entity holding instances names their new roots unrecorded (no enclosing record to mark), so the store's coverage holds",
    reaches: { op: 2, outcome: 'done' },
    repro: [
      {kind: 'reparent', u: [0.06092194584198296,  0.5855873548425734,  0.18500580242834985,  0.292117768432945,  0.5043858021963388,  0.9160233733709902,  0.8548710378818214,  0.3793145997915417]},
      {kind: 'duplicate', u: [0.7672707426827401,  0.5884795028250664,  0.41821101401001215,  0.8565692398697138,  0.7012130541261286,  0.07516100653447211,  0.05592494923621416,  0.39707960607483983]},
      {kind: 'duplicate', u: [0.18470013421028852,  0.30453263921663165,  0.5971222191583365,  0.49261036003008485,  0.35711945383809507,  0.020510197849944234,  0.7821175600402057,  0.6317515920381993]},
    ],
  },
  {
    issue: 2014,
    what: "#2014 S4 (hunt seed 1061): a file-direct addEntity parents a plain entity into an instance by parentId; no owner's parse links it, so the load marks the records stale and the door's re-seed takes the link from the capture (open with the hub)",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      {kind: 'fileMutate', u: [0.5837131440639496,  0.7612904808484018,  0.0797638667281717,  0.8474772768095136,  0.2887962309177965,  0.47769858525134623,  0.6332276829052716,  0.7796494429931045]},
      {kind: 'addChild', u: [0.28507733973674476,  0.11323025939054787,  0.11023757490329444,  0.24227618961595,  0.9574344411958009,  0.8268279330804944,  0.25355145963840187,  0.8694610816892236]},
    ],
  },
  {
    issue: 2014,
    what: "#2014 S4 (hunt seed 1014): a file-direct setTrait states ONE rotation axis on an instance root; the old save writes the group (#1829's mechanism by rotation), translated in I25",
    reaches: { op: 1, outcome: 'done' },
    repro: [
      {kind: 'fileMutate', u: [0.3731514527462423,  0.6776737358886749,  0.4340523071587086,  0.22055381210520864,  0.1170317258220166,  0.23362537799403071,  0.3060094469692558,  0.169815061846748]},
      {kind: 'delete', u: [0.2315053823404014,  0.08753362228162587,  0.47209930676035583,  0.28010529559105635,  0.41369518730789423,  0.7774100147653371,  0.22634062403813004,  0.9270184689667076]},
    ],
  },
  {
    issue: 2014,
    what: "#2014 S4 (hunt seed 1250): after a paste and an Apply, a row the fold does not reach is no added component; I25's #1829 fill leaves it alone",
    reaches: { op: 5, outcome: 'done' },
    repro: [
      {kind: 'editField', u: [0.39136458188295364,  0.7782205797266215,  0.05218648770824075,  0.07651488156989217,  0.3921410439070314,  0.8175244715530425,  0.3257839160505682,  0.8021068612579256]},
      {kind: 'copy', u: [0.04031666344963014,  0.5975732603110373,  0.9427181135397404,  0.9622786783147603,  0.07035105652175844,  0.6401705308817327,  0.7596480599604547,  0.6022250792011619]},
      {kind: 'delete', u: [0.681362887378782,  0.3945257733576,  0.8280522774439305,  0.3078357803169638,  0.11402664077468216,  0.9581399285234511,  0.6390970244538039,  0.2690978283062577]},
      {kind: 'paste', u: [0.7827815290074795,  0.6152189411222935,  0.09891523094847798,  0.27960730623453856,  0.779766088584438,  0.626295214286074,  0.2981682226527482,  0.23423136584460735]},
      {kind: 'apply', u: [0.12750802072696388,  0.06871485384181142,  0.3116945361252874,  0.6793720067944378,  0.5280332940164953,  0.6235901424661279,  0.5239321331027895,  0.30908893374726176]},
      {kind: 'addComponent', u: [0.834665124071762,  0.5015800362452865,  0.31836718623526394,  0.7737857250031084,  0.9253228609450161,  0.4302700215484947,  0.5980705958791077,  0.6880792316514999]},
    ],
  },
];
