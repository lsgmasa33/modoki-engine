/** Known OPEN prefab bugs the fuzzer finds (#1789), and how verify mode lives with each until it is fixed.
 *
 *  Two kinds:
 *  - `stops`: a seed whose first failure this predicate matches ends there as a pass (its prefix was checked). The
 *    predicate names the check AND the op shape that reaches it, so it cannot swallow an unrelated failure of the same
 *    check.
 *  - `tolerate`: a normalization verify mode applies while the issue is open (`Tolerate` in checks.ts).
 *
 *  Every entry carries a minimized repro. The self-test in prefabFuzz.test.ts runs it with the entry's tolerance OFF and
 *  asserts it still fails as described: once the bug is fixed that test goes red, which forces the entry out. Keep an
 *  entry only while its issue is open. */

import type { Op } from './ops';
import type { StepFailure } from './runner';
import type { Tolerate } from './checks';

export interface KnownOpen {
  issue: number;
  what: string;
  repro: Op[];
  /** The failure the repro must still produce (with this entry's tolerance off). */
  reproduces: (f: StepFailure) => boolean;
  stops?: (f: StepFailure, ops: readonly Op[]) => boolean;
  tolerate?: keyof Tolerate;
}

/** Create Prefab's redo refused to tag the tree it rewrote because a reload reordered its siblings (#1796's route). */
const POSITIONAL_RETAG = /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \((".*" was written at localId \d+, but sits where row \d+ was written|row \d+ changed between a nested reference and a plain member)\)/;

/** The entity a round-trip diff is on (`/<guid>/…`). */
const subjectGuid = (f: StepFailure) => /^\/([0-9a-f]{8}-[0-9a-f-]{27})(\/|:)/.exec(f.detail)?.[1];
/** The ONE node or entry a scene diff is about — not every guid in it (review: a path now carries its top-level entry's
 *  guid, so "any guid named" claimed a diff inside a dropped entry whichever node moved). A top-level entry gone, new
 *  or re-parented names itself in the path; a node gone from or new to a list names itself first in its value. */
/** The member-path node keys (`members//<nodeGuid>`) in a diff's path: which frame row of a tree the diff is inside. */
const memberKeys = (f: StepFailure) => [...f.detail.split(': ')[0].matchAll(/members\/\/([0-9a-f]{8}-[0-9a-f-]{27})/g)].map((m) => m[1]);

function diffSubject(f: StepFailure): string | undefined {
  const top = /^\/entities\/([0-9a-f]{8}-[0-9a-f-]{27})(: |\/traits\/EntityAttributes\/parentId: )/.exec(f.detail);
  if (top) return top[1];
  const m = /: (.*) vs (.*)$/.exec(f.detail);
  if (!m) return undefined;
  const side = m[2] === 'undefined' ? m[1] : m[1] === 'undefined' ? m[2] : '';
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}/.exec(side)?.[0];
}
/** Whether op `kind` of this run introduced (a drop, a paste) or covered (a detach) that guid: keys a stop on the
 *  entity its mechanism's op touched, not on the op merely having run somewhere in the list (review: a planted redo
 *  regression that misplaced some other node was claimed by #1793 on the op list alone). */
const touchedBy = (f: StepFailure, kind: 'drop' | 'paste' | 'detach' | 'create', g: string | undefined) =>
  !!g && g.length >= 20 && !!f.touched?.[kind].some((t) => t.startsWith(g) || g.startsWith(t));

/** The op before the failure, reloads aside: for a route that shows at the next save→reload after the op that exposes it,
 *  keying on that op being LAST is what keeps a stop from claiming any later failure in a list that merely holds it. */
const lastOp = (ops: readonly Op[]) => ops.filter((o) => o.kind !== 'saveReload').at(-1)?.kind;

/** #1796's Create Prefab redo route, as the walk's scene diff: keyed on the refusal the walk logged. */
const positionalRetagRedo = (f: StepFailure, ops: readonly Op[]): boolean => f.check === 'redo to the end does not restore the scene'
  && f.op === 'undo/redo to the ends' && /\/(own|added|children)(\/\d+)*: /.test(f.detail)
  && !!f.console?.some((l) => POSITIONAL_RETAG.test(l)) && touchedBy(f, 'create', diffSubject(f))
  && ops.some((o) => o.kind === 'createPrefab');

/** A node in a node list (or a template-added key's record, or a slot) that differs across the redo walk. */
const NODE_LIST_DIFF = /\/((own|added|children)(\/\d+)*|a\+k-[^/:]+): (\[?\{"(parentLocalId|own)":.* vs undefined$|undefined vs \[?\{"(parentLocalId|own)":)|\/(own|added|children)(\/\d+)+\/guid: "[^"]+" vs "[^"]+"$/;

/** #1794: a Detach, a rebuild (a reload, or a prefab-edit visit), then its undo as the last op; the next save→reload finds
 *  the member's marks differ. Never a component's mark (#1800, #1822). */
const detachMarks = (f: StepFailure, ops: readonly Op[]): boolean => f.check === 'save→reload is not the identity'
  && /\/marks\//.test(f.detail) && !/"(Rotate3D|Renderable3DPrimitive)\./.test(f.detail) && lastOp(ops) === 'undo'
  && touchedBy(f, 'detach', subjectGuid(f)) && (() => {
    const d = ops.findIndex((o) => o.kind === 'detach');
    const r = ops.findIndex((o, i) => i > d && (o.kind === 'saveReload' || o.kind === 'prefabEdit'));
    return d >= 0 && r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'undo');
  })();

/** The suffix a round-trip difference carries when it was measured with the run's deleted prefabs RESTORED (#1805,
 *  `checkRoundTrip`): the same difference, seen through the stricter comparison — optional, so a route with no deletion
 *  keeps matching. */
const RESTORED = String.raw`( \(with the deleted prefab restored\))?`;

export const KNOWN_OPEN: KnownOpen[] = [
  {
    issue: 1792,
    what: 'Revert of a -removed row whose member was dragged out respawns it on the guid the moved entity holds',
    repro: [
      { kind: 'reparent', u: [0.794, 0.1, 0.5, 0, 0, 0, 0, 0] },
      { kind: 'revert', u: [0.214, 0.1, 0.5, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'I7 duplicate guid' && /not rows of one frame/.test(f.detail),
    // An entity leaves its row but keeps the row's derived guid, and a Revert respawns the row beside it. Three routes, all
    // OBSERVED (comments on #1792): a drag OUT, a Detach of a nested frame, a Create Prefab on a member. Keyed on the
    // CONTENT — the two holders are not rows of one frame — so #1777's shape (a pin and a derivation inside one frame),
    // which a predicate keyed on the op list alone swallowed, is not claimed.
    stops: (f, ops) => f.check === 'I7 duplicate guid' && /not rows of one frame/.test(f.detail) && f.op.startsWith('revert')
      && ops.some((o) => o.kind === 'reparent' || o.kind === 'detach' || o.kind === 'createPrefab'),
  },
  {
    issue: 1794,
    what: "Detach's undo after a rebuild restores the links but not the override marks",
    repro: [
      { kind: 'editField', u: [0.7083940990269184, 0.0169174384791404, 0.2565192203037441, 0.03183711925521493, 0.5653642797842622, 0.1326391918119043, 0.5866110895294696, 0.39626767858862877] },
      { kind: 'revert', u: [0.3251578959170729, 0.8732641767710447, 0.649110505823046, 0.5803064578212798, 0.13768295058980584, 0.8408704535104334, 0.08907407149672508, 0.48194432351738214] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'detach', u: [0.15888716746121645, 0.28360947174951434, 0.40143896848894656, 0.5929380359593779, 0.02723632473498583, 0.1597168450243771, 0.8716024786699563, 0.2872234331443906] },
      { kind: 'saveReload', u: [0.2398991729132831, 0.9847583954688162, 0.29102227953262627, 0.02259724377654493, 0.9572306799236685, 0.4162498787045479, 0.40120429755188525, 0.5371022578328848] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail),
    // A Detach, a rebuild and its undo in the list; the next save→reload finds the member's marks differ. (A walk form keyed
    // on any /members path was dropped in review: it claimed an unrelated undo that lost an override.)
    stops: detachMarks,
  },
  {
    issue: 1794,
    what: "the same, where the rebuild is a prefab-edit visit (discarded)",
    repro: [
      { kind: 'detach', u: [0.7311645969748497, 0.13434822508133948, 0.6695735612884164, 0.40467609371989965, 0.8146500582806766, 0.3963876867201179, 0.7728581817355007, 0.15376638155430555] },
      { kind: 'prefabEdit', u: [0.6097711462061852, 0.9679968729615211, 0.8896497702226043, 0.6608014917001128, 0.03871827572584152, 0.6533970246091485, 0.7404179510194808, 0.898593342397362], inner: [] },
      { kind: 'undo', u: [0.7791260068770498, 0.4710204261355102, 0.7423416944220662, 0.9686100308317691, 0.6743511268869042, 0.028107878752052784, 0.8965767938643694, 0.07950291177257895] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail),
    stops: detachMarks,
  },
  {
    issue: 1796,
    what: 'nested node lists are saved in ECS query order, so a save after a reload reorders them',
    repro: [
      { kind: 'duplicate', u: [0.38699243287555873, 0.5160500674974173, 0.7015982300508767, 0.7498073864262551, 0.12323614209890366, 0.09115325007587671, 0.3395281918346882, 0.4878639730159193] },
    ],
    reproduces: (f) => f.check === 'save→reload→save is not byte-identical',
    tolerate: 'nodeOrder',
  },
  {
    issue: 1796,
    what: "the same query order reaches Create Prefab's redo, which re-tags by position and is refused after a reload",
    repro: [
      { kind: 'duplicate', u: [0.0005, 0.7639, 0.1438, 0.6678, 0.7747, 0.344, 0.5285, 0.0697] },
      { kind: 'saveReload', u: [0.9055, 0.5241, 0.2558, 0.4764, 0.7382, 0.6179, 0.362, 0.2463] },
      { kind: 'createPrefab', u: [0.2822, 0.0907, 0.9868, 0.1901, 0.0497, 0.3445, 0.7354, 0.5284] },
      { kind: 'prefabEdit', u: [0.7606, 0.2686, 0.3478, 0.6593, 0.9336, 0.4852, 0.8874, 0.3418], inner: [] },
    ],
    reproduces: (f) => f.check === 'console.error' && /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \(".*" was written at localId \d+, but sits where row \d+ was written\)/.test(f.detail),
    // The same query order reaches Create Prefab's redo (comment on #1796): it re-tags by position through collectTree,
    // and after a reload reorders siblings planMatchesFile refuses. Keyed on those two refusal wordings.
    stops: (f, ops) => f.check === 'console.error' && (f.op === 'undo/redo to the ends' || /^redo\(/.test(f.op))
      && /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \((".*" was written at localId \d+, but sits where row \d+ was written|row \d+ changed between a nested reference and a plain member)\)/.test(f.detail)
      && ops.some((o) => o.kind === 'createPrefab'),
  },
  {
    issue: 1796,
    what: "the same redo, reported as the scene diff (the walk's identity check runs before its console errors are read)",
    repro: [
      { kind: 'outsideEdit', u: [0.6936206261161715, 0.17782395984977484, 0.5137411751784384, 0.7149697851855308, 0.9969790095929056, 0.16907001845538616, 0.6203795957844704, 0.5160340690053999] },
      { kind: 'reparent', u: [0.315277598798275, 0.917392787989229, 0.9138918148819357, 0.2863043069373816, 0.8894691378809512, 0.4289656088221818, 0.22244959813542664, 0.5512217737268656] },
      { kind: 'createPrefab', u: [0.9434425951912999, 0.18627188983373344, 0.7050830235239118, 0.7845574729144573, 0.4535193827468902, 0.8970362835098058, 0.007119981572031975, 0.06791658839210868] },
      { kind: 'reparent', u: [0.926001786487177, 0.07603803905658424, 0.059589676558971405, 0.6357310710009187, 0.21650824113748968, 0.9080651458352804, 0.8035988812334836, 0.2351431674323976] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && /\/added: undefined vs \[/.test(f.detail),
    // Keyed on the refusal the walk logged (the runner hands the walk's console lines to the predicate).
    stops: positionalRetagRedo,
  },
  {
    issue: 1796,
    what: "the same redo, the other direction of the scene diff (the tree's added node missing)",
    repro: [
      { kind: 'duplicate', u: [0.033303552540019155, 0.6072016530670226, 0.17860231618396938, 0.36060059955343604, 0.24519648379646242, 0.01585288904607296, 0.7660753296222538, 0.0734335642773658] },
      { kind: 'createPrefab', u: [0.20849957410246134, 0.6444018911570311, 0.005679936148226261, 0.3887866751756519, 0.5991325152572244, 0.022242528619244695, 0.49629448540508747, 0.33016981394030154] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && !!f.console?.some((l) => POSITIONAL_RETAG.test(l)),
    stops: positionalRetagRedo,
  },
  {
    issue: 1798,
    what: "the validator misses a compact entry's top-level guid (a child of a placeholder reads as orphan)",
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
    reproduces: (f) => f.check === 'scene validator' && /references no entity/.test(f.detail),
    tolerate: 'placeholderParent',
  },
  {
    issue: 1800,
    what: "Remove Component's undo re-adds the trait's data but not its override marks",
    repro: [
      { kind: 'addComponent', u: [0.04622375639155507, 0.8679626227822155, 0.5392347774468362, 0.8630144654307514, 0.9499282059259713, 0.10872479528188705, 0.9486257375683635, 0.5012652326840907] },
      { kind: 'saveReload', u: [0.5743842197116464, 0.5823324527591467, 0.9513287632726133, 0.561390912393108, 0.5752703219186515, 0.47487166756764054, 0.751958251465112, 0.3308712081052363] },
      { kind: 'removeComponent', u: [0.00905785127542913, 0.22686874470673501, 0.2879236890003085, 0.24362082383595407, 0.6656269864179194, 0.9177013242151588, 0.7928349012508988, 0.6064457197207958] },
      { kind: 'saveReload', u: [0.3872559634037316, 0.8000171624589711, 0.39061477268114686, 0.859410464996472, 0.5958437048830092, 0.22173328371718526, 0.04321353812702, 0.29053033818490803] },
      { kind: 'undo', u: [0.1, 0.8564995671622455, 0.028990152990445495, 0.40797109180130064, 0.27484340965747833, 0.013096533715724945, 0.5823551893699914, 0.8294616998173296] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail),
    // A removed component, then an undo, before the failure — and the mark that differs belongs to a component the fuzzer
    // can remove (Transform is core, never removed), so another mark defect is not claimed.
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail)
      && /"(Rotate3D|Renderable3DPrimitive)\./.test(f.detail)
      && (() => { const r = ops.findIndex((o) => o.kind === 'removeComponent'); return r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'undo'); })(),
  },
  {
    issue: 1808,
    what: "a template-added node dragged into another instance of its template keeps its stale TemplateAddedKey",
    repro: [
      { kind: 'instantiate', u: [0.375, 0.1, 0, 0, 0, 0, 0, 0] },
      { kind: 'reparent', u: [0.4375, 0.99, 0.8125, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'I7 duplicate guid' && /under one top-level root/.test(f.detail),
    // Two instances of one template (a drop, a copy) and a move between them before the failure, which shows at a SAVE
    // (never a revert: that is #1792). The reference-node variant (after a Create Prefab on the moved node) churns the
    // nested list's bytes instead.
    stops: (f, ops) => ops.some((o) => o.kind === 'reparent')
      && ((f.check === 'I7 duplicate guid' && /under one top-level root/.test(f.detail) && /^(saveReload|final save→reload)/.test(f.op)
        && ops.some((o) => o.kind === 'instantiate' || o.kind === 'duplicate' || o.kind === 'paste'))
        || (f.check === 'save→reload→save is not byte-identical' && /\/members\/.*\/added$/.test(f.detail.split(': ')[0])
          && ops.some((o) => o.kind === 'createPrefab'))),
  },
  {
    issue: 1809,
    what: "an Apply that drops a layer-added node's anchor row keeps its old derived guid live; the reload re-derives it",
    repro: [
      { kind: 'createPrefab', u: [0.676, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.1875, 0.1, 0, 0.9, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail),
    // An Apply before the failure, after something that changes the anchor row's path (a Create Prefab Replace, or a
    // move: two routes). Keyed on the content: an entity whose guid CHANGED across the reload, not one that was lost.
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail) && (() => {
      const c = ops.findIndex((o) => o.kind === 'createPrefab' || o.kind === 'reparent');
      return c >= 0 && ops.slice(c + 1).some((o) => o.kind === 'apply');
    })(),
  },
  {
    issue: 1809,
    what: "the same, through Detach's undo after a prefab-edit save deleted the anchor row (its rebase re-anchors, keeps the guid)",
    repro: [
      { kind: 'detach', u: [0.025726123247295618, 0.6438882742077112, 0.055156498216092587, 0.2290809666737914, 0.325337108457461, 0.7244618884287775, 0.937406157143414, 0.4990142297465354] },
      { kind: 'prefabEdit', u: [0.5476142126135528, 0.18346081534400582, 0.2778930668719113, 0.278214025311172, 0.27691279095597565, 0.6830818050075322, 0.0016407903749495745, 0.34888543910346925], inner: [{ kind: 'delete', u: [0.19734677020460367, 0.22199939331039786, 0.5219223950989544, 0.29861879511736333, 0.49865362676791847, 0.32312997709959745, 0.16570315975695848, 0.15814896672964096] }] },
      { kind: 'undo', u: [0.47763126995414495, 0.6631570672616363, 0.7647192350123078, 0.0125291314907372, 0.2069809422828257, 0.5996168968267739, 0.4597687148489058, 0.01827254961244762] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\(an entity changed guid\)$/.test(f.detail) && lastOp(ops) === 'undo' && (() => {
      const d = ops.findIndex((o) => o.kind === 'detach');
      const e = ops.findIndex((o, i) => i > d && o.kind === 'prefabEdit' && o.u[1] < 0.65 && !!o.inner?.some((x) => x.kind === 'delete'));
      return d >= 0 && e >= 0 && ops.slice(e + 1).some((o) => o.kind === 'undo');
    })(),
  },
  {
    issue: 1820,
    what: "a paste of an instance copied before its template changed respawns the stale frame, and nothing rebases it",
    repro: [
      { kind: 'copy', u: [0.003, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'editField', u: [0.656, 0.0, 0.75, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.2, 0.1, 0, 0.9, 0, 0.9, 0, 0] },
      { kind: 'paste', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/traits\/Transform\/x: /.test(f.detail),
    // A copy, then a template change (Apply, Create Prefab Replace, a prefab-edit save, an outside edit), then a paste.
    // Keyed on a member lost or a transform value the reload changed.
    stops: (f, ops) => f.check === 'save→reload is not the identity'
      && (new RegExp(String.raw`\(an entity was lost\)${RESTORED}$`).test(f.detail) || /^\/[^/]+\/traits\/Transform\/(x|y|z|rx|ry|rz|sx|sy|sz): /.test(f.detail)) && (() => {
        const c = ops.findIndex((o) => o.kind === 'copy');
        const ch = ops.findIndex((o, i) => i > c && ['apply', 'createPrefab', 'prefabEdit', 'outsideEdit'].includes(o.kind));
        return c >= 0 && ch >= 0 && ops.slice(ch + 1).some((o) => o.kind === 'paste') && lastOp(ops) === 'paste' && touchedBy(f, 'paste', subjectGuid(f));
      })(),
  },
  {
    issue: 1820,
    what: "the same missing rebase, through Create Prefab's undo: it re-links the tree to its old template's stale expansion",
    repro: [
      { kind: 'createPrefab', u: [0.9428159724920988, 0.9500395997893065, 0.8217625359538943, 0.2986950015183538, 0.315559288719669, 0.43765105050988495, 0.01984696416184306, 0.9973117003683001] },
      { kind: 'createPrefab', u: [0.0017358909826725721, 0.3970535541884601, 0.538624168606475, 0.21942522306926548, 0.32584577915258706, 0.5943802592810243, 0.018516797805204988, 0.8010917166247964] },
      { kind: 'prefabEdit', u: [0.4197337697260082, 0.45629017311148345, 0.9499380351044238, 0.30179717764258385, 0.4023724365979433, 0.017604060005396605, 0.281649986281991, 0.47618820145726204], inner: [{ kind: 'instantiate', u: [0.7530755579937249, 0.7304247959982604, 0.6359159634448588, 0.5732636176981032, 0.24562921142205596, 0.715872710570693, 0.18062788620591164, 0.5258615149650723] }] },
      { kind: 'undo', u: [0.9111525018233806, 0.4756720804143697, 0.2995174073148519, 0.8736095151398331, 0.7850008409004658, 0.6371805649250746, 0.5273122461512685, 0.5875295428559184] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && new RegExp(String.raw`\(an entity was gained\)${RESTORED}$`).test(f.detail),
    // No stop: nothing in the failure says the gained entity came from the stale re-link (a review found this key
    // claimed any gained entity after a Create Prefab, a change and an undo). Its self-test keeps the route honest;
    // a hunt reports it by its signature.
  },
  {
    issue: 1820,
    what: "the same, through Paste's redo: the walk undoes and redoes a paste made before the template changed",
    repro: [
      { kind: 'instantiate', u: [0.611175028141588, 0.6514599523507059, 0.2609965375158936, 0.13653228152543306, 0.08117494895122945, 0.229994123801589, 0.19415682554244995, 0.2312458292581141] },
      { kind: 'prefabEdit', u: [0.0025320895947515965, 0.5545158837921917, 0.3194682211615145, 0.6602701237425208, 0.8647226733155549, 0.30973603832535446, 0.06382799847051501, 0.20962068950757384], inner: [] },
      { kind: 'reparent', u: [0.05289468914270401, 0.5114942493382841, 0.9024173587094992, 0.7742977037560195, 0.22715402184985578, 0.8201705161482096, 0.34489292302168906, 0.49780966504476964] },
      { kind: 'copy', u: [0.27074809931218624, 0.14453188236802816, 0.6524580360855907, 0.7346509259659797, 0.5130745004862547, 0.6953973234631121, 0.5576475753914565, 0.6048628408461809] },
      { kind: 'paste', u: [0.2788585058879107, 0.6411802317015827, 0.13857184490188956, 0.7241594886872917, 0.5755924703553319, 0.21859576366841793, 0.999815168324858, 0.40587658691219985] },
      { kind: 'prefabEdit', u: [0.6, 0.6434368717018515, 0.49586298945359886, 0.5223652205895633, 0.1734591640997678, 0.8727238741703331, 0.5582645458634943, 0.7902071727439761], inner: [{ kind: 'duplicate', u: [0.2632118870969862, 0.7401458392851055, 0.20006573991850019, 0.8598092638421804, 0.1768859124276787, 0.5392143279314041, 0.14166608965024352, 0.4079057138878852] }] },
      { kind: 'revert', u: [0.2899708952754736, 0.8689476081635803, 0.3784734313376248, 0.317490870365873, 0.01880230032838881, 0.8135771653614938, 0.9818330009002239, 0.4641318661160767] },
    ],
    reproduces: (f) => f.check === 'console.error' && /^\[undo\] Redo of "Revert prefab overrides" was REFUSED — a prefab nested in this instance of "[^"]+" has changed since it was built/.test(f.detail),
    // The Revert's refusal is right (the frame was built from old rows); the defect is the paste redo that built it.
    stops: (f, ops) => f.check === 'console.error' && f.op === 'undo/redo to the ends'
      && /^\[undo\] Redo of "Revert prefab overrides" was REFUSED — a prefab nested in this instance of "[^"]+" has changed since it was built/.test(f.detail) && (() => {
        const c = ops.findIndex((o) => o.kind === 'copy'); const p = ops.findIndex((o, i) => i > c && o.kind === 'paste');
        const ch = ops.findIndex((o, i) => i > c && ['apply', 'createPrefab', 'prefabEdit', 'outsideEdit'].includes(o.kind));
        return c >= 0 && p >= 0 && ch >= 0 && ops.slice(ch + 1).some((o) => o.kind === 'revert');
      })(),
  },
  {
    issue: 1822,
    what: "Add Component re-adding a template-row trait on a nested member reconciles its marks against the effective base",
    repro: [
      { kind: 'removeComponent', u: [0.5, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addComponent', u: [0.38, 0.1, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\//.test(f.detail),
    // A remove, then an add, with no undo after the remove (that is #1800).
    stops: (f, ops) => f.check === 'save→reload is not the identity'
      && /\/marks\/\d+: (undefined|"[^"]*") vs "(Rotate3D|Renderable3DPrimitive)\.[^"]+"$/.test(f.detail) && (() => {
        const r = ops.findIndex((o) => o.kind === 'removeComponent');
        return r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'addComponent') && !ops.slice(r + 1).some((o) => o.kind === 'undo');
      })(),
  },
  {
    issue: 1826,
    what: "rebuilding a nested frame drops the deep template-row statements of an instance dropped under one of its members",
    repro: [
      { kind: 'duplicate', u: [0.764801949961111, 0.5406083094421774, 0.6430164149496704, 0.3840809662360698, 0.6933569198008627, 0.5875219090376049, 0.9633324407041073, 0.22859293804503977] },
      { kind: 'instantiate', u: [0.38572820043191314, 0.794073564466089, 0.39131955173797905, 0.8752983931917697, 0.47591003542765975, 0.10997878038324416, 0.06098071322776377, 0.4177168821915984] },
      { kind: 'saveReload', u: [0.4362363861873746, 0.3671279076952487, 0.7622446878813207, 0.11943517229519784, 0.8320129390340298, 0.6271690565627068, 0.5742204568814486, 0.4504863144829869] },
      { kind: 'instantiate', u: [0.6227461930830032, 0.9314032015390694, 0.6335036314558238, 0.34088405361399055, 0.5395517745055258, 0.16060505318455398, 0.2577482636552304, 0.36398861138150096] },
      { kind: 'apply', u: [0.47614545724354684, 0.6902347311843187, 0.2799380994401872, 0.6043396857567132, 0.6697595652658492, 0.15446191583760083, 0.8628419709857553, 0.020307525526732206] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\/\d+: "Transform\.z" vs "Transform\.y"$/.test(f.detail),
    // A drop under a parent, then an Apply (which rebuilds the frames), no Detach (#1794). A Transform mark only: a
    // component's is #1800's or #1822's.
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\/marks\/\d+: ("Transform\.[a-z]+"|undefined) vs "Transform\.[a-z]+"$/.test(f.detail)
      && !ops.some((o) => o.kind === 'detach')
      && lastOp(ops) === 'apply' && touchedBy(f, 'drop', subjectGuid(f))
      && (() => { const n = ops.findIndex((o) => o.kind === 'instantiate' && o.u[1] >= 0.4); return n >= 0 && ops.slice(n + 1).some((o) => o.kind === 'apply'); })(),
  },
  {
    issue: 1829,
    what: "an Apply that removes a component from a template row leaves a partial override of it marked on the overridden fields only",
    repro: [
      { kind: 'editField', u: [0.72, 0, 0.5, 0, 0, 0, 0, 0] },
      { kind: 'reparent', u: [0.32, 0.1, 0, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.55, 0.1, 0, 0.9, 0, 0.9, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/marks\/0: "Transform\.[xyz]" vs "Transform\.rx"$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /^\/[^/]+\/marks\/0: "Transform\.[xyz]" vs "Transform\.rx"$/.test(f.detail)
      && lastOp(ops) === 'apply' && !ops.some((o) => o.kind === 'detach') && !ops.some((o) => o.kind === 'instantiate' && o.u[1] >= 0.4)
      && ops.some((o) => o.kind === 'editField')
      && (() => { const r = ops.findIndex((o) => o.kind === 'reparent'); return r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'apply'); })(),
  },
  {
    issue: 1830,
    what: "Create Prefab's redo mints a fresh TemplateAddedKey for a marker-less added node instead of the file's key",
    repro: [
      { kind: 'duplicate', u: [0.97, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'createPrefab', u: [0.14, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && NODE_LIST_DIFF.test(f.detail),
    // A node of a tree Create Prefab tagged (touched.create) moved in a node list across the redo, with no re-tag refusal
    // logged (that is #1796) and not a drop's node (#1793).
    stops: (f, ops) => f.check === 'redo to the end does not restore the scene' && f.op === 'undo/redo to the ends'
      && NODE_LIST_DIFF.test(f.detail) && !f.console?.some((l) => POSITIONAL_RETAG.test(l))
      && (touchedBy(f, 'create', diffSubject(f)) || memberKeys(f).some((k) => touchedBy(f, 'create', k)))
      && !(['drop', 'paste', 'detach'] as const).some((k) => touchedBy(f, k, diffSubject(f)))
      && ops.some((o) => o.kind === 'createPrefab'),
  },
  {
    issue: 1850,
    what: 'prune on: a scene holding Missing Prefab placeholders (after a trash) saves its top-level entries in another order on save→reload→save',
    repro: [
      { kind: 'addChild', u: [0.9957377251703292, 0.12976732291281223, 0.2103715562261641, 0.9275979360099882, 0.43928383802995086, 0.07324382080696523, 0.19927202980034053, 0.8402995807118714] },
      { kind: 'duplicate', u: [0.21626306232064962, 0.5490222787484527, 0.789051380706951, 0.16266263229772449, 0.5332405406516045, 0.12282868777401745, 0.042075154604390264, 0.1445559342391789] },
      { kind: 'addChild', u: [0.05152462935075164, 0.5596237492281944, 0.8935148431919515, 0.7301778043620288, 0.6726450177375227, 0.650408998830244, 0.8924802078399807, 0.5835450873710215] },
      { kind: 'duplicate', u: [0.049044220708310604, 0.3174614568706602, 0.8419715336058289, 0.9428341283928603, 0.7418814767152071, 0.5696394266560674, 0.8156659172382206, 0.15937778376974165] },
      { kind: 'trashPrefab', u: [0.6920298747718334, 0.7770941411145031, 0.7189049804583192, 0.4385903417132795, 0.2771018666680902, 0.34832038450986147, 0.43116552801802754, 0.15858133602887392] },
    ],
    reproduces: (f) => f.check === 'save→reload→save is not byte-identical' && /^\/entities: order of \d+ entries differs$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload→save is not byte-identical' && /^\/entities: order of \d+ entries differs$/.test(f.detail) && ops.some((o) => o.kind === 'trashPrefab'),
  },
  {
    issue: 1851,
    what: 'prune on: a {removed:true} statement in an own list under a placeholder frame (after a trash) is lost on save→reload→save',
    repro: [
      { kind: 'instantiate', u: [0.890076193260029, 0.07602464105002582, 0.8748778670560569, 0.8994004868436605, 0.27102022571489215, 0.9918312109075487, 0.09686897811479867, 0.650577523978427] },
      { kind: 'createPrefab', u: [0.10641237534582615, 0.4541084480006248, 0.33052576892077923, 0.07681006751954556, 0.5245194090530276, 0.10923540079966187, 0.011485954280942678, 0.8934976372402161] },
      { kind: 'delete', u: [0.7875144437421113, 0.012621408328413963, 0.2831360867712647, 0.5367887993343174, 0.2565011365804821, 0.1866220193915069, 0.8291857801377773, 0.1646028971299529] },
      { kind: 'duplicate', u: [0.25096105434931815, 0.41517852898687124, 0.599444696912542, 0.9083774276077747, 0.7222796024288982, 0.14209487126208842, 0.08802204579114914, 0.17651533195748925] },
      { kind: 'prefabEdit', u: [0.5254611463751644, 0.2734725868795067, 0.8239260467234999, 0.4681115027051419, 0.08659698511473835, 0.21779864304699004, 0.798325058305636, 0.005162230459973216], inner: [{ kind: 'addChild', u: [0.5445627241861075, 0.6406494460534304, 0.24393830355256796, 0.5524948914535344, 0.21830334048718214, 0.9373807050287724, 0.7852899883873761, 0.02144386968575418] }] },
      { kind: 'instantiate', u: [0.7125174487009645, 0.5778118125163019, 0.8138011395931244, 0.39210460148751736, 0.4582940158434212, 0.7859341835137457, 0.07254934683442116, 0.7631003758870065] },
      { kind: 'trashPrefab', u: [0.2291001125704497, 0.06505722552537918, 0.3196396178100258, 0.5072860661894083, 0.9762245726305991, 0.09268465684726834, 0.5966271760407835, 0.6079313140362501] },
      { kind: 'saveReload', u: [0.6465196667704731, 0.05350407934747636, 0.16035932721570134, 0.13257079641334713, 0.9233581093139946, 0.29431016836315393, 0.9723562414292246, 0.9721436109393835] },
      { kind: 'reparent', u: [0.12739807600155473, 0.7872736032586545, 0.6443532698322088, 0.5128415427170694, 0.5043930902611464, 0.47902564983814955, 0.5393894750159234, 0.4522446892224252] },
      { kind: 'createPrefab', u: [0.4085471951402724, 0.8239434850402176, 0.6017588612157851, 0.32962158299051225, 0.3047786010429263, 0.07762112468481064, 0.871194537030533, 0.01045084954239428] },
    ],
    reproduces: (f) => f.check === 'save→reload→save is not byte-identical' && /\/own\/.*: undefined vs \{"removed":true\}$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload→save is not byte-identical' && /\/own\/.*: undefined vs \{"removed":true\}$/.test(f.detail) && ops.some((o) => o.kind === 'trashPrefab'),
  },
  {
    issue: 1856,
    what: 'prune on: trash → addChild → Apply, and the comparison reload (the trashed prefab restored) gains an entity',
    // A WHOLE top-level entity gained (not a trait path — hunt seed 254 gains a PrefabInstance trait, another mechanism). The
    // stop still claims seed 250's shape (copy → outside edit → paste gains an entity with no trash) in a run that also
    // trashed something: the detail cannot tell them apart (close-out measurement, hunt 201-400).
    repro: [
      { kind: 'trashPrefab', u: [0.9616053267382085, 0.8986614316236228, 0.8458665194921196, 0.10550301731564105, 0.36948610469698906, 0.10419670818373561, 0.14534811885096133, 0.3606053702533245] },
      { kind: 'addChild', u: [0.45433683576993644, 0.06991623109206557, 0.36247888510115445, 0.32349463854916394, 0.9636948064435273, 0.36620242870412767, 0.7672389638610184, 0.7997816174756736] },
      { kind: 'apply', u: [0.16332965740002692, 0.7464540000073612, 0.7259030696004629, 0.022606123005971313, 0.05862882686778903, 0.1499764914624393, 0.42986090295016766, 0.5521558525506407] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /^\/[^/]+: undefined vs \{"traits".* \(an entity was gained\) \(with the deleted prefab restored\)$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /^\/[^/]+: undefined vs \{"traits".* \(an entity was gained\) \(with the deleted prefab restored\)$/.test(f.detail)
      && ops.some((o) => o.kind === 'trashPrefab') && ops.some((o) => o.kind === 'apply'),
  },
];

/** Fixed bugs the fuzzer found: each repro must now PASS. A KNOWN_OPEN entry moves here when its issue is fixed, so
 *  the minimized failure stays a regression test (#1789: "every minimized failure becomes a normal regression test"). */
export const REGRESSIONS: { issue: number; what: string; repro: Op[] }[] = [
  {
    issue: 1837,
    what: "a Replace over a prefab from a different tree keeps localId 1 bound to the old root's node (I4), and the walk back through it passes (hunt seed 4980, Mac; it was #1821 route 2's repro until #1795 left the create's file in place)",
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
    issue: 1844,
    what: "Apply's undo after a trashed prefab's restore resolves the prefab by guid: the delete's undo re-announces the file (a rescan in the step), with the renderer's manifest pruned as the host prunes it. The in-process push is synchronous, so this proves the rescan, not reply-over-push (restoreReannounce.test.ts pins that)",
    repro: [
      { kind: 'apply', u: [0.2937982527073473, 0.5394669128581882, 0.4197493374813348, 0.36578157427720726, 0.20788102177903056, 0.6497358186170459, 0.9164766848552972, 0.9768222714774311] },
      { kind: 'trashPrefab', u: [0.051433956949040294, 0.7084667850285769, 0.781075214035809, 0.30418737791478634, 0.647015658672899, 0.8122841196600348, 0.24840730288997293, 0.7905789571814239] },
    ],
  },
  {
    issue: 1849,
    what: "(harness) a swap that leaves a nested frame of a trashed prefab UNEXPANDED taints as ruling R — its members are gone, not placeholders (work-ai3 hunt seed 6191; #1849's seeds under prune)",
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
    issue: 1795,
    what: "the same, with the rename's undo as an OP: it refuses (the old name is a create's kept file), and the step taints as renameCollision",
    repro: [
      { kind: 'addChild', u: [0.47438800777308643, 0.6849050319287926, 0.018786048982292414, 0.41438902798108757, 0.01898742886260152, 0.7009683928918093, 0.10380097082816064, 0.5749734076671302] },
      { kind: 'saveReload', u: [0.9517920373473316, 0.6275642085820436, 0.6845347550697625, 0.034205432049930096, 0.9466571100056171, 0.9330003669019789, 0.9431702268775553, 0.853209639666602] },
      { kind: 'createPrefab', u: [0.954957535257563, 0.8790208585560322, 0.1273031032178551, 0.39226157404482365, 0.8768407960887998, 0.5753853456117213, 0.1393283517099917, 0.7638483592309058] },
      { kind: 'copy', u: [0.0819199294783175, 0.9390344275161624, 0.504217367619276, 0.8227947673294693, 0.1901625671889633, 0.71554422727786, 0.8023586187046021, 0.9949959618970752] },
      { kind: 'paste', u: [0.5775616799946874, 0.951425006147474, 0.29634487093426287, 0.9946444493252784, 0.8024187004193664, 0.6370631060563028, 0.5748223115224391, 0.7400542183313519] },
      { kind: 'delete', u: [0.2557223727926612, 0.6671593459323049, 0.3221927627455443, 0.3245999552309513, 0.780588896246627, 0.012352550867944956, 0.43838050751946867, 0.6093167993240058] },
      { kind: 'renamePrefab', u: [0.29367014579474926, 0.838569869985804, 0.744370064465329, 0.9900823086500168, 0.14166604191996157, 0.6773370199371129, 0.3684174786321819, 0.5982422344386578] },
      { kind: 'createPrefab', u: [0.33827525400556624, 0.7544570425525308, 0.698528251843527, 0.44618354621343315, 0.48049078905023634, 0.0021756314672529697, 0.017819779692217708, 0.9753832877613604] },
      { kind: 'undo', u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
      { kind: 'undo', u: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    ],
  },
  {
    issue: 1795,
    what: "create, rename it, create at the freed name, walk: the first create's redo finds its document by guid (hunt seed 6029)",
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
    issue: 1795,
    what: "the same with the rename's old path held at the segment start: the rename undo's collision taints as renameCollision (seed 6029)",
    repro: [
      { kind: 'addChild', u: [0.47438800777308643, 0.6849050319287926, 0.018786048982292414, 0.41438902798108757, 0.01898742886260152, 0.7009683928918093, 0.10380097082816064, 0.5749734076671302] },
      { kind: 'saveReload', u: [0.9517920373473316, 0.6275642085820436, 0.6845347550697625, 0.034205432049930096, 0.9466571100056171, 0.9330003669019789, 0.9431702268775553, 0.853209639666602] },
      { kind: 'createPrefab', u: [0.954957535257563, 0.8790208585560322, 0.1273031032178551, 0.39226157404482365, 0.8768407960887998, 0.5753853456117213, 0.1393283517099917, 0.7638483592309058] },
      { kind: 'copy', u: [0.0819199294783175, 0.9390344275161624, 0.504217367619276, 0.8227947673294693, 0.1901625671889633, 0.71554422727786, 0.8023586187046021, 0.9949959618970752] },
      { kind: 'outsideEdit', u: [0.08719816221855581, 0.8353592141065747, 0.9263325876090676, 0.32402691757306457, 0.8761119514238089, 0.9141452747862786, 0.8234084991272539, 0.6028601555153728] },
      { kind: 'paste', u: [0.5775616799946874, 0.951425006147474, 0.29634487093426287, 0.9946444493252784, 0.8024187004193664, 0.6370631060563028, 0.5748223115224391, 0.7400542183313519] },
      { kind: 'delete', u: [0.2557223727926612, 0.6671593459323049, 0.3221927627455443, 0.3245999552309513, 0.780588896246627, 0.012352550867944956, 0.43838050751946867, 0.6093167993240058] },
      { kind: 'renamePrefab', u: [0.29367014579474926, 0.838569869985804, 0.744370064465329, 0.9900823086500168, 0.14166604191996157, 0.6773370199371129, 0.3684174786321819, 0.5982422344386578] },
      { kind: 'createPrefab', u: [0.33827525400556624, 0.7544570425525308, 0.698528251843527, 0.44618354621343315, 0.48049078905023634, 0.0021756314672529697, 0.017819779692217708, 0.9753832877613604] },
    ],
  },
  {
    issue: 1839,
    what: "(harness) outsideEdit wrote a plain row under a REFERENCE row, a shape no editor write produces — a false I7 (win's seed 3130)",
    repro: [
      { kind: 'prefabEdit', u: [0.31428628764115274, 0.3164791292510927, 0.8148758122697473, 0.44748169742524624, 0.9601324021350592, 0.8578238422051072, 0.6915884613990784, 0.03476591291837394], inner: [{ kind: 'duplicate', u: [0.12071382580325007, 0.9100820466410369, 0.5026753153651953, 0.5419060399290174, 0.20003260928206146, 0.6299601232167333, 0.03211430087685585, 0.5577229368500412] }] },
      { kind: 'outsideEdit', u: [0.36192806623876095, 0.3773991058114916, 0.6150501875672489, 0.5344666172750294, 0.6948157059960067, 0.4617444567847997, 0.43642105208709836, 0.91876904014498] },
      { kind: 'instantiate', u: [0.315802268916741, 0.5779164917767048, 0.9913183939643204, 0.28238313808105886, 0.5831954493187368, 0.08192095602862537, 0.1403615267481655, 0.9752809575293213] },
    ],
  },
  {
    issue: 1821,
    what: "Create Prefab's undo after an Apply into the new prefab was undone (fixed with #1795: the undo leaves the file, so there is no trash for a #1774 mark to refuse)",
    repro: [
      { kind: 'createPrefab', u: [0.2059, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addChild', u: [0.5, 0.2059, 0.1, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.4375, 0.1, 0, 0.9, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.9, 0, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1835,
    what: "Apply's undo after a Rename undo reads the prefab where it is: the move route pushes the renderer's manifest before its repair, as the editor's does (#1828's second route, harness-shaped)",
    repro: [
      { kind: 'apply', u: [0.3302737674675882, 0.2567235822789371, 0.6868790478911251, 0.7366894891019911, 0.12275128113105893, 0.10771414311602712, 0.646984655642882, 0.9300033883191645] },
      { kind: 'renamePrefab', u: [0.2094005134422332, 0.4872707976028323, 0.2897710604593158, 0.9391268761828542, 0.4600680246949196, 0.9581016609445214, 0.701076986733824, 0.585580583428964] },
      { kind: 'detach', u: [0.16811815183609724, 0.4063933831639588, 0.7856829706579447, 0.2869127383455634, 0.6659100251272321, 0.9365419009700418, 0.5917436527088284, 0.9570457476656884] },
    ],
  },
  {
    issue: 1828,
    what: "the Hierarchy drop's redo after a Rename undo tags the instance by the document's guid, never a path (setPrefabSource takes the document)",
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
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.7, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1817,
    what: 'the same, under a layer-added node',
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.95, 0, 0, 0, 0, 0] }] },
    ],
  },
  {
    issue: 1836,
    what: 'a prefab-edit reparent of the root is refused, so the delete after it cannot take the root out (seed 4535)',
    repro: [
      { kind: 'renamePrefab', u: [0.6519922227598727, 0.2114757765084505, 0.018607930978760123, 0.30942356470040977, 0.8359362620394677, 0.67055669776164, 0.9231131041888148, 0.44708462059497833] },
      { kind: 'prefabEdit', u: [0.6905049616470933, 0.5051443385891616, 0.16762249427847564, 0.8142847665585577, 0.8068818023893982, 0.18743133172392845, 0.5548743580002338, 0.7678781691938639], inner: [{ kind: 'reparent', u: [0.08123077405616641, 0.6606571737211198, 0.837768564466387, 0.4680335680022836, 0.47950352635234594, 0.8769256870727986, 0.06606265692971647, 0.9000267873052508] }, { kind: 'delete', u: [0.08093803143128753, 0.029633563244715333, 0.4261932633817196, 0.4423936535604298, 0.4413971840403974, 0.8836731656920165, 0.1854370052460581, 0.35569544485770166] }] },
    ],
  },
  {
    issue: 1836,
    what: 'the same in one prefab-edit op (seed 3884)',
    repro: [
      { kind: 'prefabEdit', u: [0.0952886319719255, 0.1324546616524458, 0.7667984003201127, 0.040486402809619904, 0.38836244866251945, 0.164681785274297, 0.0033743923995643854, 0.9235746308695525], inner: [{ kind: 'reparent', u: [0.11242076917551458, 0.3747843843884766, 0.34736537211574614, 0.746526314644143, 0.02761491690762341, 0.7988603033591062, 0.11750280298292637, 0.11291002365760505] }, { kind: 'delete', u: [0.056537609081715345, 0.7215519584715366, 0.9376734544057399, 0.17930406494997442, 0.7820167003665119, 0.6088943409267813, 0.12121632206253707, 0.8013442442752421] }] },
    ],
  },
  {
    issue: 1807,
    what: "Create Prefab's undo right after a Rename undo untags by path through a lagging manifest",
    repro: [
      { kind: 'createPrefab', u: [0.2, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'renamePrefab', u: [0.7, 0.564, 0, 0, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.4, 0.5, 0, 0, 0, 0, 0, 0] },
    ],
  },
  {
    issue: 1812,
    what: "a save writes a nested frame the load could not expand as removed once the editor cache holds its prefab",
    repro: [
      { kind: 'trashPrefab', u: [0.974, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
    ],
  },
  {
    issue: 1812,
    what: 'the same, where the world swap is the final save→reload (baseline seed 246)',
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
      { kind: 'apply', u: [0.7839175323024392, 0.7955678380094469, 0.42464192933402956, 0.6151037919335067, 0.8330991917755455, 0.19254334270954132, 0.9538525966927409, 0.8849528867285699] },
    ],
  },
  {
    issue: 1797,
    what: "Apply's write into an enclosing prefab states nextLocalId",
    repro: [
      { kind: 'reparent', u: [0.19745544902980328, 0.9284775732085109, 0.5860603547189385, 0.22611782955937088, 0.25675307563506067, 0.33752377540804446, 0.4600350330583751, 0.8438367047347128] },
      { kind: 'saveReload', u: [0.4955816750880331, 0.3304008231498301, 0.0743095432408154, 0.34028684766963124, 0.5970875050406903, 0.020840930752456188, 0.5537212470080703, 0.47318257577717304] },
      { kind: 'editField', u: [0.33866258268244565, 0.3408757250290364, 0.588245488004759, 0.5010231542401016, 0.12284281710162759, 0.16788704600185156, 0.06966154696419835, 0.14767667441628873] },
      { kind: 'apply', u: [0.6356004311237484, 0.23566313600167632, 0.1354613231960684, 0.24098156881518662, 0.43663930892944336, 0.9642775468528271, 0.4479197319597006, 0.6394356489181519] },
    ],
  },
];

/** Every tolerance, on: what verify and hunt modes run with while the entries are open. */
export const KNOWN_TOLERANCES: Tolerate = Object.fromEntries(KNOWN_OPEN.filter((k) => k.tolerate).map((k) => [k.tolerate, true]));
