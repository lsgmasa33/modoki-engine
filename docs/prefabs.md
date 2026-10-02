# Prefabs

A **prefab** is a reusable entity sub-tree — a mini-scene — saved as a
`.prefab.json` file. A prefab *instance* in a scene references its source and
stores only the fields it overrides, so editing the prefab (and reloading)
updates every instance.

See also: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) · [Visual Editor](./editor.md)

> **Design reference: Unity (owner, 2026-09-28).** When a prefab behaviour is a design choice (which prefab an Apply targets, what Revert or Replace keeps, how a nested override reads), copy Unity's prefab semantics. Example: Apply on a nested instance, of a component an enclosing row added, offers both "Apply to Prefab '<nested>'" (stated truthfully as a component addition) and "Apply as override in Prefab '<enclosing>'", the default (#1658, § "Apply's targets").

## High-level rules (owner, 2026-10-02)

These rules sit above everything else in this doc. When an invariant, a ruling or an incident
section below disagrees with them, **the rule wins**, and the other text is a defect to fix. They
were set after review round 5 (#1948) found that about half of its bugs were caused by earlier
fixes. Most of those bugs came from two parts of the code disagreeing about what an instance is,
and no rule said which part was right. The design that rebuilds the instance model on these rules
is #2001.

**A question these rules cannot answer means the rule set is incomplete (owner, 2026-10-02).** A
session that cannot settle a prefab behaviour question from the rules stops and flags the hub,
citing the question and the rules it checked. It does not pick an answer itself. The hub refines
the rules here (taking a behaviour fork to the owner), and then the work continues. A guess at a
gap is how two parts of the code came to disagree in the first place.

⚠️ **The rules are the TARGET. Rules 2, 4 and 9 are not yet what the code does.** Today the live
world is the truth and Save diffs it against the prefab, and a missing prefab is kept alive by a
copy stored in the scene. The § Model and invariants section below describes that current code.
The table after the list says how far each rule is built.

1. **Copy Unity.** When a behaviour is a design choice, Unity's answer wins. Unity also decides
   whether a gap needs fixing. The one exception is silent data loss on an ordinary path, which is
   fixed even where Unity has the same gap.
2. **An instance IS its prefab plus its override list.** The list holds property changes, added and
   removed components, and added and removed children, as in Unity. The live entities are a
   projection of those two things. ONE function builds them from (prefab chain, list). Load,
   rebuild, Revert, undo and Apply's fan-out all call it. Nothing reads the live tree back to work
   out what an instance is.
3. **Only a gesture changes the list.** An edit records each field it changes; typing the value a
   field already has records nothing (F2). Once a record exists, it leaves the list only through
   Revert, Apply, undo or Remove Unused, or through a gesture that deletes or reverses the very thing
   the record IS: removing a component the list added, deleting a user-added node, or re-adding a
   component the list removed. A record is never dropped because its value later equals the base
   (#1914). Deleting a member or removing a component is itself a record (`removed`,
   `traitRemovals`), and the records on and under it stay, inert. So reverting the deletion or the
   removal brings it back as it was, edits included. Children the user added under a deleted member
   are scene content and are deleted with it, as in Unity; undo restores them. (Hub refinements,
   2026-10-02. Unity's paired "removed + added" component overrides do not apply, because Modoki has
   one trait per type, #2014 G1–G3.)
4. **Save writes the list. It does not diff the live tree.** So load → save is verbatim, and the
   prefab wins every field the list does not name. A scene can beat its prefab only with a record.
5. **Identity is minted once and never guessed.** Only a write mints identity; a reader never does.
   A reader may DERIVE identity deterministically from what the file already states (the existing
   pin → template → derived order). It never mints a fresh one (hub refinement, 2026-10-02, #2006).
   A document with duplicate identifiers is refused (I5, #1937).
6. **Nested prefabs: the outer layer wins, field by field.** Restructuring a prefab instance
   (moving or reordering what the prefab supplies) is refused, as in Unity (I1, U7, U29).
7. **When a prefab file changes, every instance rebuilds from the new file plus its own list.**
   This covers Apply, an outside edit and a git pull. Overrides survive. A record whose target is
   gone is kept, and comes back if the target returns (I9, F5). **Remove Unused** removes only
   records whose target is gone from a prefab that is loaded and intact. A record waiting on a
   missing or damaged prefab, or on a component type not yet registered, is not unused (rule 9).
   **Nodes the user added are scene content, never overrides:** Remove Unused, Detach and unpack
   never delete them. A node held under a gone anchor is re-homed under the instance root when
   the instance is unpacked (hub refinement, 2026-10-02, from the #2001 design review).
8. **Undo restores the exact list, and the prefab document, that it found.** It works in memory;
   files change on Save (#1868). It never re-derives anything from the live tree.
9. **A missing or damaged prefab: the instance keeps its list untouched.** It shows an empty
   Missing Prefab placeholder, as in Unity, and Save writes the list back verbatim. The overrides
   come back when the prefab does. An edit the list cannot hold is refused (I18, I21). There is
   **no copy of the prefab in the scene**: existing `embeddedPrefabs` still load, but are no longer
   written (owner, 2026-10-02).
10. **One door per operation.** The human and the agent call the same function and get the same
    refusals.
11. **Only the authored world is saved.** Play mode and posed states are never written (I13).

**Format rule (owner, 2026-10-02):** older override forms are converted on load and never written
again. These are the localId channels, path-keyed `nestedOverrides`/`nestedStructure`, `moved` and
legacy pins. There is one in-memory form and one writer.
A legacy record is converted when its target can be NAMED. One that cannot be named is held verbatim,
written back, and converted on the first save after it becomes nameable (hub refinement, 2026-10-02,
#2001 and #2006). A record cannot be named when its value is unparseable (the S3 / F-CB1(a) rule), when
its instance's prefab (or the nested prefab its path runs through) is missing or damaged (rule 9), or
when its localId names no row of a present document. That last kind's target is gone (rule 7): it
counts as unused, and Remove Unused may clear it, since I4 never reuses a localId. The one visible
exception: a node added under such a localId is re-anchored at the instance root, as today, so a
converted scene shows exactly what it showed before. That applies to the legacy localId case only; a
gone nodeGuid anchor keeps B′.

| Rule | Built today? |
|---|---|
| 1, 3, 5, 6, 10, 11 | Yes. These rules restate existing rulings. |
| 7, 8 | Mostly. They hold, but through live-tree re-derivations that rule 2 replaces. |
| 2, 4, 9, format | **No.** This is #2001's design. |

## Model and invariants

This section states the rules every prefab operation must obey, and names the function that owns
each rule today. It was recovered from the code for #1683 (2026-09-28). The incident sections
further down are cases of these rules being broken, and each one is tagged with the rule it
illustrates. If this section and the code disagree, the code is right and this section is stale:
fix it in the same change.

The design is Unity's. An instance is a reference to a template plus the edits it makes on top.
Every operation depends on three things: what an instance is compared against (its **effective
base**), which live entity is which template node (**identity**), and how a template write reaches
the live instances (**propagation**). The rules below are grouped by those three.

### Entities

| Entity | What it is | Defined in |
|---|---|---|
| **Template** | A `.prefab.json` document (`PrefabFile`): rows, `rootLocalId`, the localId high-water mark `nextLocalId` (v8), an optional document-level `moved`. | `editor/scene/prefab.ts` |
| **Row** | One node of a template. `localId` is its array key; a number is never handed out twice, because a new row takes one at or above the document's `nextLocalId` (v8, #1774). `nodeGuid` (v5) is its minted identity, never reused. | `PrefabEntity`, same file |
| **Reference row** | A row with `prefab` set: a nested instance of a child template. It holds edits to the child: `overrides`, `added`, `removed`, `removedTraits`, `members`, and the path-keyed `nestedOverrides` / `nestedStructure` that pass edits to frames deeper down. | same |
| **Instance, frame** | One live expansion of one template: a root plus its members, each stamped with `PrefabInstance` (`source`, `localId`, `nodeGuid`, `rootInstanceId`). A nested instance is a frame inside a frame. | `runtime/traits/PrefabInstance.ts` |
| **Stored root / owned root** | A stored root is a frame root a file stores: a scene's top-level instance, or a reference node something added. An owned root is one a reference row expanded. It carries `parentLocalId` and `parentNodeGuid`, plus `ownerGuid` once it is moved. | `isStoredRoot`, `isOwnedRoot` (`runtime/core/assetRefRules.ts`) |
| **Layer** | One source of edits to a frame. From the inside out: the template; each **enclosing layer** (the reference rows above the frame, or the template reference node that spawned it); and the instance's **own edits**, which its scene entry stores. The outer layer wins field by field. A layer that addresses a nested path owns that frame's three structure lists. The format rules are in [prefab-structural-overrides.md](./prefab-structural-overrides.md). | the folds in `runtime/loaders/prefabOverrides.ts` (`descendStructureLayers`, `foldStructureLayers`, `descendNestedOverrides`, `mergeOverrideMaps`) |
| **Effective base** | What a frame shows when it has no edits of its own: its template, folded with every enclosing layer. | no single owner (I1) |
| **Own edits** | The live frame minus its effective base. It is what the save writes, the override list shows, Apply can write into the template, and Revert can undo. | |
| **Added node** | A subtree that an instance or a layer adds (`AddedEntity`). It is a plain node or a reference node (`prefab` set). A template names it by a template `key` (`runtime/core/templateIdentity.ts`), a scene by its guid. | `AddedEntity` (`runtime/loaders/loadSceneFile.ts`) |
| **Member row** | Scene v16 and later: one member's edits and its pinned guid, keyed by a chain of `nodeGuid`s. | `memberRowsIn` (`runtime/core/ecs/memberRows.ts`) |
| **Member guid** | A member's `EntityAttributes.guid`: the member row's pin, else the template's, else derived from its anchor through identity parents. | `deriveInstanceMemberGuids` (`runtime/loaders/loadSceneFile.ts`) |
| **Identity parent** | Where an entity sits in its TEMPLATE, as opposed to where it hangs live. A move (#1437) separates the two. | `worldIdentityParents` (`runtime/core/ecs/identityParents.ts`) |
| **Frame record** | Per world, the document each frame root was actually expanded from. | `noteFrameDoc`, `frameRootDoc` (same file) |
| **The two caches** | The editor cache is read synchronously by capture, the save and Apply. The runtime cache is refcounted, read by spawners, and keeps a per-key revision. ⚠️ `getCachedPrefab` takes a GUID. Given an asset path, it resolves it through `resolveRef`, which logs `[assetManifest] path reference no longer supported` as an ERROR and returns nothing. A verification probe that reads the runtime cache by path produces that line itself, and `modoki_diagnose` goes `ok:false` over it. That is how #1801 was filed as an engine bug. Probe by GUID. | `getCachedPrefabSync` (`prefabCache.ts`); `getCachedPrefab`, `getPrefabRevision` (`runtime/loaders/meshTemplateCache.ts`) |
| **Promotion** | Apply turning a node the scene added into a template row. | `insertAddedSubtree` |
| **Override mark** | A runtime flag on a field that makes a value difference count as an edit. It does not record which layer set the value. | `runtime/loaders/overrideMarks.ts` |

### Invariants

**Owner** is the function that answers the rule today. **Bypassed by** lists the places that
answer the same question for themselves. Each place in that column is a place the rule can break.

#### Effective base

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I1 | A frame's effective base is its template folded with every enclosing layer, from the outside in, the same way at every depth. A layer can carry every edit an instance can. | Runtime: the walk in `instantiatePrefabIntoWorld`, built from the shared folds. **Editor, comparison side: `frameBase` / `chainLayer` (`editor/scene/prefabBase.ts`, #1693)** — one fold (`foldPath`) with the same folds, in the editor expansion's order: a row's fields under the outer layer's forwarded ones, then every layer's member rows over both. **The step itself is shared since #1707** (`foldRowStep` / `foldPath`, `runtime/loaders/prefabOverrides.ts`): the validator and the UIEntries pool (`effectivePrefab*Traits`) compose each nested row with it too. It climbs by `ownerOf` and through a template reference node (#1506), and reads every level's document from its frame record (I3). | **One expansion since #1783:** the editor's `instantiatePrefab` calls `instantiatePrefabIntoWorld` with its own cache (`expand.read`, which holds a parked document, #1868) and, from a rebuild, the forward state (`expand.layers`, folded at nested rows only), and a reference node has one spawner (`spawnReferenceNode`). Until then the editor carried its own copy of the walk, and #1707 found it dropping both of a frame's moves at the nested-row apply: a slot's `moved` (a pre-v5 member moved inside a scene-added reference node went back to its row on every rebuild), and the member rows, so a member moved out from under a member the same frame removes was deleted with it. `engine/tests/editor/expansionTwinParity.test.ts` pinned the two against each other through the unification, and still compares the editor's callers of the walk with the load: the reference-node path through `applyStructureByRootInstance`, and the rebuild's forward state. **One step, one carrier, one lookup since #1880 lane F (2026-09-30):** the spawner's nested rows call `foldRowStep` too (F2; its inline twin is gone, and T3's oracle holds both readers); a layer's own `values`/`valuePaths` are the only carrier of legacy nested values (F1; the merged `nestedOverrides` handed down beside the layers is gone); "the nodes inside a node" is one channel set, `nodeChannels`/`mapNodeChannels` (F3b); and "the row at localId N" is `rowAt` (`runtime/core/prefabRowAt.ts`), the LAST row as the spawner keeps it, with a repeated template key naming neither node (F3c; `tests/architecture/rowLookupCensus.test.ts` refuses a raw lookup). `effectivePrefab*Traits` still model neither a structural `removed` of the member nor an `added` node. The pose base of an applied nested move (`docChainLayer`), and `referenceRootPose`, fold one level. |
| I2 | Every "is this the instance's own edit?" question compares the live frame with its effective base. That covers the override list, the Inspector highlight, the save, the rebuild's capture, Apply's keys and write, and Revert. Every own edit found has one key, and the listing, Apply and Revert all handle it. A scene instance's root records its `sortOrder` whatever it equals (#1914 R6, F7: § "A scene instance's root always records its place"). | `frameBase`'s layer: through `instanceBase` / `enclosingRowOverrides` (fields) and `ownInstanceStructure` / `layerAuthoredStructureKeys` (structure) for the override list, the Inspector, Apply's structure refusal, and Revert; through `chainSlots` for Apply's targets and U13 (#1693); through `chainLayer` for the save (`captureNestedChannels`) — and so for the rebuild, which loads what the save states (#1880 F6) — whose removed-components pass also measures a member against the traits the layer adds (`layerAddedTraits`, #1676). | `instanceBase` folds the layer's fields but not its `removedTraits` or `added`. **Since #1914 R1 a layer's values arrive UNRECORDED:** the load marks only what the WRITER's own layer states (a scene entry's, or in prefab edit the edited document's: `StructureLayer.own`, the `OWN_NODE` tag on the nodes it adds, `ownOverrides`), so a template row's value is the instance's base and nothing subtracts it. The save, the listing and the Inspector read one rule since #1914 R3c, `recordedOverrides` (#1717): the record, each field with its live value whatever it equals, plus a component the base does not define (taken whole) and a moved member's Transform; no value decides a record (before R3c the same set was derived as a value diff, a mark gate, and a fold of the marked fields equal to the base). A recorded field is written and listed whatever the row states, so a deliberate edit equal to the row's value stays the instance's own when the row later changes (F1; the depth ≥ 2 case #1722 recorded, and the skip it took, are gone). The nested save captures over the template with the chain folded in (`withOverridesFolded`), so a value, component or tag the row gives is base, and the by-value subtraction that followed it until R3c (`subtractChainOverrides`, and its pose settle) is gone. The moved-member question behind the Transform exemption is asked only for a Transform diff with no mark (`instanceMovedMembers` is lazy), since the Inspector recomputes on every dirty frame. |
| I3 | A frame is compared against the document it was EXPANDED from. No capture runs on a frame whose recorded rows differ from the cached ones. | The frame record, read through `levelDoc` (`prefabBase.ts`) by every level of `frameBase` / `chainLayer`, the scene save's top-level capture (`savedFrameDoc`, #1685) and its nested captures, the rebuild's readers (`expandedDocOf`) and the settle's save capture (#1693 retired the scoped `expandedFrom` map and the settle's cache swap onto it). The record also lists the nested rows its expansion could NOT expand and no layer removed (`unexpanded`, #1812): the save's removal pass (`nestedRowPresent`) and Create Prefab's refusal (`unexpandedNestedRows`) ask it whether a row was expanded, never the cache. Runtime only; it answers for a capture document holding the SAME ROWS as the record's (`rowsMeanTheSame`, not object identity: the runtime and editor caches hold separate copies of one file after any editor write), and a record no expansion wrote answers nothing, so they fall back to the cache. `framesBuiltFromOtherRows` refuses a frame whose record holds other rows, and `rebaseStaleInstances` repairs it. `rebuildInstanceFromCapture` puts a capture taken against an older document back onto the current one (Revert's undo, #1665). | The two staleness tests differ: `rowsMeanTheSame` for the refusal, `sameDocument` for the rebase. A frame with no record falls back to the current cache (`setFrameDocFallback`), and the refusal cannot judge it; every expansion path writes one (`instantiatePrefab`, Create Prefab's tag, a reattach, the loader, a carry across a world swap, an undo respawn). |

#### Identity

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I4 | A `localId` means something only together with the document it was read from. Across documents a node is named by `nodeGuid`, and translated to the `localId` of the document the frame expands NOW, where it is used. A write never hands a node a number the document it replaces used for another node, nor one an EARLIER write used and freed: a new row takes a number at or above the document's persisted high-water mark, `nextLocalId` (v8, #1774). The exception is a Replace or a rebuild over a pre-v5 document, whose numbers are its only identity and stay positional. **A nested frame's overrides survive a rebuild only while the frame expands the same prefab** (Unity drops them the same way when a nested prefab asset is swapped). Across two prefabs, an edit carries only where both documents hold the same `nodeGuid`, and every link of the frame's chain is found by identity (#1767). One difference from a reload is the rebuild's standing rule, not a translation gap: a scene-ADDED node under a dropped member is re-anchored to the frame root (§ Reconcile in `prefab-structural-overrides.md`), where a reload keeps it in the orphan row. A TEMPLATE-added node whose anchor row the document lost is placed at the root (`placedAnchor`); a whole `added` list pinned over it says it covers the node (a removed row on its key in scene form, the list's own key in template form), since the load's fold replaces only what the template anchors at the list's member (#1872; the rule and the orders that forced it are in `prefab-structural-overrides.md` § "A template-added node's edits are stored on its own row (scene v17, #1516)", the bullet "Where the loader places a chain node"). | Numbering: `planPrefabRows`, whose plan `serializePrefab` records against the file it writes. The mark: `runtime/core/localIdCounter.ts`, read by every allocator and kept from going down by `commitPrefabWrites` (§ "The localId high-water mark"). A Replace keeps every matched row's number (`replaceNumbering`, #1759). So does a REBUILD of an existing prefab from a fresh tree, Import Model and the 2D skin-rig update (`serializeRebuildOver`, #1782): it matches each node to a row by its hierarchy PATH, the names from the root down, as Unity's model importer keeps identity across a reimport (hub ruling 2026-09-29). Two same-named nodes under different parents both keep their rows, and a path two nodes share mints. A Replace matches by bare name instead (U22). Then `tagEntityTreeAsInstance` reads its numbering from that file, which `planMatchesFile` checks row by row. **Translation: `runtime/loaders/memberTranslation.ts` (#1771)**, with `docRows`, `resolveMemberChain` and `translateLocalIds`. The callers are `foldMemberRowChannels` on load, R2's `rowBackedTest` (a member-row key is chained frame by frame, #1766), the rebuild's outer carry and each nested capture's re-apply (#1767), and `toLocalIdKeys` for Apply's keys. | Four readers still spell the chain walk themselves; each chains through the frame's current document, so it is duplication, not a defect: `templateFrameKeys` (`loadSceneFile.ts`), the member-path rewrite in `memberPaths.ts`, `byRowDepth` (`prefabEdit.ts`) and the member-row size check in `sceneValidation.ts`. |
| I5 | Only a write mints identity (a `nodeGuid`, a template `key`), and it carries the existing identity wherever a real correspondence exists. A reader never mints. | `nodeGuidsFor`, the one matcher (#1691): a prefab-edit save's preserved rows, then the live `nodeGuid`, then, on a Replace only, the one old row sharing a node's name (U22). Also `addedNodeIdentity`, whose `readOnly` mode never mints. | None known. Fixed at the owner: the prefab-edit save now remembers where each session-added member was written (#1662); Create Prefab's Replace serializes against the kept id (#1686); Apply's promotion carries the promoted guids (#1660, `carryPromotedGuids`). |
| I6 | Which frame an entity belongs to, what a frame holds, and where a member sits are decided by IDENTITY, never by the live tree. Delete, promotion, a move, Detach and the save's partition all act on the identity subtree. | `worldIdentityParents` (`ownerOf`, `parentOf`, `moved`, and `frameOf`: the frame an entity is a row of), `identitySubtree` (#1691, both in `identityParents.ts`), `memberRowsIn`, `instanceRowDomain` (the row claims, a partition), `rebuildTeardown`, `endFrames`, `planMoveUnlinks`. Apply's promotion delete, Detach, the save's partition and the scene-move refusal ask them (#1682, #1687). So does a copy: each copied node keeps its link only while the frame it is a row of is in the copy, an owned root whose owner is not (or not CONFIRMED: its owner link, when it has one, must name a copied node, and the owner's document must hold the row that expanded it) becomes an independent instance, and a member whose frame is not becomes a plain added node (`planCopyGuids`' `CopyLink`, applied by `copySnapshot` and the device `duplicate-entity` op, #1756). | `templateReferenceNode` climbs live parents, on purpose, for speed. A user Delete takes the LIVE subtree on purpose: it removes what is shown under the node (Unity's hierarchy delete), and `endFrames` unlinks a member moved out. Duplicate and paste copy the live subtree for the same reason, so a member dragged out of a copied instance is not copied (the copy saves it as removed); which of the copied nodes stay linked is decided by identity (#1756). "The members of frame R" is read as a raw `rootInstanceId` scan at several sites; for a member that field IS identity (stamped at expansion), so those are not bypasses. |
| I7 | A member's guid is the member row's pin, else the template's, else derived from its anchor through identity parents. Every place that predicts one derives it the same way. **A template-KEYED node's guid is its FRAME root's path plus its key** (#1809, owner ruling 2026-09-30, the Unity way — Unity's GlobalObjectId is the instance plus the object's own id in its file): never through the anchor it hangs under or a keyed parent, so an Apply that drops its anchor row (it re-anchors to the frame root) or a template that moves it changes no guid, and keys are unique within one prefab document — kept so at the sources (a prefab-edit copy mints; a promotion carries no key its target declares or already wrote), and a same-frame repeat a hand edit or merge brings in is reported by the prefab validator, never rewritten. **Since #1937 C-A every prefab seat admits its document:** a repeated identifier refuses it (a Damaged Prefab placeholder that keeps its overrides), and a keyless template node gets a key seeded by its document, its list, its own content and its ordinal among identical siblings — never its position, so a node inserted before it cannot take it (#1779). **Which node a key names in a frame is one index, `frameKeyIndex` (`runtime/loaders/prefabOverrides.ts`, #1937 C-A step 3):** a key two of the frame's nodes carry (any depth of `children`) names NEITHER, and the expansion's node rows, the fold's whole-list replace, the scene-copy pairing (`pairWithBase`), the load's "is this row backed" (`templateFrameNodes`) and the capture's chain matching (`subtractChainStructure`, `templateFormOf`) all ask it — before, five hand counts over different scopes and three last-wins maps disagreed, and a row on a repeated key was applied to neither node and called backed, so the first save dropped it. After admission the repeat survives only where no seat looks: a scene entry's own `added` (kept as unused now) or two documents' lists. **Two documents giving one frame a key** (#1933 L5: a node added AT a nested row under a key the nested file's own row declares there, one copied by hand between files) derive one guid, and an untouched save turned one node into the other; **the scene load and placement refuse that prefab** (`frameRepeatRefusal`, the validator's walk over the nested documents: a Damaged Prefab placeholder keeping the entry verbatim, the label cleared once a load finds the files fixed). The diff and gesture rules below then guard only a world the load did not vet (a nested file changed under a live instance). **No writer lands a document that introduces either repeat** (#1937 C-A step 6, owner ruling F-D): the editor's one write path (`commitPrefabChanges`: Apply, Create Prefab, the prefab-edit save, the agent's ops) refuses a document admission refuses or `frameRepeatRefusal` reports, and the raw `/api/write-file` refuses a `.prefab.json` declaring an identifier twice or whose expansion repeats a key, reading the nested documents through `makePrefabResolver` (422 `prefab-identifier-repeated`). Both judge the WRITTEN document's own expansion: a write of a NESTED prefab that gives a key an existing outer prefab already adds at its row lands, and the next load refuses that outer prefab — the window a rebuild's L5 skip covers (it leaves the live frame as it was). A park — an undo restoring what a file held — is not refused, and a scene is not gated (its gate is C-A step 5, parked), so a scene's damaged embedded copy is written back as it was. The save's node-by-node diff (`diffFrameAdded`) states nothing about a frame's repeated nodes and the rest node by node, so an untouched instance writes nothing (I23; before, any repeat put every anchor of the frame whole), and an edit to one of them is refused at the gesture with the reason (`repeatedTemplateKeyRefusal`, through the placeholder gate every field and component writer asks), since no row could record it. The prefab's first editor save writes that key. Accepted risk: a hand or agent edit of the node BEFORE that save re-keys it, and the scene's rows on the old key are kept as unused, never moved (`mintPersists.test.ts`). **A derivation never takes a guid another entity already holds** (#1882, 2026-09-30): it takes the first free salted seed (`anchor|path#1`, `#2`, …), so a PIN keeps its address and the NEW node moves, and the next save stores the salted guid as a row. Before, the pin yielded, and every ref to the pinned member retargeted onto the new node (Unity never retargets a reference onto a new object). Two pins on one guid (a damaged document) are both dropped and re-derived, loudly. | `deriveInstanceMemberGuids` (after `applyStoredMemberRows`) walks up, over `deriveMemberGuid` and `entityStep`. `memberPathIndex` (`runtime/core/ecs/memberHome.ts`) walks the identity tree down, and `stampDerivedMemberGuids`, `promoteOwnedRoots`, `storedMemberGuids` and the loader's move drain share it. Create Prefab's stamp renames through `reloadDerivedGuids`, the loader's coverage walked down: it also continues into a KEYED stored root, a template reference node the reload derives (#1758). `promoteOwnedRoots` deliberately stops there, because such a node under a promoted root is saved with its guid (measured, #1758). **A pin is followed by one sequence**, `deriveMemberGuidsAfterPins` (derive, `dropCollidingPins`, then settle tokens and moves), which the load and every rebuild call (#1761, #1777). The salt has one spelling, `deriveMemberGuidAvoiding` (`assetRefRules.ts`), called only by `deriveMemberGuidsOnly` around every guid held before the pass: at load the pins land first, and in a rebuild the OUTER frames' pins are live, so both see the same holders (#1882: a nested frame's rebuild saw only its own pins). The live predictors (`reloadDerivedGuids`, `promoteOwnedRoots`) salt around any guid another live entity holds; the compare sites (key recovery, `storedMemberGuids`) accept a salted derivation through `isMemberDerivation`. The keyed rule has ONE spelling, `IdentityParents.derivesFrom` (`identityParents.ts`), which every path-building walk asks; the file walk (`memberPaths.ts`) mirrors it. The rule before it (the live parent) survives only as `legacyKeyedParent` for the scene v17→v18 upgrade (`keyedGuidUpgrade`) and its `memberPaths` twin for a raw v17 file's remint. | Three sites predict guids with a walk of their own. The derivation's docblock names two: `derivedMemberPaths` (built on `memberPathRecords`, `runtime/loaders/memberPaths.ts`), and `planCopyGuids`, which since #1756 takes frame membership from the resolver's `frameOf` and duplicates only the walk loop. The other is the prefab-edit world's `editGuidAt` (a third, Apply's `liveMemberGuidRemap`, went with the applied move in #1868). **The salt (#1882) is not mirrored by the file walk**: a scene-file remint (`remintSceneEntityGuids`) carries only plain derivations. That is exact for a salted member that has a row (the save writes one for every keyed member, and the remint mints each row guid fresh), and misses only a salted member no row can hold: one of a pre-v5 template, which mints no `nodeGuid`, whose ref in the copy then keeps the original's guid. `planCopyGuids` needs no salt (the copy's anchor is fresh), nor does `editGuidAt` (the edit world holds no pins). |
| I8 | A template holds no identity of one instance: no guids, no member rows or moves, and a ref from one member to another is written as a member token. | `serializePrefab` with `templateTokenizer` and `assertNoRuntimeGuids`; `toTemplateNodes` for a promotion; `templateValueWriter` (`prefabTemplateValue.ts`, #1659) for every value Apply writes. | None known in Apply. `serializePrefab`'s `templateTokenizer` and prefab edit's `editWorldRefs` are further copies of the idea for other carriers. |

#### Change propagation

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I9 | The caches hold the current template for everything that reads them. A synchronous reader never runs over a cold cache: a miss there reads as "not a prefab". **Every seat admits what it holds** (#1937 C-A, `admitPrefabDocument`: the runtime fetch and `replaceCachedPrefab`, the editor fetch and `seatEditorEntry`, the scene-copy store, `parsePrefabBytes`, placement): a document declaring a localId, nodeGuid or template key twice is refused there, and so is one whose NESTED owner (a row expanding a prefab, or a reference node in any template list) states a channel in a shape no reader takes (#1948 F3, I18), and a keyless template node carries one minted key at every seat (I7). `prefabSeatCensus.test.ts` checks that every file asking the shape check admits — per FILE, so a second seat added to a file that already admits is the seats' own tests' to catch. A prefab write is one step: once it lands, both caches hold the written bytes under every key they use, and every live frame expanded from the old document is rebuilt or refused. | Warming: `installEditorPrefabCacheWarm` (before a scene swap) and `instantiatePrefabInstance`, with `preloadNestedPrefabs` / `preloadNestedPrefabsForSubtree` at the call sites. **The write step: `commitPrefabWrite(source, doc, { expected })`** (`editor/scene/prefabCommit.ts`, #1692). It is the only function that changes a `.prefab.json`. Once the write lands it seats the editor cache under the guid, the path and the caller's ref, and the runtime cache under the resolved path. Then it runs the caller's own `rebuild` (Apply's refresh, Create Prefab's tag), then `rebaseStaleInstances({ sources })` for every other frame of the source. Every writer goes through it: Apply, the prefab-edit save, Create Prefab (and a create's redo of a deleted file), the agent `create`, the skin rig, the model regenerate, the Assets model import, and Save's flush of a parked prefab. Since #1868 no undo or redo of a prefab write writes: it restores in memory and parks (§ Undo changes memory, Save writes files). **Several files are one step too** (`commitPrefabWrites`, for an Apply that writes an inner prefab and its enclosing one, #1693/U13). Every file's precondition is checked before any is written. Each file is then written only over the bytes checked. A miss part-way puts back what was already written, and names the file that missed (`failed`) and any file it could not put back (`stranded`); both refusals word themselves from those (#1732). Then both caches for each file, one rebuild and one rebase. | No writer. **An outside edit** reaches the editor as a watcher event (except under a PARKED prefab, which keeps its park, § Undo changes memory, Save writes files): the watcher re-imports it in place since #1873 R1 (both caches replaced, every frame rebased, `reimportOutsidePrefabChanges`; a key nothing live uses stays cold, and an editor write landing during the read is kept); before, the hot reload evicted the runtime cache, refreshed the editor cache, reloaded, then rebased; leaving prefab edit refreshes that one and rebases (`repairLeftPrefabEdit`, #1666). ⚠️ The commit seats the open prefab's entry too: a first version skipped it so the edit's save kept its baseline, and its own rebase then put the instances an Apply had just refreshed back onto the old document (close-out review). The edit session keeps its OWN baseline (`editBaselineFor`, § Prefab edit mode). **A server route's own move** is marked as the editor's own, so no watcher event runs: the client adopts it instead (§ "A server-side prefab move brings the client along", #1751). **A delete** (the Assets panel, the agent's `/api/delete-asset` through its renderer repair) is marked as the editor's own too, and evicts the EDITOR cache in the one repair every door runs, `applyAssetPathMoves`' delete branch (`evictDeletedEditorPrefabs`, #1805). A file or a whole folder is evicted: the path key, a guid key the manifest still maps there, and the guid of a document held under one of those. Before it, the editor cache kept answering after the trash while a world swap's re-fetch 404'd in the loader's, and an instantiate expanded a prefab that no longer existed. Live instances stay EXPANDED: that is #1738's evicted state, where every writer captures from the frame record (I18), so a save writes what the reload's Missing Prefab placeholder reads back. **The loader's entry is evicted in the same branch** (`evictDeletedPrefabs`, #1834), by path and every key under a deleted folder, keeping the scene's ownership. It was held back until #1819 landed: evicted, every reload after a trash gives placeholders, and an undo run against a placeholder was #1819's open class (the #1789 fuzzer's seeds 1 and 8); that undo now REFUSES by ruling R (`require`). It was built and backed out once more (hub ruling (B), 2026-09-29), on a diagnosis that the Apply's in-place rebuild dropped a trashed NESTED prefab's live members (hunt seed 6191). Traced, that seed was ruling R inside one fuzzer `undo` op (the Apply's undo reloads, the next undo in the op refuses) judged before its taint, a harness gap; but the in-place drop was real too (37 rebuilds in a 300-seed hunt tore down a nested frame they could not re-expand, invisible to the fuzzer because the save writes the frame's record either way). So an in-place rebuild now KEEPS such a nested frame (#1862, § Unity parity U9b), and the eviction went back in. Before it, a reload of the SAME scene (which acquires before it releases) re-expanded the deleted prefab from the stale entry, where a cold start shows the placeholder. A delete is not undoable (#1868, owner ruling D2): a file put back from the OS Trash is an outside write, which the watcher raises (the hot reload evicts, which forgets a remembered 404, and reloads a scene that uses it). The EDITOR side does not come back from the loader either: the delete tombstones what it evicted, plus every guid the manifest maps into the deleted range (`editorPrefabDeleted`), and a swap's warm (`warmEditorPrefabCacheFor`) reads a tombstoned key from disk instead of seeding it from the loader. That read is a 404 while the file is gone, and the document once it is back (or, where the manifest still maps the guid to the path and a new file took it, that file's, as the loader gave before); seating a document under the guid clears its tombstone. Before the tombstone, the first reload after a delete put the deleted prefab back in the editor cache (close-out review). **The pruned-manifest window is closed** (#1834, found through #1866): the dev editor's pruning manifest load (`createEditor.tsx`, Vite's `asset-manifest-updated`, which the delete's inline rescan broadcasts BEFORE the renderer repair runs) used to leave nothing to trace a prefab held under its guid alone to the deleted path, so the trashed document stayed readable under its guid. The prune now remembers each pruned guid's last path (`lastKnownPathOf`, `assetManifest.ts`), and the repair resolves a guid key through it. A packaged editor's IPC update is additive, so the guid still mapped there anyway. **Only a prefab DOCUMENT enters either cache** (`isPrefabDocument`, an object whose `entities` is an array of rows, #1813): it is asked by the loader's fetch, `replaceCachedPrefab`, the editor's fetch, and the editor cache's one seat `seatEditorEntry`. A file without that shape reads as a prefab that did not load (I18's placeholder), never as an empty document, which would expand to no root (#1768). The ~53 `.entities` readers then assume the shape. |
| I10 | A write over content the caller did not read is conditional, and a write that does not land changes nothing. A read that began before a write cannot put the older bytes back. | `commitPrefabWrite`'s `expected`, required on every write (#1692). It is one of three things. A document the caller READ is matched by the editor's serialization of it, and when that is refused, by the file re-read and parsed as every reader parses it, then written with `ifMatch` on those bytes; so a hand-formatted, CRLF or BOM file still counts as the document read. Raw bytes are matched as they are. `null` means nothing may be there (`createOnly`). A trash carries `ifMatch` on `/api/delete-asset` (#1679). An undo or redo of a prefab write writes nothing since #1868; its precondition is asked of memory (`prefabRestoreRefusal`), and Save's flush of the park is conditional on the file's own baseline, with Overwrite/Cancel on a conflict. `getPrefabSource` carries the runtime cache's revision token across its fetch (#1669), and so does every other read-side seed: a placement and the prefab edit-open refuse when a write landed since their read (`capturePrefabRead`, #1752, § A read-side seed carries its read's token). The runtime cache refuses a stale in-flight fetch (#863). | One deliberate unconditional write: the prefab-edit save's **Overwrite**, after the conflict was shown to the human (or an agent's explicit `overwrite:true`). |
| I11 | An operation that awaits between its steps lands whole, in the world it began in. | `beginWorldSwitch` / `prepareWorldSwitch`, which wait for what holds the world: an undo step (#1579), and a world-bound operation (`beginWorldBoundOperation`, #1667). The forward Apply holds it from its first line to its undo entry and refuses to start during a switch. Every `commitPrefabWrite` holds it from its write to its rebase. Nothing reachable from a write's rebuild may start a switch, or the two would wait on each other (`prefabCommit.test.ts` counts it). | A world swap that bypasses `beginWorldSwitch` (a hot reload) is read from #1698's adoption record instead. A write starts only once `adoptionsSettled()`, as does the forward Apply. After the write, a route mid-adoption (`pendingAdoptions()`) or a replaced world means it seats the caches and rebuilds nothing, since the new world's load builds from them. |

#### The rest of the model

| # | Rule | Owner |
|---|---|---|
| I12 | A runtime-generated (`Transient`) subtree is never authoring input. | `collectTransientSubtreeIds` / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`); `authoringEntitiesFor` for Create Prefab. See § "Authoring scope — a runtime instance is not authoring input". |
| I13 | Only an authored world (stopped, with nothing posed) is captured or written. | `whyWorldNotAuthored` (`editor/scene/authoredWorld.ts`). |
| I14 | An entity is saved into exactly one scene file, the one its `sourceScene` names, and a rebuild keeps that. | `serializeScene`'s scene filter, `planReparent`, and the rebuild (`rebuildFromEntry`), which carries the stamp. |
| I15 | A template's `version` is the writer's constant, and a build never overwrites a file written in a newer format. | `PREFAB_FORMAT_VERSION`, `engine/plugins/prefabWriteGuard.ts`, `classifyExistingDocumentId`, which reads a prefab before answering `known` even when the manifest indexes it (#1678, `docs/format-versioning.md`). |
| I16 | A template never contains itself. | The prefab-edit refusal at every gesture (`prefabEditRefusal.ts`, § Prefab edit mode); `wouldCreateCycle` / `expandedPrefabRefs` (member rows included) over the WHOLE document, when writing: in `serializePrefab`, and again at `commitPrefabWrites`, the one door every editor prefab write passes (Apply's plan included), reading the batch's own documents first, then the editor cache, then the document the live world last EXPANDED each prefab from (`prefabNestingReader`, #1866): a prefab trashed mid-session is in no cache (#1805, #1834), and read as nesting nothing, an Apply promoting a live instance of trashed P into Q (which P nests) wrote Q → P → Q, which surfaced as "P nests itself" once P was restored (hunt seed 6031; with the manifest pruned the plan's own check had caught it only through a stale guid key, the window I9 records as closed); the expansion's ancestor stack, carried through reference nodes, when loading (#1817). A file that already contains itself loads with its self-referencing node refused and named (`[loadSceneFile] cycle: prefab "…" contains itself …`), not a stack overflow (the loader's and the editor's callers both tested). The write check refuses to save such a document, so its repair is deleting the self-reference in prefab edit and saving. |
| I17 | An editor write that changes an instance member's field RECORDS each field it left differing from the instance's base, and removes no record (#1914 R2, owner rulings F2/F3); its undo puts back the record set it found. Nothing else decides a record from values: every carrier (an undo, a relink, a copy, a scene swap) restores an exact set, and the only derivations left are the save's own structural rules, a component the base lacks and a moved member's Transform (`recordedOverrides`), plus the layers a copy or Create Prefab leaves behind (`layerFieldsLeftBehind`, document against document). A scene instance's root also records its `sortOrder` always (F7, R6). | `editor/undo/overrideMarkWrites.ts`. See § "Editor writes and the override mark". Guarded since #1914 R8 by `overrideRecordNoValueCompare.test.ts` (a name check: it cannot see a raw `===` beside a mark-setter). |
| I18 | A reference the load cannot expand is written back as the file held it, until an expansion replaces it. A reader never drops what it could not interpret. | **A value in a shape no reader takes** (`removed: "x"`, a member row that is a string, `traits: 5`; #1933 S3, owner ruling F-CB1 (a)) is split off at the file boundary before anything reads the entry or reference node (`runtime/loaders/malformedChannels.ts`, shared with the scene validator, which warns; an `added` list is taken whole when a node in it is no record with a `traits` record). The expansion reads the split owner too, for an entry and for a reference node (until #1933's close-out review it read the raw one: `added: "xy"` crashed the load, and `removed: [3, "x"]` was applied although kept), and the resource walk the save and the build share reads only node-shaped values, kept with the owner's unused records, warned about once, counted, and written back where the save states nothing at its place; where the save states its own (a member's identity row, the user's delete), the save wins and the value is reported. Before, one crashed the load and the rest were dropped silently. ⚠️ The split is a SCENE owner's. A prefab document's nested owner stating such a value is refused at its seat instead (#1948 F3, hub ruling 2026-10-02: the C-A shape, as Unity rejects a malformed asset; `admitPrefabDocument`): read raw, `removed: 3` on a nested row crashed the load of every scene placing the prefab, and on a template reference node it crashed that scene's save. Its instances are Damaged Prefab placeholders, `/api/write-file` refuses it (422 `prefab-channel-malformed`), and prefab edit does not open it, so its template-form save (which writes no malformed values) never drops one (#1948 F4). The `UnresolvedPrefabRef` marker on the placeholder (`runtime/core/unresolvedPrefabRef.ts`) and its writers (`runtime/loaders/unresolvedPrefabRefs.ts`); a live frame whose document stopped resolving, its frame record (`captureDoc`); a template row a frame could not expand, the frame record's `unexpanded` list (#1812), so the row is not saved as removed once the cache holds its child; a legacy path-keyed channel no live frame reaches, R2's kept store (`keptOrphanRows.ts`); a missing prefab's document, the scene's copy (`embeddedPrefabs`, scene v19, #1867, top-level since #1935), which every save of the scene that carried it writes back verbatim until the prefab is back. See § "A missing prefab keeps its record". **Every UNUSED override too** (#1914 R4, owner ruling F5, Unity's [M6 `UnusedOverrides`]): a writer's record whose target the template no longer gives is ignored at load and written back by every save until an explicit Remove (not built). The Apply/Revert dialog states how many an instance keeps, read-only ("N unused overrides (kept)", owner ruling F6): `instanceUnusedOverrides` counts one per statement, never a row's identity, off the save's own projection (`unusedForSave`, #1938 C-B step 3: every live filter the writers apply, a kept legacy removal of a component the member carries again included, #1933 L1), and the listing carries it (`unusedOverrides`). Inside a REACHED frame, a legacy `nestedStructure` slot's records with no target (a removal, `removedTraits` or `moved` of a localId the template has since deleted) are kept like its `nestedOverrides` twin (#1933 S4) and merged into that frame's live slot before the move onto rows, which leaves that frame one whole slot (`withKeptSlots`, `keepWholeSlots`; owner ruling F-CB2 (a): that frame keeps the old file's pin, so a later template change to that nested row's lists does not reach it). The kinds, each asked of one module (`runtime/loaders/overrideFate.ts`, #1938 C-B step 1): a field no schema declares, a field recorded on a TAG (a component that became one, #1933 L2: the tag still applies) and a trait nothing registers (`unusedTraitsPart`, `fieldFate`); a removal or restore statement whose component the member's base lacks, or that this build does not register (`removalFate`: the capture never sees that component, so only the kept record carries the statement, #1933 N1) (`unusedRemovalsOf`, recorded by the fold); a legacy localId record of a row the document dropped (`unusedLegacy`, inside a reached nested frame too); a row whose member a layer UNDER the writer's removed (`isUntargetedRow`: a nested frame's node a prefab edit deleted is still in its document, so R2's document test called the row backed); and a legacy prefab-level move of a keyed node (`isKeyedMoveKey`, #1883 ruling C: every reader ignores it through `appliedMoves`, and the prefab-edit save, a template reference node and Apply carry it). The store keeps them per root guid beside R2's orphans (`keptUnusedRowsOf`, `KeptLegacy`'s localId channels). The writers merge them UNDER the capture: the scene entry (`withKeptLocalRecords`, `withKeptUnused`), a scene reference node and a template row (`captureInstanceReference`, `captureRowChannels`, behind R2's #1293 gate). A kept removal is left out once the live member carries the component again, and a kept part of any kind once the instance itself deleted its member: the delete takes the records on and under it (`withKeptUnused` writes only for a member live by `memberRowKeysIn`, the load's own index; hunt seeds 3121, 3189, 3256). The one exception is a user-added node that a member row the FILE states under the instance's own removal links: it is held, never dropped (design § 10.4b), so the load keeps that row's links as an orphan and the save writes them back (#2035). A delete in the session still takes a live node with its member. A node row (`…/a+<key>`) under the cut is not covered. A fold only SETS the untargeted mark, since the descent into a removed member's frame re-folds the same row objects (seeds 3064, 1264). A Missing Prefab node placeholder's record states its member guids, read by the same derivation rule as a live expansion's (`storedMemberGuids`), so a save does not call it equal to its template node and drop it (#1738's seed 6136). R2's orphan test reads the documents the expansion read, a scene's copies included (`runtimeReaderFor` into the load's `settleEntryRows`, as the rebuild reads its frame records): read without them, every row under a copy-expanded frame was kept as an orphan as well as applied, and once its mark was undone the save wrote the stale row back (hunt seed 1212). A legacy path-keyed channel's frame counts as reached through a copy only where the copy stood in, by the expansion's own rule (`statesUnder`, shared with `copyStandsIn`): read through every copy, a channel for a frame left unexpanded beside a copy carried for another kept only its unused sliver, and the save dropped the rest (#1914 close-out review 3). |
| I22 | A prefab reference is its DOCUMENT's guid. A path becomes a guid once, at the entry that received it (a drag payload, an agent's `{path}`, the Assets panel), spelled as the disk spells it; a reader that holds the document or a guid never re-derives identity from a path through the renderer's manifest, and nothing writes a path into `PrefabInstance.source`. | `setPrefabSource(root, doc)` (`prefabCache.ts`) for every expansion's tag: the document's guid, or the guid ref a nested expansion reached an id-less document by, and never a path; a document with no guid is refused loudly (#1828). `instanceSourceRef` (document first) for the Create Prefab tag and untag (#1807). The route (`rebuildManifestInline` before `applyMovesInRenderer`) keeps the renderer's manifest current across a move. Tests: `prefabSourceWriter.test.ts`. |
| I24 | The absence of a component this build registers no trait for is not a removal (#1933 N1, Unity's "Missing (Mono Script)"). The spawner skips such a component, so a live member lacking it says nothing about what the instance states: no save writes a removal for it, no listing offers one, and Apply refuses one that arrives anyway, so the prefab keeps data this build cannot read. Before #1938 C-B step 1 every save wrote `removedTraits` (depth 1) or `traitRemovals` (deeper) for every unregistered component (the corpus held 17 such statements on 11 instances, in sling's Base and space-console's three scenes and `spaceship.prefab`), and Apply / Apply All deleted the component from the asset. | `absenceIsRemoval` (`overrideFate.ts`) in the capture's removal diff (`captureInstanceStructure`), which every structure consumer goes through, a layer-added component included; Apply's three `-trait.` writers refuse with a reason (top level, a nested frame's override, a nested frame's own template). Checked by `unusedOverrides.test.ts` (depths 1–3, a prefab-edit save, a late registration) and the corpus's "nothing GAINED" half (`statementsGained`, `recordedListCorpus.test.ts`). | A plain entity's, a prefab row's, a scene-added node's and a TEMPLATE node's own such component is KEPT for it, verbatim, by guid (a template node's under the guid its derive gives it, recorded in the after-derive drain: the prefab-edit save rebuilds that node from the live world, and dropped it until #1948 F2; unrecorded, an untouched instance's save also stated a spurious removal of it) (`runtime/core/ecs/missingComponents.ts`, #1933 N1b, F-CB3's data half): the load records it where the spawner skips it, and the scene save, the prefab row writer (prefab-edit save, Create Prefab) and the added-node snapshot write it back; every load sets or clears each record. Not built (parked, owner ruling 2026-10-01): an Inspector "Missing component" row, and a duplicate carrying it (the original keeps it). A trait that registers after the load (HMR, game code loading late) is read as registered from then on. |
| I23 | A record no act removed is never dropped (#1914): a load→save carries an instance's recorded override list verbatim, unused records included (I18), and an op that does not act on a scene instance (a template change underneath, a prefab trash or restore, a reload) leaves every record key the scene stated. So save → reload → save is byte-identical. | The save writes the list (`recordedOverrides`, R3c) and the kept stores under it (I18); the load records only what the writer states (R1, I2). Checked by the fuzz around every record-neutral op (`prefabFuzz/checks.ts`, "I23 a record no act removed was dropped"), its save→reload→save byte check, and the corpus (`recordedListCorpus.test.ts`). |

#### Undo across worlds

The #1789 design studies proposed these three rules (§ "Undo replayed in a later world"), and #1819/#1827/#1793/#1818 built their owners on the owner's ruling R (2026-09-29: refuse, and drop the step).

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I19 | An undo or redo step re-finds every entity it recorded, meaning its target and the parent it restores under, by the guid taken while the entity was alive ([engine-concepts.md](./engine-concepts.md) § Entity, #1222). It never substitutes a raw ECS id, the scene root or any other entity. When a ref the step NEEDS no longer resolves, the step refuses as a whole, before it changes anything (`UndoRefusedError`), and `runStep` drops its entry (#310). It is never a silent no-op reported as done. A ref whose miss the step has shown to be harmless stays tolerant: Create Prefab's prior links for a held nested instance, whose guid a reload re-mints (#1272, "an unresolved ref is not a lost link" in `reattachPrefabInstance`). An entity with no guid is re-found by its raw id only in the World it was recorded in. | `require` on the entity ref (`editor/undo/entityRef.ts`): `ref.require(expect?)`, `requireWith`, `requireAll`. A step asks it for every ref it needs before its first write; the toast names the entity ("is no longer in the scene"). `resolve` stays for readers that may drop a miss (selection, `cutSourceId`, `sceneDropTarget`, #1272's prior links). A delete's undo also asks `requireRootLinks` about each instance root its members link back to, and Detach's undo `requireDetachedLinks`. `reattachPrefabInstance` no longer keeps a raw `rootInstanceId` for a root that misses. | Asked by the field-write family, add/remove, create/subtree/duplicate/paste, both deletes, reparent, the scene move, Revert, Detach, the sibling renumber (`makeSortOrderRenumberAction`), the gizmo/collider-point/UI-handle drags, the Hierarchy drop (`placePrefabFromPath`, parent by guid, resolved inside `instantiatePrefabInstance` after its awaits) and the agent `prefab instantiate`/`prefab create`, and Create Prefab's human undo (#1795's second route; since the first route's ruling it writes no file at all, and also refuses a tree rebuilt from a changed document, `createdFrameRebuiltRefusal`). |
| I20 | An undo step also acts only on the same KIND of thing it recorded. A guid names one identity across worlds, but a world swap can turn that identity into another kind of thing: an instance root into a Missing Prefab placeholder (I18), a member into a row of a placeholder's kept record (no entity at all), or a placeholder back into an instance once its prefab returns. A step whose meaning depends on the kind refuses when the kind has changed. **The kind a step expects is the one its own forward step LEFT the entity in** (and a redo expects the kind from before it), not the kind the ref saw when it was taken. | `require`'s kind check: every ref records whether its entity was a placeholder (`EntityRef.kind`), and `require` refuses a change ("is a Missing Prefab now … restore the prefab and reload the scene"). That capture kind IS what the forward step leaves, since no editor step turns an entity into a placeholder or back; only a world swap does. A step with a finer expectation passes `expect.check`: Revert's undo needs an instance root of its source, Create Prefab's (agent) undo an instance root (`isInstanceRootCheck`), Detach's undo a still-plain tree, a delete's relink an instance root. | Create Prefab's human undo (#1795's second route). |
| I21 | A placeholder takes only the edits its writer saves. The SCENE save writes a placeholder as its kept record plus the live name, guid, parent, folder, `sortOrder` and `isActive`, in BOTH scene shapes (#1901): an entry through `asSceneEntry`'s `placement` and `order`, a node the scene added inside an instance through `asAddedNode`'s `order`, in the node's own `traits.EntityAttributes`, which the reload's spawn seats (`nodeSpawnPlacement`). A node the TEMPLATE declares (a keyed node, supplied by the prefab) is written by a writer that keeps less: it is the template's, and its frame's save states nothing of it, so it takes no edit at all. ⚠️ A prefab-edit ROW placeholder's writer keeps less too (the name, and a parent only inside the edited document), and nothing asks it yet: an order, a flag, a copy's order or a move under a nested member there is shown and dropped (#1918, OBSERVED, pinned). Where the entry states either as a ROOT OVERRIDE (`overrides[<its PrefabInstance.localId>].EntityAttributes`, which is where a live instance's save puts a reordered or deactivated root), the placeholder LOADS with that value (`keepUnresolvedEntry`) and the save writes a changed one back INTO the override, never into the traits beside it, where the override would win again once the prefab re-expanded (#1850: the placeholder loaded at sortOrder 0, and `orderEntitiesForSave` moved it among its siblings on every save→reload→save). Every other edit is refused where it is made. | The placeholder gate, `placeholderWriteRefusal` (`editor/undo/placeholderGate.ts`): it asks the WRITER that will save the placeholder what it keeps (`placeholderSavedFields`: an entry or a scene-added node, `name` plus `PLACEHOLDER_PLACEMENT_FIELDS` from `runtime/loaders/unresolvedPrefabRefs.ts`; a template-keyed node, nothing), and refuses the rest with a reason. A keyed node's reparent, reorder and renumber are refused before that, as a prefab-supplied object's (#1869). Asked by `writeTraitFieldWithUndo` and its three multi-entity twins (a selection holding a placeholder refuses as a whole), `addTraitToEntitiesWithUndo`, `removeTraitFromEntitiesWithUndo`, and the agents' trait writer (`writeTraitAsEditor`, which apply-scene-ops' setTrait and the editor's set-traits share since #1816, with set-traits asking every target first in `editorTraitWriter.refusal`) and removeTrait. | **A placeholder inside an instance keeps what it shows** (owner ruling on #1901, 2026-10-01, shape 2, following #1897's "a missing nested prefab keeps its place, like Unity"; it reverses the 2026-09-29 ruling that refused a USER edit of either on a node). Whatever route puts it there (a move of itself, a move of a subtree holding it, a paste or a duplicate, an edit once inside) its save states its live `sortOrder` / `isActive` in the node's traits, so the reload spawns what was shown. So the gate lets both through on either scene shape, a move places it where it was dropped, a copy takes a fresh order (`assignFreshSortOrder`), and the Hierarchy renumbers it like any sibling. (Not a template-keyed node: its place is the prefab's, #1869, and the gate refuses every field there, a rename included, which the save dropped before #1901 too; found by #1901's close-out review.) **A LIVE node states them there too, for the placeholder a later load may spawn** (`nodePlacement`, from `captureNestedRef`): every non-default one while its prefab is missing (a trash, #1862's kept frame; #1897), and each one a ROOT OVERRIDE states while it resolves (#1901: a prefab deleted outside the editor, then a cold load). A node placeholder cannot read a root override (it has no `PrefabInstance.localId` to find one by), while a resolving node reads none of its traits, so the override still applies once the prefab returns, with the marks the live instance had. A top-level ENTRY states them in its own traits while its prefab is missing (#1895, `serializeScene`), not as a root override: a live instance's load seeds a mark for every override it applies, so the prefab's return would hold a mark the saved instance never had, while it reads nothing off a resolving root's traits but `parentId`, and the value comes from the template as before; an entry reads a root override itself (#1850). Since F7 an entry's `sortOrder` takes the override route whenever the live save wrote one (the traits skip a field the override states), and the traits route stays for `isActive` and for a record saved BEFORE F7 while its prefab was missing, which states no such override (#1914 R8 kept it for that). Since F7 (#1914 R6) every scene instance root records its `sortOrder` as a root override (§ "A scene instance's root always records its place"), so for an ENTRY the order always takes the override route: a reorder made on the placeholder survives the prefab's return. ⚠️ **Not carried past the prefab's return:** a placement made ON a placeholder that no root override states (a node's `isActive`, and an entry's `isActive` its record states no override for) is written into its own traits, which a resolving load does not read, so the root takes its template's value once the prefab is back. ⚠️ **Not stated while the prefab resolves:** an `isActive` the TEMPLATE gives a live root (no mark, no override), for either shape, so a prefab deleted outside the editor loads such a root cold active (pinned as OBSERVED in `missingPrefabPassThrough`). The ORDER half of #1916 is closed by F7: the same cold load keeps the root's place. A top-level placeholder keeps its entry's root traits (a Transform, a UI trait), so the gizmo, collider-point and UI-handle drags, which write live while they run, ask the gate at their commit (`placeholderGestureRefusal`) and put the values back when it refuses. |

### Where the owners are missing

#1683 classified the prefab bug history against these rules. Every prefab-model bug fits one of them, and none
needed a new rule. The table and the counts are on the issue, not here, because they go stale.

The bugs cluster where the table above shows no owner, or an owner that operations go around:
- **Effective base** (I1–I3). Since #1693, `frameBase` (`prefabBase.ts`) is the one answer on the comparison side: the override list, Apply's refusals, Revert, the save and the rebuild's capture all take the layer from it, every level read from its frame record. Before it, the fixes landed one surface at a time: #1386, #1401, #1498, #1492, #1506, and #1676 (the capture's removed-components pass). Apply's write followed with #1693's two-target Apply (#1658), and the expansion side is #1707 (the pure readers onto the shared step, and the twin pinned) and #1783 (the unification).
- **Propagation** (I9–I11). Owned since #1692 by `commitPrefabWrite`. Before, each writer put together write, cache and rebuild itself, and the writers that skipped a step were the bugs it absorbed: #1667, #1669, #1685, #1695 (and #1666, fixed at `loadScene`'s leave repair).
- **Identity** (I4–I8). It has real owners (`worldIdentityParents`, `memberRowsIn`, the row-claim partition), and since #1691 one identity subtree (`identitySubtree`, `frameOf`) that the sites which walked the live tree now ask (#1682, #1687). Member guids are still predicted by four walks of their own (#1324, #1339, #1430, #1461, #1660); why none moved onto the shared walk is on the follow-up issue #1691 links. Translating a saved member reference against the frame's current document has one owner since #1771 (`memberTranslation.ts`); its three copies were each handed a document the frame no longer expanded (#1766, #1767).

The verdict, the per-bug table and the proposed owners are on #1683.

- **Undo across worlds** (I19–I21) had no owner at all. #1789's harness found the routes, the two design studies
  below classified them, and the owners were built on ruling R: `require` (I19, I20) and the placeholder gate (I21).

### Undo replayed in a later world: the #1789 design studies (groups 1 and 2)

The owner ruled **study first** on 2026-09-29 (ruling A, relayed by the hub) for the #1789 clusters. This section is
the study of groups 1 and 2, as written before the fix; the ruling (R: refuse and drop) and what was built follow it
under "Built". Every route marked OBSERVED was a KNOWN_OPEN entry whose self-test failed on the tree the study was
written on: 16 entries across #1793, #1795, #1818, #1819 and #1827. The census of undo closures was read from the code.

**Why an undo meets a later world at all.** Scene history outlives a world swap on purpose (S8,
[scene-loading.md](./scene-loading.md) § "Readers of the world"):
- A save and reopen of the same scene keeps it, and so does a clean reload for a prefab-file change.
- Leaving prefab edit restores the scene's parked stack.
- Play→Stop keeps the pre-Play entries.

`entityRef` exists so that an entry re-finds its target there, by guid ("a reference that should follow the same
thing", [engine-concepts.md](./engine-concepts.md) § Entity). What nothing checks is what the guid resolves TO in the
new world, or what the step does when it resolves to nothing.

#### Group 1: an undo against a Missing Prefab placeholder (#1819, #1795's second route, #1818)

**Mechanism.** A prefab is deleted while an instance of it is in the scene. The next world swap (leaving prefab edit,
or a reload) expands that instance as a placeholder (I18). An undo recorded against the instance then runs anyway:
- **(1a)** its target's guid resolves to the placeholder, a different kind of entity (I20); or
- **(1b)** its target was a member, which the placeholder folded into its kept record, so the guid resolves to
  nothing (I19).

#1818 is the forward half: an edit made directly on the placeholder (I21).

| Route | Issue | Ops (minimized) | What happens | Rule |
|---|---|---|---|---|
| Revert's undo | #1819, OBSERVED | revert, trashPrefab, prefabEdit, undo ×2 | `rebuildInstanceFromCapture` expands a second live instance on the placeholder's guid, and the placeholder stays (I7 duplicate guid). | I20 |
| Delete's undo | #1819, OBSERVED | trashPrefab, delete, prefabEdit, undo | The respawned members point their `rootInstanceId` at the placeholder, which has no `PrefabInstance`. The next reload drops them (I6). | I20 |
| Delete's undo, of a node under a member | #1819, OBSERVED | delete, trashPrefab, prefabEdit | The parent resolves to nothing, so the node respawns at the scene root, unlinked. The walk's scene holds it top-level with an empty `parentId`, not the placeholder's guid. | I19 |
| A field edit's undo | #1819, OBSERVED | editField, trashPrefab, prefabEdit | The target misses, and the closure returns and reports success. The kept record still holds the edited value. | I19 |
| Add Component's and Add Child's undo | #1819, OBSERVED | addComponent or addChild, trashPrefab, prefabEdit | The same: the component or child stays in the kept record. Remove Component goes the same way, by reading. | I19 |
| Instantiate's or Paste's undo, under a member | #1819, OBSERVED as #1827's first KNOWN_OPEN entry | removeComponent, instantiate, apply, undo (set-up), then instantiate under an entity, trashPrefab, prefabEdit | The drop's guid misses, so the undo falls to the raw id (group 2), and the drop stays in the kept record. | I19 |
| Create Prefab's undo | #1795 second route, OBSERVED | trashPrefab, prefabEdit, createPrefab, prefabEdit | It trashes the new file although the scene still names it, and relinks nothing ("N prefab links … could not be put back"). In two seeds it re-adds the root's old `PrefabInstance` onto the placeholder. | I20 |
| Detach's undo | by reading, low reach | none | `reattachPrefabInstance` finds each link by guid, so a root that became a placeholder gets `PrefabInstance` put back on it. A detached tree is plain, so a swap alone cannot make it a placeholder: it takes a later Create Prefab over the tree, that prefab trashed, and undo past both. | I20 |
| Add Component on the placeholder itself | #1818, OBSERVED | trashPrefab, prefabEdit, addComponent | It shows in the Inspector, and the save writes the kept record without it. A field edit and Remove Component go the same way, by reading. | I21 |
| Duplicate, Paste or reorder beside the placeholder | #1818, OBSERVED | trashPrefab, prefabEdit, duplicate | The placeholder's new `sortOrder` is dropped: the placement carries only parent and folder. | I21 |
| Activate on the placeholder | by reading, not filed | none | `isActive` is written from the record, so a toggle is dropped. | I21 |

**Undoing the delete does not get the user out.** The Assets delete is itself on the stack, above the scene's entries.
In the Revert route, the undo that meets the placeholder is the SECOND one: the first restores the file.
- **Observed by splitting that op's two undos:** the first passes, and the second fails.
- **Why:** restoring a prefab file does not re-expand its placeholders. Only a reload or a rebuild does (§ "A missing
  prefab keeps its record"). So a user who undoes in order still sends the scene's older entries into the placeholder.
- **A harness limit, for anyone re-running this:** the harness's delete undo passes a no-op `refresh`. So its reload
  after the restore still loads a placeholder. That says nothing about the editor. There, Vite dev's
  `asset-manifest-updated` push replaces the manifest; the packaged editor's IPC push adds to it, as the harness does.

**What the harness's own gaps do to these routes.**
- **The manifest.** The fuzzer backend returns its rebuilt manifest instead of pushing it before the reply, as
  `/api/delete-asset` and `/api/move-file` do. Its watcher flush then loads the manifest ADDITIVELY, as the packaged
  editor's IPC push does, so a trashed prefab's guid stays mapped to its emptied path for the rest of the run. Only Vite
  dev (`asset-manifest-updated`, with `prune`) removes it. For the routes above this does not matter: the reload after
  a trash either fetches the path and gets a 404 or finds no path, and both leave a placeholder. **One route needs a
  real-editor confirmation:** the #1793 entry that carries a trash re-places its drops by path. If a dropped prefab
  nests the trashed one, the nested reference plausibly expands live in the harness (guid still mapped, document still
  cached) and as a placeholder in Vite dev. Re-running the self-tests with a pruning flush settles it. The
  restore-then-reload variant above is harness-only too.
- **#1805** (work-ai) now evicts only the EDITOR cache on a delete. Evicting the loader cache as well made trash →
  reload → undo reach #1819 and #1795 in more seeds. That half was deferred to #1834, blocked on group 1's fix, and
  landed after it (the loader evicts too, and an undo's restore refetches). So the repros cited here are unchanged. With #1805, #1818's two entries and #1820 also fail a stricter check:
  put the trashed prefab back, reload, and require identity. So an edit made on a placeholder is VISIBLY lost once
  the prefab returns.

**Bug history against I18–I21 and the undo rules.**

| Issue | Rule | Fix |
|---|---|---|
| #1699, #1738 | I18: a writer drops what it could not read | OWNER (the marker and its writers) |
| #1762, #1763 | I18: a copy of a placeholder | OWNER (`copySnapshot`, `planCopyGuids`) |
| #1768 | I18: a document that expands to no root | OWNER (`expandsToRoot`) |
| #1409 | S8: an undo replayed onto a world it does not describe, after a discard | OWNER (the history drop rule) |
| #1579 | I11 / S9: a world swap inside a running step | OWNER (`beginWorldSwitch`) |
| #1664 (and #1710 for asset documents) | The FILE side of this question: an undo replayed over a file changed since | OWNER: refused with `UndoRefusedError`, the precedent R follows |
| #1665 | I3: Revert's undo rebuilt from the document the Revert read | OWNER: the undo is carried onto the CURRENT document (`rebuildInstanceFromCapture`, `rebuildFrameFromSide` since #1880 F7d), and it refused only a stale nested frame — a refusal F7d removed, since the side states that frame as built. |
| #1353 | I20 at load: a reference, by raw id or by guid, resolved to the pass-1 placeholder instead of the instance root | LOCAL (pass 2 detaches and re-points each placeholder's references, `loadSceneFile.ts`, `SceneManager.ts`) |
| #1272 | I19: Create Prefab's undo after Play→Stop missed a nested link whose member guids the reload re-derived | LOCAL |
| #1575 | S8: an Apply undo reloaded under the wrong key, in an untitled scene | LOCAL |
| #1807 (undo side only) | I19's rule for a document: Create Prefab's undo re-found its prefab by path, through a manifest an earlier undo had moved. Its manifest half belongs to group 3's study, not this one. | LOCAL (`instanceSourceRef`, the document's own guid) |
| #1819, #1795 (second route), #1818 | I20 (1a), I19 (1b), I21 | open |

Every group 1 bug fits a rule; none fits no rule.

**Verdict: missing owners. The model is not wrong.**
- The identity model holds: a guid is the right key, and I18's "a placeholder is NOT an instance" is the right
  statement.
- What is missing is the undo side of I18. An entry does not know what kind of thing it recorded (I20), and no
  function owns a miss (I19).
- The write side of I18 is missing too: nothing refuses an edit the save will drop (I21).
- **One model-level wart, stated but not fixed:** an identity folded into a kept record is not an entity. So no
  operation that addresses entities (undo, the Inspector, an agent op) can reach it. Option K below is the only one
  that removes the wart, and it costs a second implementation of every edit.

**Proposed owners:**
- **Owner `require`, a refusing resolve on the entity ref** (`editor/undo/entityRef.ts`).
  - `ref.require(expect?)` returns the live id, or throws `UndoRefusedError`. Its toast names the entity and the
    reason: "is no longer in the scene", or "is a Missing Prefab now: its prefab was deleted".
  - **The expectation is per direction, and it is the kind the forward step leaves behind** (I20), stated by the
    step that pushes the entry. It is not the kind at capture: Detach's refs and Create Prefab's are taken before the
    step changes the entity's kind, so a kind-at-capture check would refuse every ordinary Detach or Create Prefab
    undo.
  - A ref whose miss is harmless (#1272's prior links) keeps `resolve()`. So do readers that may drop a miss
    (selection, `heldEntity`).
  - Parents go through it too.
  - It absorbs every group 1 undo route and all of group 2's editor sites. **It does not reach the runtime helpers**
    (`carryEntityIdFields`, `restoreRootLinks`, `relinkDetachedMembers`, called by the two deletes' undo), which
    cannot hold an editor ref. For those,
    the editor caller asks `require` about each root link before it respawns, or passes the helper a miss policy.
  - **Play→Stop is not fully unaffected.** It truncates the entries made during Play, and most pre-Play entries find
    their identity again, of the same kind. But Stop reloads the authored snapshot. That can re-derive a member guid
    (#1272's case, tolerated above), and it expands as an instance a placeholder whose prefab came back before Play.
    A pre-Play entry that expects the placeholder then refuses where today it acts.
- **Owner: the placeholder gate.**
  - One editor predicate, asked by every writer in the family (`writeTraitFieldWithUndo`,
    `writeTraitFieldMultiWithUndo`, `writeTraitFieldPerEntityWithUndo`, `writeTraitFieldsPerEntityWithUndo`), by
    `addTraitToEntitiesWithUndo` and `removeTraitFromEntitiesWithUndo`, and by the agent ops that write traits. The
    single-entity writer alone is not enough: a Transform edit on a multi-selection that includes a placeholder goes
    through `writeTraitFieldMultiWithUndo`. It is not in `traitEditPolicy.ts`, which
    is runtime-side and never sees the entity.
  - **It refuses every trait write on a placeholder EXCEPT the `EntityAttributes` fields its writer carries:**
    `name`, `parentId`, `editorFolder`, and, once added, `sortOrder` and `isActive`. The Hierarchy's rename and
    Activate go through `writeTraitFieldWithUndo`, and its folder moves, folder rename and folder delete through the
    multi-entity writers. The writer's contract already promises to keep what the Hierarchy changes.
  - Both writers carry the added fields: `asSceneEntry`'s placement for an entry, and `asAddedNode` for a node
    placeholder, which today carries only the name, the parent and identity.
  - It absorbs #1818.
- **Create Prefab's undo (#1795's second route) must ask `require` BEFORE `commitPrefabWrite` trashes the file,** as Apply's
  undo checks its precondition before it writes. Today the file goes first and the relink runs after. (Built. Since the
  first route's ruling, a create's undo writes no file at all, and `require` still comes first; see U27.)
- **Fix size:**
  - `require`: M, about 25 closures. Most are one line. Detach and Create Prefab, whose expectation differs by direction,
    are not. The design work is stating each step's expectation, the tolerant refs, the runtime helpers' miss policy
    and the toast.
  - The placeholder gate: S.
  - #1795's second route: S, riding `require`.
  - The KNOWN_OPEN entries are the per-route regressions: each self-test turns red when its route is fixed.

**The boundary with #1823's study** ([refusal-reporting.md](./refusal-reporting.md), work-qa):
- That study puts the silent `ref.resolve()` early returns under #1823, as steps that should report a shortfall.
  This study makes them refusals.
- The two agree once the order is fixed. A step asks `require` for every ref it needs BEFORE it writes anything, so
  a miss there is a refusal: nothing applied, and the entry dropped (#310).
- #1823's step report keeps what is genuinely applied in part: a miss or a failure found after something was
  written.
- If the two owners' designs still disagree on a site, the hub rules on it.

**Out of scope:**
- **#1795's first route** (the undo trashes a file that a SAVED scene names, with no swap) is its own owner fork,
  options (i) to (iii) on the issue. This study does not resolve it. (Resolved since: hub ruling (i), the undo leaves the
  file; U27.)
- **#1805** (the delete's cache eviction, work-ai) triggers these routes upstream. Fixing it closes none of them,
  because a reload expands a placeholder either way. It runs the other way too: **group 1's fix unblocks #1805's
  deferred half**, the follow-up that also evicts the runtime cache on a delete (#1834). It was held because it
  makes trash → reload → undo reach these routes more often, and landed once #1819's `require` made those undos refuse.

#### The owner decision: what an undo does when its target became a placeholder

The standing rule ([scene-loading.md](./scene-loading.md) § "Readers of the world", owner 2026-09-28): when the world
is not in a savable state, **refuse, with a notice saying why. Don't wait, and don't re-find the target in the new
world.** Unity's missing-asset documentation (`PrefabInstanceStatus.MissingAsset`, U9) states no rule for editing
such an instance, so Unity parity does not settle this.

- **R. Refuse (the pick).** The step throws `UndoRefusedError` before changing anything.
  - *Undo stack:* the entry is dropped (`runStep` pushes a refused step nowhere, #1664). The entries below it stay,
    and the next Cmd+Z undoes the step before it. An earlier entry against the same placeholder refuses too, with its
    own notice.
  - *Notice:* a toast naming the step and the entity, for example: *Can't undo "Revert prefab overrides": "HR" is a
    Missing Prefab now (its prefab was deleted). Restore the prefab and reload the scene to edit it again.* The agent's
    undo reports `refused`, with the same words (#1681).
  - *The save* writes the kept record unchanged, as it was at the swap. An ADDITIVE edit the user tried to undo (a
    field, Add Component, Add Child) stays in the record, comes back when the prefab does, and can then be removed with
    Revert Overrides.
  - *What it loses:* the refused undo, for good. For a Revert's undo, the reverted overrides are unrecoverable: no
    entry holds them, and the record does not. For a Delete's undo, a deleted template member comes back only through
    Revert Overrides once the prefab returns (the record states it as `removed`), without its per-instance overrides.
    A deleted scene-added node is unrecoverable. The
    toast's advice cannot bring the entry back, even though after a reload that re-expands the prefab the same undo
    would have worked.
  - *Refuse rule:* holds. It does not wait, it does not re-target, and it changes nothing in the world or on disk.
- **R′. Refuse, but keep the entry.** As R, except the refused entry stays on top of the stack, where `runStep` drops
  a refused step today (#310's policy, owner 2026-08-21, for every throwing step). **R′ reverses that ruling for
  this one kind of refusal.**
  - *Undo stack:* unchanged. Every Cmd+Z refuses on the same entry, so nothing older can be undone until the prefab is
    restored and the scene reloaded. Then, if the scene was saved before the reload, the kind matches again and the
    undo works. A reload over unsaved edits drops the stack (S8, #1409), and the kept entry with it.
  - *Notice:* the same toast, on every attempt.
  - *The save* writes the kept record.
  - *What it loses:* nothing, but it walls the whole scene history behind one missing prefab. A deleted prefab usually
    stays deleted.
  - *Refuse rule:* holds.
- **S. Skip.** The step does nothing but counts as done. This is today's behavior for a field edit, Add Component and
  Add Child.
  - *Undo stack:* the entry moves to the redo stack, and a redo does nothing either. The scene is marked dirty.
  - *Notice:* none.
  - *The save* writes the kept record with the edit still in it.
  - *Refuse rule:* broken. There is no notice, and the stack claims an undo that did not happen.
- **T. Re-target.** The step acts on whatever the guid or a fallback finds. This is today's behavior for Revert,
  Delete, Create Prefab and every respawn.
  - *Undo stack:* as normal.
  - *Notice:* none.
  - *The save* writes the damage: a second instance beside the placeholder, members the next reload drops, a node at
    the scene root, or a trashed file the scene names.
  - *Refuse rule:* broken. It re-finds its target in the new world.
- **K. Undo inside the kept record.** Every undo kind gets a twin that edits the record in the scene-file format: a
  field back in a member row's overrides, a child out of `added`, a component back.
  - *Undo stack:* normal.
  - *Notice:* none needed.
  - *The save* writes the record without the undone edit, which is what the user asked for.
  - *Refuse rule:* holds in letter, since the identity is the same and no entity is substituted.
  - *Cost:* a second implementation of every edit, in a format keyed by member-row chains (I4). That is a new surface
    for the very bugs #1683 classified. It is L or larger. And Revert's undo has no meaning inside a record at all,
    so it would still have to refuse.
- **D. Drop the scene's history at the swap.** S8 gains a fourth reason: an adopt that expands, as a placeholder, a
  reference the outgoing world held as a live instance drops the stack. Asset-file entries survive, so the Assets
  delete stays undoable.
  - *Undo stack:* empty after the swap, apart from asset entries.
  - *Notice:* one is needed, such as *Undo history cleared: the prefab of "HR" is missing.*
  - *The save* writes the kept record.
  - *Refuse rule:* holds.
  - *Costs:* it throws away every unrelated entry in the scene because of one missing prefab. That is the cost that
    got the global "frames rebuilt" epoch reverted (§ "Readers of the world"). It also sees only swaps: a rebuild
    that respawns a node placeholder under an Apply (`spawnUnresolvedReference`) has no swap.

**Pick: R.**
- It is the standing rule, applied to one more reader.
- It is the shape #1664 and #1710 already give the FILE side of the same question, and the one the editor's own cut
  and drop targets give an entity ("Refuse, never re-target", `cutSourceId` and `sceneDropTarget` in
  `entityActions.ts`).
- It changes nothing in the world or on disk, and one owner (`require`) serves both groups.
- **Its cost is real:** the refused entry is gone. R′ keeps it, at the price of walling the whole history behind a
  prefab that usually stays deleted, and by reversing #310's drop policy for this refusal. That trade is the one
  thing in this pick worth the owner's second look.
- K is the only option that does exactly what the user meant. It is not worth a second implementation of every edit
  for a state that needs an in-use prefab to be deleted.

The forward edits (#1818) follow from the pick: an edit the save would drop is refused where it is made (the placeholder gate). The
Hierarchy's placement edits (a reorder, Activate) are saved instead, because the writer's documented contract already
promises to keep what the Hierarchy changes.

**The same question arises in group 2.** #1793's fork, a parent that no longer resolves (scene root, or refuse?), is
this decision for a parent. R answers it: refuse. The agent `prefab instantiate` redo's fallback to the root changes
with it.

#### Group 2: an undo that falls back to a raw ECS id (#1827, #1793's redo half)

**Mechanism.** Some closures keep the entity's raw ECS id beside its guid, and use the id when the guid misses.
After a world swap, ids are handed out again in file order ("a stale entity id does not fail in a new world",
§ "Readers of the world"). So the id names whatever entity holds it now, and the step acts on that entity.

The key is already settled: the owner ruled on #1222 (2026-09-15, [engine-concepts.md](./engine-concepts.md) § Entity)
that an undo crosses a boundary and holds the guid. `entityRef` implements that ruling: a ref with a guid never falls
back. These sites add a fallback of their own on top of it.

| Site | Holds | On a miss | Status |
|---|---|---|---|
| `makePrefabInstantiateAction`'s undo | a ref and its `rawId` | `remove(resolve() ?? rawId)` deletes whatever holds that id | OBSERVED (#1827; also with no trash, hunt seed 5192) |
| `pasteEntityCopy`'s undo | the guid and the raw `currentId` | falls to `currentId` when an entity holds it, then deletes it | OBSERVED (#1827: it deleted another placeholder) |
| The undo of `createEntityWithUndo`, `createEntitySubtreeWithUndo` and `duplicateEntity` | the same | the same | by reading (#1827) |
| `placePrefabFromPath`'s redo (the Hierarchy drop) | the raw `parentId` | respawns under whatever holds that id. A dead id that the instance's own spawn recycles parents the instance under itself, and the redo overflows the stack. | OBSERVED (#1793, five routes) |
| The Hierarchy's sibling renumber (`makeSortOrderRenumberAction`) | raw ids | writes `sortOrder` and its mark onto whatever holds each id | by reading, **not filed**: the harness does not drive a drop that renumbers siblings |
| `reattachPrefabInstance` (the undo of Detach and Create Prefab) | a root ref and the raw `rootInstanceId` | a root that misses keeps the raw `rootInstanceId` | by reading, **not filed** |
| `respawnFromSnapshot` → `carryEntityIdFields`, in both deletes' undo | the snapshot's raw `rootInstanceId` | a member deleted as its own target keeps its raw `rootInstanceId` when `restoreRootLinks` misses its root's guid. Duplicate and paste cannot carry one: `copySnapshot` leaves no `rootInstanceId` outside the copy. | by reading, **not filed**; `carryEntityIdFields` and `restoreRootLinks` are runtime-side, so `require` reaches them only through the editor caller |
| Every respawn's `parentRef?.resolve() ?? 0`, and the agent instantiate redo | a guid | the scene root | #1819's route above; the owner decision |

**Precedents that already follow the rule:**
- The agent path fixed #1793's twin in #1223: it holds the parent by guid.
- The editor's selection holds by guid, plus a raw id tagged with its world for an entity that has no guid
  (`editor/store/heldEntity.ts`, #1221).

**Bug history.**

| Issue | Rule | Fix |
|---|---|---|
| #1221 | I19: selection by bare id | OWNER (`heldEntity`) |
| #1222 | I19: the rule table (undo holds the guid taken while the entity was alive) | OWNER |
| #1223 | I19, agent side (one resolver, a refusal, an id only without a guid) | OWNER. Its instantiate redo kept the root fallback. |
| #1229 | I19 | not planned (unreachable) |
| #1827, #1793 | I19 | open |

**Verdict: missing owner. The model is not wrong.**
- The key is settled (#1222) and implemented (`entityRef`).
- What no function owns is what a miss does, so each site invented its own fallback.
- The `require` owner fills that gap:
  - it resolves by guid only;
  - a miss refuses;
  - an entity with no guid is found by its id only in the world it was recorded in (the held-entity rule).
- **Fix size:** M, for the nine sites plus the parent fallbacks. Each gets its KNOWN_OPEN self-test as its regression:
  two #1827 entries and five #1793 entries.
- #1793's defence in depth stays as the issue states it: a liveness check where `instantiatePrefab` parents the root,
  and a visited set in the instantiate undo's subtree walk. It is a second line, not the owner. **Built** (hub,
  2026-09-29), both as LOUD refusals (`UndoRefusedError`), never silent skips:
  - `instantiatePrefab` refuses a raw parent id no live entity holds at ENTRY, before anything spawns. A check after the
    spawn alone could not catch #1793's thrown redo: its dead id was recycled by the call's own spawn, so it read as live
    there. Once the walk has run it also refuses a parent that is no longer the entity the call was handed
    (`captureEntityIdentity`), and deletes what the call spawned first.
  - It is unreachable by any current gesture; `engine/tests/editor/instantiateStaleParent.test.ts` builds each bad
    input directly (a destroyed id, an id recycled mid-spawn).
  - The undo's subtree walk and its cycle refusal are gone (#1880 T4, hunt seed 1044, 2026-09-30). The redo restores
    only the ROOT guid, minted BEFORE the members derive, so every member comes back with what a reload derives for it.
    The walk used to stamp captured member guids back by `name#siblingIndex` over members the respawn had already
    derived from a throwaway root guid. A row added between the undo and the redo whose name sorted first shifted every
    index, so only the root came back, and each member kept a guid no reload gives it. A fresh instantiate stores no
    member guid of its own, so the root guid is the instance's whole identity (Unity: undo/redo restores the same
    objects).

#### Built: ruling R (#1819, #1827, #1793, #1818; 2026-09-29)

The owner picked **R** and declined R′: an undo or redo whose target no longer resolves, or has become a Missing Prefab
placeholder, throws `UndoRefusedError` before any change, its toast names the entity, and the entry is dropped (#310).
The save writes the kept record unchanged. The owners are in the I19–I21 rows above. What the build found that the
study had not:

- **`asAddedNode` cannot carry `sortOrder` or `isActive`.** The study said both writers would carry them. A reference
  node keeps its root's order and active flag as an override on the prefab's root row, which a placeholder cannot name
  without its prefab. So the gate refuses both on a placeholder saved as a node (owner ruling: a value that holds only
  until the prefab returns is the silent loss the refuse rule exists for), and the Hierarchy renumber numbers the other
  siblings around such a placeholder rather than refusing the drop (`renumberAround`; it refuses, named, only when two
  such placeholders tie with a sibling to place between them). **Reversed by #1901** (owner ruling 2026-10-01, shape 2:
  the placeholder keeps what it shows): the node's own traits carry both, and the gate lets them through (I21).
- **The capture kind is the forward kind.** The study warned that a kind taken at capture would refuse every ordinary
  Detach and Create Prefab undo. That holds for the fine kind (instance vs plain), which those steps change. The coarse
  kind `require` checks (placeholder or not) is changed by no editor step, only by a world swap, so it is taken at
  capture; the fine expectations ride `expect.check`.
- **The placeholder check alone did not cover a delete's relink or Revert.** In the placeholder route both refuse on
  the kind first (a deleted member's parent IS the root). A root that comes back PLAIN under the same guid needs the
  finer checks, and each has its own regression (`engine/tests/editor/undoAcrossWorlds.test.ts`).
- **`deleteEntityWithUndo` captured no root links**: a member deleted on its own came back holding its dead root's raw
  id. It now runs `deleteEntitiesWithUndo` with one target.
- **A ref taken before a guid rename is required THROUGH it.** A Detach-on-move promotion renames members (#1447), and
  reparent's, delete's and Detach's undo reverse the rename only after asking for their refs; an old parent it renamed
  read as gone, and a good undo was refused (the close-out review's regression). `requireWith` takes the rename map, as
  `moveEntityToScene` already did for its rekeys. The delete's undo also relinks before it restores root links, so a
  root the rename touched is found by its original guid (no test pins that order: it needs four levels of pre-v5
  nesting and a Play→Stop; the reasoning is in the undo's comment). And Detach's "still plain" expectation holds only
  for the entities it stripped: a root outside that set (one its frame-ending promoted, or a stored root it left) must
  still be an instance root of the link's source. Both undos also require the detached members they relink
  (`requireDetachedMembers`), skipping those the undo itself respawns.
- **The Hierarchy's colliding drop is decided before it writes** (`siblingDropRefusal`, `planCollidingDrop`): a
  reparent refusal or a placeholder's reorder leaves no renumber entry behind, and only a drop INTO a span between two
  tied placeholders is refused, naming a real placeholder.
- **The fuzzer's drop op was a copy** of the Hierarchy's, still holding the raw parent id; it now calls
  `placePrefabFromPath`. Its oracle taints a segment only when a WORLD SWAP expands a placeholder, since R drops entries
  there by design; I6 and I7 are still checked at every step. With the taint off, every removed KNOWN_OPEN route ends
  in the fix's refusal rather than its original symptom, so the entries stopped because of the fix.
- **#1795's second route** was built with `require` (bbb0b370c). Since the first route's ruling (i), the create's undo
  writes no file, so the question of a partial file write there is gone.

#### Repro seeds

Each route above that is marked OBSERVED was a KNOWN_OPEN entry in `engine/tests/editor/prefabFuzz/knownOpen.ts`; the
entries for #1793, #1818, #1819 and #1827 were removed with the fix, and these replays now end in a refusal (or, for
#1818, a saved placement). These are the short ones, plus the variant that splits the Revert route's undo:

```
# #1819 Delete's undo (I6)
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"trashPrefab","u":[0.564,0,0,0,0,0,0,0]},{"kind":"delete","u":[0.686,0,0,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.99,0.9,0,0,0,0,0,0],"inner":[]},{"kind":"undo","u":[0.1,0,0,0,0,0,0,0]}]'
# #1819 Delete's undo of a node under a member (lands at the scene root)
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"delete","u":[0.62,0,0,0,0,0,0,0]},{"kind":"trashPrefab","u":[0.3,0,0,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.1,0.9,0,0,0,0,0,0],"inner":[]}]'
# #1818 Add Component on the placeholder
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"trashPrefab","u":[0.251,0,0,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.954,0.9,0,0,0,0,0,0],"inner":[]},{"kind":"addComponent","u":[0,0,0,0,0,0,0,0]}]'
# #1818 the placeholder's sortOrder
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"trashPrefab","u":[0.1,0,0,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.1,0.9,0,0,0,0,0,0],"inner":[]},{"kind":"duplicate","u":[0.15,0,0,0,0,0,0,0]}]'
# #1819 Revert's undo, split: undo 1 (the trash's undo, restoring the file) passes; undo 2 (Revert's) fails I7
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"revert","u":[0.3511497532017529,0.012670567957684398,0.46970928786322474,0.6648742232937366,0.9818382884841412,0.614271926227957,0.988015036098659,0.5841556487139314]},{"kind":"trashPrefab","u":[0.1,0,0,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.5,0.9,0,0,0,0,0,0],"inner":[]},{"kind":"undo","u":[0.1,0,0,0,0,0,0,0]},{"kind":"undo","u":[0.1,0,0,0,0,0,0,0]}]'
# #1827 with no trash (a prefab-edit save deletes the member the drop hangs under)
MODOKI_PREFAB_FUZZ_REPLAY='[{"kind":"instantiate","u":[0.1,0.5,0.2647058823529412,0,0,0,0,0]},{"kind":"delete","u":[0.1388888888888889,0,0,0,0,0,0,0]},{"kind":"createPrefab","u":[0.99,0.9,0,0,0,0,0,0]},{"kind":"instantiate","u":[0.7,0.5,0.7666666666666667,0,0,0,0,0]},{"kind":"prefabEdit","u":[0.7,0.1,0,0,0,0,0,0],"inner":[{"kind":"delete","u":[0.3,0,0,0,0,0,0,0]}]}]'
```

The longer lists are the KNOWN_OPEN entries themselves, and the hunt seeds each issue names: #1819's field edit (3020),
Add Component (5062), Add Child (5067) and Revert (1167); #1795's second route (1017, 1031, 1061, 1243); #1827
(3084); and #1793 (8, 115, 144, 159, 3093).

### A prefab named by PATH through the renderer manifest (study, #1789 group 3)

READ-ONLY study (work-ai, 2026-09-29; owner ruling A, study first). No engine code was changed. Its subject: a prefab
reference written or resolved as a PATH through the renderer's asset manifest, which lags a move (#1828, #1807), and
whether #1801 shares the mechanism.

**The invariants and their owners.**
- **M1 — `PrefabInstance.source` is the document's guid, never a path** (I22). ✅ **Built (#1828, owner ruling "Build it"):**
  `setPrefabSource` now takes the document, with no raw-path fallback. The rest of this bullet records the study's finding.
  The owner is `instanceSourceRef`, which reads
  the document's id first. It serves the Create Prefab tag and untag. The other writer, `setPrefabSource`, takes no
  document and writes `getGuidForPath(path) ?? path`: a RAW PATH whenever the lookup misses, for any reason. Its four
  callers all hold the document: `instantiatePrefabInstance` (the Hierarchy drop, the Assets and Inspector Instantiate
  buttons, their redos, the agent `instantiate`), `instantiatePrefab`'s nested rows, a template reference node's spawn, and
  `rebuildInstance` (Revert, Refresh, and the Apply and Revert undo rebuilds; `rebuildFromEntry` since #1880 F7d). **Missing owner.**
- **M2 — the renderer's manifest follows a move before the renderer's own repair runs.** The owner is the route. The real
  `/api/move-file` and `/api/delete-asset` rebuild the manifest INLINE (`rebuildManifestInline` → the host's
  `rebuildManifest`, which pushes it: Vite's ws `asset-manifest-updated`, Electron's `modoki:bridge-manifest-updated`),
  THEN call `applyMovesInRenderer` on the same channel (Vite's `requestBrowser` shares the ws), and both land before the
  HTTP reply. The 150 ms debounced push is only the watcher's second rebuild. **It holds**, with one real window: an inline
  rebuild that throws (`manifestRebuilt: false` in the reply), after which only the debounced push follows.
  A file an undo PUT BACK through `/api/write-file` (which rebuilds nothing) was the one route outside this (#1844),
  with its own restore owner; it went with #1868, when the Assets delete and import left undo. A file put back from
  the OS Trash is an outside write, which the watcher raises.
- **M3 — a path becomes a guid once, at the entry that received it**, spelled as the disk spells it (`existingAssetPath`,
  #1273, #1753 F4). The owners are the entry points (`placePrefabFromPath`, the agent ops). Partial: a redo re-reads the
  path it captured at the gesture (`prefabPlace.ts`'s respawn, the agent `instantiate`'s), which a move since may have
  made stale.

**The bug history against them.**

| Issue | What it showed | Invariant | Class |
|---|---|---|---|
| #1807 (closed) | Create Prefab's undo right after a Rename undo untagged nothing, so the tree stayed linked to a trashed prefab | M1, reached through M2's lag (its undo half is I19's rule for a document, in the group 1/2 study above) | Fixed at its site (`instanceSourceRef`, `ac5562b73`). **As filed, harness-shaped:** the lag it needs exists in the #1789 fuzzer (#1835), not in the editor, unless the inline rebuild failed |
| #1828 route 1 | The Hierarchy drop's redo wrote a raw path into `source` | M1 (`setPrefabSource`), reached through M2's lag | The same: harness-shaped as filed. The writer defect is real, and reachable by any manifest miss |
| #1828 route 2 | Apply's undo read the renamed path and refused ("changed on disk") | M2's lag only | Harness-shaped. In the editor it needs `manifestRebuilt: false`, and it REFUSES (I10), the safe direction |
| #1799 (closed) | A BOM-prefixed prefab dropped out of the manifest, and instances stored raw paths | M1, reached through a manifest miss (the scanner could not read the id) | Fixed at the scanner, not at the writer |
| #1753 F4 (closed) | The agent `create` tagged the request's case spelling, a raw path | M1 and M3 | Fixed at the entry (normalize the spelling) |
| #503 (closed) | An asset-def op refused right after `create_asset`: the renderer manifest lagged | M2 | Fixed at the delivery (the IPC push was gated off in Electron dev) |
| #1801 | A false "path reference no longer supported" after a rename | none | **Not a defect.** win found that the #1791 sweep's own probe called `getCachedPrefab(path)`, which is guid-only. Read the runtime cache by guid in a probe |

**Verdict: the model is right; one owner is missing.**
- The missing owner is M1's writer side. `setPrefabSource(root, doc, source?)` should resolve through `instanceSourceRef`
  with the document its caller already holds, with **no raw-path fallback**: a document with no guid refuses loudly,
  rather than writing a path the loader rejects. Fix size **S**: one function and four call sites, plus a guard that no
  production write of `PrefabInstance.source` bypasses `instanceSourceRef`.
- It absorbs #1828 route 1, and the writer-side symptom that #1799 and #1753 F4 each patched upstream: whatever makes the
  manifest miss (a lag, a BOM, a case spelling, a failed rebuild), the writer then cannot store a path.
- M2 needs no new owner. Its one real window is a failed inline rebuild, and the reader that meets it there (Apply's
  undo) refuses rather than corrupts.
- M3's stale redo path is covered by M1 once the writer takes the document the redo re-read.
- ✅ **Fixed (#1835):** the fuzzer backend's `rebuildManifest` now pushes the renderer's manifest before the route's repair,
  and #1828's Apply-undo route stopped reproducing. Since #1844 the push PRUNES, as the host's does. Additive, it kept a
  trashed prefab's guid resolvable, so a reload after a trash re-expanded it instead of giving a placeholder, and that
  leniency hid #1844 itself and #1849, #1850, #1851 and #1856 (hunt seeds 1–200, prune vs additive on one tree: seven
  seeds failed only under prune). The finding as the study wrote it:
- **Harness fidelity gap, not a product defect:** the fuzzer backend's `rebuildManifest` returns the manifest without
  pushing it before `applyMovesInRenderer` (#1835). Until that is fixed, the fuzzer's manifest-lag findings are harness-shaped.

**Recommendation for the owner.**
- **#1828:** downgrade it to low and re-scope it to M1's writer (`setPrefabSource`), or close it in favour of a fix issue
  for that owner. Neither of its routes exists in the editor without a failed inline rebuild, and route 2 refuses safely.
- **#1801:** close it as not a defect.
- **The comment** at `setPrefabSource` (then in `prefab.ts`, now `prefabCache.ts`) said a raw path makes `getPrefabSource` hit `resolveRef`'s hard
  rejection, which was stale: `fetchPrefabSource` sends a path to `assetUrl`. It was corrected ahead of the M1 fix, when
  #1801 closed, to say what a stored path runs into (the save writes it verbatim, and the next load's `acquirePrefab`
  rejects it). The M1 fix (#1828) then retired it: `setPrefabSource` stores no path at all, and its comment says so.

### The randomized round-trip test (#1789)

Reviews read one path at a time, but most prefab bugs live in combinations of an operation, a nesting depth, and an
interleaving with undo, save, reload or a missing file. `engine/tests/editor/prefabFuzz.test.ts` covers those combinations
mechanically:
- It runs seeded op lists through the entry points the Hierarchy, Inspector, Apply dialog, Assets panel and prefab edit call.
  ⚠️ Call the entry point itself, never a copy of its body. The drop op was a copy of the Hierarchy drop, and it went on
  holding the raw parent id after `placePrefabFromPath` stopped (#1793): the harness reproduced a bug the editor no
  longer had, and #1828's first repro reached its symptom only through that stale copy. It calls `placePrefabFromPath` now.
- Ruling R in the oracle (#1819): a segment in which a world swap expands a Missing Prefab placeholder is tainted, since
  its undos may refuse and drop by design. A same-world op that makes one (a duplicate, a paste) does not taint, unless the new placeholder took in an entity the segment had live (`rulingR` below). The walk to the ends then skips its identity checks there; the per-step I6/I7 checks
  still run.
- Everything under it is real, not stood in for: the backend router over a scratch directory, `SceneManager`'s load, both
  caches, the undo stack, and the watcher's reload handler.
- After every step it checks what can be read off a world and its files: I4, I5, I6, I7, I8, I15, I16, I18 and both
  validators.
- Every save→reload must be the identity, and a second save must write the same bytes. A rotation is compared as ONE
  value, an orientation (#1838, `alignEqualOrientations`, #1490's `sameOrientation`): the save drops a member rotation
  whose orientation equals the chain's, so the reload may spell the same turn differently (`rx: 0.283…` back as `-6`).
  It forgives what `sameOrientation` calls equal, which includes a real change under about 1e-4 rad; the second-save
  byte check still compares the numbers.
- Each run ends by undoing to the start and redoing to the end. At the start, a file a Create Prefab made may still be
  there (its undo leaves it, #1795), but only holding that create's document (its bytes, or the same document under a
  raised #1774 mark); any other content at that path is still a finding.
- The generator writes only shapes a real producer writes (#1839): an outside edit is a hand edit of a value, or a new
  plain row under a plain row as a merged editor Add Child numbers it. Never a plain row under a reference row, which no
  editor write produces and which reads as a false I7.
- **What the editor HOLDS is checked, not only the files** (#1880 T1). A third of the generated saves are Save All
  (`op.save`): every PARKED prefab (#1868) is flushed first, a conflict answered Overwrite or Cancel, and half of those
  stop at the save with no reload, as Cmd+S does, so the undo stack survives the save.
  ⚠️ The generator WRITES the variant into the op; the executor never derives it from `u`. A recorded repro carries draws
  that would otherwise select it: when it did, #1794's regressions passed with #1794's fix deleted (close-out review). The file checks (I4, I16, the validator) and a mark check
  (`checkMarks`: a document's localId mark never goes down across steps) read the files with each park laid over its
  file. #1877's 3b S1 (a restore parking a mark below what a Save wrote) was out of reach before: the scene-only save
  never landed a park, and the undo walk's file comparison deleted the mark. That comparison now forgives the mark and
  the version only going UP. The world tree carries each node's `TemplateAddedKey`, and the fixture states M.z in two
  layers through both carriers (P's row C by member row, O's row N by legacy value).
- **A rebuild is checked against a load** (#1880 T2). After the 30% of generated Applies and outside edits the generator
  marks (`op.check`), the rebuilt world must equal LOADING the scene as it stood before the op under the new template, marks included; the
  Apply's own top-level instance is left out (the Apply rewrote its statements too). The round trip cannot see a rebuild
  that drops an edit and then saves the loss consistently (#1877 S3, L4). The check reloads the scene, so the run goes on
  from the post-op scene saved and loaded back, with the undo stack reset; a recorded repro without the field keeps its
  recorded path. On the 8 verify seeds it checks ONE Apply and ONE outside edit (re-measured 2026-10-02, after #2009's
  six op kinds changed every seed's list; a third marked op was a no-op); both legs are held by hunts, which the summary
  line's counts make visible.
- **A no-op rebuild is the identity** (#1880 T4). Each run ends by rebuilding every stored instance from its own capture
  onto the document it was expanded from (`refreshInstances`, what a rebase does). The respawn form of a capture is
  pinned to the live world only by this; the save's rows form is pinned by the round trip.
- **The agent's doors, Play and the preview are fuzzed** (#2009, #2001 design § 10.2). The #2001 review's census found
  writers the fuzzer never drove (review R3), so six ops were added:
  - `agentSetTraits`, `agentInstantiate` and `agentSceneOps` call the agent ops, the last through the live
    `/api/scene-mutate` route.
  - `fileMutate` is the same route with no renderer answering. It writes the scene file, and an instance root's write
    lands in its legacy `overrides[rootLocalId]` channel (review R5).
  - `playStop` enters Play, makes up to two edits, then presses Stop.
  - `timelinePreview` is a scrub with an activation pose and a posed Transform, left by the panel's exit or by Stop.

  Leaving Play or a preview must give back the authored world it was entered from (rule 11, I13), and I23 runs around
  both. An agent edit of a posed world must be refused (rule 10). A file-direct write is an outside write: the watcher
  raises it, and it taints its segment (`agentFileWrite`).
  ⚠️ The harness's editor-write mark is keyed by the written bytes' sha1, as the host guard's is. Keyed by path, an
  op's own Save marked the scene, and the file-direct write after it in the same op was swallowed. The editor never
  reloaded, and the next save wrote the scene back without the agent's change: a loss in the harness only, which every
  check passed. A fixed list (`#2009: the agent, Play/Stop and timeline-preview doors are reached…`) holds each op
  reached, and each check fed; each was shown red on its mechanism's mutation.
  - What the hunt found (seeds 1000–1199, hub rulings 2026-10-02):
    - An agent call's composite undo half-applies when one sub's target is gone. That is #2010: a composite refuses
      whole, built in S7.
    - A pasted frame stays expanded from a pre-Apply document after its enclosing prefab is trashed (seed 1012). Left
      to S7's record-based paste.
    - #1829's partial added component also arrives through a file-direct write, since the save widens it. Fixed by
      construction in S6.
    All three are KNOWN_OPEN entries.
- **P1 and I25 against the #2001 model** (`prefabFuzz/shadow.ts`, #2009). They are written against S1's types, before
  anything implements them, so they run only once the build installs their SEAMS through `installShadow`:
  - S4 installs the store's `records`, the capture's `captureList` (`parse(captureInstanceEntry(live))`) and `doors`;
  - S5 installs `reproject`.

  I25 compares each record with the capture, modulo identity pins, and only after an op whose door exists (§ 10.5).
  Any other op is counted as "not compared (no door yet)". It refuses to compare a record with itself: a capture that
  hands back the store's own list or row is a harness error. P1 reprojects every record after every op and holds the
  world unchanged.
  ⚠️ Installing `reproject` renumbers ids between ops, so every seed's path changes from S5 on. Both checks are held
  red and green through fake seams in `prefabFuzzShadow.test.ts`, until the real ones exist.
  The store also has to cover every live stored root, Missing Prefab placeholders included. Without that, an empty store
  would pass both checks while counting them as run.
- **P1 by the fold** (`runner.ts` `foldCheck`, #2009 part 2) needs no seam, because S1's parser and S2's fold are real.
  After every op, it compares each stored instance's live tree with `foldInstance(parse(entry))` of what the save
  writes now. "Each stored instance" means every top-level entry, plus every reference node the scene added under an
  own node the owner's fold anchors, including one inside a plain added node's `children`. The comparison is #2007's
  oracle (`foldOracle.ts` `checkRecord`), so a difference is a state S5's reload would change.
  - The unused comparison reads two multisets, paired by row. Only a legacy leaf, which names no row, pairs by leaf alone.
    Under a row the record removes, only that row's `removed` and its user-added nodes are paired. Both sides drop a
    gone member's other unused parts (#1914 R4), and a keyed copy there is inert in the fold. A user node is `heldNode`
    (§ 10.4b), and today keeps it as an orphan wherever the row's member is cut: an inner layer removed the member, the
    member is gone, it sits in a missing frame, or the instance's own removal cuts it. Skipping the links too turned
    hunt seed 178 red as `fold-only … own (heldNode)` (#2032).
    The last of those, where the scene's removal alone cuts the member, was a today LOSS until #2035 (measured
    load → save → reload → save): the load kept the link in no store, and the first save dropped the node. Ordinary
    editing reached it. A template edit drops the member, so the link is kept as an orphan; a delete of the cut row
    cannot take it (it is not live), so the save writes the cut beside it; undo the template edit, and the next save
    lost the node. Since #2035 (hub ruling: fixed now, not at S6) `applyStoredMemberRows` keeps such a row's user links
    (`own`, and keyless legacy `added`) as an orphan, and the cut still takes its other records and any keyed copy.
    #2035 first did this for a MEMBER row only, so a NODE row (`…/a+<key>`) and a row reaching into a template reference
    node (`…/a+<key>/<guid>`, R3b) under the same cut still lost their node by the same route (#2038). "Cut" is now a
    backed row that names no live keyed node of the instance (`instanceRowKeysIn`, the fold's keys, which the editor reads
    as `instanceKeyMap`), not one missing from the member keys: by member keys alone a live template-added node read as
    cut, and its user child was kept as well as spawned (its delete came back; #2035's close-out review).
    #2035 also dropped every KEYED element of a cut row's legacy `added` whole, taking any key to mean "a copy of a
    template node". The same route reached this on a legacy copy: a template edit kept QA's row whole as an orphan, the cut
    was written beside it, and once the edit was undone the reload dropped the copy and the user's child inside it
    (#2041, measured). A key means a copy only where `pinAdded` PAIRS it with a template node anchored at the row's
    member. `cutRowUserLinks` (parseInstanceRecord.ts) runs that pairing on the parse's own chain, so the load and the
    fold cannot disagree about whose node it is:
    - An unpaired keyed node is the user's. It is kept on the row, in `own`, the list the parse links it in. Left in
      `added`, any reader of a cut row takes a key there for a copy.
    - A node row's `added` is the node's own list (`wholeAdded`), keyed or not.
    - A paired copy is taken. The user's nodes inside it are lifted to the key the parse links them at, the node-row form
      #2038 keeps:
      - A plain copy's unpaired children go to `<frame>/a+<key>`, and a paired child is followed the same way.
      - A reference copy's member-row nodes go to `<frame>/a+<key><row>`.
      - A reference copy's keyless `added` goes to the member it anchors at, unless a member row's whole `added`
        replaces it (`copySession`).
    - A reference copy carrying anything else of the user's is kept whole on the row: a keyed node in its lists, a slot's
      node, children, or a statement the parse holds the copy whole for. Kept is never lost.
    A lifted row the scene also states gets both lists, and a guid either list already holds is not added again.
    Liveness and pairing are both asked of the row's CANONICAL key (`canonicalRowKey`, frameChain.ts), as the parse reads
    it. A hand-written alias of a live nested root (`/R/<innerRoot>`, § 2.1) once read as cut, so its nodes were kept
    AND spawned and a delete came back (the #2041 review, observed, and on #2035's own links too). The frame chain lives
    in `loaders/frameChain.ts` because both the parse and the load read it: `prefab/` already depends on `loaders/`.
    Regression tests for each shape, that route, and the live side of both: `foldInstanceOracle.test.ts`.
  - Kept-only lines name their row and carry a marker that separates the waived shapes from loss:
    - `(applied)` only when the record, with that removal turned into a restore, projects the member. A gone member
      does not project after the restore either, so the fold losing its "removed, gone" record cannot read as applied.
      On an own link, `(applied <guid>)` means the fold links the SAME guid at the SAME row (#1931 member 1, #2023). A
      link the fold lost or put elsewhere stays unmarked. The guid is printed so a waiver can tie a line to that link.
    - `(unprojected)` for an own link on a row whose member no document holds any more (#2018's mechanism). A member a
      document still holds but a layer removed is held, and its link is the fold's `own heldNode` record. Losing that
      is a different defect, so its line stays unmarked and unwaived.

    The close-out reviews' mutation (the fold drops every removal of a gone member) passed as a waived #2013 twice
    before this. First the lines were unkeyed. Then `(applied)` tested only that a document still held the member,
    which an inner layer's removal also passes. The pairing is a pure function (`pairUnused`) with its own tests
    (`foldOraclePairing.test.ts`), because the real fold never takes the branches that tell these apart.
  - Where the pairing cannot reach, `placementDiverge` (#2021) holds the fold to the RECORD by the rules (design
    § 10.4b, #2018's rulings). Under a placeholder, today keeps the records at a granularity a leaf multiset cannot
    pair, so the pairing skips them. The rules check them instead:
    - Every list record at or inside a placeholder is unused `unresolved`, part by part. The exception is a `removed`
      AT a nested placeholder: it targets the reference row of a loaded document and decides whether the placeholder
      shows, so it APPLIES and is not unused (hub ruling, 2026-10-02; #2024).
    - Every held legacy statement of a member row under a placeholder is reported, and only as `unresolved`. When the
      instance's own prefab is missing, that covers every held statement. A statement's user-added nodes are checked
      as nodes. Whatever else it holds needs a record of its own, so a node cannot vouch for a lost removal beside it.
      And no unused legacy record names a statement `held` does not hold.
    - Every user-added node is placed exactly once. AT a placeholder it hangs from the placeholder. INSIDE one it is
      `unresolved`. On a projected member it is anchored there. Otherwise it is `heldNode` (B′). A node is one guid,
      whatever states it: a list row's `own` link, its content in `held.heldOwn`, or a scene-owned node in a held
      legacy form. § 10.4b's AT-a-placeholder fix covers every file form (#2025), and the held forms are judged by its
      rulings (#2030):
      - a held member row's `added` (v16) or `own` (v17), at that row. The fold reports a held `added` node by node,
        so each needs its own record. A row's `own` is one of the row's fields, so its node may also be placed by the
        record that holds the row, or its `own` list, whole. An `added` node may not: one record for a whole list would
        then place every node in it. A held KEYED copy in that `added` is walked too (#2036): every list the parser reads a copy's
        nodes from states user nodes (a plain copy's `children`, a reference copy's `added`, its member rows' `own`/`added`,
        its slots' `added`), at any depth, and slots are walked as rows are. Each is placed once, in an unused record that
        keeps it (`heldNode`, or `unresolved` where the copy waits), by its own record or the record of a copy holding it:
        the copy's key and cause are the fold's (it may sit at a placeholder, or name a missing prefab). Before, only the row's top-level nodes were enumerated, and a fold placing a copy's node
        nowhere passed;
      - the entry-level legacy `added` under a MISSING ROOT. It is AT `/` only when the entry states the root's
        localId, the node names it, and the `/` row states no whole `added` list. Otherwise it waits, `unresolved`
        (hub ruling Q3: no localId is guessed, rule 5). This is judged from the owner AS STORED (the entry, or a
        scene-added reference node), with the `/` row's `own` and the keyless nodes of its whole `added` (both AT
        `/`). The parse cannot judge it: it moves each node it links into the `/` row's `own`, so a parser linking every
        node agreed with itself and passed. The owner is read as the file boundary reads it (a malformed channel is kept
        verbatim and states no node), and a node it states at `/` that the parse links at another row is red, not a
        duplicate left unjudged;
      - a `nestedStructure` slot's `added` whose path stops at a MISSING nested document. It waits `unresolved`, keyed
        at that placeholder row, or is `heldNode` there when a removal cut the row (hub ruling Q4). The check walks the
        documents to find the row (`slotPlaceholder`); it does not take the fold's key. That walk repeats the fold's
        own (`slotKey`), so it catches the two drifting apart, not a walk both get wrong.

      A user node is keyless with a non-empty guid (`isUserNode`): the rules link a node by its guid, so `''` names
      none. The oracle and the file forms share that one predicate.
    - The fold reports only placeholders no removal cut. A placeholder the instance's own removal cuts goes with its
      member: its links are `heldNode` and its other records are inert (hub ruling, 2026-10-02: the cut dominates the
      placeholder, rule 3).

    Its rules have pure tests (`foldOraclePlacement.test.ts`). The saved-scene oracle pins what it reaches: a node on
    a projected member, AT and INSIDE a placeholder, and list and held records under one. A held own link is reached
    only at hunt length, so `prefabFuzz.test.ts` pins it on hunt seed 246, minimized. Mutations:
    - the fold dropping a held link, or marking it `gone` (which Remove Unused would take), turns that pin red; the
      leaf pairing alone misses the second;
    - the fold dropping its held `unresolved` legacy records (the close-out review's mutation, green across every
      suite before the held check) turns saved-scene seeds 5, 103 and 235 red.
  - **#2025's file forms are derived, not generated** (#2030, `prefabFuzz/fileForms.ts`). The editor writes one form
    per place, so no op reaches the others: AT a nested placeholder a row's v17 `own`, and AT a missing root the legacy
    entry `added` at the root localId (today's save writes that, not a `/` row). So the saved-scene oracle takes each
    user node a saved instance hangs AT a placeholder out of the form it is stated in and restates it in each other
    form, one variant scene per form. It loads each variant through the editor's load and judges it as it judges the
    saved scene. The forms are a v16 row's whole `added` at a nested placeholder; at a missing root, the `/` row's v16
    `added`, its v17 `own`, and the legacy `added`; and a `nestedStructure` slot naming the placeholder's reference
    row (parent localId 1, as a writer of that form stated it). Every form is pinned as reached, on seeds 5, 103 and
    235; so is a slot node actually JUDGED. Reverting each of #2025's branches turns its form red: the v16 row at a
    placeholder (9761a16df) seed 5, the root linking (bcc95fcdc) seeds 103 and 235, the slot keying (bf5da623b) seed 5.
    A `/` row's v17 `own` stays green under the second revert: #2018's older branch links it. The pure cases also hold
    the review's mutations: a parser linking every node at a missing root, an oracle reading Q3 from the parse, a
    whole-list record placing each node, and an empty guid taken as a node each turn one red. The fold collapsing a
    held `added` into one record turns seeds 5 and 103 red. Not reached: at a missing root the save states the nodes in
    the legacy `added`, so the generator's branch deriving the forms from a `/` row's `own` never runs on these seeds
    (counted 2026-10-02: 2 legacy, 0 own).
  - **Rule D is reached on a copy-less form** (#2033). D is a nested reference row whose prefab is missing and the scene
    holds no copy of it: a file saved before v19 (`embeddedPrefabs` arrived then), or saved while the prefab still
    existed. The run's own save writes the copies, so each saved scene is judged once more with `embeddedPrefabs`
    removed. Before this, D was reached only when Finder's `.DS_Store`
    aborted a trash step and the oracle read an older save, so the oracle now also fails a run whose `run.failure` is
    set.
  - Not checked:
    - The end walk (undo to the start, redo to the end) and the respawn rebuild.
    - Which part of a held legacy statement the fold reports. The check requires one record, so a statement that loses
      some of its fields passes.
    - A guid stated more than once (a duplicate identifier, rule 5): what it means is #1937's. It is counted
      (`seen.ownDuplicate`, pinned at 0 over the fuzz), not judged.
    - WHERE a user-added node shows, and its cause, in a held form no ruling places: the entry-level legacy `added`
      while the root's document LOADS, and a held slot that resolves or names no reference row. Only "placed exactly
      once" is checked there: anchored, or held at its own path (counted in `seen.heldNodeUnjudged`). The per-step P1
      passes each stored owner's root localId; a caller of `checkRecord` that passes none leaves the entry-level form
      unjudged too.
    - A held `nestedOverrides`/`nestedStructure` statement whose path runs through a missing NESTED prefab. It is keyed
      at `/`, and telling which placeholder it waits on is a frame walk the check does not repeat. No fuzz seed reaches
      it (the re-review counted 0).
    - A held member row or `nestedStructure` slot that states nothing (`{}`): it is no statement, and the fold reports
      none. Any other channel's empty entry, such as `overrides: {4: {}}`, is still one held statement.
    - A restore (`removed: false`) under a member an inner layer removed: no verify seed reaches it, so the fold
      dropping that row's `removed` record there goes unseen.
  - Its first hunt and the close-out review (2026-10-02) found three gaps in the ORACLE, all fixed there:
    - A template-added reference node did not open a frame.
    - A scene-added reference node's own template-added node was claimed by the outer instance.
    - Today's kept rows were compared where the fold's are skipped: under a rule-B placeholder, and under a member the
      record removes (#1914 R4).
  - They also found one old-model defect, #2013: today keeps a member's `removed` in its orphan store and also applies
    it (`(applied)`).
  - The length-40 hunt (#2023) reached a second one, #1931 member 1. Today's orphan test misses a template member row's
    `own`, so the scene row linking a user node under that template-added node is kept AND applied. Delete the node,
    save, reload: it comes back. Two KNOWN_OPEN entries pin it:
    - The double booking. Its waiver (`linkBookedTwice`) admits, on a template-added row only, `own (applied <guid>)`
      lines plus the `anchors` line of the deleted node. Every guid the fold has there beyond today's must be one of
      those kept links and shown nowhere at that row, so a node lost there with no kept link of its own, or one
      anchored twice, stays red.
    - The resurrection, pinned to the deleted node's guid. After the delete, S4's door drops the node's record (rule 3),
      but the old capture still links it from the kept row. I25 translates exactly that link (`keptDeletedLinks`: a
      kept `a+` row the fold still declares, its node not live, the record not linking it; counted as `known1931`), so the run reaches the save, which writes the link, and the reload, which brings the
      node back. It is #2001 S6's acceptance case. A fix to `templateFrameNodes` itself would end both entries first.
  - #2034 had the same mistake in I25's rule-3 translation, which dropped every record row under a deleted member
    because "the old capture drops them". It does not drop a row today keeps as an orphan: it writes that row back.
    Delete a nested member and Apply it to the template: its `removed` row now names nothing in the template, so today
    keeps it as an orphan. Then delete the member above it. Both sides keep that row, and I25 called it capture-only. Such a row is now compared like any other
    (counted as `removedKeptOrphan`, pinned on #2023's hunt seed 1268, minimized to 3 ops). Dropping the branch turns
    the pin red.
  - #2023's other seeds had no oracle gap: fold and parser defects (#2027, #2029), and one more #2013 double booking.
  - And five fold defects:
    - #2015: a document-level move of a template's own row into a nested instance's member was held and never projected.
    - #2016: a held reference copy's unused record is keyed at `/` instead of the node it stands for.
    - #2017: a scene-added reference node stated once, inside a template-added reference node's `added`, is anchored
      twice.
    - #2018: an own link on a row whose member is not projected is neither anchored nor unused. #2013 first waived these,
      read as applied, because nothing on either side looked like agreement.
  - Each of these issues has a KNOWN_OPEN waiver that tolerates only its own shape; a test holds both sides of each.
- The verify run's summary line says how often T2 and T4 ran, and why a marked T2 op did not check (a skip reason, or
  the op a no-op) (`#1880 checks run`), since a check that never runs guards nothing. The fold's precedence has its own oracle, outside the fuzzer:
  `engine/packages/modoki/tests/runtime/prefabFoldOracle.test.ts` (#1880 T3) draws random layer stacks and holds the pure
  fold and the spawner to Unity's rule, outermost layer wins.

The test's header lists what it cannot see (no concurrency, a simulated watcher, one scene, no game system running in Play). Read it before
concluding that an area is covered.

**How to use it.**
- **`npm run verify`** runs fixed seeds, in a few seconds.
- **`MODOKI_PREFAB_FUZZ=<n>`** hunts n seeds (optional `_SEED`, `_LEN`). It shrinks each distinct failure to a minimal op
  list, prints it as a paste-ready `MODOKI_PREFAB_FUZZ_REPLAY='…'`, and ends with an op/route coverage tally.
  ⚠️ Run it with **`--disableConsoleIntercept`**:
  `MODOKI_PREFAB_FUZZ=1000 MODOKI_PREFAB_FUZZ_SEED=3000 npx vitest run --config engine/vite.config.ts engine/tests/editor/prefabFuzz.test.ts --disableConsoleIntercept`.
  Without the flag, vitest swallows everything the hunt prints (the findings, their replays and the tally), and a
  passing hunt shows nothing at all (measured on Windows, 2026-09-29). A hunt that finds anything ends red, since it
  expects no unclaimed signature, so read its output rather than its exit code. The signature includes the prefab's
  name, so a single mechanism can be listed once per prefab it hit.
  - **Cost:** a clean seed takes well under a second, but shrinking a failing one takes 16–180 replays. On Windows,
    1000 seeds at `_LEN=40` took 28 and 53 minutes in two parallel runs.
- **`MODOKI_PREFAB_FUZZ_DUMP=<dir>`** writes every compared state while a replay runs: per step the scene save, the live
  world tree and every prefab file; per save→reload the live tree, both reloads (`-rt-after`, and `-rt-restored` when a
  deleted prefab was put back) and both saves' bytes. Diffing `-rt-before` against the two reloads is how #1831's seeds
  were read.
- An op's choices resolve against the world when it runs, so a list stays runnable as the shrinker drops ops.
- The shrinker keeps only a list that fails with the same signature. A replay can still slide onto a different bug with the
  same signature, so **re-run the minimized repro on the unchanged tree** before you attribute it to a change.
- A run's guids come from a hash of its op list, so a list's first run is the same guid for guid in any process, and a
  fresh-process replay reproduces the hunt's run.

**The simulated watcher tells the editor's own writes apart by URL (#1840).** After each op the harness raises
`scene-changed` for every changed file the router did NOT mark as the editor's own. Before #1845, a raised file tainted the segment:
the file reloaded under the op, and the undo-to-start identity and the clean-segment refusal checks were skipped. Until
#1840 the mark was looked up by `be.dir + url`, a string that never equals the router's `\`-separated path on Windows. So
on Windows every editor write was raised and every segment with a write was tainted. The reload rebuilt the world from
the file, which wiped the in-memory loss (marks, links) the KNOWN_OPEN repros need. On the public CI's Windows leg that
was 33 red tests: 32 KNOWN_OPEN repros ran clean, and #1805 route 2 lost its reach (its plain reload showed no
placeholder). Undo and redo were never inert there; the check that would have seen their bugs was switched off. The mark set is now keyed by the asset URL (`toUrl`, the same conversion the snapshot uses), and a harness
self-test holds both sides: a routed write is not raised, and an outside write is. ⚠️ **Windows hunts before `win`'s
#1840 fix found no undo-class failures because of this, not because there were none.** The reloads also changed which
routes a run reached (#1805 route 2 above), so re-run a finding from such a hunt on a fixed tree before relying on it,
and read the cost figures above as measured with the extra reloads.

**A taint must name its cause (#1845).** #1840 was one instance of a class: any mismatch between "the editor wrote this"
and "an outside edit wrote this" silently switched the fuzzer's main checks off. So a taint now comes only from a closed
list (`TaintCause` in `prefabFuzz/runner.ts`, each with the mechanism that makes it legitimate there):
- `outsideEdit`: an outside edit wrote a prefab file. Its raise is the ONLY one a run accepts, and only for paths that op
  wrote.
- `prefabEditSave`: a prefab edit saved. That is the editor's own write, marked and never raised; it taints because the
  save lives on the edit world's stack, which leaving drops (U27), and the scene entries recorded against the file refuse
  after it (I10).
- `rulingR`: a world swap expanded a Missing Prefab placeholder, or left a NESTED frame of a missing prefab unexpanded
  (#1790 ruling D records the row and spawns nothing under it). Then the entities the stack recorded inside that frame
  are gone rather than placeholders, and `require` refuses them the same way (#1849, found with the renderer manifest
  pruned; hunt seed 6191 reaches it without). A swap that loses an entity with neither record is not this cause.
  ⚠️ It is taken BEFORE the op's own refusal is judged (#1862): one `undo` op runs up to three steps, so its first step
  can swap (an Apply's undo reloads its snapshot) and its second refuse on what the swap left unexpanded. Judged first,
  that read as a refusal in a clean segment (seed 6191, once the loader's delete eviction was in). Sound either way
  round: a refused step changes nothing, so every swap the op made came before its refusal.
  **A same-world step can reach it too (#1831, hunt seed 6356).** A scene entity moved under an instance of a trashed
  prefab, then the instance deleted: the delete's undo respawns the instance in the SAME world as a Missing Prefab
  placeholder, and the placeholder's record takes the entity in instead of spawning it. The next undo on it refuses
  ("is no longer in the scene"). So a step of the walk to the ends also taints when a placeholder's record newly holds a
  guid the segment had live and that is not live now (`swallowedRecorded`, `swallowedGuids`). The runner used to say a
  delete's undo "changes no recorded entity's kind", which this case disproves. A placeholder that takes in nothing the
  segment had live (a duplicate or paste of one) still does not taint, so a false refusal after it is still caught.
  ⚠️ Only in the walk: an `undo` OP reaching the same shape still reads as a refusal in a clean segment. That is a false
  finding a hunt would show, never a hidden one, and no seed reaches it. The op-loop copy was built and removed, since no
  test could fail on it (mutation-checked).
- `assetDelete`: a Move to Trash of a prefab that something the walk restores still references (the scene at the
  segment's start or now, a prefab file then or now: `trashedPrefabReferenced`). It is not undoable (#1868, owner
  ruling D2), so the file stays gone for the walk, and the stack's entries recorded against it refuse after it by the
  same rule as `rulingR`. A trash of an unreferenced prefab only leaves the baseline (`rebaseForFileOp`), with every
  check on. A Rename is never a taint: a scene names a prefab by guid, so the runner only moves the path in the
  baseline.

A watcher raise with any other cause FAILS the step, as `unexpected outside write`. Planting #1840 back (the router marking
by absolute path) turns every verify seed red that way on macOS, which a self-test pins. Every run counts the ops that
tainted, by cause, and the checks each taint turned off: the verify test prints one line, and a hunt prints both tallies
after its coverage. The shrinker's replays of a failing seed are NOT counted (`uncounted` in `prefabFuzz.test.ts` puts
every printed tally back after the shrink), or a platform that found more failures would report more taints for that
reason alone (win's Windows hunt). **Compare those counts between platforms.** A platform whose taints or skips run far above
another's, on the same seeds, is turning the checks off for a reason the other does not have.

**A deleted prefab's round trip (#1805).** A live instance of a prefab whose file was deleted stays expanded, while a
reload gives its Missing Prefab placeholder, as in Unity. So when the run has deleted a prefab (a document that is in no
file now, by id: a rename is not a delete), `saveReload` also reloads the same save with the deleted prefabs put back, and
`checkRoundTrip` fails only when NEITHER comparison holds: the plain one (a world swap already made the live instances
placeholders) or the restored one (the live instance is expanded, and the save carried all of it). The restored one alone
would fail a correct run whose live world holds a row a swap left unexpanded, which expands once restored. Measured: with
#1812's record read taken out, the #1812 regressions go red, one through the restored comparison. What the identity cannot
see — a row the live world itself does not show — needs a regression repro, as #1812's are. The reproducibility test masks
each run's tag in a guid's last group as well as in its folder (its occurrence digits only), since an Apply that is a
noop for a deleted prefab names it.

**What is put back is the document the editor last held, at the last path it had (#1831, hunt seeds 7023 and 7078).**
The runner records every prefab after each step, by document id (`RunState.lastPrefabs`): the park an undo left for
Save if there is one (#1868: an Apply's undo is memory-only), else the file. Restoring the FILE bytes put back a value
the live world was never built on (7023: the file still held the undone Apply's `z = 2` while the live instance had
`z = 0`), and choosing among paths by the manifest failed once the trash had removed the manifest entry, so a prefab
renamed and then trashed came back at its old path with its pre-rename bytes (7078). A document whose last path another
file now holds is not put back.

**The restored comparison forgives exactly the frames the live world could not expand (#1831, the G1 study's M1).** It
asks that ONE reload equal the live world: the plain one (every frame of the deleted prefab a placeholder or an
unexpanded row) or the restored one (every frame expanded). A live world can hold both kinds at once: a frame kept across
the delete (#1738, #1862) beside one that never expanded, because it was instantiated, reloaded or rebuilt while the
prefab was gone (ruling D's unexpanded row, or a placeholder). Then neither held: the plain reload lost the kept frame,
and the restored reload expanded the other (hunt seeds 351 and 6030: trash P, then instantiate O, which nests P). That
was the comparison's gap, not the editor's: the restored reload is what the editor itself shows once the file is back.
An OS-Trash restore reaches it as a watcher event (`handleSceneChanged`, `openSceneUsesPrefab` keeps a missing
prefab's guid and counts its placeholders); there is no delete undo since #1868. Since #1873 R1 that event re-imports
the prefab IN PLACE instead of reloading the scene (placeholders re-expanded, unexpanded rows rebuilt), which reaches the
same expanded state; a clean scene the in-place path cannot fully reach still reloads. So `forgiveExpandedFrames` (`checks.ts`) drops, from the restored reload, a gained frame root of a deleted
prefab whose outer frame recorded its row as unexpanded (`unexpandedRows()`, read before the save) and everything gained
under it, and compares a live placeholder of a deleted prefab that came back an instance root by its placement (name,
parent, order, active). Everything else must still be identical, and the second save's byte identity holds the
record's content. The G1 study's editor mechanisms were ruled on #1831: a node dropped under a Missing Prefab
placeholder is now refused (seed 315, § "A missing prefab keeps its record"); seed 254's placeholder that a delete's undo did not re-expand went with
#1868's removal of delete-undo; seed 6302 needs a nested-root Detach, which #1869 refuses (Unity unpacks outermost roots
only); seed 5104 (M5) needed a reparent Unity forbids (U7), and its Unity-legal route (a frame under a scene-added node,
trashed, then Apply All) skips that node and keeps the frame live (`missingNestedFrameKeep.test.ts`).

**KNOWN_OPEN** (`prefabFuzz/knownOpen.ts`) is how verify stays green while a found bug is open.
- Each entry names its issue.
- It stops a seed at that bug, with a predicate on the check AND the op shape that reaches it. (A second kind, a
  normalization verify applied while its issue was open, had one user, #1796's node-list order, and went with its fix.)
- It carries a repro that a self-test must still see fail. Fixing the bug turns that self-test red, which removes the entry.
- A predicate sees only the ops before the failure, and keys on what the failure SHOWS (the I7 detail says whether the
  holders are rows of one frame; an identity failure says whether an entity was lost or changed guid), not on the op
  list alone. Op-list predicates claimed a fixed bug's regression in every verify seed. Two later reviews each planted
  an undo/redo regression that such a predicate swallowed with the whole file green. So the routes that keyed on an
  entity (#1793, #1794, #1796's re-tag, #1820's paste, #1826, #1830, all fixed and retired since) also asked whether it
  was the one their mechanism's op touched, and a new stop of that kind should too. The runner records the guids each drop, paste, detach and Create Prefab introduced or covered, and hands
  them to the stop with the failure (`touched`). The stop asks it about the ONE node the diff is about: the entry named
  in `/entities/<guid>`, or the first guid of a node gone or new. It does not ask about every guid the detail names,
  because a diff inside a dropped entry names the drop in its path whichever node moved.
  - #1793 also needs its node to have MOVED, meaning it is still on the other side of the diff, or its own top-level
    entry re-parented. A redo that loses or replaces the node's guid is a different regression. A node list is
    diffed by node identity, and a scene's top-level entries by guid, not by index: by index, a lost entry read as its
    neighbour shifting slot.
  - A walk failure carries the walk's console lines, where a refusal names its file.
  - A route with no such key keeps a self-tested repro and no stop (#1819's placeholder-root route, #1820's gained
    entity, #1827's raw-id deletion).
  - Other entries key on the detail's text and the op order: #1792's frame shape, #1805's lost entity or placeholder of
    a deleted prefab, #1800's component mark.
  - Accepted limit: a regression in the drop path itself, which misplaces the dropped node, has #1793's own symptom on
    #1793's own node, so #1793's stop claims it. Other seeds still turn verify red for the drop regressions the
    reviews planted.
- A self-test holds the reject side. No other issue's entry claims an entry's repro. A set of generic failures on
  untouched entities must go unclaimed after lists that end in each op a stop keys "last" on, and after lists that
  leave out each op a stop keys "no …" on. Those failures are #1777's shape, values and marks, a lost, gained or
  placeholder'd entity of a live prefab, the reviews' planted regressions, and a re-tag refusal for another tree.
  - Over KNOWN_OPEN alone these self-tests check nothing while it is empty, and it is empty whenever every found bug is
    fixed. So each one also plants fixture stops beside the real entries and runs them through the same matcher
    (`claimsOf`, which verify, the hunt and a replay all stop through). The accept side: each fixture claims its own
    failure, no other fixture does, and two entries claiming one failure are both returned (the per-entry reject side
    reads the rest). A real entry is not held to "nothing else claims it": one for the same mechanism, reopened,
    rightly would. The refuse side covers three things: the generic failures above, an op after the
    failure (the op window), and an entry with no stop, which claims nothing. Breaking the matcher in each of those ways
    turns them red with KNOWN_OPEN empty.
- Hunt mode, not verify, reports a seed as a known route, not a finding, when a stop claims both its shrunk list's
  failure (same signature) and the seed's own failure judged against the shrunk op order. A 40-op list often hides
  the op order a route's stop keys on. The content keys stay the seed's own, and the replay is printed.

**What the hunts found:** #1792 to #1796, #1798, #1800, #1805, #1807 to #1809, #1812's route, #1817 to #1822 and #1826
to #1830, each observed and minimized. #1817 is a crash: a prefab-edit save writes a file that contains itself. #1827
is an undo that deletes an unrelated entity: after a world swap it falls back to a raw ECS id. #1797 was first fixed at
its one writer, then moved into the commit (see "The localId high-water mark"). Its repro, and those of #1807 and #1812 (fixed on work-ai), are regression cases. Many of the later findings
need the undo stack to survive a reload, which the harness did not do at first: a run's first reload emptied it.
The diagnoses found two harness defects that review had not: that history key, and an end walk that judged a
restored fixture as the editor's own old-version write.

**Re-finds (a known fixed bug put back, measured 2026-09-29).** ⚠️ Measured on the generator BEFORE #2009 (2026-10-02)
added six op kinds, which changed every seed's list: the seeds and steps below are that generator's, and were not
re-measured, so "in the verify seeds" is no longer a claim about today's seeds. The generator's weights were NOT tuned against these.
Four generator changes came from reading the coverage tally. Three of them were not made for any re-find. The fourth,
the directed move-then-Apply branch, was added precisely so that #1751 F1's route is reached, so that re-find is by
construction. The four: Remove Component draws only from
entities that have a component (it was a no-op 97% of the time); reparent has a same-frame branch; an outside edit's
merged row numbers at or above the file's mark; and 20% of Applies first move a frame member under another member (the
only way the member-path route, gone since #1868, was called: 0 calls in 400 seeds before it). A re-find counts only if its seed passes
on the unmutated tree and its minimized repro does too. **Since #1869 the same-frame branch and the directed
move-then-Apply are gone:** a member does not move, so `reparent` and `cut` draw only what may (a scene-added node, a
stored root, a plain entity), and no fuzzed gesture authors a row move.

| Bug | Found | Where |
|---|---|---|
| #1756 | in the verify seeds | seed 2, step 17 (I7); 5-op repro |
| #1446 | in the verify seeds | seed 2, step 22; 5-op repro |
| #1709 | in the verify seeds | seed 2, step 19; 4-op repro |
| #1774 | a 150-seed hunt | seed 118 (I4, a localId re-bound); 4-op repro. Not re-found before the harness kept the undo stack across a reload |
| #1751 F1 | a 150-seed hunt | seed 156; 9-op repro, through the directed move-then-Apply branch only |
| #1737 | a 150-seed hunt, not isolated | seed 101 fails only with the fix taken out, but its repro shrank onto an open marks bug |
| #1777 | not re-found | reusing a number needs a hand edit below the mark (#1782's positional rebuilders keep their rows by path since) |
| #1741 | unreachable | a base scene's Apply undo; the harness has one scene |

## Unity parity

The top note makes Unity the reference for every prefab design choice. This matrix measures how far Modoki is
from it, one row per behaviour. It was built for #1694 (2026-09-28) against Unity 6 and 2022.3 LTS. Where the
2022 Manual pages lag the 2022.2 API (removed GameObjects), the row cites the newer page. **Verdicts:** `match`;
`diverges` (a bug, or a difference the owner rules on); `missing` (a Unity feature Modoki lacks, with a size).
Sizes: S = part of a session, M = about one session, L = several. **The owner decides what is built.** The
counts, the top divergences and the proposed order are on #1694.

Unity sources: [M6] = `docs.unity3d.com/6000.0/Documentation/Manual/`, [M22] = `…/2022.3/Documentation/Manual/`,
[M19] = `…/2019.4/Documentation/Manual/`,
[S6] = `…/6000.0/Documentation/ScriptReference/`, [CS] = Unity's editor C# source,
`github.com/Unity-Technologies/UnityCsReference` (master), cited where the Manual and the Scripting API say nothing.

### Structure and overrides

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U1 | Asset and instance | An instance links to its asset and stores only its differences. [M6 `PrefabInstanceOverrides`] | The same. A scene entry stores `prefab` plus its edits. § "Scene-instance format". | match |
| U2 | Nested prefabs | A nested instance keeps the link to its own asset. The outer file stores it as a `PrefabInstance` whose `m_Modification` holds its overrides. [M22 `NestedPrefabs`, M6 `yaml-prefab-serialization`] | A reference row (`prefab` set) holds the child's edits: `overrides`, `added`, `removed`, `removedTraits`, `members`, `nestedOverrides`, `nestedStructure`. § "Nested prefabs (v2)". | match |
| U3 | Prefab Variants | A variant inherits from a base prefab. Its overrides win, and base changes flow through. [M22 `PrefabVariants`] On disk its root is a `PrefabInstance` of the base. [M6 `yaml-prefab-serialization`] | None. The loader already expands a template whose root row is a reference row, which is the same shape, but no editor path writes one or edits one as a variant. | **missing**, L |
| U4 | Property override | Bold, with a blue bar in the margin. [M22 `EditingPrefabViaInstance`] | Presence-based `overrides`, on member rows since scene v16. The Inspector marks the field with a blue left accent (`overrideStyle`), and a numeric, text or vector field's label and value in blue bold. | match |
| U5 | Added / removed component | Both are overrides, badged + / −. [M22 `EditingPrefabViaInstance`] | An added trait is a whole-trait override, and `removedTraits` records a removed one. [prefab-structural-overrides.md](./prefab-structural-overrides.md) | match (badges: see U8) |
| U6 | Added / removed GameObject | Added children are overrides. A removed child is a "removed GameObject" override. [M6 `PrefabInstanceOverrides`, M22 `UpgradeGuide2022LTS`; the `PrefabUtility.GetRemovedGameObjects` API page first exists for 2022.2] | `added` (plain or reference nodes) and `removed` (the top-most member only). | match |
| U7 | Reparenting a member inside an instance | Not allowed: "There are some limitations with Prefab instances: you cannot reparent a GameObject that is part of a Prefab, and you cannot remove a GameObject that is part of the Prefab." [M19 `PrefabInstanceOverrides`, <https://docs.unity3d.com/2019.4/Documentation/Manual/PrefabInstanceOverrides.html>. The removal half was lifted in 2022.2 (U6); the reparent half never was.] The editor's dialog, as widely reported (no Manual page carries it): "Cannot restructure Prefab instance", offering Prefab Mode or Unpack. "Part of a Prefab" is every object the asset supplies, a nested prefab's included. Since 2022.3 even a nested child's reorder is not supported, and the documented way to move one is to unpack a copy, move it and remove the original. [M22 `UpgradeGuide2022LTS`] | The same (#1869, owner ruling "refuse, like Unity"). One predicate, `restructureRefusal` (`editor/scene/restructureRefusal.ts`), refuses moving an object the prefab supplies — a member, an owned nested root, a node the prefab added (a keyed node whose key an instance above it declares: a plain one, or a template reference node's root) — anywhere: within its own instance, out of it, or into another. Every route asks it before anything is written, so a refusal pushes no entry: the Hierarchy drag and drop, cut → paste, the folder and scene-group drops, a scene move, the agent `reparent-entity`, and a `parentId` field write (`apply-scene-ops`, `set-traits`). The words: "Can't restructure a prefab instance: open the prefab to edit it, or unpack it first." A node the SCENE added and a whole stored instance move freely, but not away with a supplied object whose instance stays behind (a pre-#1869 file's moved member under a scene-added node may still move within that instance). A member of a root that is not live, and an owned root nothing owns that hangs under no instance root, link to nothing and are refused nothing. In prefab edit, the edited prefab's own objects move, and a nested prefab's do not, as in Prefab Mode. **A file written before #1869 keeps its moves** (`moved`, a member row's `parent`): they load, save byte-identically, and can be applied or reverted, but no gesture makes a new one ([prefab-structural-overrides.md](./prefab-structural-overrides.md) § Moved members). The `moveKeys` machinery for a keyed node's key across a move (#1808, #1852) was reverted with it: a keyed node no longer moves. | match |
| U8 | Override indicators | Instance names in blue; a blue margin line in the Hierarchy on an instance that has overrides; + on added GameObjects; +/− on components; an **Overrides** drop-down on the outermost root, with an asset-vs-instance comparison per component. [M22 `EditingPrefabViaInstance`, `PrefabInstanceOverrides`] | The Hierarchy tints and badges every `PrefabInstance` entity ("P"), and the Inspector accents overridden fields. There is no Hierarchy mark on an edited instance, no + on an added node, no marker for a removed member or component, and no Overrides drop-down: the full list exists only inside the Apply / Revert dialog. | **missing**: badges S, drop-down with comparison M |
| U9 | Missing prefab asset | The instance stays in the scene (`PrefabInstanceStatus.MissingAsset`), and its `PrefabInstance` data stays in the scene file. [S6 `PrefabAssetType.MissingAsset`, M6 `yaml-prefab-serialization`] | An instance with no backup (Unity's `MergedAsMissing`): since #1699 a placeholder, labelled **Missing Prefab** in the Hierarchy, carries the record the file held, and every save writes it back until the prefab is back and re-expands it. A duplicate keeps the data too. § "A missing prefab keeps its record". An instance that was LIVE when the scene was saved is not one: the scene carries a backup of its prefab and the reload expands it from there, top-level as well as nested (U9b, #1935; before #1935 a top-level one reloaded as the placeholder, which is the "match" the owner's F8 ruling corrected). | match (template-form captures of one are the gap named there) |
| U9b | A prefab goes missing while its instances are live, and comes back | An instance merged before its asset was deleted keeps its objects: `MergeStatus.MergedAsMissingWithSceneBackup`, "Prefab source was missing, but Prefab data was found in the scene file - no merging was done"; such an instance "can be correctly restored only if CorrespondingObjects info is available", which it is "when a PrefabInstance with missing asset was merged before deleting the asset (kNormalMerge) or when it has a scene backup". [CS `Editor/Mono/Prefabs/PrefabUtility.cs`] Unity reconnects it when an asset with its GUID returns: INFERRED from the same comment and from instances naming their asset by GUID, not quoted from a document. | A live frame stays expanded (#1738's evicted state), a NESTED one too across every in-place rebuild (#1862): the teardown keeps a nested frame whose prefab the respawn cannot expand, and puts it back where it hung (`rebuildTeardown`'s kept set, `seatKeptFrames`); for a kept reference node, scene-added or template, the respawn spawns nothing at the node's frame address (the one spawner, `spawnReferenceNode`, meets it at any depth and in every channel a node hangs in, #1877 L4; by address since #1939, which a template node's key needs: it was guid-only; and only while the statement names the prefab it was kept for, #1948 S1). Only the rebuilt instance's OWN frames are kept: a #1484 row of another frame hanging under one of ours is parked and re-seated, whether or not its prefab can be expanded. Kept, its owner (not re-expanded) listed no unexpanded row for it, so it was deleted and the save wrote it REMOVED (#1877 S3). A Revert of the kept frame itself refuses, naming the prefab: there is no base to revert to (`revertRefusal`). On the kept frame's own root an Apply refuses in the same words, and so do the Apply dialog's and the agent `prefab` op's own load checks, which stop before either (`missingSourceRefusal`, #1831); they showed a bare guid, and Apply answered a bare `applied: false`. From an outer instance, a key reaching INTO the kept frame is skipped with that reason and the other keys still land (`missingNestedFrameKeys`); it was skipped as "the template has changed". Refusing the whole Apply instead was tried and dropped: it made the dialog's default Apply All, and the agent's `apply` with no `keys`, land nothing. A scene-added node that holds a kept frame is skipped the same way when an Apply would promote it: promoted, it wrote a reference row naming the trashed prefab, and its rebuild took the frame and its members out of the world. A node holding a Missing Prefab PLACEHOLDER is skipped the same way (#1699's refusal, which refused the whole Apply, became this per-key skip in #1831). Unity offers no Apply on a missing-asset instance. A file put back from the OS Trash is an outside write, re-imported IN PLACE (#1873 R1, `prefabReimport.ts`): an entry placeholder is loaded back as an instance where it stands (its placement and children kept), and a node placeholder or a row a frame recorded as unexpanded comes back through a rebuild of its enclosing frame — #1864's re-expansion, which ran only from the delete's undo that #1868 removed. An outside DELETE keeps the live frames, as the in-editor one does. § "A missing prefab keeps its record". | match while live, and across a reload: the scene keeps a backup of the missing prefab's document (`embeddedPrefabs`, scene v19, #1914 F8 = A1, #1867), the reload expands every instance live at the save from it, top-level (#1935) and nested, and a returned prefab wins over it. An instance that was already a placeholder at the save reloads as one, carrying its record (#1699). § "A scene backs up a missing prefab". |
| U9c | A prefab file with a duplicate identifier | A load error, and the file does not load: "Duplicate identifier N" plus "Error loading the file … File has multiple objects with same identifiers. Probably caused by a merge." (closed Won't Fix, manual editing being unsupported: <https://issuetracker.unity.com/issues/3402/duplicate-identifier-1-and-error-loading-the-file-errors-are-thrown-in-the-console-when-reopening-project-after-duplicating-buildprofilecontextasset-file-content>); its instances become missing-asset instances (<https://issuetracker.unity.com/issues/710/duplicate-identifier-error-message-appears-while-saving-prefab>). Unity never repairs one. | The same (#1937 C-A, owner ruling F-A (1)): the seat refuses the document, and its instances are Missing Prefab placeholders labelled **Damaged Prefab** with the reason, keeping every record. A key two files give one frame (#1933 L5) has no Unity equivalent (Unity's ids are per file, composed with the instance's): the load refuses that prefab the same way, placed at the top level or as a scene-added reference node, every placement refuses it (`instantiatePrefabInstance`: the human gestures, the agent's instantiate and both redos; the agent's door skipped it until #1948 F1), and a rebuild leaves a live frame of it as it was. No writer lands a document that introduces either (step 6; a nested file's write that completes an outer one's repeat is the exception I7 names), and the build fails on one (step 7). | match |

### Apply, Revert and their targets

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U10 | Apply / Revert granularity | Per property (right-click), per component (cog menu), per added GameObject (Hierarchy menu), and All / Selected from the Overrides drop-down. [M22 `EditingPrefabViaInstance`] | One dialog (`PrefabOverridesDialog`), opened from the Inspector's "Apply to Prefab…" / "Revert Overrides…". It is a tri-state tree of entity → component → field, plus one row per structural edit, all checked to start except the root's default overrides (U10b). No right-click Apply / Revert on a field or component. Revert from an OUTER instance lists none of a nested instance's own edits (the outer root's Apply lists them, U14), on both surfaces: the dialog, and the agent `revert` with no `keys` (#1873, R8-F1). Revert them from the nested instance itself. | match in what can be selected, except Revert from an outer instance (**diverges**: Unity's Revert All reverts the whole outermost instance, nested edits included); the context-menu shortcuts are **missing**, S |
| U10b | Default overrides | "Certain properties on the root GameObject of a Prefab instance are considered default overrides": the root's name, and its Transform's localPosition, localRotation (+ the Euler hint) and rootOrder, not its scale; on a RectTransform root also anchoredPosition, sizeDelta, anchorMin/Max and pivot. "Using Apply All or Revert All on a Prefab instance will not affect default overrides. The only way to apply or revert a default override is to use the context menu for the property itself." [S6 `PrefabUtility.IsDefaultOverride`] Only against the prefab whose ROOT it is: a nested prefab's root position "is not a default override if applying to A, but is if applying to B" [CS `PrefabUtility.GetApplyTargets`]. The Overrides drop-down does not list them. | The same set, on the listed instance's ROOT only (#1831, hub ruling "copy Unity"). `EntityAttributes.name` and `sortOrder`, and `Transform` `x y z rx ry rz` (Modoki stores Euler). A UI root has no Transform: its rect is `UIAnchor` (`anchor` = anchorMin/Max; the insets `top left right bottom` and their units = anchoredPosition; `pivotX/Y`) plus `UIElement` `width`/`height` and their units (sizeDelta) and `rotation`. One predicate (`isDefaultOverrideField`, `prefabOverrideKeys.ts`) and one list per instance (`InstanceOverrideListing.defaultOverrides`). Default-ness is decided at the key's apply TARGET (`isDefaultOverrideAt`): only where the root is the root of what it is applied to, the frame's own prefab (and always for Revert, which has none). So from a nested instance's own context its root placement is left out at its default target (its own prefab) but taken when sent into the prefab that contains it, as Unity's `GetApplyTargets` has it; a nested key listed from the OUTER instance is never one. That holds for Apply only: Revert lists no nested key from the outer instance (U10), and on the nested instance itself its root placement is always a default override, so no Revert All reverts it (#1873). Apply and Revert themselves take any key set, so the skip is made where the "all" set is built, and every such place reads ONE set, `effectiveDefaults` (the default overrides at their current targets). The dialog checks everything else to start; its entity and component checkboxes check their other keys (`groupToggle`: the default overrides only when they are all it holds), unchecking one clears every key in it, and it reads "mixed", never "off", while a default override in it is checked (`groupState`); the "default" badge reads the same set. A target change, from a row's picker or "Apply all to …", checks a default override it turns ordinary and unchecks one it turns back, and leaves every other check as the user set it (`retargetChecks`). The agent `prefab` op's omitted `keys` reports them as `defaultOverridesLeft` (the dry run too; `overrides` leaves them out of its plan), `targets` counts as naming a key for Apply only (Revert has no target, so a revert handed apply's parameters keeps the placement), and it refuses by name when they leave nothing applicable (a root in a Hierarchy folder moved and nothing else: `editorFolder` cannot be applied, and it used to answer "nothing was written — it may have stopped being a prefab instance"). Each is applied or reverted when named alone: its own checkbox, named in `keys`, or given its own `targets` entry. Visible consequence: Revert All keeps a moved or renamed instance where it is. The root's `sortOrder` is recorded on every scene instance, as Unity always writes `m_RootOrder` (#1914 R6, F7: `recordsRootOrder`), so it is always listed. | match. **Diverges** in one ruled way: Modoki LISTS them, unchecked and tagged "default", because it has no per-property Apply / Revert context menu (U10), so the dialog's own checkbox is the per-property route. |
| U11 | What Revert does per kind | Removes an added component or GameObject (with its children); restores a removed component or GameObject. [S6 `PrefabUtility.RevertAddedGameObject`, `RevertRemovedGameObject`; M22 `EditingPrefabViaInstance`] | The same, and "move back" for a moved member. `revertOverridesSelective` tears down and re-expands minus the reverted keys. | match per kind; which keys a Revert from an outer instance reaches: U10 |
| U12 | Apply target, per item on a nested instance | Offers every prefab on the chain: "Apply to Prefab 'Vase'" (the inner asset) or "Apply as Override in Prefab 'Table'" (an override on the nested instance inside the outer asset). [M22 `PrefabOverridesMultiLevel`] | Every field, added tag, removed component, removed member and added node takes a target per key over the whole chain (#1693, #1715, § "Apply's targets"), in the dialog and the agent `apply` op. Two cuts: an added node holding an added prefab INSTANCE takes only the frame's own prefab (#1715), and a prefab object is never moved at all since #1869. | match, except an added node holding an added prefab instance (#1715, § "Apply's targets" → "Not done") |
| U13 | Applying to the inner asset clears the outer's override | "If Apply to Prefab 'Vase' is chosen and the 'Table' Prefab has an override of the value, this override in the 'Table' Prefab is reverted at the same time." [M22 `PrefabOverridesMultiLevel`] | The same (#1693, owner 2026-09-28, superseding #1492 ruling b): every enclosing level's statement of the applied field, tag or removed component is dropped, its file written in the same step, and Apply's undo restores it. | match |
| U14 | Apply All on the outermost root | Targets the outer prefab only. Nested edits become overrides on the nested instance inside it. [M22 `PrefabOverridesMultiLevel`] | The same for fields, added tags, removed components and removed members (#1693, owner 2026-09-28, superseding the 2026-09-19 ruling): the outer instance lists them (`keys.nested`) and writes them into the outer prefab by default; the nested prefab only when picked. A nested frame's added nodes are still applied from the nested instance, which offers every target on the chain (U12); no listing on the outer one produces their key. | match for fields, components and removed members; **diverges** for added nodes (listed on the nested instance only) |
| U15 | The instance after an Apply | The applied value now comes from the asset, so the override disappears. | The same: Apply takes what it applied out of the source instance's overrides (#1469), and nothing shadows it any more (U13). | match |
| U15b | Apply, then close the scene without saving | Apply writes the prefab asset at once and leaves the scene dirty ([S6 `PrefabUtility.ApplyAddedGameObject`]: the object "becomes part of the Prefab Asset, and is no longer an override on the Prefab instance"). Discarding the scene leaves its file with the old added object, beside the asset's new child. INFERRED from the documented write model, not run in Unity. | The same since #1868 (Apply saves no scene): after an Apply of an added child, Don't Save and reopen shows the child twice (#1878 re-verify, 2026-09-30). The OTHER ways the two halves split, an outside write of the scene file between the Apply and Cmd+S, now ask Reload / Keep mine (#1879 part 3). | match |

### Unpack, Prefab Mode, Replace, Create

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U16 | Unpack | Makes the instance plain GameObjects with its overrides baked in. **Nested instances stay instances.** [M6 `UnpackingPrefabInstances`] | None. | **missing**, M: the nested frames become stored roots that carry their enclosing layer's edits as their own. The building block exists: `promoteOwnedRoots` / `endFrames` already turn owned nested roots into stored roots. |
| U17 | Unpack Completely | Repeats until only plain GameObjects remain. Undoable. Acts on an instance root: `UnpackPrefabInstance` throws on a non-root, and the Hierarchy greys Unpack on one. [M6 `UnpackingPrefabInstances`, S6 `PrefabUtility.UnpackPrefabInstance`] | "Detach Prefab" (Hierarchy menu, agent `detach`): `detachPrefabInstance` strips `PrefabInstance` from the frame and every nested frame, bakes the values, and is undoable (`detachPrefabInstanceWithUndo`). **It also strips the template key** (`TemplateAddedKey`) from every node of that identity subtree, and its undo puts them back by guid (#1874). The key is template identity on a node a template added, which carries no link, so the link strip never visited it. Unpacked and moved under another instance of the same prefab, the node still read as that prefab's node: its next move was refused as a restructure, and an edit of that instance's own node saved both on one guid (I7). Unity: an unpacked object refers to no prefab. Its guid stays, as Unity keeps references across an unpack, and nothing re-derives the key from it: key recovery (`recoverTemplateKey` and the load's heal) anchors only at a prefab INSTANCE, and the roots the unpacked nodes derived from are plain now. It used to try any ancestor with a guid, so a node a template adds directly under a template reference root got its key back from the unpacked root (the #1874 review). A Detach aimed at anything but an instance root is refused (`detachRefusal`, the agent `detach`'s answer; the Hierarchy offers it on instances only): a node a template adds is part of its instance and is refused naming that instance's root, as a member is, and a plain entity nothing supplies is refused as not an instance. Before, a template node holding a nested instance unpacked it, lost its own key, and could then move out of its instance. Detach has no one-level mode, so there is no surviving nested frame whose keys would have to stay. Measured live and across a reload: `prefabDetachTemplateKeys.test.ts`. Anything but an OUTERMOST instance root is refused on both surfaces, naming that root: a MEMBER (#1764, hub ruling on the owner's Unity rule) and, since #1869, an OWNED nested root too — Unity's `UnpackPrefabInstance` throws unless `IsOutermostPrefabInstanceRoot` (CS `Editor/Mono/Prefabs/PrefabUtility.cs`, `UnpackPrefabInstance`'s argument check: "UnpackPrefabInstance must be called with a root Prefab instance GameObject."). Unpacking a nested prefab restructured its outer instance, and a Revert of that instance then respawned the nested row beside the unpacked copy on one guid (#1792's third route). A stored root the scene added inside another instance is its own outermost root and detaches. (#1831's G1 study found this divergence first, from hunt seed 6302, which starts from such a detach.) `detachRefusal` is the one predicate. The agent refuses with its text, the Hierarchy's row is greyed with it as hover text, and the shared wrapper refuses a member itself. Before, the Hierarchy quietly detached the root, and the agent unpacked only the member and answered ok. | match |
| U18 | Prefab Mode, isolation | The scene is hidden and the prefab is edited alone. [M6 `EditingInPrefabMode`] | Double-click opens it alone (`openPrefabForEditing`). § "Prefab edit mode". | match |
| U19 | Prefab Mode, in context | The scene stays visible but locked, shown gray, normal or hidden. It is the default for Open from the Inspector. [M6 `EditingInPrefabMode`] | None. | **missing**, L |
| U20 | Opening and nesting Prefab Mode | Open button / P key on an instance; opening a nested prefab stacks a breadcrumb. [M22 `EditingInPrefabMode`] | Only from the Assets panel. `editingPrefab` holds one prefab, and the breadcrumb is always `scene › prefab`. The Inspector's source link only selects the asset. | **missing**: Open S, the stack M |
| U21 | Saving in Prefab Mode | Auto Save is on by default and can be turned off. With it off, Unity asks on exit. [M22 `EditingInPrefabMode`] | Cmd+S only. Leaving asks through the unsaved-work modal. Entering, by contrast, saves the open SCENE without asking (`openPrefabForEditing`), which Unity does not do. That silent save is one way #1699 is reached. It is skipped when the caller asked to discard the scene's edits (the agent's `discardUnsaved`), and when a newer scene request superseded the open while it waited (#1745). | **diverges**, mild: Modoki behaves like Unity with Auto Save off. The owner rules on it (S if wanted). |
| U22 | Replace an existing prefab asset with a scene object | Asks first. "Unity tries to preserve references to the prefab and the individual parts… it matches the names of GameObjects." [M6 `CreatingPrefabs`] | Asks first (`confirmReplaceAsset`) and keeps the file guid. Each row keeps its `nodeGuid` where the replacing tree holds a member of the prefab it replaces, then by Unity's name rule; a name two nodes share, on either side, mints rather than guesses (#1686, `nodeGuidsFor`). A matched row keeps its `localId` too, and a new row is numbered above the old document's max: Unity's fileIDs are never reused (#1759, `replaceNumbering`; a pre-v5 document with no `nodeGuid` keeps positional numbering). Every other instance is rebuilt from the new document (`commitPrefabWrite`, #1685 fixed by #1692). | match (Modoki refuses Unity's "unpredictable" duplicate-name match) |
| U23 | Replace the asset of an instance | Swap which prefab an instance uses, from the Inspector's Prefab field or Hierarchy › Prefab › Replace, with "Replace and Keep Overrides" or "Replace and discard any overrides". Objects are matched by name or by hierarchy path (`ObjectMatchMode`). By default no property override is deleted; `PrefabReplacingSettings.prefabOverridesOptions` can clear them. [M6 `CreatingPrefabs`, S6 `PrefabUtility.ReplacePrefabAssetOfPrefabInstance`, `PrefabReplacingSettings`] | None. `PrefabInstance.source` is write-refused on every generic edit path (`traitEditPolicy`). | **missing**, L. The U22 matcher (`nodeGuidsFor`) covers `ByName`; `ByHierarchy` would be a second key on it. |
| U24 | Create a prefab from a plain object | Makes an original prefab, and the object becomes its instance. Child instances become nested. Their modifications go into the new asset, unused overrides included. An instance whose asset is missing is refused only when Unity has nothing to restore it from — "Can't save Prefab instance with missing asset and scene backup as a Prefab. You may unpack the instance and save the unpacked GameObjects as a Prefab." — that is, one neither merged before its asset was deleted nor holding a scene backup; one merged before the delete is saved. [S6 `PrefabUtility.SaveAsPrefabAssetAndConnect`, M22 `UnusedOverrides`, CS `PrefabUtility.SaveAsPrefabAssetArgumentCheck`. This row said "cannot be saved" without that condition until #1862 read the source.] | The same (`createPrefabFromEntity`, then `tagCreatedPrefab`). **Part of a prefab instance is refused** (#1869, hub ruling on #1792): an object the prefab supplies (a member, an owned nested root, a node the prefab added) is not saved as a prefab of its own, as Unity's `SaveAsPrefabAssetArgumentCheck` throws "Can't save part of a Prefab instance as a Prefab" unless the object is its own outermost instance root (CS `PrefabUtility.cs`, `SaveAsPrefabAssetArgumentCheck`, which compares the object with `GetOutermostPrefabInstanceRoot`). `partOfInstanceRefusal` is asked by `createPrefabFromEntity` (the Hierarchy, whose item is greyed with it as hover text, and the Assets drop) and the agent `prefab create`. Making a member the root of a new prefab restructured its instance, and a Revert of the row it left respawned it beside the new root on one guid (#1792's second route). Nested instances below the root become reference rows. **A resource entity is refused** (#1873 L2, `RESOURCE_PREFAB_TEXT`, both routes, the Hierarchy's item greyed with it): a world singleton tagged as an instance made every placed copy a second singleton. **Owner ruling D (#1790, relayed by the hub), per case:** (1) a live frame in the tree whose nested prefab could not be expanded (it does not load, or loads to no root) is REFUSED, naming the member and the prefab (`unexpandedNestedRefusal`). That is Unity's condition: a row the frame never expanded has nothing to restore it from. A nested frame KEPT across a rebuild after its prefab went (#1862) is live and off the `unexpanded` list, so it is written as a reference row from its record, as Unity saves an instance merged before its asset was deleted. It is asked after the nested warm, so a merely cold key is not refused. (2) What R2 kept for a swallowed root (an orphan member row, a legacy channel into a row its template lacks: Unity's unused overrides) is BAKED into the new template's row (`bakeKeptState`, through `templateRowOf`, which strips scene identity for #1293). A root that becomes a member of the new instance keeps only the orphan's identity (pinned `guid`, `name`) in the scene, moved to the new root in member-row form (`settleSwallowedKeptState`). A root the new instance's member rows do not name is left whole: a still-stored scene-added reference node, which the scene save writes over the template's node, and every root when the tag linked nothing. A kept LEGACY channel is baked through `toTemplateStructure`, so its nodes lose their guid and a `moved` (a scene guid) is not carried. The refusal is asked after a warm that also reaches every prefab the live documents nest (`preloadNestedPrefabsForSubtree`), so a nested row the scene removed is not refused while its prefab is readable. Create Prefab's undo restores the store. Its untag, and the tag, resolve the prefab by the document's own guid (`instanceSourceRef`, #1807), not by a path through the manifest, which follows a move only at its next push: right after a rename's undo it still named the renamed path, the untag matched nothing, and the tree stayed linked to the trashed prefab. The agent `prefab create` op calls the same two helpers. **Apply's promotion of a scene-added reference node follows the same ruling (#1802):** its recapture runs in the same bake scope (`withKeptStateBake`, one try/finally scope for both writers), so the promoted row carries the node's kept state in template form, and after the refresh the same settle moves the orphans' identity onto the instance's stored root (the node, given its guid back by `carryPromotedGuids`, is now a member of it). Apply's undo reloads the scene from its snapshot, which carries the store. A frame whose record says it could not expand a row (#1812) is refused even when the cache now holds the child. **A frame built from OTHER rows than the cache now holds** (I3, #1815) is refused too, on both callers with one wording (`staleFramesInTreeRefusal`, Apply's and Revert's `framesBuiltFromOtherRows` asked of every instance root in the tree, after the warm): the capture reads the cache first (`captureDoc`), and a row only the old document had came back as a template-added node. Refused rather than rebased, as Apply and Revert do. **Create Prefab from an instance ROOT is an unpack** (#1814, hub ruling under "prefab behaviour copies Unity"): the root's OWN kept state (its old prefab's orphan rows and legacy channels) is dropped, as Unity drops an unpacked instance's unused overrides. This is done in `tagCreatedPrefab` (`dropUnpackedRootKeptState`), after the tag and before the settle, and undo restores it. Two cases keep it: a Replace of the root's own prefab (the instance stays connected, so nothing is unpacked) and a tag that refused. **The modifications LEAVE the connected instance (#1932, R4-L1 finding 1):** the capture writes a nested frame's records into the new document's rows, so the tag takes each one the new base now gives off the entity that held it — a nested frame's members, a stamped nested root, a plain node a layer added (`clearCarriedRecords`, by `recordsOffBase`, the recorder's own diff; a record whose value still differs is kept, and a tag's record goes when the new row carries the tag), and the undo puts every entity's stored set back exactly. Unity's connected instance starts with an empty modification list, since the outermost instance owns it. Until #1932 the tag cleared only the entities it RELINKED: a nested member kept its records, the scene restated them on every save, and a later edit of the new prefab's nested copy never reached the instance, live or after a reload. That was a #1914 R3 regression: R3 removed the save's depth ≥ 2 subtraction, which had dropped those records as equal to the row, and gave Create nothing in its place. The sweep's keep branch is defensive: no route was found that leaves a captured record's value out of the new document (`createPrefabCarriedRecords.test.ts`). A Replace runs the same tag. | match |
| U25 | Create a prefab from an instance root | Asks: Original Prefab or Prefab Variant. The API makes a Variant unless the instance is unpacked first. [M22 `PrefabVariants`, S6 `PrefabUtility.SaveAsPrefabAsset`] | Always an original: the root instance is flattened, nested instances stay reference rows, and the live tree is relinked to the new prefab. That is Unity's "Original" branch. | **diverges**: the Variant choice waits on U3. |

### Identity, undo, runtime

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U26 | Object identity inside an instance | Objects in a prefab have fileIDs. A reference into an instance goes through a stripped placeholder: the source fileID plus the `PrefabInstance`. [M6 `yaml-prefab-serialization`] | `nodeGuid` names a template node. A member's guid is pinned on its member row (scene v16), so a scene reference survives a template renumber. § "Identity" (I4–I8). | match by design. Open breaks: #1659, #1680. |
| U27 | Undo | Apply, Revert, Unpack and Replace record undo when run as a user action. Leaving Prefab Mode drops that prefab's undo history. [S6 `InteractionMode`, M22 `EditingInPrefabMode`] | Apply, Revert, Detach and Create Prefab are undoable (`applyToPrefabWithUndo`, `revertOverridesWithUndo`, `detachPrefabInstanceWithUndo`). **Create Prefab's undo unlinks the tree and LEAVES the prefab file on disk**, the Hierarchy's as the agent `create` op's (#1795, hub ruling (i) 2026-09-29, Unity: undo reverts the scene object's connection, never the asset's creation). It used to trash the file, and a scene saved in between (a Cmd+S, an Apply's undo) still named it, so the next reload from disk made the tree a Missing Prefab nobody deleted. A file left behind is an ordinary unused asset. **The undo gives a node born since the create the guid a load gives** (#1908, a Replace's undo too): the reversed rename (#1461) puts back only what the create's stamp renamed, so a node that a prefab-edit save added to a swallowed instance kept the guid it derived through the new prefab's frame, which the undo removes, and a reload or a rebuild derived another (hunt seed 7035). `rederiveUntaggedTree` derives it again from the stored root it belongs to, and leaves every guid the rename put back as it was. The redo re-links to it and writes nothing while it holds the document (its bytes, or the same document under a raised #1774 mark, which is how #1821's refusal went away), reading it where its guid lives NOW: a Rename since moves it, and another prefab created at the freed name may hold the path this step first wrote (hunt seed 6029); it writes it back, over nothing, only when it was deleted since; and a file changed since (a prefab-edit save, an outside edit) refuses the redo before any change (I10), since the re-tag plans the tree against the rows it wrote. The agent `create` op runs this same step (#1873 C1). The undo refuses a tree the file's changed document rebuilt since (a prefab-edit save or an outside edit rebases the instance; unlinking it would keep the change as plain entities), `createdFrameRebuiltRefusal`, since the undo has no file write left to be conditional on. **A Replace is the deliberate difference:** its undo RESTORES the document it overwrote (#1264; every route: the agent `create` IS `createPrefabFromEntity` since #1873 C1, and replaces only with `replace:true`), in memory since #1868, and Save writes it. That loses nothing and keeps the prefab's guid, so no scene can dangle, and the ruling was about a CREATED file. **Leaving prefab edit drops its history** (owner, 2026-09-28, #1704): however the edit world is left (Exit, a scene load, opening another prefab, re-opening the same one from inside it), the adoption owner drops its stack instead of parking it (`sceneAdoption.ts`, S8), so a re-open starts with nothing to undo. It used to be kept, and after an outside write (an Apply, a Replace, a checkout) it replayed onto a changed document: an undone delete came back at a number the Apply had given another row. **One deliberate difference:** an asset-document entry recorded there (material, clip, particle…, `_isFileDirect`) survives, parked under the prefab's key as it is across any discard: it edits another file, and dropping it would strand an asset edit with no undo (#1409). Like every asset-document entry, its undo and redo refuse unless the asset still holds that step's side, so an edit made to that asset elsewhere since is not reverted (#1710, [editor.md](editor.md) § An asset-DOCUMENT undo checks the asset still holds its side). Re-opening the prefab you are already editing also drops the history: that rebuilds the world from disk, which an outside write can have changed during the visit (the hot reload skips the edit world). | match, except the asset-document entries above. |
| U28 | Runtime instantiate | `Object.Instantiate` makes no prefab connection. [S6 `Object.Instantiate`] | `spawnPrefabInstance` stamps `PrefabInstance` on every spawned entity, and nested rows expand at load, not at build. | **diverges**, deliberate: the runtime uses `PrefabInstance` for member guids and frame identity. The owner rules on whether it stays. |
| U29 | Reordering children inside an instance | Not an override since 2022.3. Existing reorder overrides are discarded on upgrade. [M22 `UpgradeGuide2022LTS`, <https://docs.unity3d.com/2022.3/Documentation/Manual/UpgradeGuide2022LTS.html>] | The prefab's own children keep the prefab's order (#1869, U7's predicate with `reorder`): a Hierarchy sibling drop, a reparent that names a `sortOrder`, and a `sortOrder` field write (the Inspector, `set-traits`, `apply-scene-ops`) are refused on one. A node the scene added takes any place among them: the Hierarchy's renumber after a tie leaves the prefab's children where they are and numbers only the rest (`siblingKeepsItsPlace`), and a tie between two of the prefab's children leaves no room between them, refused in its own words (`stuckDropText`) rather than renumbering them. A `sortOrder` override a file already holds loads and saves unchanged (Unity discards one on upgrade; Modoki migrates nothing). An instance ROOT's place among the scene's own entities is still its override (I21). | match (existing overrides kept, not discarded) |
| U30 | Duplicate a child of an instance that holds a nested instance | The duplicate is an added GameObject override, and the nested prefab instance inside it stays a prefab instance. (No Manual page is cited: this is the hub's reading, recorded with its ruling.) | The same since #1756 (hub ruling on the owner's Unity rule, 2026-09-28): each copied node keeps its link only while the frame it is a row of is in the copy. A nested root whose owner stays behind becomes an independent instance (#1354's ruling, at any depth), a scene-added instance stays one, and the members of the frame left behind become plain added nodes. Before, the whole copy was flattened to plain nodes. | match |

**Not covered:** Unity's unused-override cleanup ([M6 `UnusedOverrides`]) and its handling of Unpack on a
nested instance inside an outer scene instance (no official page). Modoki's Detach allows the latter, and what
the outer instance records for it was not checked.

## Concept

When you "Save as Prefab" on a selected entity, its whole descendant subtree is
written to a `.prefab.json` with stable per-entity `localId`s (1-based, BFS
order, root = 1). Dropping that prefab into a scene spawns a fresh copy of the
subtree and tags every spawned entity with a `PrefabInstance` trait. The scene
file then stores just the instance root plus its overrides — not the children.

## PrefabInstance trait

`runtime/traits/PrefabInstance.ts` marks every entity spawned from a prefab:

```ts
const PrefabInstance = trait({
  source: '',          // path/GUID of the source .prefab.json
  localId: 0,          // which localId this entity is within the prefab (root = rootLocalId)
  rootInstanceId: 0,   // ECS id of the instance root (shared by all entities in the instance)
  parentLocalId: 0,    // for a NESTED instance: localId of the nested-prefab row in the immediate parent (0 for top-level)
});
```

`rootInstanceId` ties an entire instance together: editor operations
(override capture, apply-to-prefab, instance refresh) query all entities sharing
a given `rootInstanceId`.

## Prefab file format

Defined by `PrefabFile` in `editor/scene/prefab.ts`:

```ts
interface PrefabFile {
  id?: string;          // stable UUID, written once, survives renames/moves
  version: number;      // PREFAB_FORMAT_VERSION of the writer (runtime/core/version.ts)
  name: string;
  rootLocalId: number;  // localId of the root entity (1)
  nextLocalId?: number; // v8: the localId high-water mark — see "The localId high-water mark"
  entities: PrefabEntity[];
  moved?: Record<string, string>;
}

interface PrefabEntity {
  localId: number;
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;
}
```

Each `PrefabEntity` stores its traits with `EntityAttributes.parentId` remapped
from ECS ids to `localId`s. `serializePrefab()` clears `EntityAttributes.guid`
on every prefab entity — a prefab is a template, so per-instance identity is
assigned on the live entity at instantiation, not baked into the file (otherwise
every instance would start with the same stale guid). The same holds for an `added` node inside a
nested row: it carries a template `key` instead of a guid, and each instance derives the guid from
that key (#1387). A ref from one member to another is written as a member token
(`@member:<path>`) and resolved per instance (#1352). Both are in [scene-loading.md](scene-loading.md)
§ "Guid uniqueness is a PER-FILE rule", "Template identity". The prefab file never carries
`PrefabInstance` traits; those are added programmatically on spawn.

## localId stability — an external address space

> **Illustrates I4 and I5** (a `localId` means something only with its document; only a write mints identity).

A prefab's `localId`s are not an implementation detail: they are the address space a **scene's**
`overrides` / `removed` / `removedTraits` are keyed in (see "Scene-instance format" below). A
re-save must therefore never renumber a surviving member — doing so silently repoints or drops
every override on every instance of that prefab.

The address space outlives the file, so the blast radius is wider than the scene JSON. Every
consumer below resolves a member BY localId, and each is a place a renumber goes wrong quietly:

- **`runtime/loaders/loadSceneFile.ts`** — matches each prefab member to its scene row on load.
- **`runtime/scene/sceneMutate.ts`** — writes a mutation into `overrides[localId]`.
- **`runtime/scene/transformSpace.ts`** — reads a prefab-instance ancestor's Transform out of
  `overrides[localId]` rather than its `traits`.
- **`editor/panels/ApplyPrefabDialog.tsx`** — pairs a live instance entity to its template row.
- The live **`PrefabInstance.localId`** trait, which carries the id on every spawned entity.
- **`editor/scene/prefabLink.ts`'s `tagEntityTreeAsInstance`** — stamps that trait after a Create
  Prefab, so it must assign the SAME ids the file just got.

⚠️ **That last one had its own numbering and they disagreed (#1278).** `serializePrefab` collapses
a nested instance below the root to one reference row and drops its members from the numbering;
`tagEntityTreeAsInstance` numbered the full `collectTree`. So after Create Prefab on a tree holding
a nested instance, every member ordered after it was live-tagged one higher than its row — and
because BFS visits a nested instance's members *last*, the divergence only appears when a surviving
entity sits deeper than the dropped ones (`R → A, Hull(instance), B → C`: `C` is row 5 and was
tagged 6). `captureInstanceOverrides` on the next save then paired each live entity with the wrong
row and wrote overrides under an id denoting a different member, silently.

The first fix had tagging mirror the written file row-by-row, and **close-out review found that
still wrong** — it inferred membership from the hierarchy, and "every descendant of a nested root"
is wrong in both directions:

- An **owned** grand-nested instance (`parentLocalId > 0`) is *not* dropped by the serializer.
  `captureInstanceStructure`'s `captureChild` returns `null` for those, so they never enter
  `consumedEcsIds`, and being self-rooted they are not members either — they get a reference row
  of their own. Skipping it shifted every later row by one, and the entity whose row went missing
  was left with **no `PrefabInstance` at all**.
- `memberEcsIds` is a **world-wide query on `rootInstanceId`**, not a subtree walk, so a member
  reparented out of its instance is dropped while sitting outside the subtree.

So the inference is gone. **`planPrefabRows` owns the decision and both `serializePrefab` and
`tagEntityTreeAsInstance` call it.** **Anything that needs a member's localId calls the planner;
nothing re-derives it.**

⚠️ **One decision procedure is NOT one answer, and this is the part that is easy to get wrong
twice.** The callers must also feed it the same inputs, at the same time, and they do neither for
free:

- **Different arguments.** The planner takes `preserveLocalIds` and `existingId`; tagging passes
  neither. So tagging does not NUMBER at all. It reads each row's localId from the written file,
  which is the plan's record (#1759). A Replace keeps every matched row's number
  (`replaceNumbering`), which a positional re-plan could not reproduce. The modules that preserve
  (prefab-edit re-save) still never tag, and the modules that tag never pass a preserve map; they
  reach a kept numbering only through `serializePrefab({ replacing })` and the file. That is pinned,
  with its accept case, by `engine/tests/architecture/prefabTagNeverPreservesLocalIds.test.ts`,
  because a prefab-edit "save and relink" would reintroduce #1278 silently.
- **Different times.** `serializePrefab` plans, then the caller **`await`s the file write** — on a
  Replace that await contains the `confirmReplace` **dialog**, an unbounded wait during which MCP
  ops and the file-watcher's scene reload keep running. Tagging then plans again over world and
  prefab-cache state that may have moved. So tagging takes the written `PrefabFile` and checks its
  plan against it (`planMatchesFile`: the row count, which rows are nested, each row's name, and,
  through the plan `serializePrefab` recorded by durable guid, that the entity at each row is the one
  written there), and **refuses to tag on a mismatch**. Tagging without the file numbers by position
  and warns, since that matches only a first create. That degradation is
  chosen deliberately: an *untagged* entity round-trips as an `added` node and loses nothing,
  whereas an entity tagged with a localId the file has no row for is written to **neither** the
  scene entry (serialize drops it as a prefab child) **nor** the overrides — it is simply gone on
  the next load.

### The localId high-water mark (#1774, prefab v8)

**The defect.** A member's derived guid is a hash of its localId path. If a number is handed out twice, the
new node gets the guid of the member that last held it, and every ref still naming that member lands on
the new node, silently. Each writer numbered new rows above the rows it could SEE. That stopped reuse
within one write (#1759, #1771) and within one prefab-edit session (#1662, #1704), but not across writes:
delete the top row B(3) and save, then add C in a later session, and C took 3 and B's guid.

**The fix (owner ruling B).** The document persists the mark, `nextLocalId`: the lowest number a new row
may take. Every number the document has ever used is below it, and it never goes down. Unity avoids the
problem with random fileIDs instead; the owner kept sequential numbers, which are used elsewhere too.
`runtime/core/localIdCounter.ts` owns both halves:
- **Read.** Every allocator seeds from `localIdCounter(doc)`: max(the stored mark, the highest row + 1,
  the root + 1). A file with no mark (anything before v8, or a hand edit) derives it from its rows, so
  there is no migration.
  **A number a loaded file still names is reserved too** (#1933 S5, hub ruling A). A legacy record of a
  member deleted from a pre-v8 document is kept as an unused override (F5, I18), but that document's
  derived mark reads the freed TOP number as free, so the next new member took it and the record landed
  on it. When the load finds such a record, it reserves the number for that document's guid
  (`reserveLocalId`): a localId channel's record in `unusedLocalRecords`, and a path-keyed channel
  (`nestedOverrides`/`nestedStructure`) naming a frame row the document lacks in `legacyPathDoc`.
  `localIdCounter` reads the reservation, so every allocator mints past it. The commit judges "the file
  already holds the mark" by `storedLocalIdCounter` (the document's own mark and rows, no reservation),
  so the next write of the document states the mark past it, an undo's verbatim restore included, and
  the persisted mark keeps it from then on. The reservation lives in memory for the renderer's life
  (opening another project reloads it). A scene this session never loaded reserves
  nothing; the complete answer, a one-time project scan when a mark-less document first gets its mark,
  is recorded on #1933 as the owner's option. The repo held 0 such records when this landed.
  The allocators:
  - prefab-edit's session floor (`usedUpTo`)
  - a Replace's `replaceNumbering`, which also covers the agent `prefab create` over a path
  - Apply's promotion (`planApply`)
  - `mergeRiggedPrefab`

  `serializePrefab` states the mark on what it writes: above its rows, its session floor, and the document it
  replaces — a rebuild over a file (`serializeRebuildOver`, #1782) replaces it too.
- **Advance.** `commitPrefabWrites` is the line under every writer, because every client prefab write
  goes through it (I9). Its `contentFor` raises a document's mark to that of the file it lands over. That
  file is `expected`, or the file re-read when that is what the precondition matched. A write that lowers
  nothing, and that states its mark whenever it claims v8, goes down exactly as built.
  - **A raised mark claims v8.** The document is stamped v8 (`LOCAL_ID_MARK_VERSION`, the version the field
    arrived in, not whatever `PREFAB_FORMAT_VERSION` is by then) so an older build refuses to save over it
    and drop the mark. A document newly given the mark carries it right after `rootLocalId`, where the
    serializer puts it.
  - **A document that claims v8 states its mark, whoever stamped the version** (#1797). `contentFor`
    also writes through a document at v8 or later whose `nextLocalId` is absent or not a positive
    integer (`markUnstated`, `localIdCounter.ts`), and states the mark from its rows. The commit is the
    ONE owner of that rule. Apply's write into an ENCLOSING prefab stamped v8 on a clone of a file that
    had no mark, and nothing raised it, because no prior was higher. A writer may still state the mark
    early, where it records the bytes it will write (`serializePrefab` does), but none has to.
  - **An undo that restores bytes** (#1679) stays verbatim unless it would lower the mark, or the bytes
    claim v8 without stating one. Undoing a write
    that minted numbers must not free them: Apply adds C at 4, Cmd+Z, the next Apply adds D at 4, and D
    takes C's guid. When the mark must rise, `withTopLevelNumbers` splices the mark and version into the
    original bytes, keeping formatting, key order and a BOM. It re-serializes only when it cannot prove
    the splice exact (for example, a key spelled twice).
  - **Preconditions** (`sameDocument`) therefore compare neither the mark nor the version. The commit owns
    both where it raises the mark, and only ever raises them. So a file that differs from what the caller
    read in those alone holds nobody's change. The case this covers is an undo's redo: its expectation is
    the bytes the undo recorded, which predate the mark the undo had to keep.
  - **So does every other "is this the same document?" question, through ONE rule** (#1892):
    `documentContentKey` / `sameDocumentContent` in `localIdCounter.ts`. The other caller is the
    stale-frame compare (`staleFrames`, I3): was this frame expanded from another document than the cache
    holds? It had its own copy, a raw `JSON.stringify`, which never got the exemption. An Apply's undo
    parks the pre-Apply rows with the mark raised, so every frame expanded before that Apply read as stale,
    and each rebase caller respawned it for nothing. Create Prefab's undo also took the rebase as "the template
    changed since the create", and its redo refused in a clean segment (hunt seed 3097). The mark and the
    version change no row, and nothing that expands a frame reads either one, so a frame that differs in
    them alone is current. ⚠️ The fuzz harness had a THIRD copy that #1892 missed: its #1820 paste check
    (`requirePastedFramesCurrent`, `prefabFuzz/ops.ts`) still compared raw JSON. A paste of a copy taken
    before an Apply that was then undone passed the product's check and failed the harness's (hunt seed
    3066, #1913). The harness now states the rule ONCE, in `markFree` (`prefabFuzz/checks.ts`), which the
    paste check, the hand-edit matching, I15's carry and `diffFiles` all use. It does not import
    `documentContentKey`, so a defect in which fields that sets aside is not inherited (the paste check
    does share the product's key sort, `canonicalJson`). When the rule changes, change it there too:
    `documentContentKey`'s docblock says so, since a rule narrowed only in the product goes unnoticed.
  - **The route's refusal counts as a conflict.** `prefab-mark-lowered` from the route means the file's
    mark rose past what the write was raised to (a later undo already kept it). The commit then re-reads
    the file and raises from it, like any other precondition miss. Without this, undoing two minting Applies
    in a row refused the second undo and dropped the history entry.
  - **Known residual (close-out review, PLAUSIBLE, not reproduced).** Suppose another writer mints a
    number and then gives it back (its row is removed, its mark stays) while a caller holds an older
    read. That caller's write can land a node it minted at that number, because the document matches the
    read apart from the mark. A check against it misfired on every redo: the numbers a redo restores are
    ones its own forward write took and its undo kept. It needs two writers on one prefab inside one
    read-to-write window.
  - **A failed multi-file commit's rollback** puts the prior bytes back with the mark its write raised.
- **The server gate** (`classifyPrefabMarkWrite`, `plugins/prefabWriteGuard.ts`) stops a raw write. It
  skips a create-only write, which `if-none-match` refuses for its real reason. On
  `/api/write-file` it refuses (409 `prefab-mark-lowered`) any prefab write that would lower the mark of
  the file on disk. The route is byte-opaque and reachable without the editor's commit: an agent's eval,
  a game panel's `writeAssetFile`, or the Assets panel's OS-drop import over an existing file. The
  editor's own writes never trip it.

Server-side rewriters, duplicate, the GUID heal and the migration scripts all parse and spread the document, so they
carry the mark. None of them mints. (The member-path repair, `/api/prefab-member-paths`, went in #1868; #1784 had made
it write only over the text it planned from.)

Tests:
- `tests/editor/localIdCounter.test.ts` covers the #1774 repro, one case per minting writer, and the
  chokepoint (including that an undo restore is byte-equal except the mark).
- `tests/architecture/localIdAllocatorsReadTheMark.test.ts` checks that each allocator calls the mark.

A nested row is not retagged onto the new prefab: it keeps its link to its own child prefab and
receives only `parentLocalId`, exactly as `instantiatePrefabIntoWorld` does on reload, and its
members are left alone. **The invariant to hold on to is that the live world after Create Prefab
equals the world after a save + reload** — that is the only bar that catches this class. Holding it
meant splitting capture from strip: `detachPrefabInstance(root, { strip: false })` snapshots for
undo without severing links the tagging deliberately will not restore.

⚠️ **Dropping the strip means the tag write must name every field.** koota's generated setter is a
**partial merge** (`if ('k' in value) store.k[i] = value.k`), so an omitted field silently keeps its
previous value — which the old strip-then-add had reset. A surviving `parentLocalId` makes
`serialize.ts` classify the row as an *owned* nested instance (`IdentityParents.frameOf` finds an owner),
which writes **no scene entry for it at all**, and the freshly created prefab link is gone on the
next reload.

`serializePrefab`'s default numbering (no `opts`) is **positional** (`i + 1` over the BFS-ordered
tree) — correct for "create a prefab from an entity", where there is no prior numbering to
honour, but wrong for re-saving an existing file authored with a gap (a member deleted earlier
compacts every id after it on the next save). Measured on sling's `FieldCorner.prefab.json`:
`drip` moved localId 4 → 2.

**`serializePrefab(selectedEntityId, existingId, opts)` takes two options that fix this for a
re-save:**
- **`preserveLocalIds: Map<ecsId, localId>`** — every surviving member keeps the id it already
  had; a member with no entry (added during the edit) is allocated **above the highest preserved
  id**, never into a freed gap.
- **`name: string`** — keep this as the file's `name` instead of defaulting to the root entity's
  name (see "renaming the root" below).

Prefab-edit mode is the only caller that supplies `preserveLocalIds`. It is **not** the only path
that re-serializes an existing file — there are **six** writers, and the census that keeps them
honest is `tests/architecture/prefabSerializeCallSites.test.ts`, which fails when a seventh appears
without saying where its file guid comes from:

| Path | File guid | localId behaviour | Node identity (v5) |
|---|---|---|---|
| **prefab-edit save** (`savePrefabEdit`) | the open session's own | **preserved** — the mechanism below, including members added during the session (#1662) | **carried**, via `preserveNodeGuids` from the baseline document, or from what an earlier save of the session wrote |
| **rigged model re-import** (`ModelAssetView`) | `classifyExistingPrefabId` | preserved by a *different* mechanism: serialize positionally, then `mergeRiggedPrefab` matches bones by NAME so their localIds stay stable and user-added children stay attached | **carried** by that same content match |
| **2D skin rig write** (`skinPrefab.ts`) | `classifyExistingPrefabId` | **renumbered** — the subtree is rebuilt from `rigDef.bones`, so ids follow the rig definition, not the file | **minted** — a rig subtree has no correspondence to the old rows |
| **`prefab` agent op, `create` over an existing path** | `classifyExistingPrefabId` (throws on an unreadable file) | **renumbered** — it replaces the template with a scene entity tree, which is the intent | **carried** when the live tree is an instance of THIS prefab, then by a unique name (the Replace rule, #1686), else minted |
| **Assets panel → Import Model** | `classifyExistingPrefabId` | **renumbered** — a fresh GLB tree | **minted** |
| **Create Prefab → Replace** (`assetOps.ts`) | supplied later, by `writeNewAssetDocument`'s `build(guid, kept, previous)` | **renumbered** | **carried**: the build callback serializes the tree again against the kept guid, with the replaced bytes as `replacing` — the live `nodeGuid`, then a unique name (#1686). The draft, serialized before the kept guid is known, minted every row. |

The renumbering rows are the same hazard this section describes, left as-is because they
*regenerate* a template from a source of truth rather than round-tripping the authored file.

⚠️ **What prefab v5 changes about that hazard, and what it does not** (#1468). Every row now carries
a minted `nodeGuid` beside its `localId`. It does not stop the renumbering — `localId` is still the
document's array key and still positional. What it removes is the *silent* failure: a freed localId
is REUSED, so a stored key naming it comes back pointing at a **different member**, plausibly and
with nothing to report it. A minted guid is never recycled, so the same key can only ever **dangle**,
and a dangling key is something a reader can detect. Identity is carried where a real correspondence
exists (the table above) and minted where none does — minting is the honest answer there, not a
fallback.

⚠️ **And a dangling key is now detected rather than merely detectable.** Scene v16 stores each
member's guid in the instance's entry, keyed by that `nodeGuid`, so a key the template no longer
declares is reported by name on load and kept in case the template edit is undone. That is the other
half of the argument for minting: without a reader that notices, "can only dangle" is a property
nobody observes. See `docs/prefab-structural-overrides.md` § *Member identity is STORED, not
derived*.

⚠️ **A NESTED reference row's identity lives in `PrefabInstance.parentNodeGuid`, not `nodeGuid`.**
The live entity for such a row is the CHILD instance's root, whose `nodeGuid` is its identity in the
child document — so the outer document's identity for that row rides beside `parentLocalId`, in the
guid twin of it. Without that field a re-save of the outer prefab minted a fresh identity for the
nested row every time, and every scene key naming anything inside that expansion dangled.

The preserving mechanism, in `prefabEdit.ts`:

- **Sentinel guids carry the file's numbering through the edit world.** The loader reassigns ECS
  ids densely on load, so by the time the synthetic edit world exists the file's own numbering is
  already lost (measured: `FieldCorner`'s localId-4 `drip` loads as ecsId 2).
  `buildPrefabEditScene` stamps `EntityAttributes.guid` on every member — the root gets
  `PREFAB_EDIT_ROOT_GUID` (`__prefab_edit_root__`), every other member gets
  `PREFAB_EDIT_LOCAL_GUID_PREFIX` + its original localId (`__prefab_edit_local__7`) — and
  `savePrefabEdit` reads them back via `collectPreservedLocalIds` before calling
  `serializePrefab`. Riding on `guid` is safe because `serializePrefab` clears
  `EntityAttributes.guid` on every row it writes (a template carries no per-instance identity),
  so the sentinel can never reach the file.
- **A member ADDED during the session keeps the row its first save gave it** (#1662). It has an
  ordinary guid, not a sentinel, so each later save used to renumber it above the preserved ids and
  mint it a new `nodeGuid`. Each prefab now has a save record (`sessionRowsByPrefab`): by live guid,
  read when the save serializes, the localId and `nodeGuid` each member was written at, plus the rows
  of every document an edit world was built from. `collectPreservedLocalIds` reads it beside the
  sentinels, so it survives a delete + undo (the respawn keeps the guid). **A localId is not reused
  while the record lives:** a new member is numbered above the highest localId the record has seen
  (`serializePrefab`'s `localIdFloor`; Unity never reuses a fileID either). A save that would still put
  two rows at one localId is refused, not written.
  ⚠️ **The record is per PREFAB, for the editor process, not per edit world** — what an undo can bring
  back outlives the world: Stop rebuilds it from a snapshot. Kept per world, a Play/Stop re-minted every
  added member (close-out review). Since #1704 leaving prefab edit drops its undo history (U27), so nothing
  from an earlier visit can be brought back into a later one, and what the record keeps across visits
  costs only gaps in the numbering. It was kept per prefab when the history still outlived the visit, and
  an undone delete from an earlier visit met its own number on a later newcomer.
  ⚠️ **A write OUTSIDE prefab edit between two visits** (an Apply appends at max+1, a Replace renumbers,
  a checkout) can give a remembered number to another row. A remembered added member yields: its number
  is trusted only where the current document has no row there, or that same row. A sentinel cannot tell,
  because `__prefab_edit_local__<n>` names row n of whichever document its entity came from. That was
  reachable only through the kept undo history, which brought back an opened row whose number such a
  write refilled (#1704, R2): the save refused the duplicate, and once the user deleted the other row to
  get unstuck, it wrote the undone row with that row's `nodeGuid`. Leaving prefab edit now drops the
  history (U27), which removes the case; the save still REFUSES a duplicate rather than guess.
- **`savePrefabEdit` REFUSES to save — rather than falling back to renumbering — when the opened
  file is no longer in the editor's prefab cache** (`getCachedPrefabSync` returns null). That
  cache is where the previous numbering and name come from; silently renumbering instead would
  break every scene override keyed to this prefab.
- **`rootLocalId` is the root's assigned id**, not a hardcoded `1` — with a preserve map it keeps
  whatever the file already used, and every `parentId: <root>` in the entity rows is remapped
  through the same table.

**Behaviour change worth knowing:** because `name` now comes from the previously-opened file
rather than the root entity, **renaming the root entity in prefab-edit no longer renames the
prefab asset.** It used to, by accident — `serializePrefab` defaulted `name` to `tree[0].name`,
which is why `cover-enemy.prefab.json` and `green-enemy.prefab.json` both became "Enemy" on a
re-save (their root entity is literally named "Enemy"). Rename the asset itself (file rename /
Assets panel) to rename a prefab going forward.

## Scene-instance format — how overrides are marked

In the scene file a whole instance collapses to **one entry** — an ordinary
`SerializedEntity` (`editor/scene/serialize.ts`) detected by the presence of its
`prefab` field, the prefab ref plus its deltas, never the expanded children (no
`type` discriminator):

```jsonc
{
  "prefab": "062bd887-…",                 // source .prefab.json GUID
  "overrides": { "3": { "Transform": { "px": 4.2 } } },  // localId → trait → field → value
  "removed": [7],                          // prefab-member localIds this instance deleted
  "removedTraits": { "5": ["Light"] },     // localId → trait names deleted from a member
  "members": {                             // v16: member identity → its row (#1468)
    "/5b2e…": { "guid": "0d7a…", "name": "Button", "parent": "9f1c…",  // `parent` only when moved (#1437)
                "traits": { "Transform": { "px": 4.2 } } },           // its overrides (Phase 4)
    "/77a0…": { "removed": true }          // a member this instance deleted — no guid, it is not live
  }
}
```

⚠️ **Since #1468 Phase 4 the localId channels above are the LEGACY spelling.** A member whose template
minted it an identity (prefab v5) has its edits on its `members` row instead — `traits`,
`removedTraits`, `removed`, `added` — so they follow the member through a template renumber. The
localId channels are still read, and still written for the instance ROOT's own edits and for a member
no row can key (a pre-v5 template's). The rule and the reasons:
[prefab-structural-overrides.md § A member's edits are stored on its row](./prefab-structural-overrides.md#a-members-edits-are-stored-on-its-row-phase-4).

A prefab FILE can carry a `moved` map of its own (v4, #1437): `"<member path>": "@member:<path>"`,
for a member it places under a parent no row relation can express. Both halves are member paths in
the prefab's frame. See [prefab-structural-overrides.md § Moved members](./prefab-structural-overrides.md#moved-members-1437).
A template REFERENCE node carries the same map for its own frame, as `templateMoved` (v7, #1543):
[§ A move inside a template reference node](./prefab-structural-overrides.md#a-move-inside-a-template-reference-node-1543-prefab-v7).

The marking is **presence-based, not a flag**: a field is "overridden" purely by
appearing in `overrides` (`localId → traitName → field → value`), and it stores **only
changed fields** (float compares use a `1e-6` tolerance). Anything absent is inherited
live from the prefab, so editing the prefab updates every instance that didn't override
that field. `removed` lists deleted members (descendants cascade — only the top-most is
stored); `removedTraits` lists per-member trait deletions. A nested (`v2`) instance also
gets `nestedOverrides`, keyed by a `path` of nested-row localIds, holding only what the
scene uniquely changed on top of what the nested row already overrides. On load,
`instantiatePrefabIntoWorld` re-expands the children and re-applies these deltas via
`applyOverridesByLocalToEcs`; the round-trip is covered in
[prefab-structural-overrides.md](./prefab-structural-overrides.md).

### A scene instance's root always records its place (#1914 R6, owner ruling F7)

One exception to "only changed fields": **every scene instance's ROOT records its `sortOrder`**, as Unity's file always
writes `m_RootOrder` on the root's Transform. The save states it as a root override
(`overrides[<PrefabInstance.localId>].EntityAttributes.sortOrder`) whatever it equals, so an instance's place among its
siblings never follows the template root's `sortOrder`, and a Missing Prefab placeholder loaded cold (the prefab deleted
outside the editor) spawns where it was (seed 7078, #1916's order half). **Accepted cost:** reordering a prefab's root
in its own file no longer moves existing instances.

The record is IMPLICIT, not stored: `getOverrideMarkSet` adds it for every root `recordsRootOrder` accepts
(`runtime/loaders/overrideMarks.ts`), so each route that makes such a root (a load, a drop, a rebuild, Create Prefab, a
paste) records it without seeding its own, and no unmark can take it back. The roots it accepts: a `PrefabInstance`
stored root with a durable guid and no template key, outside the prefab-edit world (`PREFAB_EDIT_ROOT_GUID`, now in
`runtime/core/prefabEditRoot.ts`; a template states a row's place in the row), and, inside another instance, only a node
the SCENE added. A template's copy of a reference node is excluded even after it lost its key marker (a Play→Stop or
an undo respawn): the editor registers that test (`setTemplateCopyTest`, from `prefabCache.ts`'s `recoverTemplateKey`),
since only its documents can tell. Because the mark rides the #1831 machinery, the order is a **default override**
(U10b): listed unchecked, left out of Apply All / Revert All.

⚠️ A load still STORES the mark it applies, since the overrides apply before the root's guid is durable. That stored
copy outlives a change of role: Create Prefab of the tree around a scene-added reference node makes the node a row of
the new template (stamped, or keyed by the capture under a nested instance), so `clearLinkedMarks` takes the order mark
off both (hunt seed 3297). For the same reason **a carrier never captures the order the role records**: every undo
snapshot, mark-state capture, copy and scene-swap carry reads `getCarriedOverrideMarks` (the stored set, less the order
while the role records it), and the role is read again where the marks are put back. Captured through
`getOverrideMarkSet` it came back stored: a scene instance pasted into prefab edit stated an order there (#1914
close-out review 2). The writes that must put back exactly what they took read `getStoredOverrideMarks`:
`restoreMarks`' unmark, `clearLinkedMarks`, and the frame-ending's relink record (`recordDetachedMarks`), which is taken
AFTER the frame-ending made the member a scene root it stops being once the undo relinks it. Read through the role
there, a legacy-moved nested root lost an order its file states (the re-review); read through `getOverrideMarkSet`, it
gained one it never recorded. A Missing Prefab ENTRY rebuilds its `EntityAttributes` in the order it read them
(`asSceneEntry`), so a live save's `{parentId, sortOrder}` does not come back reordered (hunt seed 1130).

### Editor writes and the override mark (#1709)

In the FILE an override is presence-based, as above. In the LIVE world it is a runtime mark
(`runtime/loaders/overrideMarks.ts`), and since #1914 R3c the save writes the marks themselves, each
recorded field with its live value whatever it equals (`recordedOverrides`), so a re-imported template
does not freeze an unedited instance's stale values: nothing recorded them. (Before R3c the same set was
derived as a mark gate over a value diff.) It also means an editor write that changes a member field
without recording it is dropped by the next save. **Nothing outside the write-time recorder decides a
record from a value comparison** (#1914 R8: `engine/tests/architecture/overrideRecordNoValueCompare.test.ts`,
an editor module that sets a mark, or calls the recorder's wrappers over it (`putMarkState`, `restoreMarks`,
`recordOverridesByDiff`, `writeTraitFieldMarked`), may not call a value comparator, with `overrideMarkWrites.ts`
sanctioned and `prefabBase.ts`'s document-vs-document left-behind reader exempt). #1709 found that
in the UI resize/move handles, in every `EntityAttributes.sortOrder` rewrite (reorder, sibling
renumber, reparent, duplicate, paste, scene move) and in re-adding a trait the template defines
(#1677). Undo had the opposite gap: it restored the value but kept the mark, so an undone edit was
saved as an override pinned at the old value, and later template edits stopped reaching it.

Every editor mark write now goes through `editor/undo/overrideMarkWrites.ts`, under these rules:

- **Every write records by diff and removes nothing** (`recordOverridesByDiff`, #1914 R2; owner
  rulings F2 and F3, 2026-10-01, Unity's `RecordPrefabInstancePropertyModifications`, "record
  property modifications by comparing against the parent prefab"). After the write, each field it
  touched whose live value differs from `instanceBase` is recorded; a field equal to it is left as it
  was. So typing the prefab's own value into a field with no override records nothing (F2), and a
  drag, reorder or re-add that lands back on the prefab's value KEEPS an earlier record (F3; before
  R2 it un-recorded it). The same rule serves a deliberate edit (`markOverrideIfInstance`: the
  Inspector, a gizmo commit, agent `setTrait`, Paste Component Values, which records only the
  fields it changed, F4) and a write the user did not aim at that field (`writeTraitFieldMarked` for
  every `sortOrder` rewrite, the UI handle commit, a re-added trait): a renumber records only the
  siblings it moved off their base, so the instance's child order is not pinned whole against the
  template. A record leaves the list only by Revert, Apply, or an undo.
- **A typed field records once per edit SESSION, not per keystroke** (#1914, the hub's #1922
  finding). An Inspector number field commits on every keystroke (#242), so retyping 200 over a
  base of 200 wrote 2 and 20 first, each differing from the base, and the rule above kept their
  record. Unity commits a typed field once, on Enter/blur, so there the retype records nothing. The
  field still writes live; what moves is the record's boundary. A field's `onChange` runs inside its
  edit session (`editor/undo/fieldGesture.ts`, `BufferedEdit.session`, bumped by focus, blur, an
  undo/redo step and a new owner, never by a keystroke). A write that continues the session's
  gesture first puts back the record the gesture began with (`entityActions`' `resumeGesture`), so
  the gesture leaves what it started with plus what its FINAL value differs in. There is no clock:
  a slow typist is one gesture. Since a focus event need not fire (#242), the gesture also ends when
  anything else was pushed to the undo stack in between, so a missed blur only joins two typings of
  one field with nothing between them. Outside a field session (an agent's `setTrait`, a scrub's
  frames) every write is its own gesture, as each scripted write is in Unity. It is deliberately NOT
  the undo's coalesce chain: two discrete writes inside its 500 ms window would be one gesture, and
  the second, landing on the base, would drop the first's record (F3).
- **Every undo puts back the marks it found** (`markStateOf` / `putMarkState`; a move's undo
  restores the whole set with `restoreMarks`; a renumber's undo is built by `makeSortOrderRenumberAction`). The
  snapshot must be taken before the edit's FIRST write: `reparentEntity` once took it after its own
  marked `sortOrder` write, and its undo put the new mark back. The gizmos' marks belong to their one undo builder,
  `buildTransformUndoAction`'s `markFields` (`editor/scene/gizmoUndo.ts`).
- **An undo that re-links or re-adds takes the marks with its snapshot** (#1794, #1800). Detach's undo, Create
  Prefab's undo (both through `reattachPrefabInstance`), Remove Component's undo, and the relink of members a
  frame-ending unlinked (a delete's, Detach's and a reparent's undo), and the members a reparent itself unpacks
  (#1450's root dropped under its own member, which #1869 keeps; a member it PROMOTES is saved as the standalone
  instance it became, whose overrides mark it again on the reload) restore values from their own snapshot, so
  they record the marks there too: `captureMarks` / `restoreMarks` (the whole set, or the one trait a step touches), and
  `recordDetachedMarks` / `relinkDetachedMembersMarked` for the members outside the tree. `relinkDetachedMembers`
  itself is L0 and cannot read the L3 store, so `DetachedMember.marks` is plain data the owner fills, and a member
  that no longer resolves when it is recorded gets NO record rather than an empty one (a multi-select delete can
  destroy a member an earlier target detached; its own snapshot restores its marks, and an empty record wiped them);
  `relinkPutsMarksBack.test.ts` keeps editor code off the bare relink.
- **What an undo leaves UNMARKED comes from the CURRENT template** (owner ruling on #1800, 2026-09-30; Unity always
  shows the current asset's value). A snapshot holds the values of the world it was taken in, so after a SAVED
  template change in between (leaving prefab edit, an outside edit, an Apply from another instance) restoring them
  verbatim showed the OLD template's values in the editor and in Play until a reload, while the save, which keeps only
  marked fields, wrote nothing and the reload showed the new ones. `putMarkState` and `restoreMarks` end with
  `takeUnmarkedFromBase`: the fields the save would DROP (the value diff against `instanceBase`, less `recordedOverrides`)
  take the base's value, so an added trait, a moved member's Transform and a marked field stay as restored; and a
  field an enclosing row states is left UNMARKED, as a load leaves it (I2, #1914). The delete's undo runs it over every
  respawned and relinked node after its rebase. A base value that still holds a member token after resolving is left
  as restored: Detach's and Create Prefab's undo re-link the tree root first, so when the root's pass runs no member is
  linked yet and its `@member:` refs cannot resolve (the close-out review caught the raw token written into a live
  `UIAction` target). Which route holds what (`overrideMarkUndo.test.ts`, each mutation-checked): a field write and
  Remove Component, the owner; a delete whose own frame's document changed, and Detach's undo, #1820's rebase and
  `reattachDetachedInstance`; a delete two levels down, where the document that changed is the one ABOVE the deleted
  node's frame so no frame reads as stale, the owner's pass in the delete's undo, over the respawned root and over a
  legacy member the delete unlinked where it stood. `relinkDetachedMembersMarked` itself runs no pass, since it runs
  before its caller's relinks and rebase settle the frame.
  **A plain node a template adds is covered too** (#1932, hunt seed 1224): it has no `PrefabInstance`, so the
  pass returned on it, and an undo across a saved change of the row that adds it restored the old row's values
  unrecorded, live, while the save dropped them. `takeUnmarkedNodeFromBase` diffs it against its template node
  (`templatePlainNode`, compared as the save's node diff compares; a second copy of `nodeDiffer`'s rule, noted on #1932's
  close) and takes the node's value for each unrecorded field
  (`plainNodeUndoTakesTemplate.test.ts`).

#### Why an undo cannot trust the side store (#1794, #1800, #1853)

The marks die with every world, and nothing carries them across a rebuild that keeps the undo stack: Play→Stop
(reloaded from the authored snapshot), leaving prefab edit (the scene reloads from disk), returning to a scene left
clean (its parked stack comes back), and a watcher reload for a prefab change. They come back only from the file
being loaded, and the file has nothing to mark a DETACHED tree or a REMOVED component from. So an undo that restored
the values and trusted the store for the marks held only while its forward step's world was still there: after the
rebuild the screen showed the instance's overrides, and the next save wrote the template's values. It was silent
data loss on an ordinary path (unpack by mistake, press Play, then Cmd+Z). #1853's three hunt seeds were the same
defect, reached by the harness's own final save→reload between a Detach and the walk back.

Unity has no gap here, because its override IS data. The `PrefabInstance`'s `m_Modifications` is serialized on an
ordinary object, and Undo snapshots it like everything else (Unpack registers `RegisterFullObjectHierarchyUndo`,
`PrefabUtility.cs`), and a removed component's overrides are kept as unused overrides, never dropped
([UnusedOverrides](https://docs.unity3d.com/6000.0/Documentation/Manual/UnusedOverrides.html)). Edit-mode undo also
survives Play mode (UUM-14824, closed As Designed). Modoki's FILE already has Unity's shape, since its override rows
are the recorded list. Only the live side is a separate store, which is why each snapshot must carry it.

**The load records only the writer's own statements (#1914 R1, 2026-10-01).** Until then the loader marked every
field ANY row stated, so a template row's value arrived as if the scene had typed it, and the editor re-derived around
that: #1893's `markEnclosingStated` marked an enclosing row's stated fields after every mark-settling write, the fold
skipped them, and the nested save subtracted them by value. All three are gone. What that blanket marking had carried
by accident is now explicit, per Unity's rule (a record is ADDED by a write, and taken off only by Revert, Apply or
Remove Unused):
- **Revert takes the record off** (`unrecordReverted`, after the rebuild and after its redo): the rebuild of a frame
  that states its fields whole (a template's reference node) puts the layer's value back as a statement.
- **Apply takes the record off** in the frame it came from, also when it writes an ENCLOSING row: `writeOuter`
  `took`s the field, and the refresh subtracts it from that nested frame's statement (`refreshInstances`'
  `frameEdits`; the Apply's own document through `nestedApplied`).
- **A copy that leaves its layers behind records what they gave it**: Duplicate/Paste of a nested frame makes it a
  stored root (`leftBehindReader` → `EntitySnapshot.layerMarks` → `copySnapshot`), and Create Prefab unpacks the
  selected instance, so its capture marks those fields for its duration (`withLeftBehindRecorded` around
  `serializePrefab`) and the new template's rows state them.
- **A whole list's copy of a template node takes that node's values as base.** The scene writes a member's `added`
  list whole when it cannot state it node by node (an unkeyed or repeated key in the frame; an edit inside a template
  REFERENCE node did until #1914 R3b, which states it by rows reaching into the node), and in scene form a copy
  states only its recorded values, so a reload lost every value the chain node gave it (hunt seeds 1091, 1192). The
  writer stamps each copy's template key (`stampTemplateKeys`), the fold pairs a keyed copy that carries a guid with
  the chain node it replaces (`pairWithBase`, `BASE_NODE`), and `spawnReferenceNode` folds that node's values under the
  copy's own as non-own layers (`baseLayersOf`, `PrefabExpansion.base`). Nothing is pinned: a change to the chain
  node's values still reaches the copy. Because omission now reads as "base", a component only the base adds is
  restated against it (`withBaseRemovals`): cut to its recorded fields while live, a stated removal
  (`removedTraits` / `traitRemovals`, applied after the values) once gone. The copy's STRUCTURE is still the whole
  list's, pinned as before; node rows that reach into a reference node are R3's (the hub's end state B).
- **An undo that restores a component its layer has since dropped records it** (`restoreMarks` →
  `takeUnmarkedFromBase(…, recordAdded)`): its snapshot holds the layer's values unrecorded, but the save now writes
  it whole as an added component and a reload records it (hunt seeds 1163, 3250, at T4).
#1822's and #1893's seeds stay as REGRESSIONS.
The L model below is a candidate for round 4 (#1740), not ruled (hub, 2026-10-01): the narrow alignment was a scope
call, not a correctness one.

**The recorded direction, not scheduled (hub G2-3, 2026-09-29):** Unity's model. The instance root holds its recorded
modification list as trait data (member guid → trait → field, the scene's own edits only), the save writes it
verbatim, every editor write updates it through this owner, and undo snapshots it because it is data on the root. It
would remove the side store and all its carriers, the by-value subtraction of layer values, the two-writer divergence
above, and #1722's depth ≥ 2 loss (a deliberate equal edit of a field an enclosing row states, lost once the
template changes). It is size L across the loader's seeding, the six re-apply callers, the save's capture, the
listing, Apply, Revert and the nested capture, so it waits until the divergence gets a reader or Prefab Variants
(U3), which need per-layer recorded lists anyway, are scheduled. A cheaper halfway (the marks as a runtime-only
trait) was rejected: a snapshot of one trait (Remove Component) or of `PrefabInstance` (Detach) would still need
this capture.

⚠️ **By value cannot keep a reorder local when the template's siblings TIE.** 651 of the 843
sibling groups across the repo's 325 templates carry equal `sortOrder`s, mostly all 0
(measured 2026-09-28). No value sorts between two tied siblings, so the Hierarchy renumbers
the group. Every child from the drop point on then differs from its base, is marked, and stops
following template reorders. That is correct by value, because it is the order on screen. Writing
distinct `sortOrder`s into templates is #1714.

**Agent writes are marked like the Inspector's (#1816).** In the editor, `set-traits` (through `modoki_eval`) and
`apply-scene-ops` `setTrait` both write through `writeTraitAsEditor` (`app/editor/agentEditorOps.ts`), so a member's
field is marked, undoable and dirty exactly as a human edit is, and its `parentId` is a reparent (`planReparent` /
`applyReparent`, `docs/scene-loading.md` § the reparent entry-point table). Until #1816 the editor ran the DEVICE's
`set-traits`, a raw write, and a member field changed through it was not saved. On a device it stays raw: there is no
project and no undo stack there. In Play the write is undoable until Stop, which reverts it with its entry and its
dirty mark (docs/editor.md § Play/Stop). Pose, timeline and preview writes, guid mints, `parentId` and `sourceScene` are not
mark-gated.

A general "unmarked write fails" tripwire was measured at the gate over 3,503 tests: it tripped 28,
and 17 of those were the gate's legitimate drops. So the guard is the narrow one,
`engine/tests/architecture/instanceSortOrderWrites.test.ts` (no raw `sortOrder` write in editor
code), and each writer has a save-and-reload test in `engine/tests/editor/instanceWriteMarks.test.ts`.

**Which fields an override may carry is decided by the trait's koota SCHEMA, never by
`meta.fields`** (`runtime/core/ecs/traitSchema.ts` — `isPersistentTraitField`).
`meta.fields` is the Inspector-rendering list: a field is in it because the generic
renderer should draw a row for it. A field can persist and still be absent from it —
`Animator.clips`/`clip` (the custom `AnimatorClipsSection` owns them),
`EntityAttributes.editorFolder` (no row at all). All three override paths — capture
(`captureInstanceOverrides`), the editor apply (`applyOverridesByRootInstance`, deleted in #1914 R8 with no
caller left), and the loader apply (`applyOverridesByLocalToEcs`) — used to treat `field in meta.fields` as
"does this field persist", which lost data twice over: the loader **dropped** such a
field instead of applying it (and so never seeded its override mark), and capture never
**read** it, so the next save deleted it from the file. Measured on `skinned-test.scene.json`: a load→save removed a populated
`Animator.clips` bank naming a real clip guid. A field the schema does not declare is
still ignored — that is the genuinely renamed/retired case. Capture additionally skips
`runtimeOnly` fields at the READ, mirroring `serializeScene`, so live read-back
(`Animator.activeClip`, a crossfade's progress) can never be frozen into a file.

The same predicate governs **`applyToPrefabSelective`** ("Apply to Prefab"), which had the
bug in the write direction: it skipped such a field and reported success, so applying a
`clips` override changed nothing. Because it now admits AoS object/array fields
(`AnimationLibrary.animSets`) that the old gate excluded, it **deep-copies** the live bag
before writing — `readTraitDataFull` returns live references, and storing one would alias
the cached template to one instance, so editing that instance would rewrite the template.
`engine/tests/editor/traitPersistencePredicateGuard.test.ts` fails the build if any of
these files goes back to testing `field in meta.fields`.

**Writing a TEMPLATE excludes two things a scene keeps** (`isTemplateExcludedField`, shared
by `serializePrefab` and `applyToPrefabSelective`): `runtimeOnly` read-back, and the
scene-only fields in `SCENE_ONLY_TEMPLATE_FIELDS` — today just
`EntityAttributes.editorFolder`, the Hierarchy grouping tag. A template inheriting a folder
would file every future instance under one author's folder. Note the asymmetry is
deliberate: **capture into a SCENE keeps `editorFolder`** (a foldered instance must stay
foldered — that is what the field is for); only templates drop it. It is now excluded
BY NAME, where it used to be excluded as accidental collateral of the `meta.fields` gate
that was also losing `Animator.clips`.

**So Apply does not OFFER them, and Revert does** (#1661). The Apply/Revert listing has ONE builder,
`collectInstanceOverrideListing` (`prefabOverrideKeys.ts`, #1671): the dialog renders
`listingFor(listing, mode)`, and the agent op flattens the same listing to keys. Apply's cut leaves
out `applyExcluded` (the dialog used to list and pre-check `editorFolder`, and Apply then skipped it
with no word); Revert keeps them, since resetting an instance's folder to the base is meaningful, and
leaves out the nested instances' own (U14) edits, which it reverts on the nested instance itself. An
added subtree whose live root has no durable guid is not listed at all, only counted
(`unaddressableAdded`, a note in the dialog): `+added.` cannot name one of two such subtrees. Every
editor create/duplicate path mints a durable guid (`ensureGuid`), so this is a code- or
runtime-spawned child, addressable once the scene is saved.

## Core operations (`editor/scene/prefab*.ts`)

The editor's prefab system was one 9.3k-line `prefab.ts` until the split before the third review pass (#1656 § Plan
step 5, a pure move). It is now one module per concern, in dependency order (a module imports only from those above it;
no value-import cycle runs through any of them):

| Module | Owns |
|---|---|
| `prefab.ts` | The document model: `PrefabEntity`, `PrefabFile`, `isTemplateExcludedField`, `collectTree`, the guid ↔ entity-id helpers |
| `prefabCache.ts` | The one editor `prefabCache` and file reads: `getPrefabSource`/`getCachedPrefabSync`, parked reads, refresh, nested preload, the editor-cache seat/prime/rekey/evict, `setPrefabSource`, `wouldCreateCycle`, `classifyExisting*Id`; it registers the frame-doc fallback (`setFrameDocFallback`) |
| `prefabTokens.ts` | The write-side token scope: the template tokenizer and its node exits, `baseTokenResolver`, the kept-state bake and the rewriting-prefab scope (`withKeptStateBake`, `withNodeExits`, `withRewritingPrefab`) |
| `prefabMembers.ts` | Member rows and moves: the row domain, `memberRowParents`, the prefab's own moves, `captureInstanceMembers`, `instanceMovedMembers` |
| `prefabInstanceOverrides.ts` | Field overrides: `getOverrideValues`, `recordedOverrides`, `withOverridesFolded`, `captureInstanceOverrides` (the apply is the loader's `applyOverridesByLocalToEcs`) |
| `prefabCapture.ts` | The capture core: `captureInstanceStructure`, `captureNestedChannels`, `moveChannelsOntoRows`, `captureInstanceReference`, the template rows, the rows reaching into a reference node (`referenceNodeRows`). One mutual recursion, so it is the largest module |
| `prefabFrames.ts` | Frame state: `rebuildTeardown`, `framesBuiltFromOtherRows`/`staleFrames`, the missing/stale/unexpanded refusals |
| `prefabInstantiate.ts` | Editor instantiate: `instantiatePrefab`, `instantiatePrefabInstance`, `instantiatePrefabAsync`, `applyStructureByRootInstance` |
| `prefabChain.ts` | An instance's own layer against its enclosing chain: `instanceBase`, `enclosingRowOverrides`, `ownInstanceStructure`, `memberOverrideKeys`, `nestedFrameMoves` |
| `prefabRebuild.ts` | Rebuild, refresh and rebase: `rebuildFromEntry` (a rebuild is the load of the outermost scene entry, #1880 F6; the old per-frame `rebuildInstance` was deleted in F7), `refreshInstances`, `rebaseStaleInstances`, `rebuildFrameFromSide` |
| `prefabSerialize.ts` | `serializePrefab`, row planning and numbering, `mergeRiggedPrefab`, `serializeRebuildOver` |
| `prefabApplyStructure.ts` | Apply's structural writes: `insertAddedSubtree`, promotion, the promoted-guid carry |
| `prefabApply.ts` | Apply's orchestrators: `previewApply`, `applyToPrefabSelective`, `planApply`, `commitApplyPlan` |
| `prefabLink.ts` | The instance link: `tagEntityTreeAsInstance`, `tagCreatedPrefab`, Detach/Reattach |
| `prefabRevert.ts` | `revertOverridesSelective`, `revertRefusal` |

Only the orchestrators await (Apply, Revert, the rebase); the capture and rebuild core stays synchronous.

- **`serializePrefab(selectedEntityId, existingId?, opts?)`** — collects the selected
  tree (`collectTree`, BFS), assigns `localId`s, snapshots each trait, remaps
  parent links to localIds, and rewrites asset path refs to GUIDs. Pass
  `existingId` to preserve a prefab's UUID on re-save. `opts.preserveLocalIds` /
  `opts.name` keep a re-save from renumbering members or renaming the file — see
  "localId stability" above.
- **`instantiatePrefab(prefab, parentId?)`** — editor-side spawn into the current
  world, through the runtime's `instantiatePrefabIntoWorld` (#1783) reading nested documents from the
  EDITOR cache: spawns entities, remaps `parentId`s, adds the `PrefabInstance` trait
  stamped with the document's guid (I22; `''` for a document without one), sets `rootInstanceId`, returns the
  root ECS id. It is **synchronous**, so any nested (`v2`) child must already be cached — a nested row whose
  child file is not in the cache is skipped and recorded on the frame as unexpanded.
- **`instantiatePrefabAsync(prefab, parentId?)`** — the preload-safe wrapper:
  `await preloadNestedPrefabs(prefab)` then `instantiatePrefab`. **Every UI
  instantiate path** (Assets, Hierarchy drag-drop, Inspector) uses this so the
  preload contract can't be forgotten (forgetting it drops nested children).
- **`instantiatePrefabIntoWorld(world, prefab, parentId?, rootTransform?,
  source?, overrides?)`** — the runtime equivalent (in `loadSceneFile.ts`): spawns
  into an explicit world (used by `SceneManager` against the staging world),
  applies a root transform, and applies per-localId overrides via
  `applyOverridesByLocalToEcs`.
- **`captureInstanceOverrides(rootInstanceId, prefab)`** — walks every entity in
  an instance and returns `{ localId → { traitName → { field → value } } }` for
  fields that differ from the source (float comparison uses a `1e-6` tolerance;
  `parentId` and tag traits are skipped). `getOverrideValues` /`getOverrides`
  back it. **It writes one key order** (#1896, Unity's deterministic save): traits in registry order, and each trait's
  fields in schema order (an AoS trait's in its live order), the order `writtenTraitKeys` gives a plain entity. The
  record (`recordedOverrides`) is read in HISTORY order, the mark set's insertion order. A reload re-seeds marks in file order, and a rotation mark pulls in its whole group, so a root whose
  `x` was marked before it was rotated saved `{rx,x,ry,rz}` and then re-saved `{rx,ry,rz,x}` with no value changed.
  `inCanonicalOrder` puts the object in the canonical order at the end of the capture. The committed scenes were
  normalised to it once, as a key-order-only commit.
- **`getPrefabSource(source)`** — fetch (and cache) a prefab file by GUID or path; a fetch that a write or a
  trash overtook is not seated (#1669, the token below). A WRITE is `commitPrefabWrite` (prefabCommit.ts, #1692), never a
  cache set. A write that does not land is a `conflict` or carries a reason in `error` (#1776), the one channel a refusal travels
  in whoever produced it: the route's own (`/api/write-file` refuses a path outside the asset roots with `{error,
  options}`, where it once sent an empty body), else `the request was refused (HTTP <status>)`. The agent `create` refuses
  with it (and the route's `options`), and `createPrefabFromEntity` returns it as `refused`, which both panels toast, as it
  does its other refusals (an unreadable file it would replace, a tree that cannot be serialized); before, all of these
  reached the human as a bare `null` the panels only logged. The cache lets the serialize loop and the
  Inspector read override diffs synchronously. (The runtime resource cache uses
  its own `getCachedPrefab()` in `meshTemplateCache.ts`.)
- **`applyToPrefabSelective`** — write live overrides back into
  the source file and refresh sibling instances.

### A read-side seed carries its read's token (#1752)

> **Illustrates I10** (a read that began before a write cannot put the older bytes back).

A write seats the newer document under every key (`commitPrefabWrite`). A reader that seeds the caches from bytes it
read BEFORE an await would put the older document back after it, and every frame expanded from the newer one then read
as stale: the next unrestricted rebase rebuilt them onto the old document (#1685's shape). #1669 closed this for
`getPrefabSource` alone; #1752 found two more seeds, and all three now ask one question:
`capturePrefabRead(source)` (`editor/scene/prefabRead.ts`), the runtime cache's per-key revision, which every write and
eviction bumps. Capture BEFORE the read, ask after its last await, before seeding. It is never a content comparison: a
raw fetch and the migrated cache copy of the same file differ in bytes.

- **The key is resolved once, at capture**, to the path the runtime cache keys by. A path used to be mapped to its guid
  and re-resolved at every check: after a trash and the manifest's prune the guid resolved to nothing, the revision read
  0, and a capture taken at 0 (any prefab nothing has written this session) passed.
- **An outside edit moves it too** (`notePrefabFileChanged`, which the watcher's refresher
  `refreshPrefabSourceAfterDiskChange` raises before its own fetch — and only it: the leave-edit repair refreshes an
  unchanged file, and noting there refused placements for a write nobody made). The watcher's
  reload evicts the runtime cache, which is the revision's bump, as late as it can, because a deferred reload must not
  strand Play's synchronous spawns. It seats the editor cache from the new bytes before that, so a placement in between
  passed the revision check and primed the old bytes over the new.
- **The agent ops key on the file's own spelling** (`existingAssetPath`, #1273): `instantiate`, `create` and
  `edit-open`. A path typed in another case reaches the same file on a case-insensitive disk. But a token keyed by it
  never saw a write's bump, `instantiate` tagged the raw path, and `create` seated a second editor-cache entry that no
  later write updates.
- **A read names its file in the manifest only once it is kept** (`registerRead`). The fetch used to register every
  read, so a stale one re-registered a trashed prefab's guid at the emptied path until the next manifest broadcast.

- **A placement** (`instantiatePrefabInstance`) asks it after the nested preload and BEFORE the spawn, and runs the
  spawn, the tag and the prime synchronously after the check, so a write queued behind it cannot land in between. A moved token
  **refuses** (`StalePrefabRead`), so nothing is spawned and nothing is primed. It is never a re-read: placing a version
  the caller did not read is a re-target. A caller that fetches captures the token before its own fetch, so a write
  during that fetch counts too. The three human gestures (Assets "Instantiate", a Hierarchy drop, the Inspector's
  button) share `placePrefabFromPath` (`prefabPlace.ts`), which toasts the reason and never rejects. The agent
  `prefab instantiate` answers `REFUSED_BY_OP`.
- **A redo** of a placement that refuses is **dropped with its notice** (`UndoRefusedError`, #1664's contract) rather
  than left on the redo stack. The file is the newer one now, so the retry is placing it again. The next undo undoes
  the step below it.
- **The prefab edit-open** seeds nothing once a newer scene request superseded it: its `setPrefabCache` rewrites the
  runtime cache too, re-spawning every pool built from it. It also seeds nothing from a stale read, and it asks again at
  the swap, after its save and the human's discard dialog. A write there refuses the open instead of building the edit
  world from the older document.

Two seeds do not need the token. The scene-swap warm (`prefabCacheWarm.ts`) primes synchronously from the runtime cache
right after its own `has` check. The watcher refresh (`refreshPrefabSourceForPath`) seats only while the entry is
still the object it replaced; the file-changed signal above is raised around it, by the watcher's entry point.

### Apply takes what it applied OUT of the source instance's overrides (#1469)

> **Illustrates I2** (own edits are measured against the effective base).

Apply refreshes **every** instance of the source, the one it was applied from included: each is
captured against the OLD document, rebuilt from the new one, and has its capture re-applied. A match
with the new base is **not** what drops an applied field from the source instance. The field is still
override-MARKED (`overrideMarks.ts`), and the capture keeps a marked field that differs from the old
base. The rebuild then re-applied it through `applyOverridesByRootInstance` (since gone: a rebuild is the load of its
entry now, #1880 F6), which re-seeded the mark.
The result was an override whose value equalled the base. It was invisible in the override list
(a value diff), it was saved into the scene, and it **pinned** that instance: a later template edit
to the field reached every instance except the one the author had applied from. An applied MOVE
pinned the moved member's Transform the same way, because a moved member's Transform is captured
without a mark.

So `applyToPrefabSelective` records every `localId.Trait.field` it copies from the instance into a
row: an applied field, every field of a component it seeds whole, and the Transform an applied move
writes. `refreshInstances` subtracts that set from **that one instance's** capture before its
rebuild (`subtractFieldOverrides`, which Revert uses for the fields it reverts). Other instances keep
their own overrides of the same field. Tests: `engine/tests/editor/applyLeavesNoSourceOverride.test.ts`.

**On a nested instance, the enclosing override goes too (U13, #1693; supersedes #1492's ruling b).** Unity's rule
(owner, 2026-09-28): "if Apply to Prefab 'Vase' is chosen and the 'Table' Prefab has an override of the value, this
override in the 'Table' Prefab is reverted at the same time". So an Apply of a field an enclosing prefab's row also
sets DROPS that row's statement of it, and the enclosing prefab's file is written too: every instance of the outer
prefab then shows the applied value, and nothing is left shadowing it, so every applied field leaves the source
(`appliedFieldsToDrop`, ruling b's keep rule, is gone). Before, the row kept its override and the source kept its own
(ruling b, 2026-09-24): every OTHER instance of the outer prefab still showed the row's value. Three surfaces still
read a nested instance against its template UNDER the rows (`enclosingRowOverrides`), because a field the row sets is
not the instance's own edit:
- **the override list** (`collectInstanceOverrideTree`) diffs a nested instance against its template under its rows.
  Against the bare template, a value the outer row sets was listed as the instance's own override;
- **Revert** puts back the ROW's value for a field a row sets, not the template's. The rebuild re-expands from the
  template alone and carries the row's values only as captured (marked) overrides, and the one reverted is subtracted
  from those. A reverted REMOVAL of a component the row adds puts the row's component back the same way. A reverted
  REMOVED MEMBER (#1730) brings back everything the layer states of it and its template subtree
  (`layerForRestoredMembers`): the rows' field bags and added components, the components and members they remove,
  and the nodes they add under it. Only members the Revert brings back: a subtree member still live (moved out before the
  delete) already carries the layer in its own capture, and seeding it again duplicated a layer-added node into the
  save (close-out review). "Live" includes an owned nested ROOT, which is its own `rootInstanceId`, and so is found by
  its row (`parentLocalId`) in the frame that owns it. A descendant the scene removed on its OWN key (moved out, then
  deleted) is seeded too, harmlessly: the structure pass skips an addition anchored on a member it removes
  (`applyStructureCore`). A member the scene deleted had nothing live to capture, so before #1730 it came
  back as the bare template's, its row's values were listed as phantom overrides, and the save wrote the row's
  component as a `traitRemovals`. A restored REFERENCE row's frame, and every frame inside it, gets what the layer
  says of its INSIDE from the expansion itself, which runs under the layer's forwarded state (#1737, § "A rebuild's
  nested frames"). The seed above covers only the restored members' own localIds;
- **the save** compares a nested field with the row by value (#1498).

### Apply's targets (#1693, owner ruling C, U12–U15)

Apply writes each key to a prefab ON THE INSTANCE'S CHAIN (`applyToPrefabSelective(root, keys, targets)`, Unity's
`PrefabOverridesMultiLevel`): the frame's own template ("Apply to Prefab '<inner>'"), or, as an override on the row an
enclosing prefab holds for the frame, that prefab ("Apply as override in Prefab '<outer>'"). `prefabApplyTargets.ts`
names the chain's places (`chainSlots`, from `frameBase`) and reads, writes and drops a member's statement where a
level states it: the row's `overrides`, its `nestedOverrides[path]`, or a member row (`members`, which folds over both,
so a value written under a member row that states the field would not show — it is written there instead).
- **An Apply is ONE plan, and every surface renders it (#1736).** `planApply` decides what each selected key writes,
  where, and what else that write changes, and returns it as a `KeyEffect` per key (`prefabApplyEffects.ts`: `setField`,
  `addComponent`, `removeComponent`, `stopAddingComponent`, `addTag`, `removeMember`, `addNode`, `move`, `notApplied`,
  `conflict`, with U13's `alsoReverts` and a `note`). The commit executes exactly that plan. `previewApply` is the same
  plan as a DRY RUN — nothing written, nothing stamped on the live world (the promotion's template captures run
  `readOnly`) — and the dialog's rows, its "Writes:" footer (file names, from the plan's writes — #1733) and the agent
  op's `overrides`/`apply`/`apply {dryRun}` all render it through ONE `describeEffect`. `prefabApplyOptions.ts` says only
  which targets a key HAS. It used to word each target key by key, and so could not see an effect that exists only
  across keys. The dialog hands the preview's fingerprint to the commit, which refuses a fresh plan that differs from
  what the rows showed rather than writing it. Both of Apply's plan-level refusals (a conflict, a changed plan) are
  decided on a DRY plan before the writing one runs: the writing plan's promotion stamps template keys on live nodes,
  which a refused Apply otherwise left behind with no undo. That second plan was measured and kept (#1773, 2026-09-29,
  macOS, load 7.5, headless): at one instance of 20 nested frames with 5 marked Transform fields each (100 nested keys)
  a dry plan takes a median 6.3 ms and a whole Apply 42.3 ms, so the extra pass is about 15% of an Apply, and the
  cheaper shape (stamping in the commit, one plan for both) was not worth its restructure. A dry plan prints nothing
  (`quiet`; pinned in `promotionGuidCarry.test.ts`), and the dialog re-plans its preview when the world moves, not only
  when its checkboxes do (`previewWorldKey`: the edit version and the run mode).
- **A press of Apply made while the plan is re-worked is kept, and applies only what the rows showed (2026-09-30).** A
  checkbox change makes the preview stale for the 120 ms debounce plus the plan, and Apply used to be DISABLED for
  that window: the first press after every uncheck did nothing, and the "Working out…" line that came and went moved
  the button half a line under the pointer (3 of 3 directed tries). Now a press over a SHOWN but stale plan is kept
  (`applyPress` → `wait`) with what the rows showed for the checked keys (`shownPlan`), and `queuedPress` applies it
  only if the plan that lands says the same. Otherwise it is not applied, and `prefab.dialog.pressNote` says so. That
  keeps the contract above: a press is never the go-ahead for a plan nobody saw (a target changed under it, a
  cross-key effect, an edit that re-planned it — the close-out review's case against a first version that applied
  whatever landed). So only an uncheck, or an edit re-planning the same rows, keeps a press: the stale rows must
  state an effect for every checked key at the target now chosen, and a key just checked (no row yet), a retargeted
  key (its row names the old target) or no plan at all (the open, the re-read after a refused Apply) leaves Apply
  disabled until the plan lands. A changed
  selection or a blocked plan drops a kept press; a world change alone does not, since the world is part of the
  request key (`previewRequestKey`'s `world`), so a preview planned before an edit is stale, not current. The status
  line's height is reserved, so the button does not move. A closed dialog also drops its whole session — kept press,
  preview and listing — because the reopen's own commit ran the preview effect on the last session's listing: once
  as a stale fingerprint the plan refused ("review it again"), once as an empty preview with Apply enabled at 1 ms.
  Pinned by `applyDialogModel.test.ts` and, live, by QA-DLG-0008 step 8c.
- **What each target does is said truthfully**: a field of a component the enclosing row ADDED, applied to the inner
  prefab, writes the whole component — "add component Rotate3D (axis x, speed 7) to A in Prefab 'P' — every P gains it"
  (#1658: it used to be listed as "speed 3 → 7" and written whole anyway). A component written at an enclosing level
  where nothing inside it gives the member one is written whole there too. Whether a write ADDS the component is decided
  against the document as READ, not as this Apply has changed it so far (#1727: a second frame found the first one's
  bag and was labelled a one-field edit).
- **A statement is keyed by its SLOT** — `document | row | path | member | trait | field` (a template's own row has no
  row or path; `*` is a whole-trait tag or removal) — never by document alone. Two keys that state one slot with
  DIFFERENT values are a **conflict** (#1727: two nested instances of one prefab, both applied into it, and the last
  write won silently): the plan marks EVERY key stating that slot `conflict` (an equal third value too — each row names
  only the keys whose value differs from its own), the dialog shows those rows in red and disables Apply, and
  `applyToPrefabSelective` refuses the whole Apply naming every key (the agent op: `REFUSED_BY_OP`, the keys in
  `options`). A field against another key's whole-trait removal is one too. Equal values write once. Unity has
  no rule here — its Apply All on an outer root sends each nested instance to a different slot, and its per-property
  "Apply to Prefab '<inner>'" acts on one instance — so this refuses rather than picking one.
- **Defaults (owner ruling (a))**: the frame's own template, except a field or removal of a component an enclosing row
  added, which goes back to the prefab that adds it (`defaultKeyLevel`). A removal has no inner target: the inner
  template never had the component.
- **U13** runs for every write, removals included: each enclosing level that states the applied field, tag or removed
  component drops it (a row override of a component the member lacks ADDS it, so a removal left under one came back
  half-built). Never what the same Apply wrote at that SLOT itself (`wroteAt`) — keyed by document, one frame's write at
  an enclosing prefab suppressed ANOTHER frame's drop there, and the applied edit was lost (#1728).
- **U14 (owner, 2026-09-28; supersedes the 2026-09-19 ruling)**: Apply on an OUTER instance lists its nested instances'
  own fields, added tags, removed components and removed members too (`keys.nested`, chain-qualified: `<row chain>:<key>`,
  `nestedKeyRef`), and writes them into the outer prefab by default, as overrides on the row it holds for that
  instance; the nested prefab only when picked. They are not in `keys.all`: Revert acts on the nested instance itself.
- **The write is ONE step over every file** (#1692's `commitPrefabWrites`), and the instances of each written prefab are
  refreshed innermost first — a file another written file CONTAINS goes before it (`innermostFirst`), the deepest chain
  level it was reached at breaking ties — so each capture reads frames already rebuilt inside it. A level recorded at a
  file's FIRST use tied P (reached at depths 1 and 2) with Q, which contains it, and Q went first (#1715); the maximum
  alone still misorders O→P beside O→R→S→Q→P. An id-less enclosing prefab gets its id on both sides of the write, as the
  frame's own document does, or its undo re-minted it and redo always refused (#1729). A file that took a frame's OWN edit (the frame's own keys, or
  a nested instance's U14 key written into its own prefab) has its refresh take that edit out of the frame's capture
  (`appliedFrom`), or its mark would pin it (#1469). Apply's undo and redo put every file back the same way.
- **Every live value goes into a template through one writer** (`prefabTemplateValue.ts`, #1659): the value overlay,
  the added-component seed, both promotion branches (a promoted node's refs, and a promoted reference node's overrides
  in its own frame) and the move pose. It tokenizes a ref to a member (or to a node the same Apply promotes) and drops
  a template-excluded field and a blank asset ref.
- **An ADDED node takes a target per level too (#1715, U12).** Unity offers one Apply target per nested level for an
  added GameObject (`PrefabUtility.HandleAddedGameObjectOverridesMenuItems`); the default stays the frame's own prefab
  (promotion, `insertAddedSubtree`). At an enclosing level the node is written as a TEMPLATE node (`guid: ''`, a fresh
  `key` per node, `toTemplateNodes`) by `writeAddedNode`: into the row's own `added` where the row expands the frame, and
  APPENDED to a member row's `own` deeper down — a member row's `added` would replace what the chain puts under the
  member, and pin it. For the same reason, where the frame-expanding row already holds a member row for the anchor
  (a prefab-edit save writes one whose `added` restates the list when it cannot diff node by node), the node goes on
  that row's `own`: pushed into the row's own list, it was written, deleted live and shown nowhere. Its values go
  through ONE writer per enclosing level (`writerAt`), applied in the frame the node hangs in, after every node of every
  `+added.` key at that level is `promote`d to its `+key` path (`promoteOuterAdded`, before any key is written), so a
  ref to a member, to another node of the subtree or to a node another key adds (two sibling buttons naming each
  other) is a token. A writer per key left that last one as the source instance's live guid. The frame's OWN level is the
  promotion's writer itself: a U14 key's default write lands in that document too, and a fresh writer there left a field
  naming a node the same Apply promotes as the source instance's guid (#1659's cross-instance ref, since #1693).
  **Identity:** a node in a row's `added`/`own` is template-keyed — every instance DERIVES its guid from its anchor and
  its `+key` step (`templateIdentity.ts`), and no scene row can pin it — so the carry is `carryPromotedGuids`' follow
  half: after the last refresh each key is paired with the one entity carrying it among what that level's instance can
  name (`memberPathIndex`, which stops at a stored root — a scene-nested instance of the same prefab inside it carries
  the same key, and the pairing was not unique), and every ref moves to the derived guid, which the reload derives
  again. A ref in ANOTHER file to the node dangles (the gap
  #1680 was closed on under the Unity rule). The live node is deleted before ANY refresh, not in the frame's turn: an
  Apply writing only the enclosing prefab has no frame turn, and that prefab's capture re-spawned the node beside its
  template twin. Refused at an enclosing level, the target not offered: an anchor that level cannot name (a pre-v5 row
  on the path), and the cut below. Pinned by `nestedEnclosingLayer.test.ts` › #1715 and `applyTwoFileUndo.test.ts` ›
  #1715.
- **Not done (#1715, hub ruling 2026-09-30, the Unity line)**: an added node whose subtree holds an added prefab
  INSTANCE is applied to the frame's own prefab only — "apply it there, or unpack the added instance first". Written
  into a row's `added` it needs the template re-capture promotion does for a reference row (#1533, #1538, #1802, and
  `toTemplateNodes` drops a node's `members`), and its carry the expansion walk (`promotionPathIndex`): the large half,
  for low reach. It is also the only place Unity's disabled self-nesting target could arise, so with the cut it cannot.
  A move inside a nested instance is not applied anywhere: no gesture moves a prefab object since #1869. A template reference node above the chain is not a place Apply writes, so U13 cannot drop its
  statement (#1731; Unity would — that needs the node as a write target, #1715's family). Where it states the applied
  field, the prefab IS written (every other instance takes the value), and THIS instance keeps the value it shows as
  its own edit — left out of the refresh's subtraction, still marked and still listed, since it differs from its base —
  rather than flipping to the node's. The key's effect says so in its `note`; nothing lands in `skipped`. (It used to
  push "not applied, the node still wins" after writing, which neither the file nor the instance matched.)

**The resolved base is the enclosing layer WHOLE (#1506).** `frameBase` (`prefabBase.ts`, #1693; `enclosingLayer` reads
its layer) answers what the layers enclosing an instance author on it: field overrides AND structure lists. `enclosingRowOverrides` is its
field half, with tokens resolved. The layer can be one of two things:
- **a row frame**: every row from the top down, fields and structure in ONE fold (`foldPath`, whose per-row step
  `foldRowStep` lives in `prefabOverrides.ts` and is shared with the validator and the pool since #1707), each level's
  document read from its frame record;
- **a reference node that a prefab TEMPLATE authored** (a keyed `added` node with `prefab`, in a row of the
  frame it hangs in): the node's own channels (`overrides`, `added`, `removed`, `removedTraits`, `moved`,
  with its `members` folded as the loader folds them — a template node carries template-form rows since
  #1538). A chain of rows UNDER such a node starts from the node's `nestedOverrides`/`nestedStructure`
  and its `members` (`foldPath`'s seed).
  The node is found by template key (`templateReferenceNode`), using the marker first and the
  guid-derived recovery if the marker was lost. A node the SCENE added has no enclosing layer: the scene
  writes it as that instance's own.

Before this, only the rows' fields counted. A row's structure was listed as the nested instance's own,
and **Apply of the listed keys wrote it into the child template**: an outer row's removed trait was
stripped from every instance of the child prefab. A row-authored reference node read as a stored root, so
its node-set fields were listed as its own, and Revert took them to the template's value.

The listing (the agent op and the dialog both) now diffs structure through `ownInstanceStructure`: the
capture minus the layer's lists, with the rebuild's own subtraction (`subtractChainStructure`, `added`
nodes matched by template key). Apply and Revert also **refuse** a layer-authored structural key that a
caller still holds (`layerAuthoredStructureKeys`). Apply reports it in `skipped`, and Revert warns. A
revert of one put an outer row's removal back, or DELETED its added node, and neither is what the
instance shows with nothing of its own. An `added` node the layer authored is never the instance's own, **even once the scene has
edited it**. The subtraction keeps an edited node whole for the rebuild to respawn, but listed, Apply
copied it into the child prefab, and every other instance of the enclosing prefab then showed it twice.
Its edits are the scene's, and the save keeps them.

A reference node inside a plain added node's `children` is found too (#1513). The frame is the one the
first MEMBER above it belongs to, since a plain node carries no `PrefabInstance`, and the key is looked
for through the layer's `children`. A reference node in another reference node's `added`, under one of
that node's members, needs neither: that member's frame is the outer node's instance, whose layer is the
outer node's `added`.

Limits:
- A template node the scene moved out of the frame that authored it reads as having no template node. Its
  identity parent is its live parent, since no row expanded it (`identityParents.ts`), so the climb reaches
  another frame, or none, whose layer does not hold its key.
- **A scene edit to a node the layer added has no key on any surface**, so it can be neither applied nor
  reverted to the row's version. It is saved and reloads as edited. Before #1506 it was listed, but Revert
  deleted the node, which was no better.
- A save leaves the node to the template unless the scene changed it (#1511), so Revert's target lasts
  past a save. Once the scene edits the node, the member's whole `added` list is saved. A node whose
  template carries an all-empty `nestedStructure` slot, or one holding `added` nodes, is still saved
  as edited. See
  [prefab-structural-overrides.md](prefab-structural-overrides.md).

The #1490 half: after Apply of a MOVED nested root, the pose is in the reference row's overrides, so the
save's by-value subtraction drops it from the source. A later edit to that row pose moves the instance.
Tests: `engine/tests/editor/nestedRowFieldSave.test.ts`.

### A promoted added node keeps its guid (#1660)

> **Illustrates I5 and I7** (a write carries identity where a correspondence exists; a member guid is predicted one way).

Promoting `+added.<guid>` writes the node into the template as a new row. It then deletes the live node, and
the refresh re-expands the row as a member. A member **derives** its guid from the instance's anchor and its
path, so before #1660 every ref naming the added node named nothing after the Apply. That covers a UI nav
link, a UIAction target and a joint, in this scene or another file. `applyToPrefabWithUndo` then saved the
scene that way, because a promotion always saves.

`carryPromotedGuids` closes that gap. While the promoted entities are still live, it reads each one by where
the refresh will put it back:
- a plain node by the row it became;
- a reference node's whole expansion by its nested row, then by path below the nested root
  (`memberPathIndex`).

After the refresh it pairs each re-expanded entity with its original, and then:
- **A member the save writes a v16 row for takes the old guid back.** The row states it, so the reload pins
  it, and a ref anywhere keeps resolving, in another file too. This is a carry, not a remap, because no remap
  of the live world can reach another file. It is the same rule `stampDerivedMemberGuids` and
  `promoteOwnedRoots` follow from the other side: where a row states a guid, identity does not move.
- **An entity no row can pin keeps its derived guid, and the live refs follow it.** This covers a
  template-keyed node and a member of a pre-v5 document. Renaming such an entity back would hold only until
  the reload re-derived it. A node, or an instance, that the author added *inside* the promoted reference node
  is one of these. The promotion writes it into the row's `added` as a template node, and it gets paired
  anyway: the template write stamps the key it gives each node on the live entity (`addedNodeIdentity`), so
  its step is the same before and after. `promotionPathIndex` continues the path index into such an
  instance's own frame, which `memberPathIndex` stops at.
- **A pairing that is not unique carries nothing**: an original two entities answer to, or the reverse.
  Neither is a guid a live entity still holds. Each row is written once, so neither case is known to happen.
  The guard is the floor under a pairing that stopped being unique.

**The delete takes the promoted nodes' identity subtree, not the live one (#1682, I6).** A member of another
frame dragged under a promoted node is not the node's: the live delete took it, and the refresh's capture saved it
as removed. It is parked at the scene root for the refresh (the capture then reads it as moved and keeps its pose as
values), and afterwards hung back under the node it was dragged under, now a member, found by the carried or
followed guid (`deletePromotedNodes`, `rehangPromotionSurvivors`). A member of an inner frame dragged OUT of a
promoted node, at any depth, is the node's, and goes with it: the live delete left it beside its re-expansion.

Undo and redo hold the carried guid on both sides. For the primary scene they reload its whole snapshot. For a base
scene's instance (#1431), redo instead rebuilds it from the post-Apply capture, and the guid comes back from the
member row that the undo's rebuild left in the kept-orphan store (`keptMemberOrphans`). **Not covered**
(#1680): a ref in **another file** to an entity that kept its derived guid still dangles. Only a stored row
could hold that identity, and a template-keyed node is never pinned (#1426).

Tests: `engine/tests/editor/promotionGuidCarry.test.ts`.

### Undo changes memory, Save writes files (#1868)

> **Illustrates I9 and I10** without a write: the owner ruled D1 = Park and D2 = None (#1868).

**Why, and against Unity.** Modoki had three undo classes. Scene edits and asset-document edits (materials, clips,
particles, rigs…) were already memory-only: the edit parks, and Save writes it. The third class WROTE files on undo:
the Assets panel's file operations and the prefab writers. That class produced most of the #1789 campaign's bugs,
because each of its undo steps was an async HTTP round trip. Unity's behaviour, from its manual, issue tracker and C#
reference source (INFERRED where it rests on native code Unity does not publish):
- an asset edit's undo "simply marks the asset dirty, it has nothing to do with saving" (issue 1182899, By Design);
- a delete is not undoable, "You cannot undo the delete assets action." (`ProjectWindowUtil.DeleteAssets`);
- create and cut/paste move are meant to be undoable (flaky, UUM-115890); rename and duplicate are unverified;
- Apply writes the file at once, and its undo snapshots the file's bytes (`Undo.RegisterFileChangeUndo`), so it
  INFERRED rewrites the file on undo; Revert, Unpack and an instance Replace change only the scene;
- the Prefab Mode session is one undo step on leaving (2022.2); Modoki drops its history instead (U27), which stays.

The owner's two rulings: **D2 = None** — no Assets file operation keeps an undo ([editor.md](editor.md) § "Assets
file operations are not undoable"), the one real departure from Unity, since its create and cut/paste move are
undoable; and **D1 = Park** — an undone Apply, Replace or rig update is restored in memory and waits for Cmd+S, where
Unity (INFERRED) rewrites the file at once. The owner's framing: *"I think we are making things more complicated than
necessary."*

The undo and redo of a prefab WRITE (Apply to Prefab, Create Prefab's Replace, a rig-prefab update) restore the
document IN MEMORY, and Save writes it, as for every other asset document. The forward write still writes the file at
once, as Unity's Apply does. Only the undo and redo stopped writing. Before, each was an HTTP round trip inside the
undo step. The rest of the editor ran while it was in flight (#1833), the file could change under it (#1664, #1821),
it could fail half-way (#1823), and it needed a restore owner for the renderer (#1844). None of that is left to guard
once no file is written.

**One step for every change to a prefab document** (#1880 W, `commitPrefabChanges` in `editor/scene/prefabCommit.ts`).
The write door stated the invariants, and the in-memory restore every undo used stated most of them again, or did not
(#1877 C1: the mark written back down, a self-containing restore, an undo that brought a trashed prefab back). Now each
change carries how it LANDS, and every landing passes one stage, in this order, before anything changes:
1. **the world gate** (I11): for a write and an adopt, the step holds world switches off; a write also waits for a route
   mid-adoption and refuses in a world that is not adopted. A PARK's gate is the undo step that runs it — a world switch
   that takes `beginWorldSwitch` waits for a running step (#1579); the watcher's hot reload does not, as it did not for
   the old restore — and not the adoption gate, whose refusals are transient while a refused undo is dropped for good;
2. **`documentNow`**: the ONE answer to what the editor holds (the park, else the cache) and what the file holds (read
   for a write; else the editor's record of it: a clean park's baseline, or the cache). It replaced three computations
   (the park's `onDisk`, the undo step's own `from`, the commit's re-read) that disagreed exactly where round 3 found
   its bugs;
3. **the precondition**: a write, that the file holds what the caller read (I10); a park, that the EDITOR holds what the
   other half of the step left (the #1664/#1679 precondition asked of memory) — or, when nothing holds it, that the
   FILE does. The toast reads *"<file> changed since,
   and was left as it is"*;
4. **the file exists**, for a write of a document and for a park: a prefab trashed since is not written or parked back.
   Unity brings no deleted asset back through an undo either;
5. **I16**, read through the step's own documents first. Only a TRUE no-op is exempt: `bytes` equal to the file's text
   as just read (W3). Recorded bytes used to be exempt whatever the file held, so Create Prefab's redo wrote a document
   back into a nesting that had become a cycle since;
6. **the mark** (I4): the highest of the document's, the editor's (its park included), the file's, what `expected`
   names, and the session's record (`markRecord`, hub ruling: an outside rewind cannot lower what this session handed
   out), taken once;
7. **land**, then **seat** both caches (REPLACE, never evict, #1308), the caller's `rebuild`, and the rebase.

The three landings:
- **`'file'`** (`commitPrefabWrite(s)`, which wrap it): every forward write and Save's flush of a park. It always READS
  its file first: that read is the precondition's exact `ifMatch`, the exists check, and the mark's file term. A read
  that fails (not a 404) is not a delete: one file then writes conditional on what the caller read, as before.
- **`'park'`** (`parkPrefabChanges`): the undo and redo of Apply, Create Prefab's Replace and a rig update. Both caches
  hold the document, the caller rebuilds, the rest is rebased, and the document is PARKED with the document its file
  holds as the baseline — or the park is dropped when the document IS what the file holds (a redo back to what the
  forward write put there), and nothing is left unsaved.
- **`'adopt'`** (#1880 W4): the FILE already changed, and the editor takes it — the watcher's outside change (#1873 R1),
  a discarded park (#1873 S2), the prefab-edit open's seed and the leave repair. It never refuses as a whole: a file
  gone is adopted as gone (the instances stay, as Unity keeps a Missing Prefab, and a put-back re-seats them); a file
  that would contain itself is not seated, and the report names the prefab that closes the cycle; an editor write that
  landed during the read is kept; JSON that is not a prefab document is kept out as unreadable; and a file refused as a
  cycle is taken again once a prefab on that cycle is adopted, deleted or written (a checkout that flips a nesting direction arrives one
  file per event). It raises the mark to the session's record and to what both caches held, **in the
  caches only** (hub ruling (A)): nothing is parked or written and `sameDocument` ignores the mark, so no precondition
  or dirty flag moves, and the next real write carries it to the file. Every branch of the watcher goes through it — in
  prefab edit and with no scene open too, where the runtime copy used to be EVICTED and a synchronous reader read
  `undefined` until the next load. The prefab open in prefab edit keeps its editor copy against an outside change until
  the session ends (the leave repair then takes the file).

Only the step seats a prefab's caches or parks one; `tests/architecture/prefabStepCensus.test.ts` pins that, with the
exceptions it names.

**A door's pre-commit capture stamps come off when it lands nothing** (#1884). A template-form capture keys each
scene-added node it writes as a template's added node (`addedNodeIdentity`), on the LIVE node, before the step runs.
So a door whose step fails or conflicts, or which refuses after its capture, takes those keys back off, and so does its
undo: a key on a plain node is one the save drops, so live and reloaded disagree. The door snapshots the tree's unkeyed
nodes before its capture and drops what got keyed (`snapshotUnkeyed`, `editor/scene/capturedKeys.ts`), including after a
landing that tagged nothing — whose redo then links the tree to the file, so Create Prefab records the keys right after
its serialize and that redo seats them again (without them its plan minted keys the file does not declare). The snapshot names its nodes by durable guid, so a rebuild in place during the write (a
nested prefab rebased meanwhile) does not hide one, and another create that linked the tree meanwhile re-derived their
guids, so its keys stay. **An exception is an exit too**: a throw after the capture and before the landing took the tree
drops the keys as a refusal does (`dropOnThrow`), and one after it leaves them — Create marks the moment its tag links the
tree (`keep()`, from inside the tag: the rest of the tag can still throw); Apply's
rebuild respawns every node its promotion keyed under a guid the snapshot does not name. **The drop writes no identity**:
it un-keys by id (`stripKeysNow`), where an `entityRef` would mint a guid on a node that has none (#1884 close-out). Two doors
capture a live scene tree: **Create Prefab** (its serialize; the refused serialize, the failed write and the undo,
below) and **Apply** (its writing plan's promotion; a failed write or a refusal after the plan. Its undo reloads the
scene from before it). The rest capture nothing before their step, or capture a tree that is not the scene's: a model
import's and a rig's temporary trees, deleted before the write, and the prefab-edit save's edit world, whose keys are
the document's own (census 2026-09-30, #1884 close-out). Pinned by `createPrefabUndoTemplateKeys.test.ts` and
`applyFailedTemplateKeys.test.ts`.

**Behaviour changes a human sees (#1880 W, owner-approved plan):**
- an undo or redo that used to "succeed" into a bad park now REFUSES, naming the prefab and why: the prefab was deleted
  since (*"<file> was deleted since, and was left deleted"*), or putting it back would make it contain itself;
- **Create Prefab's undo refuses before it changes anything** when a link it puts back would be lost — its entity went
  with a prefab deleted since (#1881, W5 `requireLinks`). It used to unlink the tree and then report "N prefab links …
  could not be put back";
- an **Overwrite of a prefab deleted since refuses** (*"… was deleted since, so it was not written back"*) — Save's
  Overwrite of a park, and the prefab-edit save's (W6);
- an **agent edit made while an Apply to Prefab is in flight is refused** (*"an Apply to Prefab is in progress … retry
  once the Apply has finished"*, W8): the Apply's undo reloads the scene as it was when the Apply began, so the edit
  used to sit below the Apply's entry and be erased by its undo (#1877 L5). The human's forward edits are not held
  (#1833), and an edit that SURVIVES the Apply's undo would need the undo to stop reloading its snapshot — not done;
- a single-file prefab write makes one extra read of its file.

**By guid, never by a recorded path** (hub call (e)): each step restores its prefab by the prefab's guid, resolved to
wherever the file is now, so a Rename since the step does not strand it. A document read from an id-less file keeps
the id the manifest gave it, or Save would mint a new one and unlink every instance.

**A parked prefab wins every read** (hub call (c)): the runtime loader's re-read on a world swap
(`setPrefabReadOverride`, installed with `installEditorPrefabCacheWarm`), the editor's cold read (`fetchPrefabSource`),
the prefab-edit open and a placement (`parkedPrefabRead`). Otherwise Apply and Revert would compute against the file
while Save writes the park. **A writer's "what is there now" read takes the park too** (`readPriorDocument`, #1872): every
caller replaces the prefab (Create Prefab and the agent's `create`, both redos, the model re-import, the rigged
regenerate, the skin-rig update), so it matches its rows against, merges over and restores the document the editor
shows. Four spelled that inline and three read the file: the rigged regenerate merged the fresh skeleton over the file
and dropped a parked child hung on a bone from its write, and the agent's Replace minted a fresh `nodeGuid` for a node
only the park held. One read stays on the file on purpose: the commit's precheck, the precondition about what the file
holds. No caller of `readPriorDocument` holds its bytes as the disk's; each hands them to the commit as `expected`,
which the D-a rule below checks against the file's own baseline. So over a park kept across an outside change of the
file, those writers now REFUSE as a conflict, as Save's flush does, where a re-import or an agent `create` used to write
over the outside change unasked.

**A write over a parked prefab** (`commitPrefabWrites`, D-a) that names the park as its `expected` is checked against
the park's own baseline, the file; any other `expected` is checked against the file as it is, and a writer that read
something else conflicts. **Any write that LANDS retires the park**, whatever it was checked against: the file and both
caches then hold the written document. A writer that read the file (a model re-import, the agent's `create`) used to
leave the park behind, and every later read took it over the document just written (close-out review F3). The park is
retired while it holds the document the write captured (re-flagged meanwhile or not); a different document parked
meanwhile keeps its own baseline, so Save conflicts and asks rather than overwriting the write (close-out re-review).
Every prefab write is a write in flight (`beginAssetWrites`), so a restore waits for it. A Replace or a rig
update over a parked prefab reads the park as its "before" (D-i), so its undo brings the park back.

**A restore waits for any write of the same prefab** (`assetWritesSettled`, as an asset-document step waits: Save's
flush and every `commitPrefabWrites`). Until a Save's write lands, the park's baseline names what the file held BEFORE it, and a redo back to that document read as
"back to the file": the park was dropped, the file kept the saved document, the editor showed the redone one, and it
reported clean (F1). **A park kept over an outside change is never dropped by a restore** (`fileChanged`, set by the
watcher's keeper): its baseline no longer names the file, so the park stays for Save, which meets the change and asks
(F2). **The keeper runs when the change is HELD, not when the release applies it** (`holdOutsideChange`, the #1879
hold). Marked only at the release, a redo during the hold back to the park's baseline dropped the park, and the release
then adopted the outside file over the unsaved document silently, where Save used to ask (the #1879 × #1868 seam,
`prefabParkOutsideHold.test.ts`, which runs each case with the change held AND arriving and requires the same outcome).
A held change to an UNPARKED prefab is untouched until the release, which adopts it silently as before. **An editor
write landing after the hold supersedes the held change** (#1889, the prefab twin of `outsideChangeSuperseded` — see
[editor-hmr.md](editor-hmr.md)): the release neither marks a park nor adopts the file. Without it, Save → Overwrite →
redo parked a new document over the editor's own write, the release's keeper marked THAT park, and an undo back to the
file kept it "unsaved" — Save then rewrote identical bytes unasked; on arrival the change was consumed before the
Overwrite, so held and arriving diverged. Every editor prefab write counts, not only Save's flush: the epoch is stamped
at the one file door (`prefabCommit`'s `landFiles` — `prefabWriteStarting` / `prefabWriteLanded`), so the prefab-edit
save's Overwrite supersedes too. A change held AFTER that write is on disk, and is marked or adopted as ever. An **Overwrite** answers one conflict: the flush that wrote with it clears it, whatever it did (F6), and a flush
that did not leaves it for the Save that asked.

**Save** flushes a parked prefab through `commitPrefabWrite` over its baseline. `/api/asset-write` refuses the type.
A file changed on disk since the park refuses as a conflict. The human's Cmd+S then asks **Overwrite or Cancel** per
file (`answerParkedConflicts`, `saveCommand.ts`), and Cancel leaves the document parked. An agent `save_all` has no
dialog and reports the conflict per path. **A hot reload of a parked prefab keeps the park** (`agentBridge`'s parked-prefab keeper),
DIVERGING from a parked asset document, whose park the watcher drops: a prefab's park is what every live instance was
rebuilt from, so dropping it without a reload would leave them on a document neither the park nor the file holds. An **agent discard** of a parked prefab re-imports it from its file IN
PLACE (D-e, #1873 S2, `prefabReimport.ts`): both caches take the file's document and every live instance is rebased onto
it, keeping its own overrides, as Unity's reimport does. It used to take the watcher's path, which is the #1164 disk-wins
reload of the whole open scene, and an unrelated unsaved scene edit and the undo stack went with it. During Play or a
preview it waits and replays as a re-import, not a reload. An instance it cannot rebase (a stale nested frame) is named
in the reply's `notRebased`, whose way out is an explicit scene reload. An undo step that depended on the discarded
document (the undone Apply's redo) refuses through its own precondition. An outside change to the file waits for a
focus gain or `modoki_refresh` (#1879) and is then re-imported in place (#1873 R1). An asset document's discard leaves its live edit. **A build or OTA publish** warns when
anything is unsaved (`confirmUnsavedBeforeBuild`), since a build reads the files.

What the owner gives up (D1): after undoing an Apply, the file still holds the applied version until Cmd+S. A git
diff, another clone or a build sees the applied bytes. Save re-serializes the document, so a BOM or hand formatting the
replaced file had is not kept.

### Undoing an Apply

> **Illustrates I9, I10 and I11** (the document is restored whole, only over the side the step left, and in the world
> it began in).

An Apply changes two things: the prefab, and every live instance of it. So its undo (`applyPrefabUndo.ts`) puts back
both. It restores the prefab document in memory (§ above), then reloads the live world from the `serializeScene`
snapshot taken on that side of the Apply. Only the scene snapshot tells the applied instance (an override again after
the undo) apart from the ones that merely inherited the value (back to the old base). Neither a rebase nor a rebuild
from the prefab's document can recover that. **Neither the Apply nor its undo or redo saves the scene** (#1868). Unity's
Apply never does, and the undo dirties the scene as every undo does. Before, a promotion Apply saved the scene, and its
undo and redo then saved it over the other half's bytes, which needed #1695's precondition to stay safe.

**Every prefab the Apply wrote** (an enclosing prefab's row too, #1693/U13) is restored as one step, and the refusal
names the prefab whose document changed, not the Apply's primary (#1732). On the FORWARD side, a multi-file Apply that
fails part-way is refused, but when its rollback could not put a written file back, or the world was replaced while it
wrote (#1667), part of it is on disk anyway: `ApplyResult.landed` marks that, and the agent op answers `PARTIAL`
(`prefabApplyRefusal`), never a plain refusal that reads as "nothing happened" (#1910's family).

**The snapshot is reloaded under the key of the world the undo belongs to when it RUNS**
(`currentSceneKey()`, the key Stop's restore uses), not under a path captured at the Apply (#1575):
- **a scene's path**: reloaded there, and the editor's path and base re-synced;
- **the prefab-edit world's synthetic path**: reloaded there (#1573, § Prefab edit mode);
- **an untitled scene** (`null`): reloaded under `''`, as `restoreAuthoredSnapshot` reloads one on
  Stop. Nothing is fetched, the world is not marked as a loaded scene, and the editor's path stays null
  (so Save still asks where). `replaceWorldContent`, which builds an untitled world, cannot do this: its
  populate callback is synchronous, and a prefab instance needs the async loader.

Before #1575 an untitled scene matched neither captured path, so only the prefab came back. Reading the key at undo
time also covers an untitled scene saved with **Save As** after the Apply.

**The reload happens only if that world is still live.** The restore's nested preload, the member-path repair and the
reload itself are awaited, and a scene load, an Exit from prefab edit, or a Create Scene that bypasses #1579's wait can
land there. The reload is skipped, with a warning, when the key changed, the world object changed (checked for every
key: a scene load swaps the world before it sets the path), or a scene load is swapping the world
(`isSceneLoadSwapping()`, or `sceneManager.getNext()`; a load only WAITING for this undo does not count). A skipped
reload also skips `rederiveBaseInstances`. **And the step throws**, since it applied only half (the prefab, not the
world), so the undo manager drops it with a loud report (#310, [editor.md](editor.md) § A throwing undo/redo closure).
Since #1579 every user world switch waits for the undo in flight, so these guards are defence in depth
([editor.md](editor.md) § A user world switch waits for the undo in flight).

Tests: `engine/tests/editor/applyUndoIfMatch.test.ts` (memory, park and refusal), `applyTwoFileUndo.test.ts` (several
prefabs), `untitledApplyUndo.test.ts` and `prefabEditApplyUndo.test.ts` (the world rules, each mutation-checked),
`applyPrefabDirtiesBase.test.ts`, `prefabPark.test.ts` (the park across a world swap, the flush, Overwrite/Cancel), and
`engine/packages/modoki/tests/editor/applyToPrefabUndo.test.ts` (no scene save).

### What a rebuild respawns is what the save writes; a capture that is READ keeps reference nodes legacy (#1826)

A live capture of an instance's structure has two kinds of consumer, and they need a reference node (an `added` node
carrying `prefab`, scene-added or template-added) in two different forms.

- **Respawned** (a rebuild re-spawns the node): since #1880 F6 a rebuild is the LOAD of its scene entry as the save's own
  writer states it (next section), so it respawns the rows form by construction. Before that, the old per-frame rebuild
  respawned from a capture of its own, which had to be mapped onto the save's rows form by hand
  (`captureStructureForRespawn` / `inRespawnForm`, through `writerFormOf` keeping each node's placement); a channel the
  map missed was the bug (#1826: the LEGACY channels fold wrongly in the loader's one spawner against a template member
  row, so a template value was lost live until a reload, or a scene edit lost outright). Both were deleted with that
  route (#1880 F7d). The invariant stands: **what is respawned equals what is saved**. Mechanism and measurements:
  [prefab-structural-overrides.md](./prefab-structural-overrides.md) § the member-row bullet "Rows are written in the scene
  FILE form".
- **Read** (compared, listed, promoted): the comparisons against the chain's nodes (`diffFrameAdded`,
  `subtractChainStructure`, the save's nested-frame diff), the override listing, and Apply's promotion into a template
  (`insertAddedSubtree`, `toTemplateNodes`). These take `captureInstanceStructure` itself, in the legacy form. **Do not
  move them to rows:** in rows form a template reference node compared as edited and was restated on every save, and the
  promotion, which reads the localId channels, dropped the members' edits of the node it promoted (the first #1826 fix
  did that by capturing rows at the source — its close-out review's F1).

Tests: `engine/tests/editor/prefabPastedReferenceRebuild.test.ts` (each node is respawned once, WHERE it sat, with its
values; with the capture moved to rows at the source, the promotion case and the template-added node case go red).

### A rebuild is the LOAD of its outermost scene entry (#1880 F6)

> **Illustrates I1** (one fold at every depth) **and I14.** A rebuild and a reload now run the same code over the same
> statement, so they cannot fold an instance differently.

**The unit is the OUTERMOST scene entry** (hub ruling F6-U (i), 2026-09-30). A rebuild asked for any frame inside it (an
owned nested root on Apply's fan-out, a stale nested frame, a reference node) rebuilds that entry once:
`outermostEntryOf` climbs an owned root to its owner (identity, #1437) and a stored root to the frame of the member it
hangs under. **The rebuild states the entry as the save does, then loads it:** `captureInstanceEntry` (`instanceEntry.ts`,
the save's own writer since F6a) with the caller's edit made in the frame it names (`FrameEdit`: an Apply's subtracted
fields, a Revert's reduced set, a reverted move's `parent`), then `rebuildFromEntry`: the teardown and what it parks and
keeps (unchanged), the loader's spawn (`instantiatePrefabIntoWorld`), and the loader's post-pass for that one entry
(`settleEntryRows`, scoped so a pin outside the entry is untouched). What no document holds stays the rebuild's own: the
root's durable guid, `Transient`, the `sourceScene` stamp, and each torn-down node's template key (#1567).

- **Every reference node is stated against its own RECORD** (`againstRecords`), not the cache: a stale nested frame is
  then stated as it was built, and the load expands it from the cache, as a reload of an older save does (I4). Its
  localId channels are translated into the cache's numbering (`translateCarried`).
- **Every caller warms the entry before its synchronous rebuild** (`preloadRebuildEntry`, #1880 F7a): the load reads
  every prefab in the entry, not only the frame's. An entry whose own prefab is gone (a trash, #1862) loads from its
  record (`entryDocOf`). A frame INSIDE the entry whose prefab is gone is expanded from its own record too
  (`withFrameRecords`, #1880 F7d), as a reload with the prefab restored expands it — kept whole instead, a stale frame
  inside it was never re-expanded yet was counted (hunt seed 1042). Only where that changes nothing else the load
  expands: the records come from the entry's own live subtree and must agree on one document, and a prefab the entry
  holds as an UNEXPANDED row (ruling R, #1849) or a placeholder is not answered — a no-op rebuild must leave those as
  they are (the placeholder half, #1909 (d): the STATE is built with gestures alone — a P node placed under an instance
  whose template has no P row, P trashed, the scene reloaded, a copy of a P instance pasted beside it — and unblocked, a
  no-op rebuild of that entry expanded the placeholder from the pasted frame's record; `entryRebuildPlaceholderGuard.test.ts`
  calls the rebuild directly, so which gesture then rebuilds the entry is not exercised) — nor one with a NEW row: a row of it that no live frame of it expands and that its owner's frame was not
  built with (a refreshed document's added row, which a reload leaves unexpanded, ruling D, #1790), matched by nodeGuid
  (by number only for a pre-v5 row, since a renumber can put a new row on an old number). A row the instance removed is
  one its frame was built with, so it blocks nothing. Otherwise the frame is KEPT by the teardown (`unexpandable`, asking
  the same reader) — including an owned frame moved OUT of the entry (#1437), kept where it hangs, or parked and put back
  by its parent's guid when it hangs under something the teardown takes. (A kept frame re-parented under ANOTHER
  moved-out frame loses its members on the rebuild, #1909 (b), but only through a raw `parentId` write: every editor and
  agent route asks `restructureRefusal` first, and a legacy `moved` file placing it there keeps them.) — and a target inside a kept frame is not
  counted: the rebuild says so ("left as they were"). A gesture that must rebuild such a frame to change it — a Revert,
  an Apply, a Revert's or Apply's undo — is REFUSED before anything moves (`keptEnclosingSource`, which asks the frame
  itself too: its own prefab can be trashed between a gesture and its undo): the rebuild would
  leave it as it was while the gesture reported success. An entry with no document at all, or one whose document
  expands to no root, is not rebuilt, and the caller says so, once, and does not count it.
- **A Revert of a nested frame finds that frame again by a durable guid** (`captureEntrySide` mints the frame's as well
  as the entry root's): on a runtime-guid instance (#1210) the rebuilt frame derived a new guid, and the Revert answered
  the entry's root and its undo was refused (#1880 F7d close-out review).
- **A refresh expands every frame of its prefab in the entry from the document it was handed** (the load's reader
  answers `source` with `newPrefab`, #1880 F7d), so a nested frame is built from it even where the cache holds another
  copy.
- **A frame built from other rows than the cache's (#1493) is rebuilt, not refused** (#1880 F7d, close-out F2): its
  record states it as built, and the load expands it from the cache, as a reload does. The old per-frame rebuild refused
  it because its nested capture read the cache; that reason went with it. Refused while a sibling target in its entry was
  accepted, it had been rebuilt by the sibling's load anyway, under a false "not refreshing" warning and count.
- **Revert, its undo, and an Apply's undo sides keep the entry itself** (`EntrySide`: the entry root's guid, its source,
  the document it was captured against, the entry), because ids do not survive the rebuilds in between. An entry root
  with no durable guid (never saved, or on a runtime guid, #1210) is given one when the side is captured, as `ensureGuid`
  gives any entity an undo step names (#1880 F7c). The undo and redo load the side through `rebuildFrameFromSide`. A
  Revert whose frame has no entry to state it by is refused, with a warning.
- **In the prefab editor an entry is a ROW** of the edited prefab (F6f). It is rebuilt the same way; the rows the load
  keeps for it (R2) go back into the template through the edit save's row writer, which states a node by its key, so
  every member-row set in the entry is keyed while its nodes are live (`keyEntryRows` → `keySceneNodes`, gated by
  `keepsTemplateRows`), and every other node carries its live key marker (#1880 F7d): a node the rebuild brings back
  that was not in its teardown — one a Revert took out, put back by its undo — had no marker to carry over, and the next
  template save minted it a new key. A payload's refs stay live guids: a token would name a row added this session by a
  localId only the next save assigns.
- **What it changes, accepted by the hub:** more is re-expanded per rebuild. Measured on Court's daily-month (42 cell
  frames, machine under load, relative only): one cell's refresh 20–40 → 130–154 ms, all 42 cells 654–786 → 410–419 ms.
  No interactive path (a field edit, a gizmo drag, a scrub, Play) reaches a rebuild; a focus-gain release of outside
  changes can land during a drag, as before F6. An open EntityPin anywhere in the entry closes (#868's rule, wider
  reach). The rebuild ends the undo coalescing chain (its respawn takes back the raw ids the chain is keyed by). koota
  handed a torn-down entry its ids back in allocation order in every case tried (four perturbations), so the ids of the
  entry's other entities did not drift there.
- **The old per-frame `rebuildInstance` is gone** (#1880 F7, § 3 of the design), with its nested capture and re-apply,
  its respawn form and `rebuildInstanceFromCapture`. The three classes that still reached it after F6 were closed first,
  each measured to zero on the editor suite: an entry whose load read an uncached prefab (F7a, the preload and the record
  fallback), a refresh whose new document was the cache's in content but not by identity (F7b; F7d's reader then
  replaced the comparison), and a side whose entry root had no durable guid (F7c).
- **Pre-v5 documents** (rows without `nodeGuid`): the save states a nested row's own `added` / `removed` /
  `removedTraits` as the scene's, so a reload keeps the old template's there, and since F7d so does a refresh (it IS a
  reload). Measured on `rebuildNestedReapply`'s fixtures at `version: 3` (four refresh cases red; all green on v6 rows).
  Every source prefab with a nested row in the repo's corpus is v5+; only stale build copies are older.

Tests: `prefabWholeListRebuild` (#1891's seed 1233, the class the unit closed), `nestedEnclosingLayer`'s three-level
U14 case, `nestedRowFieldSave` (the kept `removed: false`, in a scene and in the prefab editor),
`templateReferenceNodeRows` (the edit world's keys, and a Revert's undo through the real undo), `rebuildNestedReapply`
(the old re-apply's cases, now driven through the refresh), `sceneMemberRowWriter` (a stale nested frame refreshed, not
refused), `revertUndoCurrentPrefab` (the same for a Revert's undo), and the fuzz's T2/T4 checks (rebuild ≡ reload, a
no-op rebuild is the identity).

### A capture reads the document the frame was EXPANDED from (#1483)

> **Illustrates I3** (a frame is compared against the document it was expanded from), **and I9**.

A localId means something only together with the document it was read from. Every capture
(`captureInstanceOverrides`, `captureInstanceStructure`, the override keys, Apply, Revert) diffs a
member's `PrefabInstance.localId` against the editor's CACHED copy of its source. So the invariant
is: **a live frame is expanded from the document currently in the editor cache.** Apply keeps it by
refreshing every instance, and its undo/redo keep it through `refreshBaseInstances` (#1431).

The hot reload broke it for a **kept base scene**. `SceneManager` carries a base with unsaved edits
across the swap FLAT (`snapshotPersistentEntities`), so its instances keep the old document's
numbering. Meanwhile `refreshPrefabSourceForPath` has already put the new document in the cache.
After a renumbering write (a `git checkout`, a hand edit), each member was compared with another
member's row: false overrides, and Apply wrote one member's value into another's row. Three pieces:

- **Every respawn keeps the record.** `identityParents.ts` records, per frame ROOT, the document it
  was expanded from (`noteFrameDoc`). A flat respawn is a new entity, and the record keyed by the old
  one does not reach it. The base-scene carry re-records it on the respawned root (`noteFrameRootDoc`,
  root only: the new world did not expand that source, so its per-source "latest" record is not
  touched). `EntitySnapshot.frameDoc` does the same for duplicate, paste and delete-undo. A copy keeps
  it too, because it was built from the same document. Without that, a respawned instance was
  invisible to both guards below.
- **The reload rebuilds stale carried instances.** `adoptWorldReloadedFromDisk` (the editor's
  hot-reload hook, now awaited by `agentBridge.ts`) calls `rebaseStaleInstances()`. That runs the
  refresh Apply uses on every instance FRAME root, stored or owned nested (#1493), whose recorded
  document differs from the cache (by content), inner frames first (see below). Kept bases are not the only carried roots: in Play a `Persistent` root is carried
  whatever scene owns it (in Edit mode it is re-read from its file, #1863). Everything the reload re-expanded from disk compares equal and is left
  alone. A world replaced while the nested prefabs load rebuilds nothing. A reload that is deferred
  (Play, a preview envelope) rebuilds when it finally runs, because the record, not a remembered
  baseline, says what each frame was built from.
- **A respawn or re-link from a RECORD is rebased at once** (#1820, #1859). The clipboard outlives an Apply,
  a Replace, a prefab-edit save and an outside edit, so a Paste (and its redo) respawns frames expanded from
  an older document; an undo snapshot outlives a template change the scene's stack does not hold (a SAVED
  prefab edit, an outside edit), so Delete's undo and Duplicate's redo do too (the close-out sweep, OBSERVED:
  23 of 192 grid draws); Create Prefab's undo re-links a tree to the template it was built from. The respawns
  call `rebaseRespawned` (`entityActions.ts`; Delete's undo after it restores its root links), the re-link
  `rebaseStaleInstancesSoon` directly: the same rebuild, SYNCHRONOUS when every prefab it reads is cached (as right after
  an in-session change), and the async rebase under a world hold only when one has to be fetched. As in Unity,
  an instance always merges against the CURRENT asset. Before, the live paste showed the old template until a
  reload, and edits to a stale member were lost there. Detach's undo already rebased (`reattachDetachedInstance`).
  ⚠️ When Create Prefab's undo DID rebase (the template changed since the create), the tree is no longer what the
  create's rows describe, in shape or only in value, so its **redo refuses** before anything is written. Re-linked
  anyway, it tagged nothing while reporting success (a shape change) or its reload reverted the new value (a value
  change) — both OBSERVED by the close-out reviews.
- **Create Prefab's undo and redo take the tree's state from what the TAG WROTE and the document it wrote** (#1830),
  never from a record of the whole tree or a re-plan of it. `tagCreatedPrefab` (both routes) reports each write — a
  `link` (the entity's link replaced by a row of the new prefab) or a `stamp` (a nested row's root: only its
  owning-row fields) — and hands back exactly what the step's two halves need:
  - **The undo puts back only what the tag overwrote.** A relinked frame gets its record back with its links (below,
    #1665). A nested frame keeps the record it has NOW: a saved prefab edit since may have rebased it, and the
    create-time record put back over it made the undo's rebase respawn the edit's new child beside itself (I7,
    OBSERVED from O → Create Prefab → edit the nested P, add a child, save → Cmd+Z). A nested frame's members were
    never written, so they are not relinked either (a member a later save deleted read as a lost link).
  - **The redo puts the file's template keys back before it re-plans.** A node an undone Duplicate respawned without
    its `TemplateAddedKey` marker was minted a fresh key by the plan (`addedNodeIdentity`), so its derived guid no
    longer matched the file: a later redo refused "X is no longer in the scene", or a `{removed:true}` record keyed
    on the old key was lost (#1854's signature). The tag records each key the written document declares by the node's
    pre-stamp guid; not row-for-row as #1759 does for localIds, because those nodes sit inside a nested row's lists
    and the plan's capture carries no entity to pair them with.
  - **…and the undo takes off every key the create put on** (#1884), both routes. The keys come from the create's
    CAPTURE, not its tag: `serializePrefab` writes a scene-added node under a nested instance as that row's added
    node and keys it (`addedNodeIdentity`), before the tag runs. So the caller takes the tree's unkeyed nodes BEFORE
    its serialize (`unkeyedNodes`), and the tag's undo strips exactly those that are keyed afterwards. A redo takes its
    own set before its seat, a redo that refuses strips its seat on the spot, and a create that writes nothing after
    its serialize (the write fails or conflicts, or the serialize refuses) strips them before it returns — the rule for
    every door, above ("A door's pre-commit capture stamps come off when it lands nothing"). A node keyed before the create (a
    nested instance's own template-added node) keeps its key. Left on, the undone node was plain with a key the save
    drops, so live and reloaded disagreed (fuzz seed 1021), and a later capture would read the stale key as its
    identity. Unity: undoing Create Prefab leaves no prefab identity on the object. Detach's twin: U17 (#1874).
    Pinned by `createPrefabUndoTemplateKeys.test.ts` and the fuzzer's REGRESSIONS.
  - **The redo refuses when the tree no longer plans to the written rows** (`planMismatch`, the unlogged half of
    `planMatchesFile`), before anything is linked. A Detach's undo can rebase the tree onto a newer template between
    the two halves. The tag used to log `not tagging … (N rows now vs M written)`, leave the tree unlinked and let the
    step report success.
    **…and when a frame the undo RELINKED was rebuilt from another document since** (`relinkedFramesCheck`, both
    routes, a create's redo and a Replace's; the value half, from the close-out reviews). A Replace's in-memory
    precondition asks only after the document it replaced, not after the template the undo put the tree back on. A saved prefab edit of the template the undo put back changes
    the tree's values without changing its shape; linked anyway, those values sat on rows written with the old ones,
    and a Save + reload reverted them. `rebasedByUndo` caught this only when the undo's own rebase did it. A reload
    re-expanding the same document is not a change.
  - **The tag clears the override marks of what it links, and its undo puts them back.** The tree is written as it
    stands, so nothing in it overrides the document just written from it (Unity: a prefab made from an unpacked object
    has no overrides). A Detach keeps its marks on the plain tree until a reload, and Create Prefab linked them as
    overrides equal to the template's values, which pinned them against every later edit of the prefab.
  - **The redo reads the document the EDITOR holds first** (`readPriorDocument` takes the park, #1868's rule). A later Replace's or
    Apply's undo restores this prefab in memory only, and the file keeps the bytes it overwrote until a Save; read
    from disk, the redo refused "changed on disk" over the stack's own step.
  Tests: one fuzzer REGRESSION per symptom (`prefabFuzz/knownOpen.ts`, issue 1830), and
  `createPrefabTagWrites.test.ts` for a relinked root's record and the marks.
  **A deleted ROW of a frame that SURVIVES the delete** (a member, or an owned nested root, whose frame root was not
  deleted) is the case the rebase alone cannot see. It rebuilds frames whose OWN record is stale, and leaving prefab
  edit has already rebased the surviving frame onto the saved document. Before this fix, the respawned row followed the
  old document: a template value frozen as the row's own, a member the template dropped lost on reload, a nested
  root's parent link reverted (16 of 528 review-grid draws). So the delete records each surviving frame's document
  (`survivingFrameRows`, `entityActions.ts`). The undo's steps:
  - **Before anything respawns (I19)**, it compares each surviving frame with its current record. It REFUSES when that
    document dropped a row it would bring back, or that row's parent: a member the prefab no longer has.
  - **After the respawn**, it renumbers the rows (`translateLocalIds`). It re-records the frame as the current document
    holding those rows' OLD content, so the ordinary rebuild sees the frame as stale: it captures against that record,
    where the mark gate carries only the rows' real overrides, and rebuilds onto the current document.
  - The result is the template's new values plus the instance's own overrides, with no rebuild path of its own.
  ⚠️ The check reads the world the UNDO runs in, not the one the delete was taken in. Leaving prefab edit swaps the
  world, and the dead world still held the old record, so the first version saw nothing to translate.
- **Written lists follow SIBLING order, never ECS query order** (#1796). `captureInstanceStructure`'s child
  lists (a scene's `added`/`own`/`children`) and `collectTree` (Create Prefab's writer and its redo's re-tag)
  sort children by `compareSiblings` — sortOrder, then guid — as the top-level `entities` list already did
  (#500, `entityOrder.ts`). Query order is not stable across a reload (koota reuses slots), so a save → reload
  → save flipped those lists forever, and Create Prefab's redo re-tagged by position over a reordered tree
  and was refused. A prefab-edit re-save keeps every existing localId (`planPrefabRows`' preserve map), so
  only NEW rows are numbered in the new order. A committed file reorders once, on its next save.
- **Every refresh captures a root against ITS document.** `refreshInstances` (Apply's fan-out, its
  undo/redo, the rebase) uses each root's own record as the capture baseline, and falls back to the
  caller's `oldPrefab` only when there is no record; the load translates from that baseline by
  `nodeGuid` (`translateLocalIds`, `memberTranslation.ts`). Before the close-out review, an Apply on one instance rebuilt a
  stale nested frame in ANOTHER against the cached rows and moved its edits onto other members, for
  good. (The per-frame rebuild then skipped a root whose stale frame was only NESTED, and ran the fan-out **deepest
  first**, since its outer capture read an inner instance of the same source against the CACHED document. Since #1880
  F6/F7d every frame in an entry is stated against its own record by one load, so neither the skip nor the order is
  needed, and both are gone.)
- **Apply's undo/redo rebuilds the applied base instance FIRST** (`rederiveBaseInstances`,
  `applyPrefabUndo.ts`), then re-derives the other base instances, then re-selects by guid. The
  applied instance can sit inside another base instance, whose refresh captures it through
  `captureNestedRef` against the cache, so it must already be built from the restored prefab. Before
  the third review, the enclosing instance read it as a stale nested frame, was skipped, and kept the
  member the undo had taken away. The snapshot restore also rebases the `Persistent` roots its scene
  load carries flat, before it saves.
  The capture is of the applied FRAME against its own prefab (`BaseInstanceSide.source`), taken whenever the
  instance is base-owned, including when the Apply wrote only an ENCLOSING prefab ("override in Prefab 'O'", #1724).
  That Apply moves the instance's own value into O's row (U15), so the refresh of O's instances from the restored row
  cannot bring it back. Before #1724 the capture was dropped for it, and the undo showed the row's old value on the
  dirty base, which Save All then wrote. The rebuild re-seeds the value as a MARKED override, and that mark is what
  carries it through the enclosing refresh that follows (a second rebuild after the refresh was tried, and a mutation
  proved it inert). It is rebuilt onto the CURRENT copy of its own prefab (`rebuildInstanceFromCapture`, as Revert's
  undo does, #1665), not the copy captured: an enclosing-only Apply restores nothing of the frame's own, and a
  prefab-edit save, another scene's Apply or a pull can have changed it since. Rebuilt from the captured copy, a member
  it had gained vanished from this instance, and the frame then read as stale, so Apply and Revert refused it (close-out
  review). Test: `applyBaseTwoFileUndo.test.ts`, on the real two-file path.
  The side also carries every frame NESTED in the applied instance (`BaseInstanceSide.nested`, #1741), captured with it
  and handed to the rebuild in place of the live frames. An Apply from the OUTER root of a nested frame's own edit
  (U14) takes that edit out of the frame, so at undo time the live frame shows the other side, and the rebuild's own
  capture read nothing of it: the undo showed O's row value on the dirty base. See § "A rebuild's nested frames".
- **Leaving prefab-edit mode re-reads the edited prefab, by EVERY route** (`settleLeaveDebts`,
  `sceneAdoption.ts`). `refreshPrefabSourceForPath` skips the prefab open in prefab-edit mode, so after an
  exit without saving, the editor's copy could be older than the file the scene had just loaded from.
  Every instance of it was then refused, and a later rebase rebuilt carried ones back to the old
  template. The repair re-reads it once the edit flag no longer names it, then rebases, because a
  `Persistent` root was carried through prefab-edit mode and back (no longer: outside Play it is re-read from its file, #1863), so a SAVED edit reached it only there.
  Until #1666 it ran only in `exitPrefabEditing`, so the Assets double-click, the Inspector's Open Scene
  and agent `load-scene` (all `serialize.loadScene`) left the carried instance built from the old
  template and the prefab's copy stale for the session. Since #1698 the adoption owner RECORDS the
  debt: adopting any world (another edit world included) over an edit world whose session is still
  open owes that prefab's repair. The debt comes from the owner's own `lastAdopted`, not the edit flag,
  which the breadcrumb's re-render clears on the swap. Debts are a SET: #1690's one slot lost the first
  debt when an edit-open landed in a scene load's tail. They are paid by the last world switch to END,
  whatever its outcome, and cleared only by a repair that completed in the world it started in. The
  session ending WITHOUT a load leaving the world (Exit with no return scene, or whose load installed
  nothing) is `endPrefabEditInPlace`, which acts only if no adoption happened since Exit began: an
  edit-open adopted in Exit's tail keeps its session. The full model: `docs/scene-loading.md`
  § "Load supersession: states and invariants", S7.
- **An undo that puts an instance back from an older capture lands it on the CURRENT template**
  (#1665). Revert's undo and redo rebuilt from the document the Revert read, and Detach's undo re-adds
  links naming the pre-detach document. When the template changed in between (a prefab-edit save, an
  Apply from another instance), both undid that change on this one instance, and the next save wrote a
  member the template had gained as REMOVED by it. Revert (`revertOverridesWithUndo`, the one wrapper
  the dialog and the agent op share) rebuilds through `rebuildFrameFromSide` (the entry as it stood, loaded onto the
  current documents, #1880 F6d/F7d), and Detach's undo
  rebases after the reattach (`reattachDetachedInstance`). In production the template changes between
  a Detach and its undo only across a world reload, which leaves the tree plain with no frame record, so
  the detach snapshot carries each frame root's record and the reattach puts it back; without it the
  rebase skipped the frame (close-out review). Always, not only where the world has none: the restored
  localIds index the snapshot's document, and Create Prefab's Replace undo otherwise kept the SAME
  prefab's newer record over them, so the instance read as stale (re-review). Create Prefab puts back only the
  records of frames its tag RELINKED (#1830): a nested frame's current record stands. Detach's redo keeps
  the snapshot of the detach it just made (`detachPrefabInstanceWithUndo`): the undo's rebase can bring
  members in, and replaying the FIRST snapshot on the next undo left one of them plain. (The per-frame route this
  replaced translated the carried state into the frame's recorded document, and refused a step whose NESTED frame was
  stale with `UndoRefusedError`. The entry states every frame as it stood, keyed by identity, so there is nothing to
  translate by hand and nothing to refuse; the step is refused only when the entry's root is gone.)
- **Apply and Revert refuse whatever is left** (`framesBuiltFromOtherRows`): any frame of the
  instance, nested ones included, whose recorded document does not hold the same rows as the cache:
  the same localIds, each naming the same `nodeGuid` where both carry one (`rowsMeanTheSame`). Both
  directions matter. A row the cache GAINED is not harmless: `captureInstanceStructure` reads every
  row with no live member as one the instance REMOVED, so it becomes a false removal on the next save
  or Revert. A round of this close-out narrowed the check to let gained rows through, on the evidence
  of a fixture (`duplicateCarriesRefs.test.ts`, #1437 P3-a) whose reload expanded the old document
  under a cache holding the new one, a split production never makes. The second review drove the
  false removal, and the fixture now resets its cache. Only row identity is compared, not content: a
  template whose values changed is still captured on the right rows (the mark gate), and refusing on
  content would block Apply over any byte difference between two copies of one file.

> **Superseded by #1880 F6/F7d.** A rebuild is now the load of the outermost scene entry, which states every frame in it
> against its own record, so a stale nested frame is rebuilt WITH its entry and is no longer refused. The next two
> sections record the per-frame design that replaced, and why it was shaped so.

**A stale NESTED frame is rebuilt by ITSELF (#1493), never through its outer instance.** The nested
captures (a rebuild's `captureNestedInstanceOverrides`, a save's `captureNestedChannels`) read each nested
frame's record since #1693, but the outer rebuild RE-APPLIES them onto a fresh expansion of the CURRENT
document. So rebuilding the OUTER instance would carry a stale nested frame's edits onto the wrong rows. Rebuilding the nested root on its own does not have that problem, because its own
capture reads its own record, like any other root's. That is also what Apply's fan-out already did to a
nested root of the source it applied. The rebase lists every frame root and rebuilds a frame only once
no other stale frame is left in what its teardown destroys (#1499), so by the time an outer frame is
rebuilt, every frame its capture reads is current. The issue's own proposal, which
was to teach the outer nested capture to read each nested frame's record and translate its re-apply, was
not needed. Before this, a nested frame was only detected. The rebase skipped it, and a dirty kept base
was carried stale through every reload until it was saved. The save then wrote its edits onto other
members: a nested member the scene had deleted came back on reload, and the member now holding its old
number was deleted instead (OBSERVED, the "…so the SAVE" test below).

**A rebuild's nested frames get their LAYER from the expansion and their EDITS from one source, the live capture,
unless the caller names the side (#1737, #1741).** A rebuild re-expands its root from the template, under the state the
layers ENCLOSING that root forward into it (`frameForward`): an owned nested root's chain, or a template reference
node's channels. That is the state a load hands the same root, so every nested frame the expansion brings in comes back
with the whole layer, as it would on a load. A stored root that no prefab layer encloses gets nothing and expands as
before. What the SCENE hands it on a load (a legacy `nestedOverrides` channel, a scene-added node's channels) is the
scene's own statement, and it comes back through the capture. A frame the capture cannot reach, because the document
did not expand it at load, keeps it through R2's LEGACY half (#1780): the load keeps each path-keyed channel whose frame
the document does not expand (`legacyPathReached`, asked of the document as R2's row test is), every writer puts it back
with a live capture winning each key (`withKeptLegacy`), and a rebuild that brings the frame in hands it to the
expansion as the OUTERMOST layer (`keptLegacyForward`). It is deliberately not part of `frameForward`: the nested
capture subtracts that state as a prefab layer's, and a scene statement subtracted would never be saved. Captured as
the scene's own, it goes onto a member row at the next save, so **a legacy file's first save after the frame is live
migrates the channel and changes the file's bytes**; a file with no such channel saves byte-identically. Both channels
are forwarded: kept `nestedStructure` slots ride as the outermost STRUCTURAL layer, so a removal the scene states
inside a frame the Refresh gains applies there as a load of the same scene would apply it (close-out F2: forwarded
fields alone left the frame showing a member the file removes, and the save then wrote both). The scene's own edits
reach it through the live capture (`captureNestedInstanceOverrides`, taken just before the teardown), which subtracts
the chain folded from that SAME forward state. A frame whose right state is not what the live tree shows at that moment
comes back wrong. There are three cases:
- **The caller names the side.** An undo rebuilding an instance to one side of a step hands in the frames it captured
  with that side (`nested`, from `captureNestedFrames`), and they REPLACE the live capture. They are re-applied exactly as
  a live capture is: each link is found by `nodeGuid`, and each capture is translated from the document it was read against
  (I4). A prefab file that changed between the step and its undo therefore takes the edit by identity, never by number.
  Apply's undo does this (`BaseInstanceSide.nested`). Revert's does not need to: Revert refuses a U14 nested key, so
  the live nested frames at its undo are the side's own.
- **A frame no capture reached (#1737).** A reference row under a member a Revert restores, one the template gained
  under a Refresh, or a row that a re-pointed frame's new prefab holds (#1767) has nothing live to capture. It gets its
  layer from the forwarded expansion like every other frame. Before #1737 the expansion was a bare top call, so the
  layer reached a nested frame only through its capture, and such a frame showed the inner template's values until a
  reload.
  - The two halves hold only TOGETHER. Without the capture's subtraction, a node the layer adds comes back twice (once
    expanded, once re-applied as the scene's own), and a restated layer value pins the frame against a later template
    edit. Without the expansion, nothing brings the subtracted layer back. Both halves match an added node by template
    key or durable guid, so a hand-written node with neither is matched by nothing and comes back twice (#1779; a
    prefab's own rows had this before #1737).
  - The forward state is folded against the document each side is FROM, because what a layer forwards to a frame's
    nested roots depends on that document's rows. The expansion uses the new `prefab`, the capture uses `baseline`.
  - The expansion stays a TOP call, with its own token scope, resolved by the rebuild's own derive once the member
    guids are restored. Its cycle stack holds the documents of the levels above, from the stored root down. The
    forwarded state is applied at the root's NESTED rows only: the root's own members take their layer from the
    caller's `overrides`/`structure`.
  - **Why not seed the frame afterwards:** two fixes that did (a nested `rebuildInstance`, then a respawn) were backed
    out in review. A rebuild's tail is world-wide: the kept-orphan settle, the derive that drains the move queue, the
    token scope and the cycle stack all run on the shared world. So the inner tail ran inside the outer one, and the
    respawn's teardown destroyed enclosing rows hung under the frame. Every after-the-fact seed fights the shared
    world. Doing what a load does avoids that, because the rebuild's single tail runs once over a tree that is
    already complete.
Tests: `applyBaseTwoFileUndo.test.ts` (#1741); `nestedEnclosingLayer.test.ts` § #1737, which also guards the moves and
kept rows the seeds broke, a Refresh from another version of the prefab, a forwarded member token, and a stored root's
unchanged save.

**A rebuild carries what its teardown reaches OUTSIDE its live subtree (#1499).** (The teardown, `rebuildTeardown`, is
still the rebuild's own and runs in `rebuildFromEntry`; the nested capture and the rebase's order below went with the
per-frame route, #1880 F7d.) The teardown
(`rebuildTeardown`) reaches by identity, so it also destroys things outside the rebuilt root's live
subtree: whatever the frame owns that was moved elsewhere in the instance (#1437), a member of a
user-added reference node moved out of that node, and every frame under those. Before #1499 the capture
and the respawn did not match it, and each mismatch was a defect:
- **The nested capture walked LIVE children** (`captureNestedInstanceOverrides`). A frame owned here but
  moved out was destroyed and re-expanded at its row with its edits lost. The capture now takes its frames
  from the teardown's own set, so the two cannot disagree.
- **The respawn restored two of an owned root's three identity fields.** `parentLocalId` and
  `parentNodeGuid` came back, but not `ownerGuid`, the link a move writes (`linkOwnerBeforeMove`). An owned
  root moved under the OUTER frame and rebuilt on its own then read its owner off where it hung, read as
  user-added, and the save wrote its row `removed` plus a scene-added reference node. (Moved under a member
  of its own owner frame, where it hung happened to name the right owner.)
- **The unpark and reverse-case walks took whole subtrees without the park test.** So something not ours
  under a member they took, such as an outer member moved in under a moved-out frame, was destroyed with
  nothing to respawn it. All three walks now share one `take`. (The unpark itself runs inside the
  teardown's fixpoint since #1493's third review: run once, ahead of it, a member of a frame that joined the
  teardown only later survived beside its own respawn, its link stripped.)

**What keeps the rebase safe is ORDER, not a skip.** The #1493 close-out skipped every frame whose
rebuild reached outside its subtree (`rebuildReachesOutside`), because each shape above lost edits. The
skip also kept the loop safe: every rebuild destroyed only deeper, already-processed entries. An earlier
draft argued "a stored root owns nothing outside its subtree", and that was false. Moving a member unlinks
it only when it leaves the OUTERMOST instance, and when the review drove the gap, a recycled id was rebuilt
as the wrong prefab. With the rebuild fixed, the skip is gone. What replaced it:
- **Teardown order.** A frame is rebuilt only once no other stale frame is left in its teardown set.
  Deepest-by-live-depth was right only while every frame hung inside its owner's subtree, and a
  moved-out frame can sit shallower than its owner. The case that shows it: P and Q both gain a member, and
  QR is moved under OR. By depth, the P frame went first, and its capture read the stale QR against Q's new
  rows, so the gained member read as REMOVED by the scene.
- **A teardown-shaped refusal.** `framesBuiltFromOtherRows` judges the frames a rebuild of the instance
  tears down, not its live subtree. So `refreshInstances`, Apply and Revert all refuse an instance whose
  teardown holds a frame built from other rows. (The close-out review drove the gap: at first only the
  refresh judged the teardown, and a Revert on the P frame captured a stale moved-out Q frame against the
  cache, then saved the member the cache had gained as REMOVED.) The rebase then clears it.
- **A per-entry re-check** (the id is still a root of the same source, holding the document collected).
  ⚠️ It is traced, not driven: the order never lets a rebuild destroy a pending entry.

What still refuses: `refreshInstances` skips a root whose teardown holds a stale frame, and Apply/Revert
refuse an instance holding one. That now happens only while the cache has moved and no rebase has run:
a direct cache write, or the window before the reload hook finishes. A reload clears it. The refusal reaches the Apply
dialog's Revert as a toast and the agent op as `prefab revert refused`, because Revert's own `null`
cannot carry a reason. A runtime (Transient) frame is never judged: no capture reads it, and nothing
would rebuild it to clear a refusal.

⚠️ **The save does not rebase for itself.** `serializeScene` is also the Play and timeline-preview
snapshot and the before/after capture of Apply's undo, and a rebuild respawns entities, so it must not
run inside them. A save is safe because every path that moves the cache under live instances brings
those instances current first, and so does every undo that puts an instance back from an older capture
(Revert's, Detach's). The hot reload, leaving prefab-edit mode and Apply's undo call the rebase, and so does every prefab write:
`commitPrefabWrite` rebases every frame of the source it wrote (#1692). Apply's fan-out refreshes each instance of
the source from that instance's own record first. Before #1692, the writers that did not rebase broke this: Create
Prefab's Replace and its undo, the skin-rig prefab update and the model regenerate. For Replace it was OBSERVED
(#1685): a template that gained rows had them saved as removed on the other instance, for good. Test:
`engine/tests/editor/prefabCommit.test.ts`.

⚠️ **Wrong fix, reverted (#1468 Phase 4):** making the listed keys name members by their own live
`nodeGuid` made it worse. The key then disagreed with the capture it named, and Revert moved A's
override onto B. A key cannot be more right than the capture it names, so the fix has to make the
capture right. Tests: `engine/tests/editor/sceneMemberRowWriter.test.ts` § "a live frame built from
another version of its template", and `engine/packages/modoki/tests/editor/carryFrameRootDoc.test.ts`.

## Scene serialization integration

In `editor/scene/serialize.ts`, a `SerializedEntity` carries two prefab fields:

```ts
prefab?: string;                                              // source path/GUID (on the instance root)
overrides?: Record<number, Record<string, Record<string, unknown>>>;  // localId → trait → field → value
```

During `serializeScene()`:

- **Prefab child entities are skipped** — only the instance root is written
  (children are re-instantiated from the source on load). Children are detected
  via `PrefabInstance.rootInstanceId !== ownId`.
- On the root, `captureInstanceOverrides()` produces the per-localId `overrides`
  map; only changed fields are stored. The root also keeps any "structural
  additions" — traits the prefab source doesn't define on the root (e.g. a
  user-added `Rotate3D`).

On load, `loadSceneFile.ts` detects the `PrefabInstance` (or `prefab`) field and
delegates re-instantiation to the `onInstantiatePrefab` hook. `SceneManager`'s
implementation spawns from the refcounted prefab cache into the staging world,
re-applies the root's extra traits, and replays the `overrides` map per localId.
Override tracking is per-localId, so edits to a sub-entity (not just the root)
survive a reload.

### A missing prefab keeps its record (#1699, I18)

A prefab reference whose document does not resolve at load (deleted, renamed without its sidecar, or not pulled yet)
cannot be expanded. Before #1699 the loader skipped it and kept its data nowhere, and the next save wrote only what the
world held: every override, added node and the name were lost for good, and did not come back with the prefab. Unity
keeps a missing-asset instance's `PrefabInstance` data in the scene untouched (U9). So does Modoki now:

**The reference leaves a placeholder that carries its identity, and the record the file held for it rides on the
placeholder as the unregistered `UnresolvedPrefabRef` marker. Every writer that meets the placeholder writes that
record back verbatim.** Only identity and placement come from the live placeholder: its guid, its name, its parent and
its folder, because those are what the Hierarchy can change. The name is the live one on purpose, so a rename is kept.

| Reference | Placeholder | Writer |
|---|---|---|
| A top-level scene entry | The loader's pass-1 placeholder stays (`keepUnresolvedEntry`) and takes the entry's name. | `serializeScene` writes the entry (`asSceneEntry`). |
| An added reference node (on the entry, a member row, a plain node's children, another reference node) | `spawnUnresolvedReference`, under the node's parent. The one reference-node spawner (`spawnReferenceNode`, which the loader's and the editor's structure applies both run) calls it, so a rebuild (Apply, Revert, Refresh) respawns it — except over a node whose frame is still LIVE (its prefab went mid-session): the rebuild keeps that frame and skips the node's respawn (#1862; met by its frame address and prefab, `keepingFrames`, #1939/#1948), so its members survive and no placeholder stands beside it; a Revert of the node's own add removes it. The loader keeps no orphan rows for it: its record holds them, and kept ones outlived its re-expansion and overwrote a later edit. | `captureChild` writes the node (`asAddedNode`). |
| A template's reference row inside a resolved instance | None: the frame is the template's. | The scene's edits to that frame ride member rows. `rowBackedTest` counts a row naming a reference row whose child cannot be read as unbacked, so the orphan store keeps it (the nested root's own row included, which it used to drop) and the save writes it back. Whether the ROW itself is saved as removed is asked of the frame record (`unexpanded`, #1812), not the cache: a frame built while the child was unreadable lists the row, so a cache holding the child later (restored or re-warmed mid-session, or left stale by an Assets delete, #1805) does not turn a row the frame never had into the scene's removal of it. A layer that removes the row takes it off the list (`noteRowsRemoved`, in `applyStructureCore`), so a scene's removal is stated again. |
| A reference row in PREFAB EDIT | The row is a top-level entry of the edit world, so it takes the first path. | `serializePrefabEditWorld` writes the row from the baseline, because the edit world's entry went through `editWorldRefs`. |
| A document that LOADS but expands to no root (#1768): its `rootLocalId` names no row, or a reference row whose prefab cannot be read, or one that nests itself | Where it is a scene entry or an added node: the same placeholder as a document that does not load. One predicate (`expandsToRoot`, `runtime/loaders/prefabRoot.ts`) gates the entry site before `onDeletePlaceholder`, the reference-node spawner (`spawnReferenceNode`), the expansion (which spawns NOTHING rather than a root-less scatter of rows) and the rebuild (`rebuildTargetsByEntry`, `rebuildFromEntry`: the live instance stays, and a refresh does not count it). A template ROW whose child expands to no root has no placeholder, as a missing child has none: both expansions list the row on the frame record as unexpanded, as they do a missing child (`nestedRowPresent` reads that; the document tests read that child as unreadable for a frame with no such record, `rowBackedTest`'s reader and `templateNodeGuids`' unread set, `legacyPathReached`), so its row is not saved as removed, and the scene's edits to its frame are kept (close-out F1). | As the row it replaces; a template row's frame, as the row "A template's reference row inside a resolved instance" above. |
| A LIVE frame whose document stops resolving mid-session (both caches evicted, no reload; #1738) | None: the frame is live. | The writers capture it against its frame record, the document it was expanded from (`captureDoc`, and `serializeScene`'s `levelDoc` fallback); the cache comes first, so a capture that works today writes the bytes it wrote. |
| The same frame NESTED, when an in-place rebuild (Apply's fan-out, Revert, their undos, a rebase) re-expands the frame that owns it (#1862) | None: the frame is KEPT, a template row's (an owned root) and a scene-added reference node's (a stored root under one of ours) alike. The teardown parks every such root whose own prefab the respawn cannot expand (asked of the cache the respawn reads, so a merely cold key is kept too), and `seatKeptFrames` puts it back under its parent member by guid and takes its row off the owner's `unexpanded` list. A kept frame whose row the new document no longer leaves unexpanded (dropped, removed by a layer, or expanded after all) goes, as the teardown would have taken it. | As the row above: from its frame record. The save is byte-for-byte the one the same Apply writes with the prefab present, plus the scene's copy of the missing prefab (`missingNestedFrameKeep.test.ts`). A RELOAD while the prefab is still missing expands the frame from that copy (below); before scene v19 it gave an unexpanded row (ruling D), not the entities. |

#### A scene backs up a missing prefab (#1914 F8 = A1, #1867, scene v19; top level #1935)

**A scene saved while a prefab is missing carries a copy of that prefab's document, and a reload with the prefab still
missing expands that scene's instances from the copy, top-level, nested and reference nodes alike** (each only if it was
live at the save; see below). This is Unity's scene
backup: `MergeStatus.MergedAsMissingWithSceneBackup`, "Prefab source was missing, but Prefab data was found in the scene
file - no merging was done" (U9b). Before it, a frame survived every in-place rebuild (#1862) but not a reload: a nested
row came back unexpanded (ruling D) and a top-level instance came back a Missing Prefab placeholder (#1699), each with
only its record, and the entities returned only with the prefab. R7 built the nested half; the top-level half, which the
owner's ruling names as well ("top-level and nested"), landed in #1935.

- **What is copied.** The scene file's top-level `embeddedPrefabs`, keyed by the prefab's guid
  (`collectEmbeddedPrefabs`, `serialize.ts`). A copy is the document the frame was EXPANDED from (I3), so it is that
  frame's template (I1). It comes from a live frame's own record, a top-level instance's or a nested one's. For a prefab
  no live frame expands (a row the copy itself could not expand), it is the copy THIS scene's load carried, written back
  verbatim (I18). A copy is base only. The writer's own edits stay in the scene's records, measured against it exactly
  as they were against the prefab (I2/I17), so the bump changes no record.
- **What is not copied.** A prefab that loads, which always wins. A top-level Missing Prefab PLACEHOLDER is no frame and
  gives none. A copy the file no longer reaches: the writer walks every guid the entries hold, then every guid inside a
  document one of those names, and writes only the copies it met, so a copy whose frames were all deleted goes, and so
  does one only a placeholder's record reaches (hunt seed 1031). **A copy another scene of the chain carried** (#1934
  L1): the loader keeps copies per SCENE (`noteEmbeddedPrefabs`, keyed by the file's `id`), and a save writes back only
  its own scene's (`embeddedPrefabGuids(world, scene)`). Kept per world, a level's copy was written into its base's
  file at the base's next save, and the base's reload then expanded frames that were not live at its save.
- **How the load reads it: one reader** (#1934 S1). `loadSceneFile` takes the document reader its caller expands with
  (`LoadSceneOptions.read`, the runtime cache by default; the editor's in-place re-expansion passes its own cache), adds
  the copies THAT scene's file carried (`withSceneCopies`; the re-expansion names the placeholder's scene,
  `LoadSceneOptions.copiesOf`), and hands that ONE reader to `onInstantiatePrefab`
  (`load.read`) and to the settle's orphan test (`settleEntryRows`). An instance expanded with any other reader is
  refused after the callback: it throws in a dev build and reports in a release one. Two readers in one load disagree
  on which frames a copy backs. With the settle reading copies the expansion did not, a frame stayed unexpanded while
  its rows read as backed, so they were neither applied nor kept, and the next save dropped them (S1, an in-place return
  of a placeholder). With the opposite split, rows a copy expanded were also kept as orphans (hunt seed 1212). A copy with
  no `entities` array is dropped with a warning, and the validator names it (`embeddedPrefabWarnings`, which reads a
  copy's own nested prefabs as the load does: the project's file, then the scene's other copies). **Never another
  scene's copy** (#1934 close-out F1): read across the chain, bases first, a level's instance expanded from its base's
  copy (another version of the prefab, or a copy the level never had), and the level's next save replaced its own backup
  with the base's. Unity keeps a backup in the scene file that holds the instance (`sceneCopiesPerLoad.test.ts`).
- **Which frames it restores: exactly the ones that were LIVE at the save** (R7 fork A, #1939). That is Unity's line:
  every PrefabInstance has its own backup of an instance merged before its asset went, never of one missing from the
  start. The save states it beside each copy, in `embeddedPrefabFrames` (scene v19, an optional sibling of
  `embeddedPrefabs`, no version bump): per prefab guid, the ADDRESS of every frame of that prefab live in this scene
  (`frameAddress.ts`, one spelling for the save and the load). An address starts at a stored root the file states, a
  top-level entry's guid or a scene-added reference node's guid, and adds `/<nodeGuid>` per nested row and `/+<key>` per
  TEMPLATE reference node (from the frame its key-derived guid derives from, #1809). The load expands a frame from the copy
  only when its address is listed: a top-level entry (`loadSceneFile`'s prefab loop), a nested row (`instantiatePrefabIntoWorld`),
  and a reference node, template or scene-added (`spawnReferenceNode`), all through `copyBacksFrame`. So an instance that
  was already a Missing Prefab placeholder, or a row left unexpanded (an instance made after its nested prefab was
  deleted, ruling D), reloads as it was saved, and every live one comes back: a scene-added node too, which before #1939
  never read a copy and reloaded as #1699's empty placeholder (#1934 M-b, hunt seeds 1012/1027), and a frame inside a
  template reference node, where the member rows the old signal read are never written (`memberRows` exclusion 2; #1934
  F3, T14: 6 live, 4 reloaded). A placeholder entry saved beside a live instance of its prefab stays a placeholder
  (#1934 C1, hunt seeds 1269/3266: it used to expand). The reloaded world is the saved one, so the next save writes the
  same bytes (I23).
  - **When the two fields disagree.** A copy with no list (a v19 file written before #1939) answers by the old rules: a
    nested row when the scene's own rows state its root or a member below it (`copyStandsIn`), an entry always, a
    reference node never. A list for a guid with no copy is read by nothing, and the next save, which writes a list only
    beside a copy it writes, drops it. A list that is not an array of strings is ignored with a warning (that copy answers
    by the old rules) and the validator names it; an address that resolves to no frame is ignored, and the validator
    names one whose anchor is no guid the file holds. Neither ever fails a load. A frame with no address answers by the
    old rules too.
  - ⚠️ **Known limit (accepted, R7, narrowed by #1939):** a frame with no ADDRESS: a row of a template that predates
    prefab v5 has no `nodeGuid`, and a stored root with no durable guid has no anchor. Such a frame answers by the rows
    rule, and a pre-v5 row has no row key either, so a live one reloads unexpanded (ruling D, the pre-v19 behaviour), its
    record kept, until the prefab returns.
  - ⚠️ **Known limit (parked, #1966):** a node a prefab anchors AT a nested row's root. The capture never walks a nested
    row's root for added nodes, so the save restates the node (the declaring frame's node REMOVED, plus a scene copy by
    guid) while it lives by key: the list names it `…/+<key>`, the reload asks its guid, and it reloads a placeholder.
    Pinned `it.fails` in `copyLiveFrames.test.ts`. The same restatement severs the node from template edits with the
    prefab present, which is pre-#1939.
- **What a world swap carries** (#1939 item 2, H1/C2). The copy store is per world (`loadSceneFile`'s
  `embeddedDocsByWorld`, with the lists beside it), so a swap that does not reload a scene from its file would lose it.
  **A scene loaded from its FILE reads that file's copies alone**: a load of some bytes expands what a fresh session
  would (I23), and an in-session reload of an edited file never takes the previous world's copy (pinned by
  `copyReaderPerLoad.test.ts` § #1934 S1, which reloads an edited file). What carries (`captureSceneCopies` /
  `restoreSceneCopies`, `SceneManager.loadScene`):
  - **a KEPT base** on a level switch, a hot reload of its level, or any load that keeps it: it is carried flat, not
    reloaded, so its copies and lists go with it (H1, low);
  - **an Apply's undo or redo** (`applyPrefabUndo.ts`), which reloads a snapshot taken at the Apply: the copies and the
    live frames' documents and addresses of the world it replaces (`LoadOptions.sceneCopies`). The snapshot could predate
    the prefab going, and the frames live a moment before came back unexpanded and lost their backup at the next save
    (C2, hunt seed 1268, serious; Unity's undo does not reload);
  - **Stop and a timeline preview's exit**: the EDIT world's, captured when Play or the preview began
    (`AuthoredSnapshot.copies`), never the Play world's. Unity discards Play state, so no edit made in Play changes
    which frames the edit world expands. A prefab TRASHED during Play is not in that capture, so its frames come back
    unexpanded after Stop (#1972; inferred to match Unity, whose backup is taken at Play start too).
  Only a prefab the runtime cannot read is carried, and only for a scene the new world loads. **A snapshot reload keys
  the primary's carry by the SNAPSHOT's id** (`captureSceneCopies(world, primaryAs)`, #1948 S2), the guid the load gives
  its primary: an untitled world's serialize mints that id fresh, and a New Scene world has no loaded scene, so keyed by
  the world it came from the swap's chain filter dropped every copy (New Scene, place, Apply, trash a nested prefab,
  undo: the frames came back unexpanded, and Save As wrote no copy).
- **What still refuses (I3).** The copy reaches only the EXPANSION. Apply and Revert still ask the editor's
  `getPrefabSource`, so a frame expanded from a copy, top-level or nested, is refused as a missing one is: "Restore the
  prefab, or Detach Prefab". The editor's own rebuild readers (`getCachedPrefabSync`) do not see the copy either, so an
  in-place rebuild KEEPS such a frame (#1862) rather than re-expanding it.
- **How the editor meets a frame a copy restored: two rules, each in one place** (#1939, hunt seeds 1031 and 3081).
  A copy makes live, after a reload, frames that used to come back as placeholders, and every editor path that had
  only ever met a placeholder there now meets a frame.
  - **Which live frame a statement means: its frame ADDRESS** (`frameAddress.ts`, the grammar the list uses). A
    scene-added reference node is its guid; a TEMPLATE reference node is its enclosing frame's address plus `+<key>`,
    because a document states it by key alone and its live guid is only derived. The rebuild's keep records each kept
    node's address (`KeptFrame.address`), and the ONE reference-node spawner skips that address (`keepingFrames` →
    `spawnReferenceNode`), so the seat then knows the node is still named. Matched by guid, a kept template node was
    respawned as a placeholder beside itself and dropped as unnamed (1031). A node with no address is not kept: the
    teardown takes it and the respawn rebuilds it from its statement. **The address is met only while the statement
    still names the prefab the node was kept for** (`KeptFrame.source`, #1948 S1): a document that re-points the node
    (an outside change, Q → H) gets the new prefab, as a reload and Unity give it. The spawner first RELEASES the kept
    frame (`keepingFrames`' `release`), so the new prefab's spawn derives the guids the kept frame held; spawned beside
    it, the new root took a salted guid (I7) and the rebuild differed from the reload. Met by address alone, the kept
    frame stood in for the new statement and the save persisted the old prefab. The statement's ANCHOR is not compared
    yet (#1986, low): a node an outside change moves within its row is seated where it hung.
  - **The current template of a missing prefab's frame: the document that frame was built from** (its record,
    `captureDoc`, #1738), which for a copy-restored frame IS the copy (Unity's scene backup). An undo that puts a
    member's marks back brings each unmarked field to that document's value (`takeUnmarkedFromBase`); read from the
    cache alone it did nothing, and an undo after the template changed left the old value showing until the next rebuild
    or reload (3081). This also covers #1862's in-session kept frames. The other cache-only readers acting on a live
    frame were left as they are (hub ruling: change only a reader a directed test shows wrong).
- **When the prefab comes back.** A reload expands it from the returned file, whatever the copy says, and the next save
  writes no copy. Put back while the editor is open, it is re-imported in place (#1873 R1): a placeholder is re-expanded
  through `loadSceneFile` with the editor's cache as the load's reader, so a nested frame under it that a copy backs
  expands from the copy, as a reload would.

A v18 file has no copies and reads unchanged: its rows stay unexpanded under ruling D until the prefab returns; a v19
file a build before #1935 wrote has no copy of a missing TOP-level prefab, so that instance reloads as its placeholder.
Tests: `missingNestedFrameKeep.test.ts` § (c)/(b), `copyReaderPerLoad.test.ts` (one reader per load, copies per scene,
the undo carry), `copyLiveFrames.test.ts` (the list and the carry, #1939),
the "expanded from the copy" and "as a placeholder" cases in `missingPrefabPassThrough.test.ts`, and
`embeddedPrefabValidation.test.ts` for the validator.

**A placeholder is NOT an instance.** It is a plain entity carrying the marker and no `PrefabInstance`; the top-level
one drops the `PrefabInstance` pass 1 gave it, and the marker holds the source. Carrying it, every piece of instance
machinery (the Apply fan-out to every instance of a source, the override list, the rebuild settle) treated the
placeholder as a live, empty instance the moment its prefab resolved: it rebuilt it and destroyed the record, and the
override list offered "removed" for every member, which Apply then wrote into the prefab (close-out review, observed).
Without the trait, none of them can see it.

A placeholder dragged from one kind of place to the other is written in the shape of where it now is. `asAddedNode`
drops an entry's legacy root traits (`rootExtraTraits`), and `asSceneEntry` drops a template node's `templateMoved`;
neither is written by a current scene save. `asAddedNode` writes the node in `captureNestedRef`'s key order, so a
save with no edit writes the bytes it read (#1722: it used to move `guid` to the end, and every no-edit save churned the
file).

**The writers key on the marker, not on whether the prefab resolves now.** A prefab restored mid-session (a checkout,
no reload) resolves while the live entity is still the empty placeholder, and a capture of it would drop the record
one save later. Only an expansion clears the marker: a reload or a rebuild that finds the prefab spawns new entities.

Lifecycle: delete → undo carries the marker (`carriedMarkers.ts`). A duplicate or a paste keeps the record, with every
guid it states re-minted and the root's set to the copy's (`copyUnresolvedRef`), so the two never share an identity
once the prefab resolves. The copy has ONE remap (#1763): `planCopyGuids`' new guids for every copied entity plus every
record's re-minted identities (`recordGuidMints`), built before anything is rewritten and applied both to the records
and to the copied traits. So a ref inside the record to an entity copied alongside it names the copy of that entity,
and a copied entity's ref into a record's member names the copy's member. A member copied without its `PrefabInstance`
keeps the records under it too (#1762). In prefab edit, a copy of a missing row has no baseline row. It is written from its record
when nothing in the record was rewritten into the edit world's ids and it states no guid; the save refuses otherwise.
The guid test is what refuses a SCENE placeholder pasted into prefab edit, whose member rows pin scene guids (#1293). The Hierarchy
labels the placeholder **Missing Prefab** (`EntityInfo.missingPrefab`), so it does not read as an empty object to clean
up.

A plain child the scene puts under a NODE placeholder is saved top-level, parented by the placeholder's guid, which is
the guid the node's root is spawned with. Pass 2 resolves parents before any expansion runs, so the load records a
guid `parentId` it cannot resolve and asks again once the expansions and the derive are done (`retryGuidParents`,
#1738). One that still misses stays at the scene root, as before.

The TEMPLATE writers refuse rather than write a scene record into a template (I8): Create Prefab of a tree holding a
placeholder (the human path and the agent `prefab create` op, over the live tree they write). An Apply SKIPS the
`+added` key that would promote one, naming it, and lands the other keys: refusing the whole Apply made the dialog's
default Apply All, and the agent's key-less `apply`, land nothing (#1831, as for a kept frame). What an `+added` key
promotes is the node's IDENTITY subtree (I6), so Apply asks that, not the key's text (a placeholder under a plain added
node is named by no key of its own) and not the live tree (a placeholder under a member moved into the node stays
behind with the member). A rebuild's preload fetches a placeholder's source (`preloadNestedPrefabsForSubtree`), so a
prefab restored on disk re-expands on the next rebuild.

**Nothing new goes UNDER a placeholder** (#1831, hunt seed 315, hub ruling): a create, paste, duplicate, prefab drop or
reparent whose new parent is a placeholder or sits inside one is refused, in the scene and in prefab edit, through the
one gesture refusal (`prefabEditRefusal`'s `under-missing-prefab`, asked inside every forward choke point, so the
Hierarchy toasts it and every agent op answers `REFUSED_BY_OP`). The placeholder's save writes the record its file held
and folds no live child into it. Before, a prefab-edit save wrote a node dropped there as a row parented to the
placeholder's reference row, every expansion spawned it at the instance's OWN parent (outside it, under a runtime guid),
and the scene save wrote that orphan as a new top-level entry, once more on every reload. A child the placeholder
already has stays, and a reorder under its current parent is not a new link. Not covered: the device debug ops (no
save) and the file-direct `/api/scene-mutate` (its file graph has no placeholder).

**How a live frame's document stops resolving.** An editor trash (the Assets panel, `/api/delete-asset`) evicts both
caches in its renderer repair (I9: `evictDeletedEditorPrefabs`, `evictDeletedPrefabs`) and leaves the live frames
expanded (#1738's evicted state), so the next reload takes the load path above. The caches are also emptied by
`seatCaches(key, null)` (`prefabCommit.ts`), which runs on the undo of an Import Model or a rig prefab (not a Create Prefab's since #1795: it leaves the file). A live instance of that
prefab is reached there only past a dropped throwing undo, `worldLeft()` mid-commit, a `Persistent` tree carried in Play, or a
key the editor never warmed. Create Prefab over such an instance writes a REFERENCE row from the record rather than
refusing: its placeholder check runs before the nested warm, so a refusal would fire on a merely cold key. The check for
a NESTED frame that did not expand (#1790, U24) runs after the warm for the same reason, and refuses.

**A pre-v5 template** states a nested frame's edits in path-keyed `nestedOverrides` / `nestedStructure`, with no
`nodeGuid` for a member row to carry them. One addressing a frame whose prefab is missing is kept by R2's legacy half
(above, #1780), on the scene side and in the template's own prefab-edit save (`captureRowChannels`, under
`keepsTemplateRows`).

Still refused or open (#1738):
- **A Revert of a frame whose own prefab is missing** (a kept nested frame, #1862, or #1738's top-level one) is REFUSED,
  naming the prefab by its frame record's document: there is no base to revert to. `revertRefusal` is the one question the
  dialog, the agent op and the fuzzer ask. Restore the prefab, or Detach Prefab.
- **A prefab-edit save of a template holding an added reference NODE whose prefab is missing** (the template's own
  key node, or a pasted scene one) is REFUSED, not written: the template capture leaves a placeholder out, and writing
  it back needs the file's node matched in the same frame, wherever a template node can hang. The reason names the
  missing prefab and says which case it is: a node the template declares is still in the file on disk, a pasted one
  exists only in this edit. Restore the prefab, or delete the node. A node placeholder with children takes the same
  refusal.
- **A missing row moved under a member of a nested row, in prefab edit,** is written under its row parent: the save
  keeps the record and drops the move. (A move, not a record: not this class.)

Tests: `engine/tests/editor/missingPrefabPassThrough.test.ts`, one case per row and per lifecycle step, each red under
the mutation it names.

## ⚠️ A prefab EDIT replaces the runtime cache entry — it used to empty it (#1308)

> **Illustrates I9** (after a write, both caches hold the written bytes).

**An editor write of a prefab a scene owns now puts the written bytes straight into the runtime
cache.** Before #1308 it DELETED the entry, and only a scene load put it back, so every
synchronous runtime reader silently read nothing for the rest of the session.

The mechanism:

- A prefab write goes through `commitPrefabWrite()` (`editor/scene/prefabCommit.ts`, #1692), which calls
  `replaceCachedPrefab(path, prefab)` (`runtime/loaders/meshTemplateCache.ts`) once the write lands.
  - **If a scene owns the prefab**, it seats a JSON copy of the written bytes. The copy is run
    through the same load-path migration `fetchPrefab` applies. The #863 key token is still bumped,
    so an in-flight fetch of the pre-write bytes is refused.
  - **If nothing owns it**, it evicts as before. Seating an entry nothing owns would leave a row
    that no `releaseAllForScene` ever drops.
  - A trash (`commitPrefabWrite(src, null, …)`) still evicts.
- **Why this matters:** an eviction left the scene's owner hold intact and the bytes gone.
  `acquirePrefab` is the only thing that refills the cache, and outside games that preload
  deliberately, only `SceneManager`'s scene load calls it. The readers stranded by that:
  - the `UIEntries` pool: its stride went to 0, every slot parked, and the view went blank (#1308);
  - timeline scrub and control-track spawns;
  - a nested row inside any runtime spawn.
- **Every replace or evict bumps a per-key content revision** (`getPrefabRevision`). A runtime
  spawner compares it to tell that its live instances were built from OLD bytes.
  - `EntryPrefabProvider.revision` is a `guid@revision` list over the entry prefab and every
    prefab it nests. It is a list, not a sum: a sum let a removed nested row cancel the parent's
    bump, so the pool kept stale rows.
  - `entriesSystem` releases and rebuilds a view's whole pool when that signature changes. The
    rebuild keeps the view's per-frame scroll baseline; a fresh 0 there, on a rebuild first seen
    by a scroll-event drive, ballooned the pool to its raise cap.
  - ⚠️ **A rebuild does not re-target keyboard/gamepad focus.** The focused row is destroyed
    before the focus capture runs. Focus usually survives anyway, because the respawned row in
    the same slot gets the same seeded guids, and `uiFocusSystem` finds it again. It can land
    on a DIFFERENT entry when the Apply arrives mid-scroll: the rebuilt drive starts with minimum
    overscan, so the window origin moves. It falls back to the scope's autoFocus when the edit
    removed the focused member. Both need an editor Apply during Play; read from code, not
    observed.
  - This is needed because the Apply refresh skips Transient subtrees on purpose (§ Authoring
    scope, #1301), so nothing else would rebuild pooled rows.

**Paths that write an in-use prefab without reloading.** Since #1308 all of these keep the cache
warm:
- **Apply to Prefab** on a scene instance: `applyToPrefabWithUndo` → `commitPrefabWrite`.
- **`modoki_prefab action:'apply'`** (and `'create'`).
- Create Prefab → Replace, the skin-prefab writes, the model regenerate and import (all through `commitPrefabWrite`,
  which also rebuilds their other live instances since #1692).

Paths that also reload:
- Prefab-EDIT mode reloads on exit (`exitPrefabEditing` → `loadScene(target)`), and so does any other scene load out
  of it; the load runs the leaving repair (#1666).
- Undo/redo of an Apply reloads (`restoreSnapshot` → `loadScene`), under the key of the world the
  undo belongs to when it runs (`currentSceneKey()`): the scene's path, the prefab-edit world's
  synthetic path (#1573), or `''` for an untitled scene (#1575). See § Undoing an Apply.

**An external `.prefab.json` write** (a hand edit, `git checkout`) goes through the scene hot
reload. `handleSceneChanged` evicts and then reloads (#1169, [editor-hmr.md](editor-hmr.md)), and
that path is unchanged: the reload is what refills the cache there.

**Game code still owns two cases.** Instances a game spawned at runtime keep the art they were
built with: the cache is warm again, but nothing re-spawns them. And a prefab that really is
missing still reads `undefined`. So the guidance below (re-acquire on a miss; remember what each
instance was built FROM) still applies, and the incidents below are the pre-#1308 shape of the
failure.

**What this looks like in a game.** Court's guard flag falls back to drawn primitives when its
prefab is uncached, so after an Apply-to-Prefab the flags already planted keep the real art while
every new one draws a placeholder, and the board stays mixed until a scene load. Fixed there by
recording the art each instance was spawned with, retiring on a mismatch, and asking for the
prefab back through `requestPrefab` on a miss (`syncFlags`, `games/court/runtime/systems.ts`).

**Measured on Court's tray badge, 2026-08-19** — the wholesale version of the same failure. With
the prefab cached, a board build gives the authored instance (`Coin` ×6, `CountBadge`, `CountBanner`,
`InfoBadge`, `ChipRow`). Invalidate, then rebuild the board with **no** scene reload, and every one
of those drops to **0**, replaced by the pre-#171 code-spawned set (`TrayIcon_<piece>`,
`TrayCountBanner_<piece>`, `InfoBadge_<piece>` …). The tray silently reverts to the old art and
the constant layout — `refreshBadgeLayout` and the instantiation are two separate consumers of the
same cache and both fall back.

**If you spawn prefab instances at runtime, handle the miss on purpose.** Two things, and the
first alone is not enough:

1. **Re-acquire on a cache miss — call `requestPrefab(<your owner sentinel>, guid, { world })`**
   (`@modoki/engine/runtime`, #1376) wherever you would have read `getCachedPrefab`. It returns the
   cached document or null, and on a miss it asks for the prefab back. Call it every time you need
   the prefab (every frame is fine). **Do not hand-write this latch.** Seven spawners across four
   projects did, from an earlier version of this section, and every copy was wrong in at least one
   of the three ways below. The helper exists so the next spawner cannot repeat them:
   - **In-flight dedup, released on EVERY settle.** Without it a per-frame caller refetches every
     frame (#1373).
   - **A bounded give-up budget, per world, refunded on a hit, and never spent on an outage
     (#1397).** `acquirePrefab` on an unresolvable guid **RESOLVES**, with the cache still empty
     (measured 2026-08-19). It still never rejects. What changed is that `fetchPrefab` now
     classifies its failures: it remembers a 404 or a bad file until the prefab is invalidated,
     and backs off a 5xx or a dropped connection. `requestPrefab` refunds an attempt that ended
     transiently. So the three attempts are spent only on a prefab that is not coming, and an
     outage retries on the shared backoff (1 s doubling to 10 min) instead of giving the prefab up.
     The rule: [architecture.md](architecture.md) § "A load failure is classified before it is
     remembered". Before #1397 a 404, a 5xx and an offline blip looked identical here. Re-arming only on success (`.finally(() => { if
     (getCachedPrefab(ref)) rearm; })`, the shape this section used to prescribe) reads every
     transient failure as a deletion and disables the prefab for the session (#1359). Re-arming
     unconditionally refetches a deleted guid forever. A `.catch` re-arm (or a `.catch` warning,
     #1375) is dead code. Three attempts per world, then it stops. ⚠️ **"Per world" is an EDITOR
     safety net:** a built game never swaps its world, so there the give-up lasts the session.
     That is accepted because this is a recovery path. The scene load already acquired the prefab.
     It is a real change for `games/court`, whose hand-written guards were cleared on every board
     build. That gave a missing prefab one more try per level, forever. A per-frame caller (the
     flag layer, the win confetti, the debug-menu preview) now spends its three tries in about
     three fetch round-trips and stops until the next Play. Since #1397 that is true of a prefab that
     is NOT THERE; an outage backs off and does not spend the tries. A preview of a prefab that gave up
     stays parked, and the tap looks dead until then.
   - **The hit test and the re-arm test are ONE predicate.** The default is "has at least one
     entity", since an entity-less document spawns nothing. A caller whose miss test is stricter
     passes it as `isHit`: Court's tray badge passes its layout parse, because a cached document
     that does not parse is as useless there as a missing one. A re-arm on bare truthiness accepts
     such a document, releases the guard and refetches forever (#1359). A caller that reports an
     unspawnable document separately passes `isHit: () => true` (forest-camp's
     `arrow-spawn-failed`).
   ⚠️ **The re-acquire is async, so the action that found the miss still fails — record it.** The
   shot, spawn or build that hit the empty cache cannot wait for the fetch, and dropping it silently
   makes it read as a dead control. `demos/forest-camp` journals `archery.shot-refused` with
   `reason: 'arrow-prefab-not-cached'` for exactly this window (#996).
   ⚠️ **The miss itself is not the useful signal; the give-up is.** A miss is also what a healthy
   cold cache looks like one frame before it fills. So `requestPrefab` stays silent through the
   miss and journals **`prefab/unavailable`** (`warn`, payload `{prefab, owner, attempts}`) once,
   when the budget is spent and the prefab still has not arrived. That is also the only way a
   failed PRELOAD is ever seen, because `acquirePrefab` never rejects. Where the refused action is
   a *player* action, record it anyway, as forest-camp does, because the player really did lose
   something.
   **What stays on `acquirePrefab`:** a preload that AWAITS a batch (a scene load, sling's
   bootstrap `Promise.all`) is not a latch. `engine/tests/architecture/prefabRequestSites.test.ts`
   fails when a game or demo calls `acquirePrefab(` outside its short list of such sites.
2. **Remember what each live instance was built FROM**, and retire instances whose source no
   longer matches. ⚠️ **Key that record on the prefab's REVISION, not only its guid**
   (`${guid}@${getPrefabRevision(guid)}`). An editor Apply replaces the entry in place, so the guid
   never changes; Court's flag layer keys `art` this way so that an edit made during Play still
   retires every planted flag (`syncFlags`). Without this, the window between the invalidation and the re-acquire leaves a
   mixed population that never converges, because "this cell already has an instance" is true and
   says nothing about which art that instance wears.

Court's tray badge has now been audited (#262) — see the measurement above.

⚠️ **Acquiring under your own owner sentinel means RELEASING it too.** `acquirePrefab(<sentinel>,
guid)` adds that sentinel to the prefab's owner set, so the scene's own `releaseAllForScene` can
never evict it and the prefab outlives the game. Drop the holds wholesale when the game
unregisters — `releaseAllForScene(<sentinel>)`, not `releasePrefab` per guid, because a per-guid
release leaks anything the acquire pulled in transitively (`games/sling` records this at its own
call site, and `games/court` had to add it after missing it).

## ⚠️ A server-side prefab move brings the client along (#1751)

> **Illustrates I9** (after a write, both caches hold the written bytes).

A server route that changes a prefab or scene file marks the write as the editor's own (`markEditorWrite`), so the
watcher does not hot-reload the open scene under its live edits. But the watcher event is ALSO what brings the
client up to date. The mark means two things, "don't reload the world" and "the client already holds these bytes",
and the second is true only for bytes the client sent. For a move, something else has to take the watcher's place.

A census of every `markEditorWrite` call site found the routes that change bytes or a path behind a prefab or scene
cache:

| Route | What it changes | Who brings the client along |
|---|---|---|
| `/api/move-file` | a prefab's PATH | `applyAssetPathMoves` re-keys both prefab caches (`rekeyCachedPrefab`, `rekeyEditorPrefabCache`) |
| `/api/delete-asset` | a prefab is gone | the delete's repair evicts both caches (§ Model and invariants, I9); a writer that loses the document writes from the frame record (#1738, § "A missing prefab keeps its record") |

A third route, `/api/prefab-member-paths`, rewrote the member refs of every OTHER scene and prefab when an Apply
re-parented a row (#1437), and the client adopted its reply (`serverPrefabRewrites.ts`). It went in #1868 with the
only Apply that re-parented a row: since #1869 no gesture moves a prefab-supplied object, and an Apply of a move a file
from before #1869 still holds is skipped, naming Revert (hub ruling B, § "Moved members" in
[prefab-structural-overrides.md](prefab-structural-overrides.md)).

**A move MOVES both cache entries.** The runtime cache is keyed by PATH and read synchronously, so once the manifest
mapped the guid to the new path the entry was unreachable: a `UIEntries` pool went blank, and a later write's
`replaceCachedPrefab(newPath)` found no owner and evicted. `rekeyCachedPrefab` moves the entry, the owners and the
content revision to the new path. The moved entry always wins at the new key. The owners move with it, so the scene's
`releaseAllForScene` drops them there. A load of the old path still in flight is refused, and when owners are left with
no entry the file is fetched where it is now. The editor cache moves its path key too, the same way. A parked prefab
(#1868) moves with its baseline (`applyMovesToParkedDocs`).
- **The order on the route:** the manifest broadcast reaches the renderer BEFORE the move repair, so the re-key's own
  `registerAsset` is only a backstop. For the frames between the two messages the guid already names the new path
  while the entry is still at the old one. That window predates #1751; closing it means sending the repair first.
- ⚠️ **A first version kept the old runtime key** to cover that window, and the kept entry then served stale content
  (close-out review). Renaming back after an edit read the pre-edit document; the revision was carried, so a pool
  never noticed. A swap (A→B, then C→A) read A's document for C. A marked create at the old path is never evicted by
  a watcher `add`, so the stale entry stayed.

Tests: `engine/packages/modoki/tests/runtime/prefabCacheMoveRekey.test.ts` (the move).

## Mesh sharing

Instances are cheap: they reuse the cached mesh **template** geometry and
material rather than re-parsing the GLB — `new THREE.Mesh(template.geometry,
template.material)`. The resource cache `acquirePrefab(sceneId, ref)` refcounts
the prefab source itself, and the meshes it references resolve through the same
shared template cache as everything else (see
[Scene Loading → Resource cache](./scene-loading.md#resource-cache-with-refcounting)).

## Editor UX & current limits

**Done:**

- The Hierarchy marks prefab instances with a `[P]` indicator and a subtle blue
  tint.
- Prefabs appear in the Assets panel and can be **dragged into the Hierarchy**
  to instantiate.
- Override capture works per-localId (including sub-entities), and
  `applyToPrefabSelective` push live overrides back to the
  source file, refreshing sibling instances.
- **Structural overrides** — an instance can add child entities, delete prefab
  members, and remove components; these survive save/reload and are pushed back
  recursively via the *Apply to Prefab* dialog. See
  [Prefab Structural Overrides](./prefab-structural-overrides.md).
- **Inspector override highlighting** — fields that differ from the prefab source
  are flagged in the Inspector (blue accent), driven by `getOverrides` and
  recomputed on each ECS edit.
- **User-added nested instances** — a prefab dragged under another instance's
  member round-trips under its EXACT parent member. It is captured as a *reference*
  `added` node (an `AddedEntity` carrying the child `prefab` GUID + its
  overrides/structure) on the owning top-level instance, and re-expands under the
  same member on load. Apply-to-Prefab promotes it to a nested row in the owner's
  `.prefab.json`.

## Prefab edit mode

> **Illustrates I4 and I13** (the file's numbering survives a re-save; only an authored world is written).

**Double-clicking a prefab** in the Assets panel opens it *alone* in the Scene
viewport (Unity-style isolation) — `editor/scene/prefabEdit.ts`. Under the hood
`openPrefabForEditing()` synthesizes an in-memory scene from the prefab's
entities plus throwaway scaffolding (a directional + ambient light and a default
HDR environment, all named `__PrefabEdit*`) so the prefab is visible, and loads
it through `SceneManager.loadScene(path, { preloaded })`. A breadcrumb in the
SceneView toolbar (`← <scene> › 🧩 <prefab>`) marks edit mode; the scene name
shows there in normal mode too.

- **Cmd+S** routes to `savePrefabEdit()`, which serializes the prefab subtree
  back to its `.prefab.json` (the `__PrefabEdit*` scaffolds are excluded — they
  aren't descendants of the root, located via a sentinel `EntityAttributes.guid`).
- **It refuses while the run mode is not `stopped`** — the prefab twin of `saveScene`'s transience
  guard, and for the same reason doubled: it serializes out of the LIVE world, so a save during a
  scrub/preview envelope or during Play bakes a posed rig or a spawned prefab into the file, and
  every scene instantiating it inherits them. The guard lives inside `savePrefabEdit`, not in its
  callers, so the agent op (`prefabAction:'edit-save'`) inherits it — it had no such guard while the
  check sat in the Cmd+S handler alone. **Cmd+S does not need you to exit preview first**:
  `runSaveAll` puts a live envelope down before saving and picks it back up after (docs/editor.md
  § Animation Editor), so the guard is already satisfied by the time it runs. Stopping Play is still
  on you, and the agent op refuses in every non-stopped mode.
  Parked ASSET docs still flush in that state, because a `.particle.json` the panel owns is
  authored data in every run mode — see [mcp-persistence.md](./mcp-persistence.md) § 5.
- **The edit world has exactly ONE top-level entity, the root, and nothing makes it unsavable (#1817, #1836).** The
  save writes the root's subtree and nothing else, so one predicate (`editor/scene/prefabEditRefusal.ts`, asked inside
  each forward choke point, never in an undo or redo closure, as Unity's Prefab Mode refuses the same) refuses:
  - **the root deleted or moved.** A delete of the root, or of the 2D `__PrefabEditStage` scaffold above it, and any
    parent change of the root. Every later save used to fail "prefab root not found";
  - **an authored entity outside the root.** A create, paste, duplicate (the root's own too, which lands beside it) or
    prefab placement at the top level or under a scaffold, and a move of one of the root's entities out of it. The save
    silently dropped it. So the Assets and Inspector **Instantiate** buttons, which place at the top level, refuse in
    prefab edit: drag the prefab onto the root instead. The agent's `create-entity` / `addEntity` with no parent refuse
    the same way, with nothing defaulted to the root;
  - **the edited prefab nested in itself.** A drop, paste or duplicate holding an instance of it, or of any prefab that
    contains it, anywhere in the world (the save refuses such a file too, § Nested prefabs);
  - **the scaffolding in the root.** The `__PrefabEdit*` lights, environment and 2D stage (`SCAFFOLD_PREFIX`) may move
    among themselves but never into the root, moved or pasted: the save would write an editor-only light into the prefab
    (close-out review). Recognised by name, so an authored entity stranded outside the root can still be moved in.

  The choke points: `deleteEntitiesWithUndo`, `reparentEntity` / `planReparent` (reasons `root-moved`, `outside-root`,
  `scaffold`), `createEntityWithUndo`, `duplicateEntity`, `pasteEntityCopy`, `instantiatePrefabInstance`. The panels
  toast the refusal (`prefabEditRefusalToast.ts`), and every editor agent op answers it as `REFUSED_BY_OP` in the same
  words. The agent's `delete-entities` and `apply-scene-ops removeEntity` ask it before they name or mint the
  descendants they report. A placement's redo re-runs `instantiatePrefabInstance`, so it can meet the refusal too; the
  undo wrapper drops that step as refused, as it drops a stale read. The ground truth is the world (the synthetic scene
  path and the root's sentinel guid), never the `editingPrefab` flag.
  Tests: `engine/tests/editor/prefabEditRefusal.test.ts`.
- **It writes only over the document the edit was opened from, or last saved as (#1692, I10).** A file changed on
  disk under the open edit (a save from elsewhere, an Apply from a carried instance, an outside edit, a `git pull`)
  is not overwritten unasked: Cmd+S (and Exit's Save) asks *"<prefab> changed on disk"*, with **Overwrite** (the one
  deliberate unconditional write) and **Cancel** (nothing written, the edit stays open and unsaved, so Exit's gate
  finds it still unsaved and does not leave). The agent's `edit-save` is refused with both choices named, and takes
  `overwrite:true`. The editor's own writes never trip it: the save's `expected` is the session's own baseline
  (`editBaselineFor`) — a copy of the document it opened, moved only by its own saves — not the editor cache, which
  every writer re-seats; and a file the open migrated in memory is matched as a document, not as bytes. The same
  baseline supplies the save's row numbering. It is seated only once an open has LANDED: an open of another prefab
  that is cancelled at its unsaved-work question (or whose swap fails) leaves the session still open saveable. With no
  baseline at all — only an edit world a test built without an open — the save and the numbering fall back to the
  editor cache. Tests:
  `engine/tests/editor/prefabEditSaveConflict.test.ts`.
- The breadcrumb **Back** button reloads the originating scene, which
  re-instantiates every instance of the just-saved prefab.
- Right-click → **Instantiate** still adds a copy to the current scene (the old
  double-click behavior).
- **Re-saving preserves the file's `localId` numbering and `name`** — see "localId
  stability" above; this is what makes prefab-edit safe to drive as a scripted
  round-trip rather than only a human UI action.
- **Undoing an Apply made here reloads this world from its scene snapshot** (#1573). The
  Inspector offers Apply on a nested instance whose source is not the prefab being edited, and the
  agent `apply` op reaches it too. Apply's undo restores the world from the `serializeScene`
  snapshot it took on each side. The scene branch reloads that snapshot at the scene path, and this
  world's scene path is `null`, so before #1573 only the applied prefab's file came back. The
  applied instance lost its edit, every other instance of that prefab in this world kept the
  applied state, and the next save wrote that state as an override on each of them. The same
  snapshot is now reloaded at the world's synthetic path (`prefabEditWorldPath()`), without the
  save: the Apply never wrote the edited prefab, and Cmd+S still does.
  - ⚠️ **Not a rebuild from the edited prefab's document**, which the first fix tried. A template
    document carries no live guid, so everything added in the session came back under a new one.
    Every later undo entry addressing it by guid silently missed. A new entity that inherited a
    deleted row's localId sentinel was saved with that row's durable nodeGuid. The scene snapshot
    keeps live guids, as it does in scene mode.
  - It does not carry template keys (a scene never writes `key`), and the reload does not re-mark
    them either: the loader recovers keys only from documents instantiated into the world, and the
    edited prefab never is in its own edit world. The editor's `recoverTemplateKey` recovers each
    from the node's guid against the whole prefab cache when a save or apply next reads it. A key a
    file holds therefore survives the undo, and one only ever minted in memory does not.
  - It reloads only if that world is still the live one. The file install before it is awaited, and
    an Exit landing in that window would otherwise have the synthetic world loaded under the real
    scene's path, where `saveScene` writes it into the scene file.
  - ⚠️ **A rebase is not a substitute either.** It rebuilds the applied instance with the overrides
    it holds against the applied document, which are none, so the edit being undone is lost from
    the prefab AND the instance.
  - `prefabEditApplyUndo.test.ts` mutation-checks each of these. The untitled-scene case is
    § Undoing an Apply (#1575).

**Reachable headlessly.** `openPrefabForEditing` / `savePrefabEdit` / `exitPrefabEditing` are
exposed as the `prefab` agent op / `modoki_prefab` MCP tool's `prefabAction: 'edit-open' |
'edit-save' | 'edit-exit'` — full tool contract (params, refusals, minimal call) in
[debug-tools-mcp.md](./debug-tools-mcp.md)'s generated tool catalog. `edit-open` swaps the world
exactly as `load-scene` does (refuses on unsaved work, takes `discardUnsaved`) and additionally saves the
current scene on the way in, deliberately, so the return trip's reload-from-disk is
non-destructive. It skips that save when the caller passed `discardUnsaved`, whose work is meant to be
gone from the file too, and when a newer scene request superseded it while it waited (#1745). Its reply's
`returnScene` is the scene `edit-exit` will reload: `returnSceneTarget()`, the one choice `exitPrefabEditing` makes
(the banked return scene, else the project's last scene), asked after the open. It used to be the path current before
the open, which is null inside another prefab's edit world, while that session kept the scene the first open banked and
the Exit went back to it (#1806). `savedReturnScene` still means "this open saved the current scene on the way in", which
is never true from an edit world. In prefab-edit mode `modoki_save_all` writes any parked work (asset docs, base-scene
refs, import settings) and then refuses the scene half, because `edit-save` is the save for that
world.
`edit-exit` refuses the same way while the prefab world holds unsaved edits, because its reload of
the return scene discards that world (#1424). Before that fix it answered `ok:true` over an unsaved
delete, with the undo stack gone. `edit-save` first, or pass `discardUnsaved:true` to drop them
deliberately. Inside prefab-edit mode the refusal's remedy is split by cause: `edit-save` for the
prefab-world edits, `save_all` for parked work (`edit-save` does not write parked work). The human
"Back to scene" button asks through the #1419 modal ([editor.md](./editor.md) § "The unsaved-work
gate"). That modal counts only the world edits, because parked work survives the swap, while the
agent refusal also counts parked work, as every agent world swap does.

**Editing the template from an agent (#1254).** The prefab-edit world has no scene file. Prefab-edit
sets the editor's scene path to `null`, so a normal save cannot target a real file. That world is
therefore addressed by its synthetic handle, `/__prefab-edit__/<prefab guid>`, which
`modoki_get_editor_state` reports as `prefabEditWorld` only while that world is loaded AND its edit
session is open (`prefabSessionWorldPath(editingPrefab)`: the world and the session must name the same
prefab). An exit whose return-scene reload fails, or that has no scene to return to, clears the session
but leaves the world loaded. Nothing can persist an edit there (`edit-save` needs the session, and
`save_all` refuses the prefab world), so that world is deliberately not reported as editable.
- `modoki_mutate_scene` and `modoki_set_transform` with `path` **omitted** target it.
- `/api/scene-mutate` treats that handle as **LIVE-ONLY**. It applies through `apply-scene-ops` only
  when the renderer reports that exact world, and otherwise refuses: 409, or 400 for `setBaseScene`.
  It never falls back to a file write, because the template reaches disk only through `edit-save`.
- A stale handle therefore cannot edit whatever world happens to be live. That covers a handle left
  over after `edit-exit` (including the failed-reload exit above) and a handle for a different prefab.
- **Parent new entities UNDER the prefab root.** `edit-save` serializes only the root's subtree
  (`serializePrefab` → `collectTree(rootId)`), so an `addEntity` with `parentId: 0` is refused
  (#1836). It used to succeed live and be silently absent from the saved file.
- **Prefer `space: 'local'`.** A 2D template's root is re-parented under the editor-only
  `__PrefabEditStage` scaffold, so a `'world'` transform converts against the stage offset and
  `edit-save` bakes that offset into the template.
- The live entity tools (`create_entity`, `duplicate_entity`, `delete_entities`, `reparent_entity`)
  never needed a path, and work unchanged.
- `modoki_validate_scene` does not apply here: it validates files, so use `modoki_validate_prefab`
  on the `.prefab.json`.

This is what
`engine/scripts/resave-prefabs.sh` drives to bulk-migrate prefabs to the current serializer
format — see [scene-loading.md](./scene-loading.md) § "Re-saving legacy prefabs".

## Nested prefabs (v2)

> **Illustrates I1** (the effective base at depth), **I9** (a cold editor cache) **and I16** (no self-containment).

A prefab may **contain other prefab instances** at any depth. A nested instance
is stored in the parent prefab file as a single *reference row* — one
`PrefabEntity` carrying the child `prefab` GUID plus its own
`overrides`/`added`/`removed`/`removedTraits` — mirroring how a scene stores an
instance. The child's members are **not** listed; they expand from the child
file at load.

Every file this serializer writes carries `PREFAB_FORMAT_VERSION`. Read the number in
`runtime/core/version.ts`, which is where the constant lives and which lists what each version added.
This paragraph once said **2** (until #1468) and later **6** (after v7 had landed): a hardcoded number in
prose drifts. It used to be derived from
the document's content (`nestedRefs.size > 0 ? 2 : 1`, so flat prefabs stayed at 1),
and that rule was replaced in #379 because it could **decrease**: deleting a prefab's
last nested instance rewrote `2` back to `1`, which is not something a format version
may do. v1 and v2 share the same shape — the nested fields are optional — so a v1 file
still loads unchanged and no migration exists or is needed.

⚠️ **THE WRITE PATH NOW READS IT — that REVERSES what the rest of this section says, and the
reversal is deliberate (#1468, owner 2026-09-23).** A server-side gate
(`engine/plugins/prefabWriteGuard.ts`, wired into `/api/write-file` and the asset scanner's
`writeAssetGuid`) refuses to OVERWRITE a `.prefab.json` stamped **newer** than this build writes,
with a 409. Four client-side writers refuse earlier so the refusal lands before the live world has
been mutated, and `migrate-assets.mjs` / `migrate-anchor-zindex.mjs` carry their own copies because
they have no server between them and the bytes. Every comparison is `version > CURRENT`, never
`!==`: the authored corpus is entirely BELOW the constant, so an exact-match gate would refuse all
of it. What forced the reversal was v5 adding a field an older build destroys irrecoverably — a
minted `nodeGuid` per row, which cannot be re-derived because re-minting produces different guids.
Disposition and the wording it replaced: `docs/format-versioning.md` § 3.

**The LOADING path still does not read it**, and everything below remains true of loading.
`fetchPrefab` (`runtime/loaders/meshTemplateCache.ts`)
fetches, parses and caches; there is no version comparison anywhere between the
file and a spawned instance, and `getCachedPrefab` is a map lookup. The field is
a marker for the SERIALIZER, and no consumer acts on it. (It used to record
*whether the file nests*; since #379 it records only *which serializer wrote it*.)

Say so plainly, because the gap where this sentence used to be is what produced
the defect: #344 read a version marker with no stated consumer, inferred that an
unexpected value must gate loading, and that inference was then written as fact
into a commit message, two game docs, a guard test and three issues (#363, #364,
#365) before anybody observed it. Two independent measurements killed it —
`games/space-console`'s nested spaceship prefab spawns byte-identically at 1 and
at 2 across all three of its scenes, and Court's flat level tile at `version: 2`
renders its full pooled 25-tile grid with no console warning.

⚠️ **Those two measurements can no longer be repeated from the repo as it stands.**
#379 migrated every tracked prefab to 2, so there is no flat-vs-nested or 1-vs-2
contrast left on disk to re-run them against. They are recorded here as the evidence
that settled #344 — reproduce them by hand-editing a copy, not by looking for a v1
file. `version` is
now guarded by **nothing**: `prefabFormatVersion.test.ts` was deleted (owner,
2026-08-27) rather than narrowed to "2 only on a prefab that really nests
another". The narrowed rule was written and green, and the reason it went is
worth keeping — the mistake it caught is one both measurements had just proved
**harmless**, so it was a red gate with no failure mode behind it, on a field no
code reads.

**What emptied #344's grid is therefore still unidentified — and there is very
likely nothing to find.** `ec48f2586`, the commit reported as broken, was checked
out and the editor booted COLD against it: the selector rendered 100 tiles and
100 visible numbers, and nothing on the prefab-loading path has changed since. So
the symptom does not belong to any committed tree. The file is also
byte-identical across the "broken" and "fixed" commits apart from that one
number, so the A/B was confounded — most likely by the prefab cache, which
serves the doc it read at scene load: restructure a `.prefab.json` under a live
editor and instances keep spawning from the OLD copy until something forces a
re-read. **If a pooled view renders empty, restart the editor before believing
the file.**

- **`rootInstanceId` semantics are unchanged**: it is the ECS id of the
  *innermost* instance root an entity belongs to. Nesting is expressed purely
  through `EntityAttributes.parentId` — the inner instance's root hangs under an
  outer member, but inner members carry the inner root's `rootInstanceId`.
- **Instantiation** (`instantiatePrefabIntoWorld`; the editor's `instantiatePrefab`
  calls it with the editor cache, #1783) recurses on a `prefab` row, expanding the child from cache, applying
  its overrides/structure, and parenting its root to the outer member. The outer
  pass sets `rootInstanceId` only on its *own* members so inner ids aren't
  stomped.
- **Cycle safety** is three-layered (#1817):
  1. **The gesture.** In prefab edit, `prefabEditRefusal` refuses a drop, paste or duplicate that would nest the edited
     prefab, or any prefab that contains it, anywhere in the world (§ Prefab edit mode).
  2. **The write.** `serializePrefab` checks EVERY prefab the document it is about to write expands (`expandedPrefabRefs`:
     rows, the reference nodes rows add in `added` or `nestedStructure`, and member rows' `added` and `own`) with
     `wouldCreateCycle`, and returns null ("refusing to save — nesting … creates a cycle"). That covers a prefab-edit save
     and Create Prefab's Replace. `commitPrefabWrites` asks the same of every document it is handed, so a writer that
     builds its document another way (Apply's plan, a skin write, the agent's create) cannot write one either; it reads
     the batch's own documents first, so two files of one Apply holding each other are refused too. A verbatim restore
     (an undo's `bytes`) is exempt. Apply's promotion of an added node asks the same (`addedNestsPrefab`, #1446: it used to
     write the row, which expanded to nothing, so the user's instance vanished on the refresh). Never trait data: a
     spawner trait's `prefab` field is not nesting. A SCENE may hold such a nesting; only a file may not.
  3. **The load.** The expansion's ancestor stack reaches reference-node expansion (`spawnReferenceNode`, the one
     spawner the loader's and the editor's structure applies both run). A node is refused only when its prefab is being expanded ABOVE it **and that prefab's own
     document contains itself** (`refuseCyclicReferenceNode`, `prefabRoot.ts`). That is the one shape that recurses
     forever. Across a reference node the stack carries only such self-containing ancestors (`stackForReferenceNode`), so
     a loop through two files still meets its start.
  - ⚠️ **Not "the prefab is on the stack".** The first draft refused that, and 78 tests went red. A scene may nest a
    prefab inside its own instance, and an outer layer's statement is applied under levels that did not state it, so a
    plain repeat is legal and ends.
  - Before #1817 neither layer reached a reference node folded into a nested row: the save guard asked only of
    self-rooted instance roots, `expandedPrefabRefs` skipped `members`, and both spawners dropped the stack. So a
    prefab-edit drop under a nested member wrote a file containing itself, and every load of it overflowed the stack.
  - Because a prefab never contains itself transitively, refreshing every instance of one source is order-independent.
  - Tests: `engine/tests/editor/prefabEditRefusal.test.ts`.
- **Apply-to-prefab refresh preserves placement**: `refreshInstances` tears down
  and re-instantiates each instance under its *original* parent, so a nested
  instance (or any instance parented to a non-root entity) is not detached to the
  scene root.
- **Serialization** (`serializePrefab`) writes a nested instance below the
  selection root as a reference row via `captureInstanceReference` and excludes
  its members from the flat output. The selection root itself is never collapsed.
- **Resource acquisition** is transitive: `SceneManager` walks each fetched
  prefab for nested `prefab` refs and acquires them under the scene id.
- **Caching — and it cuts BOTH ways, which is the part that bit (#1284).** The editor's
  `prefabCache` is read *synchronously* by code on both sides of the nesting, and every
  one of those readers treats "not in the cache" as "not a prefab":
  - **instantiate** — `instantiatePrefab` skips a nested row whose child is not cached
    (it warns). `instantiatePrefabAsync` exists so UI entry points cannot get this wrong.
  - **serialize + capture** — `planPrefabRows` **flattens** a held nested instance into
    copies, `captureNestedRef` drops a user-added nested subtree from `added[]`, and
    the rebuild's load reads every prefab in the entry, and one it does not find is one it cannot expand (the frame is
    kept as is) — so every rebuild caller warms the entry first (`preloadRebuildEntry`, #1880 F7a). Before, the old
    rebuild's nested capture lost a nested instance's per-copy overrides here *with no warning at all*.

  ⚠️ **There are two warmers, and they answer different questions.**
  `preloadNestedPrefabs(prefabFile)` walks a prefab FILE's reference rows;
  `preloadNestedPrefabsForSubtree(entityId)` walks the LIVE tree. **The sync readers above
  all walk the live tree**, so the file walk alone leaves anything live-but-not-in-the-file
  cold — and an ordinary scene load leaves the *whole* cache cold, because the loader fills
  the RUNTIME cache (`meshTemplateCache`), not this one.

  That gap is what #1284 was: Create Prefab warmed nothing, so on a freshly-loaded scene it
  silently wrote copies instead of a reference, and the author found out weeks later when
  editing the child prefab moved nothing. The rebuild paths warmed from the file, so they
  lost only *user-added* nested instances — the same defect at a smaller amplitude.

  **Serializing a live tree therefore means `await preloadNestedPrefabsForSubtree(id)`
  first**, and `serializePrefab` stays synchronous so the obligation sits with the caller
  who can actually await. The scene save does the same thing its own way — `serialize.ts`
  collects every live instance source and awaits `getPrefabSource` over the set before its
  capture loop — which is why a scene save has never lost nesting to a cold cache.

  The live walk does **not** recurse into each fetched file's rows, deliberately:
  `collectTree` is a full descendant walk and every nested root is its own
  `PrefabInstance`, so depth is already covered. A recursion was written and removed —
  with both present, neither could be shown to fail, which is the shape of a line that is
  load-bearing only in appearance.

  Guarded two ways: `coldPrefabCacheWarming.test.ts` (behaviour, starting from a cold
  cache — note every OTHER nested test calls `setPrefabCache` by hand and so only ever
  exercised the warm path) and `prefabCacheWarm.test.ts` (the swap warm and the instantiate
  helper — the two mechanisms that make the cache populated by construction).

  ⚠️ **Every entry point that reaches one of these readers now warms — including the undo/redo
  closures.** Those were deferred three times as "synchronous closures that can never await",
  and that was simply false: `UndoAction.undo/redo` are typed `(): void | Promise<void>`,
  `undoManager`'s `runStep` does `await run()`, and the comment beside its in-flight mutex says
  an action's undo/redo may await, *"e.g. prefab instantiate redo"*. A wrong premise survived
  three passes because each one restated it instead of checking the type.

  Each closure that warms then **re-resolves its `entityRef`**: a cold source makes the warm do
  real I/O, and `entityRef` exists in those files precisely because a raw ecs id goes stale
  across a world rebuild (Play→Stop, a watcher reload).


  ⚠️ **The cache is now populated BY CONSTRUCTION, and the per-call-site warms are belt-and-braces
  rather than the mechanism** (#1295). Two things make it so, and they are what to keep working if
  this ever regresses:
  - **`instantiatePrefabInstance`** — every path that spawns a prefab from an asset path caches it
    under the ref the new instance actually CARRIES. `setPrefabSource` tags it with the document's
    guid (#1828; it resolved the path through the manifest before), and nothing used to cache under
    that guid, so a prefab dropped in mid-session was unreachable however warm the scene load had been.
  - **`installEditorPrefabCacheWarm`** — a `beforeSwap` hook (the loader awaits it, so the swap
    cannot complete half-warm) that takes each prefab from the RUNTIME cache the loader has already
    filled. A `Map.get` plus a `Map.set`; it only fetches for a source the runtime cache cannot key.

  ⚠️ **"By construction" is NOT universal, and the exceptions are why the per-call-site warms stay.**
  Three spawners put a live instance into the CURRENT world *after* the swap, so the beforeSwap hook
  structurally cannot reach them: the timeline scrub preview and its control-track edge
  (`runtime/timeline/timelineSystem.ts`), and the UIEntries scroll pool
  (`runtime/loaders/entryPrefabProvider.ts` → `runtime/ui/entriesSystem.ts`). All three go through
  `spawnPrefabInstance`, which writes a non-empty `source`, and none goes through
  `instantiatePrefabInstance`. A game spawning a prefab from `onSceneReady` is the same shape.

  ⚠️ **Those three spawners are deliberately NOT made to seed the editor cache** (#1301). Seeding
  would make the sync readers read them *correctly*, and reading them at all is the defect: every
  instance those three create is `Transient`, and a `Transient` instance is not authoring input.
  The rule in § Authoring scope (end of this file) is what closes that hole — at the reader rather
  than at the spawner.

  The ~15 `await preloadNestedPrefabsForSubtree(...)` calls are therefore deliberately KEPT: each
  is a `Map.has` once warm, the failure they guard against is SILENT, and the paragraph above does
  not cover everything. They are the cheap half of the defence; the census that policed them was
  the expensive half, and only that was removed. ⚠️ Nothing now detects their removal — that was
  the census's one uncovered job, recorded here rather than left implicit.

  ⚠️ **Do not trust a census that anchors on ONE reader — this paragraph shipped a wrong count
  three times doing exactly that.** The sync reads are not three; in the prefab modules alone (one `prefab.ts` then) there are
  **seven** (`planPrefabRows`, `instantiatePrefab`, `wouldCreateCycle`, `captureNestedRef`,
  `applyStructureByRootInstance`, and two inside the nested-override capture/replay pair), plus
  `Inspector.tsx` and the prefab-edit save. They are reached by different call chains, so a sweep
  anchored on `captureInstanceStructure` cannot see the one that reaches `planPrefabRows` through
  `tagEntityTreeAsInstance` — which is how `assetOps`' async redo survived a manual sweep AND an
  adversarial review. A source census used to pin three anchors separately for that reason; it was
  **deleted** once the cache became populated by construction (see below), because it needed a new
  anchor per reader and that treadmill was its own maintenance defect.

  ⚠️ **The old `applyToPrefab` is the one worth remembering** (deleted as dead code, #1671), because
  it showed what the cold read actually costs. It captured the structure and used the result to
  BUILD the key set it handed to `applyToPrefabSelective`, so a cold miss did not merely hide a row —
  it silently dropped a hand-added nested subtree from an action whose entire promise is "apply all
  of it". It was
  found by a source census on its first run, having been missed by both a manual sweep and an
  adversarial review — which is the argument for the construction-level fix below rather than for
  keeping the census.

  ⚠️ **One behaviour change worth knowing, because warming changes what a GUARD can see.**
  `planPrefabRows` runs `wouldCreateCycle` BEFORE the cache lookup, and that guard returns
  `false` on a miss — so a cold cache made it blind. With the tree warmed it now has the data
  to refuse: `modoki_prefab create` over an EXISTING path, on an entity holding an instance of
  a prefab that nests the target guid, used to flatten-and-succeed and now refuses (Create Prefab's own text since
  #1873 C1: "the selection could not be written as a prefab … which cannot contain itself"). That is the guard working, but it is a new
  refusal rather than a silent mis-save.
- **A prefab's effective ROOT, without spawning** (#1031): `effectivePrefabRootTraits`
  in `runtime/loaders/prefabOverrides.ts` answers "what traits would a spawned
  instance's root carry?" — for code that must not spawn: the `UIEntries` pool
  provider (`rootSize`, `rootAuthoredUI`, `isCached`) and the scene validator's
  entry-prefab pass. It mirrors `instantiatePrefabIntoWorld` step for step:
  - the root is `rootLocalId ?? 1` — **not** "the first row", which the provider and
    the validator used to fall back to and the spawner never did;
  - a **nested-instance root row** resolves to the CHILD prefab's root, composed by
    `foldRowStep` (#1707), the step the editor's effective base folds with: the row's
    `overrides` merged UNDER whatever an outer layer addresses at that row (outer
    wins), its `nestedOverrides` threaded on, its `removedTraits` unless an outer
    whole-frame slot (`nestedStructure`) owns the child frame (then the slot's lists,
    an absent one read as empty), and then every layer's member rows (`members`) over
    both. Before #1707 the member rows and the slot were skipped. The row's own
    `traits` are not part of the answer — the spawner reads only `parentId` there;
  - the outer layer's `overrides` for the root fold on after that, then its
    `removedTraits` — the spawner's order (overrides, then structure);
  - no root would spawn (an uncached child, no row at the root localId, a cycle)
    → `null`, and the provider reports the prefab **not cached**, because
    `spawnInstance` would return 0.

  **Any member, not just the root:** `effectivePrefabMemberTraits(prefab, localId, …)`
  is the general form (the root is `localId = rootLocalId ?? 1`). The validator's
  instance-override pass uses it to read the base `UIElement`/`UIAnchor` a scene
  override lands on — a nested member's base is its child prefab's root, which the
  pass could not see while it read raw rows.

  **A member of a nested frame** (#1707): `effectivePrefabMemberTraitsAt(prefab, path,
  localId, …)` takes the nested rows' localIds down to the member's frame, and
  `memberAddressOfRowKey` turns a member-row key (`/<row>/<member>`) into that address,
  frame by frame through each document's `nodeGuid`s (`docRows`, the spawner's rule). The
  validator uses both, so a scene's DEEP member row sizing a stretched nested member now
  warns (it got the ref check only before). An address naming the ROOT of a nested frame
  is the nested row's member in the frame above, and is composed there (`asOuterMember`,
  at every depth): what that frame puts on the row lands on the same entity. The outer layer's `members` and
  `nestedStructure` are options, as a placement row states them. The test helper
  `prefabInstances` composes every member from the top along its path, and no longer
  carries its own copy of the step. Measured on the corpus when it landed: 72 validator
  warnings before and after, and all 125 prefab roots and 1953 members composed
  identically. No committed prefab row carries `members` or `nestedStructure`, and no
  scene deep member row carries `traits`.

  ⚠️ **Why a separate module rather than a helper in `loadSceneFile.ts`:** the
  validator runs in the Node Vite plugin with no trait registry, imports nothing that
  calls `trait({...})`, and is itself imported by `loadSceneFile.ts`. So the override
  helpers (`mergeOverrideMaps`, `descendNestedOverrides`, `mergeNestedOverridePaths`)
  and the per-trait fold (`foldTraitOverride`, which the spawner's
  `applyOverridesByLocalToEcs` now calls too) live there, re-exported from
  `loadSceneFile.ts`. The two override RULES are **injected**: `acceptField` (which
  fields count) and `traitKind` (what a name is — the spawner ADDS a known trait an
  override names even when no field of it is accepted, a tag as a tag, and skips a
  name it does not know). The provider passes the registry's answers; the validator
  rebuilds both from its `SceneSchema`, which is stricter than the spawner for AoS
  traits (it lists their factory fields, the spawner accepts any) — neither pass reads
  one. The merge ORDER is control flow in the spawner and is not shared with it (the pure
  readers share `foldRowStep` among themselves, #1707), so
  `tests/runtime/prefabOverrides.test.ts` spawns every fixture through the real
  spawner and requires field-by-field agreement.

  Before #1031 both callers read the root row's own `traits`, so a nested-instance
  root reported a 0 size and no authored `UIElement`, silencing every pooled-row
  authoring warning. **Latent, and not a shape the editor writes** — no prefab in
  `games/` or `demos/` has a nested-instance root, and the prefab serializer never
  collapses the selection root into a reference row (`editor/scene/prefabSerialize.ts`), so it
  arises only from hand- or agent-written JSON. That is why it was fixed by
  construction rather than observed. Its cycle guard is keyed on each level's `id` AND the ref it was reached
  by, registered once on entry: a first draft registered the child's ref in the
  parent before recursing, and since a real prefab's `id` IS that ref, every nested
  child resolved to `null` as a self-cycle.

**Not yet done — stated honestly:**

- **A dedicated Prefabs category in Assets** — prefabs currently show alongside
  other assets rather than in their own section.
- **Live propagation to instances in the current scene** — saving a prefab (edit
  mode or *Apply to Prefab*) re-instantiates instances on the next scene
  reload / on returning from edit mode, not in place for an unrelated already-open
  scene. `refreshInstances` handles apply-to-prefab within the same world.

Two limits this list used to carry are gone. Structural edits inside an OWNED nested instance
round-trip: as per-member rows (#1468, #1511), with `nestedStructure` (#1358) as the fallback for a frame
whose members cannot be keyed. A per-copy override on a nested child survives an
outer Apply's refresh, because a rebuild is the load of the scene entry, whose statement carries every nested frame's
edits (#1880 F6).


## Authoring scope — a runtime instance is not authoring input

> **Illustrates I12.**

**Rule: a reader that treats the LIVE TREE as authoring input asks one shared predicate,
`collectTransientSubtreeIds` / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`).**
A `Transient` entity — a UIEntries pooled row, a timeline scrub or control-track spawn, anything a
system spawned inside a tick — is a live artifact, and its subtree goes with it.

| Reader | What it does | Before #1301/#1306 |
|---|---|---|
| `serializeScene` | writes the scene file | hand-rolled copy of the walk |
| `captureInstanceStructure` | diffs an instance against its prefab | hand-rolled copy (added by #1295's review) |
| `collectInstanceRoots` | Apply-to-Prefab's fan-out to every instance | **never asked** |
| `serializePrefab` -> `collectTree` | Create Prefab | **never asked** |

The two misses look unrelated at the symptom level — one saves a scene, one writes a prefab file —
which is exactly why two hand-rolled copies were not enough. What each one did:

- **`collectInstanceRoots`** handed a pooled/scrub instance to `refreshInstances` -> `rebuildInstance`,
  which carried the durable guid and `source` forward but **not the tag**. The rebuilt root was an
  ordinary serializable entity, so the next save wrote a preview artifact into the authored scene —
  defeating the guarantee `spawnPrefabInstance` sets `Transient` for. The rebuild (`rebuildFromEntry` since #1880 F7d) now carries
  it over the respawn as well, on the same reasoning that already carries the guid: transience
  belongs to the identity, not to the id.
- **`serializePrefab`** wrote them into the new `.prefab.json` as ordinary authored members. It now
  **reports** what it left out (a toast on both human entry points through one shared wording, a
  `warnings` entry on the agent op) rather than quietly producing a smaller prefab.

  ⚠️ **The unit of exclusion is a generated REGION, not a tagged entity** — a region being a tagged
  subtree whose top's parent is not tagged. Create Prefab excludes every region that STARTS inside
  the selection, except one starting at the selection root itself, which is the deliberate "bake
  this". Both simpler rules are wrong, and both were written before this one:
  - *"drop every tagged entity in the selection"* destroys the bake case, because in production
    **every** member of a region carries the tag (`spawnEntity` tags whatever is spawned inside a
    system tick), not just its top — so baking a pooled row would write a one-entity prefab.
  - *"skip filtering whenever the selection sits anywhere inside a region"* re-opens this very
    issue: an unrelated region deeper in the selection is then written into the file as an authored
    member **and** tagged as an instance member, silently, with the report suppressed. Measured by
    the close-out re-review on a `PooledRow → Middle → InnerPooled` tree.

  The count is scoped to the selection for the same reason the exclusion is: a world-wide tally made
  every Create Prefab in a pooled scene warn about entities it had not dropped, which is the alarm
  that makes the true report unreadable.

⚠️ **Create Prefab reads the world TWICE, and both reads go through `authoringEntitiesFor`.**
`serializePrefab` writes the file; `tagEntityTreeAsInstance` then re-walks the tree and re-runs
`planPrefabRows` to convert it into a live instance — and **refuses to tag at all** when its plan
does not match the file (`planMatchesFile`, a bare `return`). So a selection rule applied to one
read and not the other does not produce a wrong prefab, it produces a prefab asset with **no
instance in the scene and nothing logged**. This is the second instance of that shape: #1278 was
the first (a held nested instance gave the two reads different localId spaces). `planMatchesFile`
is the backstop; the two reads agreeing at the source is the fix.

⚠️ **The subtree is the load-bearing half, not the tag.** Only the ROOT of a generated subtree is
tagged (`spawnPrefabInstance` tags the instance root; members spawned outside a system tick are not).
A reader that filters on `has(Transient)` alone keeps the members and drops their parent — an
orphaned half-subtree, which is worse than not filtering at all.

⚠️ **This is NOT a Play-mode concern, and reading it as one is why both misses looked unreachable.**
`runPipeline` skips a system only below `TRANSFORM` (200), and the UIEntries pool sits at 270 so a
paused list keeps recycling: measured on `games/scroll-demo`, a **stopped** editor holds 16 pooled
entities out of 36, including 8 live prefab-instance roots that match `collectInstanceRoots`' filter
exactly. A scrub envelope also reports `playState: 'stopped'` (#1122/#1148), which is what lets an
authoring mutation through in the first place. Play-mode spawns, by contrast, never survive Stop —
`playMode.ts` reloads the snapshot and discards them.

⚠️ **What actually applies the tag is the SYSTEM TICK, not the spawner — and that is load-bearing.**
`spawnPrefabInstance` tags only when `forceTransient` is passed or the run-mode is not `stopped`
(`loadSceneFile.ts`), and the timeline scrub is the only caller passing `forceTransient`. The
UIEntries pool's rows and the control-track edge's spawns are tagged because `spawnEntity` tags
**everything spawned inside a system tick** (`core/ecs/world.ts`), and `entriesSystem` spawns from
inside its own tick deliberately. So: move the pool's growth out of the tick — to a DOM handler, a
React effect, a deferred callback — and every reader above goes quiet with no test failing. The
pool's docblock already says it must spawn inside the tick; this is the other half of why.

⚠️ **Therefore "a runtime spawn is `Transient`" is NOT universal, and a game's own spawn is the
gap.** A game spawning a prefab from `onSceneReady` while stopped, outside a tick, gets **no tag** —
so `collectInstanceRoots` still fans out to it and Create Prefab still bakes it in.
`games/sling/runtime/field/rebuildField.ts` adds the tag by hand, which is evidence the hole is
known and nothing makes it structural. Fixing that means changing where the tag comes from, not
adding a fifth reader-side check (found by #1301's close-out review, F8; not filed).

⚠️ **The predicate lives in its own module, not on `entityUtils`.** Most editor tests mock
`entityUtils` with an explicit object literal, so an export added there arrives `undefined` in every
one of them — the guard would be silently absent in all 284 files while they all stayed green.
