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

/** A node in an instance's node list (own / added / children, or a template-added key's record) that the redo put
 *  somewhere else: missing where the end state held it, or present where it held none. Never a trait diff. */
const DROP_NODE_MOVED = /\/((own|added|children)(\/\d+)*|a\+k-[^/:]+): (\[?\{"(parentLocalId|own)":.* vs undefined$|undefined vs \[?\{"(parentLocalId|own)":)|^\/entities\/[0-9a-f]{8}-[0-9a-f-]{27}(\/traits\/EntityAttributes\/parentId: "[^"]+" vs "[^"]+"$|: (\{.* vs undefined$|undefined vs \{))/;

/** Create Prefab's redo refused to tag the tree it rewrote because a reload reordered its siblings (#1796's route). */
const POSITIONAL_RETAG = /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \((".*" was written at localId \d+, but sits where row \d+ was written|row \d+ changed between a nested reference and a plain member)\)/;

const UNDO_IDENTITY = /^(undo to the start|redo to the end) does not restore the scene$/;

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

/** #1793: the drop's redo lands under the raw parent id it captured. */
const KNOWN_OPEN_1793 = (f: StepFailure, ops: readonly Op[]): boolean => ((f.check === 'redo to the end does not restore the scene' && f.op === 'undo/redo to the ends' && DROP_NODE_MOVED.test(f.detail)
    && (f.moved === true || /\/traits\/EntityAttributes\/parentId: /.test(f.detail)) && touchedBy(f, 'drop', diffSubject(f)))
  || (f.check === 'redo threw' && /Instantiate/.test(f.detail) && /Maximum call stack/.test(f.detail)))
  && ops.some((o) => o.kind === 'instantiate' && o.u[1] >= 0.4);

/** #1794: a Detach, a rebuild (a reload, or a prefab-edit visit), then its undo as the last op; the next save→reload finds
 *  the member's marks differ. Never a component's mark (#1800, #1822). */
const detachMarks = (f: StepFailure, ops: readonly Op[]): boolean => f.check === 'save→reload is not the identity'
  && /\/marks\//.test(f.detail) && !/"(Rotate3D|Renderable3DPrimitive)\./.test(f.detail) && lastOp(ops) === 'undo'
  && touchedBy(f, 'detach', subjectGuid(f)) && (() => {
    const d = ops.findIndex((o) => o.kind === 'detach');
    const r = ops.findIndex((o, i) => i > d && (o.kind === 'saveReload' || o.kind === 'prefabEdit'));
    return d >= 0 && r >= 0 && ops.slice(r + 1).some((o) => o.kind === 'undo');
  })();

/** #1819: an edit whose undo cannot reach its target, because a world swap folded it into a placeholder's kept record —
 *  the record still holds the edit after the undo walk. */
const PLACEHOLDER_KEPT_EDIT = /^\/entities\/[^/]+\/(added\/\d+\/)*members\/\/[^:]+\/(traits|added|a\+k-[^/:]+): undefined vs [[{]/;
const placeholderEditUndo = (f: StepFailure, ops: readonly Op[]): boolean => UNDO_IDENTITY.test(f.check) && f.op === 'undo/redo to the ends'
  && PLACEHOLDER_KEPT_EDIT.test(f.detail) && !ops.some((o) => o.kind === 'detach') && (() => {
    const t = ops.findIndex((o) => o.kind === 'trashPrefab'); const w = ops.findIndex((o, i) => i > t && o.kind === 'prefabEdit');
    return t >= 0 && w >= 0 && ops.slice(0, w).some((o) => ['editField', 'addComponent', 'removeComponent', 'addChild'].includes(o.kind));
  })();

/** #1819: an undo recorded against an instance, run after a trash and a world swap turned it into a placeholder. */
const placeholderUndo = (f: StepFailure, ops: readonly Op[]): boolean => ((f.check === 'I7 duplicate guid' && /different top-level roots; not rows of one frame/.test(f.detail))
  || f.check === 'I6 member names no live root') && /^(undo|redo)/.test(f.op) && (() => {
    const t = ops.findIndex((o) => o.kind === 'trashPrefab'); const w = ops.findIndex((o, i) => i > t && o.kind === 'prefabEdit');
    return t >= 0 && w >= 0 && ops.slice(0, w).some((o) => o.kind === 'revert' || o.kind === 'delete');
  })();

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
    issue: 1793,
    what: 'the Hierarchy drop redo respawns under the raw parentId it captured',
    repro: [
      { kind: 'addChild', u: [0.10074071935378015, 0.028060921700671315, 0.7381888588424772, 0.07076097163371742, 0.48960428941063583, 0.8733981365803629, 0.6133775096386671, 0.42650880897417665] },
      { kind: 'saveReload', u: [0.5627734144218266, 0.658590353326872, 0.20640674652531743, 0.20616899570450187, 0.6343548579607159, 0.5095381010323763, 0.7855825365986675, 0.2228345947805792] },
      { kind: 'delete', u: [0.8534152032807469, 0.004220895003527403, 0.012713729869574308, 0.5877229287289083, 0.543377417139709, 0.7120547322556376, 0.8890753472223878, 0.011987897567451] },
      { kind: 'createPrefab', u: [0.39224287075921893, 0.34542759554460645, 0.5703704461921006, 0.651647862745449, 0.640527063049376, 0.906829692190513, 0.5833610829431564, 0.11566608608700335] },
      { kind: 'instantiate', u: [0.5398968369700015, 0.5591946570202708, 0.3965801652520895, 0.8199710526969284, 0.7236331920139492, 0.3989574590232223, 0.5845813890919089, 0.9010130369570106] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && DROP_NODE_MOVED.test(f.detail),
    // A drop under a parent (instantiate's u[1] >= 0.4) before the failure, then the redo walk. What renumbers the world
    // between them can be any rebuild, and every run ends with one (the final save→reload). Keyed on what the redo shows:
    // a node the end state held in a node list (the drop, respawned elsewhere) is missing — never a trait diff (review:
    // keyed on the check alone, this claimed a redo that lost an override). The redo that throws is the dead-id branch
    // of the same mechanism (a stack overflow in the instantiate undo's subtree walk).
    stops: (f, ops) => KNOWN_OPEN_1793(f, ops),
  },
  {
    issue: 1793,
    what: "the same, where the redone drop lands inside a tree Create Prefab saved, whose redo then refuses to tag",
    repro: [
      { kind: 'instantiate', u: [0.536669387947768, 0.6350903764832765, 0.16291079157963395, 0.6589401110541075, 0.06732470379211009, 0.28064573951996863, 0.814664434408769, 0.09242976340465248] },
      { kind: 'duplicate', u: [0.1208830603864044, 0.1635916270315647, 0.13143340032547712, 0.8468647501431406, 0.23493050667457283, 0.5173707250505686, 0.24668535101227462, 0.9065328275319189] },
      { kind: 'instantiate', u: [0.7415995926130563, 0.9059424293227494, 0.6720692184753716, 0.09967420063912868, 0.9266807311214507, 0.75157764647156, 0.5515890922397375, 0.413286124356091] },
      { kind: 'createPrefab', u: [0.4479338226374239, 0.27541221934370697, 0.9265035709831864, 0.5260013118386269, 0.39644129923544824, 0.46983038261532784, 0.2828926555812359, 0.9987726588733494] },
      { kind: 'duplicate', u: [0.6731960822362453, 0.6350430566817522, 0.7874502844642848, 0.569269162369892, 0.3572055655531585, 0.6255097249522805, 0.7987854916136712, 0.40314554143697023] },
      { kind: 'prefabEdit', u: [0.42861639079637825, 0.054919869638979435, 0.11251235730014741, 0.25302259996533394, 0.5110977506265044, 0.6065081746783108, 0.19385989173315465, 0.17463909462094307], inner: [] },
      { kind: 'instantiate', u: [0.8633103484753519, 0.7312443025875837, 0.2811007387936115, 0.9838384159374982, 0.2525151225272566, 0.22980506089515984, 0.1260009352117777, 0.912312442669645] },
      { kind: 'duplicate', u: [0.27535659074783325, 0.4235336270648986, 0.865512638585642, 0.7019412482623011, 0.7961306441575289, 0.866034438367933, 0.18822620552964509, 0.03233868605457246] },
    ],
    reproduces: (f) => f.check === 'console.error' && /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \(\d+ rows now vs \d+ written\)/.test(f.detail),
    // A drop under a parent and a Create Prefab, no trash (with a trash it is #1795's placeholder route).
    stops: (f, ops) => f.check === 'console.error' && (f.op === 'undo/redo to the ends' || /^redo\(/.test(f.op))
      && /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \(\d+ rows now vs \d+ written\)/.test(f.detail)
      && ops.some((o) => o.kind === 'createPrefab') && ops.some((o) => o.kind === 'instantiate' && o.u[1] >= 0.4) && !ops.some((o) => o.kind === 'trashPrefab'),
  },
  {
    issue: 1793,
    what: "the same, where the redone drop lands under another member (a node gained there)",
    repro: [
      { kind: 'createPrefab', u: [0.4756804835051298, 0.9059161539189517, 0.2702726419083774, 0.04173311730846763, 0.3559492980130017, 0.7170560555532575, 0.7191443415358663, 0.3863689487334341] },
      { kind: 'apply', u: [0.0984069409314543, 0.7538809631951153, 0.9942104765214026, 0.13992764917202294, 0.5408165806438774, 0.9048162957187742, 0.8538481199648231, 0.10714701632969081] },
      { kind: 'instantiate', u: [0.5284241682384163, 0.6892916776705533, 0.5348713435232639, 0.20216689840890467, 0.11103156278841197, 0.7996803736314178, 0.7371482730377465, 0.5829197440762073] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && DROP_NODE_MOVED.test(f.detail),
    stops: (f, ops) => KNOWN_OPEN_1793(f, ops),
  },
  {
    issue: 1793,
    what: "the same, where the respawned drop takes another node's slot in a node list",
    repro: [
      { kind: 'addChild', u: [0.7145716946106404, 0.5561756328679621, 0.5099239049013704, 0.6244862840976566, 0.7335275961086154, 0.6134859917219728, 0.23060267022810876, 0.7317334439139813] },
      { kind: 'createPrefab', u: [0.21342101460322738, 0.1870845491066575, 0.8912742179818451, 0.07492860639467835, 0.7403424200601876, 0.2867176430299878, 0.9215701427310705, 0.31814626371487975] },
      { kind: 'saveReload', u: [0.6422297023236752, 0.8505626353435218, 0.2529598572291434, 0.9410491364542395, 0.9856884707696736, 0.3246399243362248, 0.683646138291806, 0.12626319588162005] },
      { kind: 'instantiate', u: [0.23157899221405387, 0.6794504942372441, 0.18278003903105855, 0.240608187392354, 0.0013917970936745405, 0.7093260157853365, 0.2822195577900857, 0.96261520171538] },
      { kind: 'undo', u: [0.09050807449966669, 0.6558327882084996, 0.3099635324906558, 0.6077217403799295, 0.5417213151231408, 0.20162267237901688, 0.8052350806538016, 0.4917391324415803] },
      { kind: 'addChild', u: [0.6238473090343177, 0.5287783958483487, 0.6110795557033271, 0.11876990180462599, 0.2796090093906969, 0.9069117002654821, 0.912856874987483, 0.44095068075694144] },
      { kind: 'reparent', u: [0.8635704338084906, 0.907134655630216, 0.9837169637903571, 0.9309531296603382, 0.16331519768573344, 0.6003672608640045, 0.9272804129868746, 0.046366722555831075] },
      { kind: 'prefabEdit', u: [0.14680528966709971, 0.6739758297335356, 0.7129750931635499, 0.254939271369949, 0.9860867182724178, 0.09944728901609778, 0.03289157245308161, 0.5044709760695696], inner: [] },
      { kind: 'trashPrefab', u: [0.645055967150256, 0.3555994192138314, 0.4762186794541776, 0.02507166936993599, 0.45181857072748244, 0.64018270582892, 0.5068258126266301, 0.3847066070884466] },
      { kind: 'instantiate', u: [0.19409324880689383, 0.9259697603993118, 0.5660134558565915, 0.9067194813396782, 0.20263959048315883, 0.7811750741675496, 0.004530955571681261, 0.8311343181412667] },
      { kind: 'instantiate', u: [0.22969491896219552, 0.35693361377343535, 0.7506059226579964, 0.8251728769391775, 0.9540188987739384, 0.3535843987483531, 0.5003614285960793, 0.2983123888261616] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene',
    stops: (f, ops) => KNOWN_OPEN_1793(f, ops),
  },
  {
    issue: 1793,
    what: "the same, where the respawned drop shifts the top-level entities",
    repro: [
      { kind: 'detach', u: [0.09200233151204884, 0.4978172762785107, 0.8711860135663301, 0.9882726897485554, 0.4086105620954186, 0.26161185512319207, 0.09985085763037205, 0.7580608306452632] },
      { kind: 'cut', u: [0.3569653546437621, 0.02168582985177636, 0.6318808461073786, 0.040972903836518526, 0.10015158797614276, 0.28511395188979805, 0.04311187658458948, 0.37725126929581165] },
      { kind: 'paste', u: [0.7133683976717293, 0.7894542491994798, 0.3840922354720533, 0.6534743243828416, 0.949433326954022, 0.21257702424190938, 0.6325942415278405, 0.1245825260411948] },
      { kind: 'saveReload', u: [0.38046945980750024, 0.047217794228345156, 0.22895032935775816, 0.34555352735333145, 0.033765289932489395, 0.4782737318892032, 0.9830439805518836, 0.8440993558615446] },
      { kind: 'instantiate', u: [0.17357664229348302, 0.836304823635146, 0.3443488501943648, 0.5612517131958157, 0.7548945001326501, 0.2683266291860491, 0.23483543982729316, 0.915401702048257] },
      { kind: 'cut', u: [0.4678339713718742, 0.61683215550147, 0.5234560901299119, 0.4106190758757293, 0.4732466072309762, 0.5263875990640372, 0.09380397107452154, 0.2719819906633347] },
      { kind: 'paste', u: [0.12226695870049298, 0.7349859543610364, 0.6576325534842908, 0.5577748806681484, 0.08136803284287453, 0.040631324518471956, 0.204928963445127, 0.797939523588866] },
    ],
    reproduces: (f) => f.check === 'redo to the end does not restore the scene' && /^\/entities\/[0-9a-f]{8}-[0-9a-f-]{27}\/traits\/EntityAttributes\/parentId: /.test(f.detail),
    stops: (f, ops) => KNOWN_OPEN_1793(f, ops),
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
    issue: 1795,
    what: "Create Prefab's undo against a tree a world swap re-expanded as a Missing Prefab placeholder trashes the file the scene names",
    repro: [
      { kind: 'trashPrefab', u: [0.7206, 0.8358, 0.2251, 0.7701, 0.6414, 0.4093, 0.0235, 0.3128] },
      { kind: 'prefabEdit', u: [0.5902, 0.2545, 0.0586, 0.1319, 0.8827, 0.4678, 0.2631, 0.1415], inner: [] },
      { kind: 'createPrefab', u: [0.8449, 0.6267, 0.0149, 0.1407, 0.4933, 0.2333, 0.3549, 0.3216] },
      { kind: 'prefabEdit', u: [0.3871, 0.5004, 0.0544, 0.7359, 0.5348, 0.7957, 0.3886, 0.1663], inner: [] },
    ],
    reproduces: (f) => f.check === 'console.error' && /^\[undo\] Undo of "Save prefab "[^"]*"" did not fully apply — \d+ prefab links? the tree had before could not be put back/.test(f.detail),
    // The second route (comment on #1795): a trashed prefab, then a world swap (prefab edit), then a Create Prefab whose
    // undo or redo runs against the placeholder. Keyed on the two lines that say so; the "rows now vs written" wording
    // keeps it off #1796's positional re-tag, which says "was written at localId" or "changed between".
    stops: (f, ops) => f.check === 'console.error' && (f.op === 'undo/redo to the ends' || /^(undo|redo)\(/.test(f.op))
      && (/^\[undo\] Undo of "Save prefab "[^"]*"" did not fully apply — \d+ prefab links? the tree had before could not be put back/.test(f.detail)
        || /^\[Prefab\] not tagging "[^"]+" — the live tree no longer matches the prefab just written \(\d+ rows now vs \d+ written\)/.test(f.detail))
      && ops.some((o) => o.kind === 'createPrefab') && (() => {
        const t = ops.findIndex((o) => o.kind === 'trashPrefab'); return t >= 0 && ops.slice(t + 1).some((o) => o.kind === 'prefabEdit');
      })(),
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
    issue: 1796,
    what: "the same redo, where the created tree's node is missing from an own list (21 ops; did not shrink further)",
    repro: [
      { kind: 'delete', u: [0.7869051562156528, 0.32680091029033065, 0.17741511180065572, 0.064084536395967, 0.7394088266883045, 0.9181825206615031, 0.2666794089600444, 0.6213861852884293] },
      { kind: 'editField', u: [0.7101908680051565, 0.4720049968454987, 0.3094741618260741, 0.38340692641213536, 0.6998259236570448, 0.46449348074384034, 0.5754108203109354, 0.6111313616856933] },
      { kind: 'saveReload', u: [0.8231905084103346, 0.5387807020451874, 0.9879717626608908, 0.38985347701236606, 0.8230040643829852, 0.5344827990047634, 0.09323303145356476, 0.18507185787893832] },
      { kind: 'apply', u: [0.6406025618780404, 0.426739358343184, 0.18353088619187474, 0.7748297811485827, 0.8843551387544721, 0.9194504439365119, 0.21818224829621613, 0.2528507993556559] },
      { kind: 'duplicate', u: [0.22814509132876992, 0.15901406737975776, 0.8366280221380293, 0.18494723457843065, 0.3341570985503495, 0.2037063802126795, 0.5880342544987798, 0.6795997964218259] },
      { kind: 'detach', u: [0.509330557892099, 0.37932411790825427, 0.8312338744290173, 0.3267618559766561, 0.24016799964010715, 0.902737297816202, 0.6082887835800648, 0.12824060069397092] },
      { kind: 'apply', u: [0.4793406187091023, 0.29598562186583877, 0.8320873647462577, 0.43977406970225275, 0.3506213976070285, 0.7863092974293977, 0.1686364144552499, 0.924748569028452] },
      { kind: 'instantiate', u: [0.7121125643607229, 0.1354014843236655, 0.6526460386812687, 0.8659608855377883, 0.45212059328332543, 0.42255788925103843, 0.028180899331346154, 0.15954560646787286] },
      { kind: 'trashPrefab', u: [0.03717427630908787, 0.9504511456470937, 0.38499065302312374, 0.14257556851953268, 0.10294431145302951, 0.4756358992308378, 0.10243889642879367, 0.5066614393144846] },
      { kind: 'delete', u: [0.812278785277158, 0.06260053999722004, 0.4259755874518305, 0.32458122354000807, 0.90911735733971, 0.6504083217587322, 0.987839809153229, 0.6435587147716433] },
      { kind: 'editField', u: [0.21721916203387082, 0.17733420873992145, 0.901688737096265, 0.6152864517644048, 0.16949320933781564, 0.3227336232084781, 0.5634142253547907, 0.251472445204854] },
      { kind: 'removeComponent', u: [0.6204396202228963, 0.054029672872275114, 0.0963529113214463, 0.8212014231830835, 0.03707568603567779, 0.6476416965015233, 0.3282623717095703, 0.03977012960240245] },
      { kind: 'reparent', u: [0.2726127931382507, 0.6638640670571476, 0.12935588625259697, 0.7636036353651434, 0.8392666787840426, 0.0007917035836726427, 0.8301953163463622, 0.8063291984144598] },
      { kind: 'duplicate', u: [0.04075807612389326, 0.5350618809461594, 0.7036187932826579, 0.8367577623575926, 0.6972814088221639, 0.2032229509204626, 0.8271287344396114, 0.7871801019646227] },
      { kind: 'saveReload', u: [0.4157884665764868, 0.520228423178196, 0.3347147856839001, 0.6629283297806978, 0.15264668664894998, 0.3769426594953984, 0.8355729351751506, 0.046979035483673215] },
      { kind: 'delete', u: [0.11570771085098386, 0.24691615323536098, 0.4521506945602596, 0.030634205555543303, 0.9931171748321503, 0.7192651892546564, 0.23199849389493465, 0.9877878550905734] },
      { kind: 'createPrefab', u: [0.7933650796767324, 0.6978349294513464, 0.28034798079170287, 0.8613478152547032, 0.019552623387426138, 0.7686620019376278, 0.7373560897540301, 0.2242870528716594] },
      { kind: 'detach', u: [0.3041471876204014, 0.20615770621225238, 0.8273651364725083, 0.04255107953213155, 0.028327596839517355, 0.5097611858509481, 0.9530998733825982, 0.7858844101428986] },
      { kind: 'removeComponent', u: [0.06279179221019149, 0.47693874314427376, 0.9122700137086213, 0.41033109463751316, 0.11926526250317693, 0.03752007405273616, 0.592368433251977, 0.6520900789182633] },
      { kind: 'apply', u: [0.8741665869019926, 0.7889110972173512, 0.15771035477519035, 0.7967837299220264, 0.22659871657378972, 0.882628922117874, 0.25956694944761693, 0.4585677166469395] },
      { kind: 'duplicate', u: [0.03654034179635346, 0.06432576943188906, 0.8141263155266643, 0.8554626393597573, 0.16263446654193103, 0.34149776166304946, 0.21945376531220973, 0.12901113834232092] },
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
    issue: 1805,
    what: 'an Assets delete leaves the prefab in the editor cache while a world swap drops it from the loader, so the save writes rows naming it as removed',
    repro: [
      { kind: 'trashPrefab', u: [0.5253717228770256, 0.3637211681343615, 0.16043360973708332, 0.6716910290997475, 0.20890621887519956, 0.42551467870362103, 0.42723338585346937, 0.0039873996283859015] },
      { kind: 'prefabEdit', u: [0.2850157537031919, 0.2534669756423682, 0.6076711313799024, 0.6218444388359785, 0.11600693548098207, 0.14820343581959605, 0.1644768884871155, 0.3037136106286198], inner: [] },
      { kind: 'instantiate', u: [0.5536115297582, 0.7428521458059549, 0.17168851662427187, 0.6443779191467911, 0.9432437820360065, 0.49406764027662575, 0.3743322738446295, 0.2861176738515496] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity',
    // A trashed prefab before the failure, then a world swap (prefab edit, a reload, a watcher reload) or a prefab created
    // this session before the trash (the loader never held it; the final save→reload is the swap) — two routes. Keyed on
    // what the reload lost: an entity of a deleted prefab's instance, or an instance that came back a placeholder
    // (checkRoundTrip names both) — never any lost entity (review).
    stops: (f, ops) => f.check === 'save→reload is not the identity'
      && /\((an entity of a deleted prefab was lost|it came back a Missing Prefab placeholder of a deleted prefab)\)$/.test(f.detail) && (() => {
        const t = ops.findIndex((o) => o.kind === 'trashPrefab');
        return t >= 0 && (ops.slice(t + 1).some((o) => o.kind === 'prefabEdit' || o.kind === 'saveReload' || o.kind === 'outsideEdit')
          || ops.slice(0, t).some((o) => o.kind === 'createPrefab'));
      })(),
  },
  {
    issue: 1805,
    what: "the same route 2, where the first difference is the instance member's marks (it came back a placeholder)",
    repro: [
      { kind: 'instantiate', u: [0.5075831420253962, 0.8186536263674498, 0.4673538957722485, 0.9546289832796901, 0.39170667389407754, 0.5493532461114228, 0.4505586097948253, 0.8853592379018664] },
      { kind: 'duplicate', u: [0.39032594044692814, 0.04696453106589615, 0.3570088869892061, 0.40155923343263566, 0.5113228356931359, 0.29383464995771646, 0.025902038207277656, 0.7472156076692045] },
      { kind: 'createPrefab', u: [0.5959376466926187, 0.9407973305787891, 0.6634466790128499, 0.633407388580963, 0.013036289950832725, 0.15678744250908494, 0.8456963025964797, 0.3821238283999264] },
      { kind: 'trashPrefab', u: [0.3976654135622084, 0.9079436135943979, 0.3005773222539574, 0.4423462732229382, 0.34140314417891204, 0.17301023192703724, 0.8832939309068024, 0.3436738490127027] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(it came back a Missing Prefab placeholder of a deleted prefab\)$/.test(f.detail),
    // Keyed on what the reload did to the instance, not on the mark that happened to sort first (a mark alone is #1777's
    // shape, which the reject test holds unclaimed).
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /\(it came back a Missing Prefab placeholder of a deleted prefab\)$/.test(f.detail)
      && (() => { const t = ops.findIndex((o) => o.kind === 'trashPrefab'); return t >= 0 && ops.slice(0, t).some((o) => o.kind === 'createPrefab'); })(),
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
    issue: 1817,
    what: "CRASH: a prefab-edit save of the edited prefab dropped under a nested member or an added node writes a self-containing file and overflows the stack",
    repro: [
      { kind: 'prefabEdit', u: [0.3, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'instantiate', u: [0.3, 0.5, 0.7, 0, 0, 0, 0, 0] }] },
    ],
    reproduces: (f) => f.check === 'op threw' && /Maximum call stack size exceeded/.test(f.detail),
    // A prefab-edit op that drops a prefab and saves (u[1] < 0.65) throws the overflow itself. The ^ anchor keeps it off
    // #1793, whose redo overflow is thrown as 'redo "…" threw: …'.
    stops: (f, ops) => f.check === 'op threw' && /^Maximum call stack size exceeded/.test(f.detail) && f.op.startsWith('prefabEdit(')
      && (() => { const o = ops[ops.length - 1]; return o?.kind === 'prefabEdit' && o.u[1] < 0.65 && !!o.inner?.some((i) => i.kind === 'instantiate'); })(),
  },
  {
    issue: 1818,
    what: "an Inspector edit on a Missing Prefab placeholder shows live, and the save writes the kept record verbatim",
    repro: [
      { kind: 'trashPrefab', u: [0.251, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.954, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
      { kind: 'addComponent', u: [0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/traits\/(Rotate3D|Renderable3DPrimitive): .* vs undefined$/.test(f.detail),
    // A trashed prefab, a world swap that makes the placeholder, then a component added. Keyed on a whole component the
    // reload lost, never an entity.
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /^\/[^/]+\/traits\/(Rotate3D|Renderable3DPrimitive): .* vs undefined$/.test(f.detail)
      && (() => {
        const t = ops.findIndex((o) => o.kind === 'trashPrefab'); const w = ops.findIndex((o, i) => i > t && o.kind === 'prefabEdit');
        return t >= 0 && w >= 0 && ops.slice(w + 1).some((o) => o.kind === 'addComponent');
      })(),
  },
  {
    issue: 1818,
    what: "the same writer drops a placeholder's sortOrder a Hierarchy gesture set (Duplicate)",
    repro: [
      { kind: 'trashPrefab', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
      { kind: 'duplicate', u: [0.15, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\/traits\/EntityAttributes\/sortOrder: \d+ vs \d+$/.test(f.detail),
    stops: (f, ops) => f.check === 'save→reload is not the identity' && /^\/[^/]+\/traits\/EntityAttributes\/sortOrder: \d+ vs \d+$/.test(f.detail) && (() => {
      const t = ops.findIndex((o) => o.kind === 'trashPrefab');
      const w = ops.findIndex((o, i) => i > t && ['prefabEdit', 'saveReload', 'outsideEdit'].includes(o.kind));
      return t >= 0 && w >= 0 && ops.slice(w + 1).some((o) => ['duplicate', 'paste', 'reparent'].includes(o.kind));
    })(),
  },
  {
    issue: 1819,
    what: "a scene undo recorded against an instance runs against the Missing Prefab placeholder a world swap re-expanded it as",
    repro: [
      { kind: 'revert', u: [0.3511497532017529, 0.012670567957684398, 0.46970928786322474, 0.6648742232937366, 0.9818382884841412, 0.614271926227957, 0.988015036098659, 0.5841556487139314] },
      { kind: 'trashPrefab', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.5, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
      { kind: 'undo', u: [0.5, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'I7 duplicate guid' && /different top-level roots; not rows of one frame/.test(f.detail),
    // Two routes: Revert's undo spawns a second instance on the placeholder's guid (I7), Delete's undo restores members
    // whose root is the placeholder (I6). A Revert or Delete, then a trash and a world swap, then the undo. Disjoint from
    // #1792, whose failing op is the revert itself.
    stops: (f, ops) => placeholderUndo(f, ops),
  },
  {
    issue: 1819,
    what: "the same, through Delete's undo: members restored under the placeholder root (I6)",
    repro: [
      { kind: 'trashPrefab', u: [0.564, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'delete', u: [0.686, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.99, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
      { kind: 'undo', u: [0.1, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => f.check === 'I6 member names no live root' && /^(undo|redo)/.test(f.op),
    // Delete's route, claimed by the same stop.
    stops: (f, ops) => placeholderUndo(f, ops),
  },
  {
    issue: 1819,
    what: "the same, through a field edit's undo: its target does not resolve and it reports success having done nothing",
    repro: [
      { kind: 'editField', u: [0.9796891720034182, 0.23118928470648825, 0.8521646368317306, 0.5933850177098066, 0.9363153059966862, 0.46753835841082036, 0.38651481945998967, 0.924117068760097] },
      { kind: 'trashPrefab', u: [0.09160058596171439, 0.9653133898973465, 0.5251444848254323, 0.14914855733513832, 0.10175600508227944, 0.8862450474407524, 0.23216438991948962, 0.9334844422992319] },
      { kind: 'prefabEdit', u: [0.8881433825008571, 0.9885712193790823, 0.7237701204139739, 0.027423259802162647, 0.4221728721167892, 0.49895594269037247, 0.8632127209566534, 0.3873697053641081], inner: [] },
    ],
    reproduces: (f) => f.check === 'undo to the start does not restore the scene' && PLACEHOLDER_KEPT_EDIT.test(f.detail),
    stops: (f, ops) => placeholderEditUndo(f, ops),
  },
  {
    issue: 1819,
    what: "the same, through Delete's undo of an added node: its parent became the placeholder, so it lands at the root",
    repro: [
      { kind: 'delete', u: [0.62, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'trashPrefab', u: [0.3, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.1, 0.9, 0, 0, 0, 0, 0, 0], inner: [] },
    ],
    reproduces: (f) => f.check === 'undo to the start does not restore the scene' && /^\/entities\/[0-9a-f]{8}-[0-9a-f-]{27}: undefined vs \{/.test(f.detail),
    // No stop: a top-level entry gained by an undo says nothing about a placeholder parent by itself (the review of
    // entity-identity diffing found a generic gained entry claimable by the op shape alone). Self-tested repro only.
  },
  {
    issue: 1819,
    what: "the same, through Add Component's undo (the component stays in the kept record)",
    repro: [
      { kind: 'addComponent', u: [0.6427716070320457, 0.8639664901420474, 0.5031768959015608, 0.6599007654003799, 0.4345746631734073, 0.9000449238810688, 0.5381293753162026, 0.374259619275108] },
      { kind: 'trashPrefab', u: [0.30492790788412094, 0.8365210755728185, 0.5132871367968619, 0.13930025370791554, 0.20630978257395327, 0.36985206860117614, 0.010625399881973863, 0.6315253779757768] },
      { kind: 'prefabEdit', u: [0.9100218610838056, 0.6029162958730012, 0.5514063406735659, 0.06771880853921175, 0.005160580854862928, 0.6917043258436024, 0.3046174261253327, 0.3058516394812614], inner: [{ kind: 'instantiate', u: [0.7038765226025134, 0.5172761019784957, 0.15159959415905178, 0.6085920596960932, 0.70793516933918, 0.9555558916181326, 0.8827216704376042, 0.9631576612591743] }] },
    ],
    reproduces: (f) => f.check === 'undo to the start does not restore the scene' && PLACEHOLDER_KEPT_EDIT.test(f.detail),
    stops: placeholderEditUndo,
  },
  {
    issue: 1819,
    what: "the same, through Add Child's undo (the child stays in the kept record)",
    repro: [
      { kind: 'addChild', u: [0.42997664655558765, 0.9901395693887025, 0.8573861042968929, 0.351486035855487, 0.12494081328622997, 0.12548391707241535, 0.6611704928800464, 0.9193278399761766] },
      { kind: 'trashPrefab', u: [0.09337501158006489, 0.27066205465234816, 0.6804431919008493, 0.7805610729847103, 0.6948331138119102, 0.6576268649660051, 0.2520267250947654, 0.5680687197018415] },
      { kind: 'prefabEdit', u: [0.9155996430199593, 0.8407363444566727, 0.9690347339492291, 0.22356510814279318, 0.47766409651376307, 0.721751298289746, 0.3306460517924279, 0.9674016057979316], inner: [] },
    ],
    reproduces: (f) => f.check === 'undo to the start does not restore the scene' && PLACEHOLDER_KEPT_EDIT.test(f.detail),
    stops: placeholderEditUndo,
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
      && (/\(an entity was lost\)$/.test(f.detail) || /^\/[^/]+\/traits\/Transform\/(x|y|z|rx|ry|rz|sx|sy|sz): /.test(f.detail)) && (() => {
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
    reproduces: (f) => f.check === 'save→reload is not the identity' && /\(an entity was gained\)$/.test(f.detail),
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
    issue: 1821,
    what: "Create Prefab's undo refuses after an Apply into the new prefab was undone (trashDoc compares exact bytes)",
    repro: [
      { kind: 'createPrefab', u: [0.2059, 0.5, 0, 0, 0, 0, 0, 0] },
      { kind: 'addChild', u: [0.5, 0.2059, 0.1, 0, 0, 0, 0, 0] },
      { kind: 'apply', u: [0.4375, 0.1, 0, 0.9, 0, 0, 0, 0] },
      { kind: 'undo', u: [0.9, 0, 0, 0, 0, 0, 0, 0] },
    ],
    reproduces: (f) => /^(undo|redo) refused in a clean segment$/.test(f.check) && /\.prefab\.json changed on disk since, and was left as it is$/.test(f.detail),
    // Apply's own refusal reads "…since the Apply, and…", so it does not match.
    stops: (f, ops) => /^(undo|redo) refused in a clean segment$/.test(f.check) && /\.prefab\.json changed on disk since, and was left as it is$/.test(f.detail)
      && (() => { const c = ops.findIndex((o) => o.kind === 'createPrefab'); return c >= 0 && ops.slice(c + 1).some((o) => o.kind === 'apply'); })(),
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
    issue: 1827,
    what: "an Instantiate or Paste undo whose guid no longer resolves after a world swap falls back to the raw ECS id and deletes whatever holds it",
    repro: [
      { kind: 'removeComponent', u: [0.7308414850849658, 0.11567534902133048, 0.848587361164391, 0.787630746839568, 0.7113146656192839, 0.3873164844699204, 0.9128336061257869, 0.36134594422765076] },
      { kind: 'instantiate', u: [0.9548506285063922, 0.27003602869808674, 0.11935152229852974, 0.3853158338461071, 0.8323814605828375, 0.7989177156705409, 0.11269795312546194, 0.3089376366697252] },
      { kind: 'apply', u: [0.12287110020406544, 0.05943365744315088, 0.24781434866599739, 0.3723465271759778, 0.2909893386531621, 0.9141282250639051, 0.5124099575914443, 0.6358611001633108] },
      { kind: 'undo', u: [0.40309701883234084, 0.12515778234228492, 0.11249637953005731, 0.4787011307198554, 0.9712785759475082, 0.3228068328462541, 0.5649044967722148, 0.43929144088178873] },
      { kind: 'instantiate', u: [0.8346606260165572, 0.8866690865252167, 0.7850938416086137, 0.020686337258666754, 0.6102396890055388, 0.8041137782856822, 0.3622960189823061, 0.18157163984142244] },
      { kind: 'trashPrefab', u: [0.6130347338039428, 0.3288127388805151, 0.8532239398919046, 0.8729194402694702, 0.7349629334639758, 0.13135315827094018, 0.9492790035437793, 0.21047820406965911] },
      { kind: 'prefabEdit', u: [0.9011082218494266, 0.7135820589028299, 0.7668768686708063, 0.31017256062477827, 0.27789436001330614, 0.6631764196790755, 0.13236475456506014, 0.17098554223775864], inner: [] },
    ],
    reproduces: (f) => f.check === 'undo to the start does not restore the scene' && /^\/entities\/[0-9a-f]{8}-[0-9a-f-]{27}: \{.* vs undefined$/.test(f.detail),
    // No stop: the entry this undo deletes is an unrelated one (whatever holds the recycled ECS id), so nothing in the
    // failure ties it to the undo that deleted it — keyed on the op shape it claimed any lost top-level entry (review).
    // Self-tested repro only; a hunt reports it by signature.
  },
  {
    issue: 1828,
    what: "the Hierarchy drop's redo respawns by path through a manifest a Rename undo has not caught up with (#1807's mechanism)",
    repro: [
      { kind: 'instantiate', u: [0.12306458246894181, 0.659326083259657, 0.3238855139352381, 0.3017094286624342, 0.7389431328047067, 0.6331829989794642, 0.8944360001478344, 0.3325171605683863] },
      { kind: 'createPrefab', u: [0.15510661457665265, 0.9943042399827391, 0.9856164292432368, 0.310858246171847, 0.6426518538501114, 0.3538553356193006, 0.2786709980573505, 0.9714844699483365] },
      { kind: 'addChild', u: [0.5799607739318162, 0.2170702046714723, 0.5558724678121507, 0.6893410694319755, 0.011181237641721964, 0.44485651864670217, 0.8736847601830959, 0.8628021879121661] },
      { kind: 'renamePrefab', u: [0.09707820601761341, 0.14232445927336812, 0.9031931138597429, 0.3121798960492015, 0.3815521625801921, 0.3378106460440904, 0.31110939756035805, 0.10088769742287695] },
      { kind: 'prefabEdit', u: [0.5217692020814866, 0.24212318868376315, 0.6475640579592437, 0.7428316583391279, 0.8591179379727691, 0.2987568259704858, 0.37442863010801375, 0.12064710608683527], inner: [] },
      { kind: 'revert', u: [0.4475659942254424, 0.4263928036671132, 0.892479837173596, 0.5712739205919206, 0.016539404401555657, 0.49129072832874954, 0.5349354806821793, 0.03838557889685035] },
    ],
    reproduces: (f) => f.check === 'scene validator' && /\.PrefabInstance\.source: internal asset path '[^']+\.prefab\.json' — references must be a GUID/.test(f.detail),
    stops: (f, ops) => (f.op === 'undo/redo to the ends' || /^(undo|redo)\(/.test(f.op))
      && ((f.check === 'scene validator' && /\.PrefabInstance\.source: internal asset path '[^']+\.prefab\.json' — references must be a GUID/.test(f.detail))
        || (f.check === 'console.error' && /^\[serialize\] internal asset path in PrefabInstance\.source — references must be GUIDs: \S+\.prefab\.json/.test(f.detail)))
      && (() => { const r = ops.findIndex((o) => o.kind === 'renamePrefab'); return r >= 0 && ops.slice(0, r).some((o) => o.kind === 'instantiate'); })(),
  },
  {
    issue: 1827,
    what: "the same, where the swap is a prefab-edit save that deleted the drop's parent row (no trash)",
    repro: [
      { kind: 'instantiate', u: [0.1, 0.5, 0.2647058823529412, 0, 0, 0, 0, 0] },
      { kind: 'delete', u: [0.1388888888888889, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'createPrefab', u: [0.99, 0.9, 0, 0, 0, 0, 0, 0] },
      { kind: 'instantiate', u: [0.7, 0.5, 0.7666666666666667, 0, 0, 0, 0, 0] },
      { kind: 'prefabEdit', u: [0.7, 0.1, 0, 0, 0, 0, 0, 0], inner: [{ kind: 'delete', u: [0.3, 0, 0, 0, 0, 0, 0, 0] }] },
    ],
    reproduces: (f) => f.check === 'console.error' && /^\[undo\] Undo of "Save prefab "[^"]*"" did not fully apply — \d+ prefab links? the tree had before could not be put back/.test(f.detail),
    // The only symptom a tainted segment shows: the NEXT undo's line. Disjoint from #1795 (a trash) by its op shape.
    stops: (f, ops) => f.check === 'console.error' && f.op === 'undo/redo to the ends'
      && /^\[undo\] Undo of "Save prefab "[^"]*"" did not fully apply — \d+ prefab links? the tree had before could not be put back — that entity is no longer addressable/.test(f.detail)
      && !ops.some((o) => o.kind === 'trashPrefab') && ops.some((o) => o.kind === 'createPrefab') && (() => {
        const n = ops.findIndex((o) => o.kind === 'instantiate' && o.u[1] >= 0.4);
        return n >= 0 && ops.slice(n + 1).some((o) => o.kind === 'prefabEdit' && o.u[1] < 0.65 && !!o.inner?.some((x) => x.kind === 'delete'));
      })(),
  },
  {
    issue: 1828,
    what: "the same lagging manifest, through Apply's undo: it resolves the source to the renamed path and refuses",
    repro: [
      { kind: 'apply', u: [0.3302737674675882, 0.2567235822789371, 0.6868790478911251, 0.7366894891019911, 0.12275128113105893, 0.10771414311602712, 0.646984655642882, 0.9300033883191645] },
      { kind: 'renamePrefab', u: [0.2094005134422332, 0.4872707976028323, 0.2897710604593158, 0.9391268761828542, 0.4600680246949196, 0.9581016609445214, 0.701076986733824, 0.585580583428964] },
      { kind: 'detach', u: [0.16811815183609724, 0.4063933831639588, 0.7856829706579447, 0.2869127383455634, 0.6659100251272321, 0.9365419009700418, 0.5917436527088284, 0.9570457476656884] },
    ],
    reproduces: (f) => f.check === 'undo refused in a clean segment' && /changed on disk since the Apply/.test(f.detail),
    // Keyed on the refusal the walk logged naming a RENAMED path (the fuzzer's rename writes R<n>.prefab.json), which
    // the file was moved back from — not on any Apply-undo refusal in a list that holds a rename.
    stops: (f, ops) => f.check === 'undo refused in a clean segment' && f.op === 'undo/redo to the ends'
      && !!f.console?.some((l) => /^\[undo\] Undo of "Apply to Prefab" was REFUSED — \S*\/R\d+\.prefab\.json changed on disk since the Apply/.test(l))
      && (() => { const a = ops.findIndex((o) => o.kind === 'apply'); return a >= 0 && ops.slice(a + 1).some((o) => o.kind === 'renamePrefab'); })(),
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
];

/** Fixed bugs the fuzzer found: each repro must now PASS. A KNOWN_OPEN entry moves here when its issue is fixed, so
 *  the minimized failure stays a regression test (#1789: "every minimized failure becomes a normal regression test"). */
export const REGRESSIONS: { issue: number; what: string; repro: Op[] }[] = [
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
