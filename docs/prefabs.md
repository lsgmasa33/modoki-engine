# Prefabs

A **prefab** is a reusable entity sub-tree — a mini-scene — saved as a
`.prefab.json` file. A prefab *instance* in a scene references its source and
stores only the fields it overrides, so editing the prefab (and reloading)
updates every instance.

See also: [Architecture](./architecture.md) · [Scene Loading](./scene-loading.md) · [Visual Editor](./editor.md)

> **Design reference: Unity (owner, 2026-09-28).** When a prefab behaviour is a design choice (which prefab an Apply targets, what Revert or Replace keeps, how a nested override reads), copy Unity's prefab semantics. Example: Apply on a nested instance, of a component an enclosing row added, offers both "Apply to Prefab '<nested>'" (stated truthfully as a component addition) and "Apply as override in Prefab '<enclosing>'", the default (#1658, § "Apply's targets").

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
| **Template** | A `.prefab.json` document (`PrefabFile`): rows, `rootLocalId`, an optional document-level `moved`. | `editor/scene/prefab.ts` |
| **Row** | One node of a template. `localId` is its array key: positional, and reused once freed. `nodeGuid` (v5) is its minted identity, never reused. | `PrefabEntity`, same file |
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
| **The two caches** | The editor cache is read synchronously by capture, the save and Apply. The runtime cache is refcounted, read by spawners, and keeps a per-key revision. | `getCachedPrefabSync` (`prefab.ts`); `getCachedPrefab`, `getPrefabRevision` (`runtime/loaders/meshTemplateCache.ts`) |
| **Promotion** | Apply turning a node the scene added into a template row. | `insertAddedSubtree` |
| **Override mark** | A runtime flag on a field that makes a value difference count as an edit. It does not record which layer set the value. | `runtime/loaders/overrideMarks.ts` |

### Invariants

**Owner** is the function that answers the rule today. **Bypassed by** lists the places that
answer the same question for themselves. Each place in that column is a place the rule can break.

#### Effective base

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I1 | A frame's effective base is its template folded with every enclosing layer, from the outside in, the same way at every depth. A layer can carry every edit an instance can. | Runtime: the walk in `instantiatePrefabIntoWorld`, built from the shared folds. **Editor, comparison side: `frameBase` / `chainLayer` (`editor/scene/prefabBase.ts`, #1693)** — one fold (`foldPath`) with the same folds, in the editor expansion's order: a row's fields under the outer layer's forwarded ones, then every layer's member rows over both. It climbs by `ownerOf` and through a template reference node (#1506), and reads every level's document from its frame record (I3). | The expansion side is still twinned (#1707): `instantiatePrefab`, the editor's copy of the spawner (#1683 said it drops a nested row's moves and member rows; it threads member rows since #1533, so re-check before relying on either). `effectivePrefabRootTraits` / `effectivePrefabMemberTraits` (the UIEntries pool and the validator) predate member rows, `nestedStructure` and `added` (#1707). The pose base of an applied nested move (`docChainLayer`), and `referenceRootPose`, fold one level. |
| I2 | Every "is this the instance's own edit?" question compares the live frame with its effective base. That covers the override list, the Inspector highlight, the save, the rebuild's capture, Apply's keys and write, and Revert. Every own edit found has one key, and the listing, Apply and Revert all handle it. | `frameBase`'s layer: through `instanceBase` / `enclosingRowOverrides` (fields) and `ownInstanceStructure` / `layerAuthoredStructureKeys` (structure) for the override list, the Inspector, Apply's structure refusal, and Revert; through `chainSlots` for Apply's targets and U13 (#1693); through `chainLayer` for the save (`captureNestedChannels`) and the rebuild (`captureNestedInstanceOverrides`), whose removed-components pass also measures a member against the traits the layer adds (`layerAddedTraits`, #1676). | `applyToPrefab` builds its keys from `captureInstanceOverrides` against the bare child. `instanceBase` folds the layer's fields but not its `removedTraits` or `added`. A layer's values arrive override-marked, so every bare-child diff has to subtract them by value. The listing and the Inspector diff by value, with no mark gate; the save has one. Gating the listing the same way is #1717 (unblocked by #1709, which made every editor write mark). |
| I3 | A frame is compared against the document it was EXPANDED from. No capture runs on a frame whose recorded rows differ from the cached ones. | The frame record, read through `levelDoc` (`prefabBase.ts`) by every level of `frameBase` / `chainLayer`, the scene save's top-level capture (`savedFrameDoc`, #1685) and its nested captures, the rebuild's readers (`expandedDocOf`) and the settle's save capture (#1693 retired the scoped `expandedFrom` map and the settle's cache swap onto it). `framesBuiltFromOtherRows` refuses a frame whose record holds other rows, and `rebaseStaleInstances` repairs it. `rebuildInstanceFromCapture` puts a capture taken against an older document back onto the current one (Revert's undo, #1665). | The two staleness tests differ: `rowsMeanTheSame` for the refusal, `sameDocument` for the rebase. A frame with no record falls back to the current cache (`setFrameDocFallback`), and the refusal cannot judge it; every expansion path writes one (`instantiatePrefab`, Create Prefab's tag, a reattach, the loader, a carry across a world swap, an undo respawn). |

#### Identity

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I4 | A `localId` means something only together with the document it was read from. Across documents a node is named by `nodeGuid`, and translated to the `localId` of the document the frame expands NOW, where it is used. A write never hands a node a number the document it replaces used for another node, except a Replace over a pre-v5 document, whose numbers are its only identity and stay positional. **A nested frame's overrides survive a rebuild only while the frame expands the same prefab** (Unity drops them the same way when a nested prefab asset is swapped). Across two prefabs, an edit carries only where both documents hold the same `nodeGuid`, and every link of the frame's chain is found by identity (#1767). One difference from a reload is the rebuild's standing rule, not a translation gap: a scene-ADDED node under a dropped member is re-anchored to the frame root (§ Reconcile in `prefab-structural-overrides.md`), where a reload keeps it in the orphan row. | Numbering: `planPrefabRows`, whose plan `serializePrefab` records against the file it writes. A Replace keeps every matched row's number (`replaceNumbering`, #1759), and `tagEntityTreeAsInstance` reads its numbering from that file, which `planMatchesFile` checks row by row. **Translation: `runtime/loaders/memberTranslation.ts` (#1771)**, with `docRows`, `resolveMemberChain` and `translateLocalIds`. The callers are `foldMemberRowChannels` on load, R2's `rowBackedTest` (a member-row key is chained frame by frame, #1766), the rebuild's outer carry and each nested capture's re-apply (#1767), and `toLocalIdKeys` for Apply's keys. | A number freed at the TOP of the numbering is reused by a later write, because the document stores no high-water mark (#1774, OBSERVED). Four readers still spell the chain walk themselves; each chains through the frame's current document, so it is duplication, not a defect: `templateFrameKeys` (`loadSceneFile.ts`), the member-path rewrite in `memberPaths.ts`, `byRowDepth` (`prefabEdit.ts`) and the member-row size check in `sceneValidation.ts`. |
| I5 | Only a write mints identity (a `nodeGuid`, a template `key`), and it carries the existing identity wherever a real correspondence exists. A reader never mints. | `nodeGuidsFor`, the one matcher (#1691): a prefab-edit save's preserved rows, then the live `nodeGuid`, then, on a Replace only, the one old row sharing a node's name (U22). Also `addedNodeIdentity`, whose `readOnly` mode never mints. | None known. Fixed at the owner: the prefab-edit save now remembers where each session-added member was written (#1662); Create Prefab's Replace serializes against the kept id (#1686); Apply's promotion carries the promoted guids (#1660, `carryPromotedGuids`). |
| I6 | Which frame an entity belongs to, what a frame holds, and where a member sits are decided by IDENTITY, never by the live tree. Delete, promotion, a move, Detach and the save's partition all act on the identity subtree. | `worldIdentityParents` (`ownerOf`, `parentOf`, `moved`, and `frameOf`: the frame an entity is a row of), `identitySubtree` (#1691, both in `identityParents.ts`), `memberRowsIn`, `instanceRowDomain` (the row claims, a partition), `rebuildTeardown`, `endFrames`, `planMoveUnlinks`. Apply's promotion delete, Detach, the save's partition and the scene-move refusal ask them (#1682, #1687). | `templateReferenceNode` climbs live parents, on purpose, for speed. A user Delete takes the LIVE subtree on purpose: it removes what is shown under the node (Unity's hierarchy delete), and `endFrames` unlinks a member moved out. "The members of frame R" is read as a raw `rootInstanceId` scan at several sites; for a member that field IS identity (stamped at expansion), so those are not bypasses. |
| I7 | A member's guid is the member row's pin, else the template's, else derived from its anchor through identity parents. Every place that predicts one derives it the same way. | `deriveInstanceMemberGuids` (after `applyStoredMemberRows`) walks up, over `deriveMemberGuid` and `entityStep`. `memberPathIndex` (`runtime/core/ecs/memberHome.ts`) walks the identity tree down, and `stampDerivedMemberGuids`, `promoteOwnedRoots`, `storedMemberGuids` and the loader's move drain share it. | Four sites predict guids with a walk of their own. The derivation's docblock names two: `derivedMemberPaths` (built on `memberPathRecords`, `runtime/loaders/memberPaths.ts`), and `planCopyGuids`. The other two are `liveMemberGuidRemap` and the prefab-edit world's `editGuidAt`. |
| I8 | A template holds no identity of one instance: no guids, no member rows or moves, and a ref from one member to another is written as a member token. | `serializePrefab` with `templateTokenizer` and `assertNoRuntimeGuids`; `toTemplateNodes` for a promotion; `templateValueWriter` (`prefabTemplateValue.ts`, #1659) for every value Apply writes. | None known in Apply. `serializePrefab`'s `templateTokenizer` and prefab edit's `editWorldRefs` are further copies of the idea for other carriers. |

#### Change propagation

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I9 | The caches hold the current template for everything that reads them. A synchronous reader never runs over a cold cache: a miss there reads as "not a prefab". A prefab write is one step: once it lands, both caches hold the written bytes under every key they use, and every live frame expanded from the old document is rebuilt or refused. | Warming: `installEditorPrefabCacheWarm` (before a scene swap) and `instantiatePrefabInstance`, with `preloadNestedPrefabs` / `preloadNestedPrefabsForSubtree` at the call sites. **The write step: `commitPrefabWrite(source, doc, { expected })`** (`editor/scene/prefabCommit.ts`, #1692). It is the only function that changes a `.prefab.json`. Once the write lands it seats the editor cache under the guid, the path and the caller's ref, and the runtime cache under the resolved path. Then it runs the caller's own `rebuild` (Apply's refresh, Create Prefab's tag), then `rebaseStaleInstances({ sources })` for every other frame of the source. Every writer goes through it: Apply and its undo, the prefab-edit save, Create Prefab (Replace and its undo), the agent `create`, the skin rig and its undo, the model regenerate, and the Assets model import and its undo. **Several files are one step too** (`commitPrefabWrites`, for an Apply that writes an inner prefab and its enclosing one, #1693/U13). Every file's precondition is checked before any is written. Each file is then written only over the bytes checked. A miss part-way puts back what was already written, and names the file that missed (`failed`) and any file it could not put back (`stranded`); both refusals word themselves from those (#1732, § Undoing an Apply). Then both caches for each file, one rebuild and one rebase. | No writer. **An outside edit** reaches the editor as a watcher event: the hot reload evicts the runtime cache, refreshes the editor cache (except the prefab open in prefab edit, `refreshPrefabSourceForPath`), reloads, then rebases; leaving prefab edit refreshes that one and rebases (`repairLeftPrefabEdit`, #1666). ⚠️ The commit seats the open prefab's entry too: a first version skipped it so the edit's save kept its baseline, and its own rebase then put the instances an Apply had just refreshed back onto the old document (close-out review). The edit session keeps its OWN baseline (`editBaselineFor`, § Prefab edit mode). |
| I10 | A write over content the caller did not read is conditional, and a write that does not land changes nothing. A read that began before a write cannot put the older bytes back. | `commitPrefabWrite`'s `expected`, required on every write (#1692). It is one of three things. A document the caller READ is matched by the editor's serialization of it, and when that is refused, by the file re-read and parsed as every reader parses it, then written with `ifMatch` on those bytes; so a hand-formatted, CRLF or BOM file still counts as the document read. Raw bytes are matched as they are. `null` means nothing may be there (`createOnly`). A trash carries `ifMatch` on `/api/delete-asset` (#1679). The Apply undo's SCENE half saves only over what the editor itself last wrote to that file (`saveScene({ ifMatch })` over `lastWrittenSceneBytes`, #1695). `getPrefabSource` carries the runtime cache's revision token across its fetch (#1669). The runtime cache refuses a stale in-flight fetch (#863). | One deliberate unconditional write: the prefab-edit save's **Overwrite**, after the conflict was shown to the human (or an agent's explicit `overwrite:true`). |
| I11 | An operation that awaits between its steps lands whole, in the world it began in. | `beginWorldSwitch` / `prepareWorldSwitch`, which wait for what holds the world: an undo step (#1579), and a world-bound operation (`beginWorldBoundOperation`, #1667). The forward Apply holds it from its first line to its undo entry and refuses to start during a switch. Every `commitPrefabWrite` holds it from its write to its rebase. Nothing reachable from a write's rebuild may start a switch, or the two would wait on each other (`prefabCommit.test.ts` counts it). | A world swap that bypasses `beginWorldSwitch` (a hot reload) is read from #1698's adoption record instead. A write starts only once `adoptionsSettled()`, as does the forward Apply. After the write, a route mid-adoption (`pendingAdoptions()`) or a replaced world means it seats the caches and rebuilds nothing, since the new world's load builds from them. |

#### The rest of the model

| # | Rule | Owner |
|---|---|---|
| I12 | A runtime-generated (`Transient`) subtree is never authoring input. | `collectTransientSubtreeIds` / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`); `authoringEntitiesFor` for Create Prefab. See § "Authoring scope — a runtime instance is not authoring input". |
| I13 | Only an authored world (stopped, with nothing posed) is captured or written. | `whyWorldNotAuthored` (`editor/scene/authoredWorld.ts`). |
| I14 | An entity is saved into exactly one scene file, the one its `sourceScene` names, and a rebuild keeps that. | `serializeScene`'s scene filter, `planReparent`, and `rebuildInstance`, which carries the stamp. |
| I15 | A template's `version` is the writer's constant, and a build never overwrites a file written in a newer format. | `PREFAB_FORMAT_VERSION`, `engine/plugins/prefabWriteGuard.ts`, `classifyExistingDocumentId`. It answers `known` before it checks the version (#1678). |
| I16 | A template never contains itself. | `wouldCreateCycle` / `expandedPrefabRefs` when writing; the loader's ancestor stack when loading. |
| I17 | An editor write that changes an instance member's field leaves its override mark in the state the save needs, and its undo puts the mark back. | `editor/undo/overrideMarkWrites.ts`. See § "Editor writes and the override mark". |
| I18 | A reference the load cannot expand is written back as the file held it, until an expansion replaces it. A reader never drops what it could not interpret. | The `UnresolvedPrefabRef` marker on the placeholder (`runtime/core/unresolvedPrefabRef.ts`) and its writers (`runtime/loaders/unresolvedPrefabRefs.ts`). See § "A missing prefab keeps its record". |

### Where the owners are missing

#1683 classified the prefab bug history against these rules. Every prefab-model bug fits one of them, and none
needed a new rule. The table and the counts are on the issue, not here, because they go stale.

The bugs cluster where the table above shows no owner, or an owner that operations go around:
- **Effective base** (I1–I3). Since #1693, `frameBase` (`prefabBase.ts`) is the one answer on the comparison side: the override list, Apply's refusals, Revert, the save and the rebuild's capture all take the layer from it, every level read from its frame record. Before it, the fixes landed one surface at a time: #1386, #1401, #1498, #1492, #1506, and #1676 (the capture's removed-components pass). Apply's write followed with #1693's two-target Apply (#1658), and the expansion side is #1707.
- **Propagation** (I9–I11). Owned since #1692 by `commitPrefabWrite`. Before, each writer put together write, cache and rebuild itself, and the writers that skipped a step were the bugs it absorbed: #1667, #1669, #1685, #1695 (and #1666, fixed at `loadScene`'s leave repair).
- **Identity** (I4–I8). It has real owners (`worldIdentityParents`, `memberRowsIn`, the row-claim partition), and since #1691 one identity subtree (`identitySubtree`, `frameOf`) that the sites which walked the live tree now ask (#1682, #1687). Member guids are still predicted by four walks of their own (#1324, #1339, #1430, #1461, #1660); why none moved onto the shared walk is on the follow-up issue #1691 links. Translating a saved member reference against the frame's current document has one owner since #1771 (`memberTranslation.ts`); its three copies were each handed a document the frame no longer expanded (#1766, #1767).

The verdict, the per-bug table and the proposed owners are on #1683.

## Unity parity

The top note makes Unity the reference for every prefab design choice. This matrix measures how far Modoki is
from it, one row per behaviour. It was built for #1694 (2026-09-28) against Unity 6 and 2022.3 LTS. Where the
2022 Manual pages lag the 2022.2 API (removed GameObjects), the row cites the newer page. **Verdicts:** `match`;
`diverges` (a bug, or a difference the owner rules on); `missing` (a Unity feature Modoki lacks, with a size).
Sizes: S = part of a session, M = about one session, L = several. **The owner decides what is built.** The
counts, the top divergences and the proposed order are on #1694.

Unity sources: [M6] = `docs.unity3d.com/6000.0/Documentation/Manual/`, [M22] = `…/2022.3/Documentation/Manual/`,
[S6] = `…/6000.0/Documentation/ScriptReference/`.

### Structure and overrides

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U1 | Asset and instance | An instance links to its asset and stores only its differences. [M6 `PrefabInstanceOverrides`] | The same. A scene entry stores `prefab` plus its edits. § "Scene-instance format". | match |
| U2 | Nested prefabs | A nested instance keeps the link to its own asset. The outer file stores it as a `PrefabInstance` whose `m_Modification` holds its overrides. [M22 `NestedPrefabs`, M6 `yaml-prefab-serialization`] | A reference row (`prefab` set) holds the child's edits: `overrides`, `added`, `removed`, `removedTraits`, `members`, `nestedOverrides`, `nestedStructure`. § "Nested prefabs (v2)". | match |
| U3 | Prefab Variants | A variant inherits from a base prefab. Its overrides win, and base changes flow through. [M22 `PrefabVariants`] On disk its root is a `PrefabInstance` of the base. [M6 `yaml-prefab-serialization`] | None. The loader already expands a template whose root row is a reference row, which is the same shape, but no editor path writes one or edits one as a variant. | **missing**, L |
| U4 | Property override | Bold, with a blue bar in the margin. [M22 `EditingPrefabViaInstance`] | Presence-based `overrides`, on member rows since scene v16. The Inspector marks the field with a blue left accent (`overrideStyle`). | match |
| U5 | Added / removed component | Both are overrides, badged + / −. [M22 `EditingPrefabViaInstance`] | An added trait is a whole-trait override, and `removedTraits` records a removed one. [prefab-structural-overrides.md](./prefab-structural-overrides.md) | match (badges: see U8) |
| U6 | Added / removed GameObject | Added children are overrides. A removed child is a "removed GameObject" override. [M6 `PrefabInstanceOverrides`, M22 `UpgradeGuide2022LTS`; the `PrefabUtility.GetRemovedGameObjects` API page first exists for 2022.2] | `added` (plain or reference nodes) and `removed` (the top-most member only). | match |
| U7 | Reparenting a member inside an instance | Not allowed: "you cannot reparent a GameObject that is part of a Prefab". [M22 `PrefabInstanceOverrides`. The same sentence's ban on removal is out of date (U6), and the Unity 6 page says nothing, so this citation is weak.] Since 2022.3 Unity even drops child REORDER overrides, and its suggested way to move a nested child is duplicate plus delete. [M22 `UpgradeGuide2022LTS`] | Allowed and stays linked: the member row records `parent`, and Apply re-parents the row (#1437). Dragging a plain member out of its instance unpacks it; an owned nested root dragged out becomes a standalone instance (`planMoveUnlinks`). A reorder inside an instance is saved as a `sortOrder` override, by value (#1709). | **diverges**, deliberate: a Modoki extension. The owner rules on whether it stays. |
| U8 | Override indicators | Instance names in blue; a blue margin line in the Hierarchy on an instance that has overrides; + on added GameObjects; +/− on components; an **Overrides** drop-down on the outermost root, with an asset-vs-instance comparison per component. [M22 `EditingPrefabViaInstance`, `PrefabInstanceOverrides`] | The Hierarchy tints and badges every `PrefabInstance` entity ("P"), and the Inspector accents overridden fields. There is no Hierarchy mark on an edited instance, no + on an added node, no marker for a removed member or component, and no Overrides drop-down: the full list exists only inside the Apply / Revert dialog. | **missing**: badges S, drop-down with comparison M |
| U9 | Missing prefab asset | The instance stays in the scene (`PrefabInstanceStatus.MissingAsset`), and its `PrefabInstance` data stays in the scene file. [S6 `PrefabAssetType.MissingAsset`, M6 `yaml-prefab-serialization`] | The same since #1699: a placeholder, labelled **Missing Prefab** in the Hierarchy, carries the record the file held, and every save writes it back until the prefab is back and re-expands it. A duplicate keeps the data too. § "A missing prefab keeps its record". | match (template-form captures of one are the gap named there) |

### Apply, Revert and their targets

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U10 | Apply / Revert granularity | Per property (right-click), per component (cog menu), per added GameObject (Hierarchy menu), and All / Selected from the Overrides drop-down. [M22 `EditingPrefabViaInstance`] | One dialog (`PrefabOverridesDialog`), opened from the Inspector's "Apply to Prefab…" / "Revert Overrides…". It is a tri-state tree of entity → component → field, plus one row per structural edit, all checked to start. No right-click Apply / Revert on a field or component. | match in what can be selected; the context-menu shortcuts are **missing**, S |
| U11 | What Revert does per kind | Removes an added component or GameObject (with its children); restores a removed component or GameObject. [S6 `PrefabUtility.RevertAddedGameObject`, `RevertRemovedGameObject`; M22 `EditingPrefabViaInstance`] | The same, and "move back" for a moved member. `revertOverridesSelective` tears down and re-expands minus the reverted keys. | match |
| U12 | Apply target, per item on a nested instance | Offers every prefab on the chain: "Apply to Prefab 'Vase'" (the inner asset) or "Apply as Override in Prefab 'Table'" (an override on the nested instance inside the outer asset). [M22 `PrefabOverridesMultiLevel`] | Every field, added tag and removed component takes a target per key over the whole chain (#1693, § "Apply's targets"), in the dialog and the agent `apply` op. An ADDED node, and a move inside a nested frame, still take only the frame's own prefab; a move OUT of a nested frame only the outer one (#1437). | match for fields, components and removed members; **diverges** for added nodes and moves (#1715) |
| U13 | Applying to the inner asset clears the outer's override | "If Apply to Prefab 'Vase' is chosen and the 'Table' Prefab has an override of the value, this override in the 'Table' Prefab is reverted at the same time." [M22 `PrefabOverridesMultiLevel`] | The same (#1693, owner 2026-09-28, superseding #1492 ruling b): every enclosing level's statement of the applied field, tag or removed component is dropped, its file written in the same step, and Apply's undo restores it. | match |
| U14 | Apply All on the outermost root | Targets the outer prefab only. Nested edits become overrides on the nested instance inside it. [M22 `PrefabOverridesMultiLevel`] | The same for fields, added tags, removed components and removed members (#1693, owner 2026-09-28, superseding the 2026-09-19 ruling): the outer instance lists them (`keys.nested`) and writes them into the outer prefab by default; the nested prefab only when picked. A nested frame's added nodes and inner moves are still applied from the nested instance. | match for fields, components and removed members; **diverges** for added nodes and inner moves (#1715) |
| U15 | The instance after an Apply | The applied value now comes from the asset, so the override disappears. | The same: Apply takes what it applied out of the source instance's overrides (#1469), and nothing shadows it any more (U13). | match |

### Unpack, Prefab Mode, Replace, Create

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U16 | Unpack | Makes the instance plain GameObjects with its overrides baked in. **Nested instances stay instances.** [M6 `UnpackingPrefabInstances`] | None. | **missing**, M: the nested frames become stored roots that carry their enclosing layer's edits as their own. The building block exists: `promoteOwnedRoots` / `endFrames` already turn owned nested roots into stored roots. |
| U17 | Unpack Completely | Repeats until only plain GameObjects remain. Undoable. [M6 `UnpackingPrefabInstances`, S6 `PrefabUtility.UnpackPrefabInstance`] | "Detach Prefab" (Hierarchy menu, agent `detach`): `detachPrefabInstance` strips `PrefabInstance` from the frame and every nested frame, bakes the values, and is undoable (`detachPrefabInstanceWithUndo`). | match |
| U18 | Prefab Mode, isolation | The scene is hidden and the prefab is edited alone. [M6 `EditingInPrefabMode`] | Double-click opens it alone (`openPrefabForEditing`). § "Prefab edit mode". | match |
| U19 | Prefab Mode, in context | The scene stays visible but locked, shown gray, normal or hidden. It is the default for Open from the Inspector. [M6 `EditingInPrefabMode`] | None. | **missing**, L |
| U20 | Opening and nesting Prefab Mode | Open button / P key on an instance; opening a nested prefab stacks a breadcrumb. [M22 `EditingInPrefabMode`] | Only from the Assets panel. `editingPrefab` holds one prefab, and the breadcrumb is always `scene › prefab`. The Inspector's source link only selects the asset. | **missing**: Open S, the stack M |
| U21 | Saving in Prefab Mode | Auto Save is on by default and can be turned off. With it off, Unity asks on exit. [M22 `EditingInPrefabMode`] | Cmd+S only. Leaving asks through the unsaved-work modal. Entering, by contrast, saves the open SCENE without asking (`openPrefabForEditing`), which Unity does not do. That silent save is one way #1699 is reached. It is skipped when the caller asked to discard the scene's edits (the agent's `discardUnsaved`), and when a newer scene request superseded the open while it waited (#1745). | **diverges**, mild: Modoki behaves like Unity with Auto Save off. The owner rules on it (S if wanted). |
| U22 | Replace an existing prefab asset with a scene object | Asks first. "Unity tries to preserve references to the prefab and the individual parts… it matches the names of GameObjects." [M6 `CreatingPrefabs`] | Asks first (`confirmReplaceAsset`) and keeps the file guid. Each row keeps its `nodeGuid` where the replacing tree holds a member of the prefab it replaces, then by Unity's name rule; a name two nodes share, on either side, mints rather than guesses (#1686, `nodeGuidsFor`). A matched row keeps its `localId` too, and a new row is numbered above the old document's max: Unity's fileIDs are never reused (#1759, `replaceNumbering`; a pre-v5 document with no `nodeGuid` keeps positional numbering). Every other instance is rebuilt from the new document (`commitPrefabWrite`, #1685 fixed by #1692). | match (Modoki refuses Unity's "unpredictable" duplicate-name match) |
| U23 | Replace the asset of an instance | Swap which prefab an instance uses, from the Inspector's Prefab field or Hierarchy › Prefab › Replace, with "Replace and Keep Overrides" or "Replace and discard any overrides". Objects are matched by name or by hierarchy path (`ObjectMatchMode`). By default no property override is deleted; `PrefabReplacingSettings.prefabOverridesOptions` can clear them. [M6 `CreatingPrefabs`, S6 `PrefabUtility.ReplacePrefabAssetOfPrefabInstance`, `PrefabReplacingSettings`] | None. `PrefabInstance.source` is write-refused on every generic edit path (`traitEditPolicy`). | **missing**, L. The U22 matcher (`nodeGuidsFor`) covers `ByName`; `ByHierarchy` would be a second key on it. |
| U24 | Create a prefab from a plain object | Makes an original prefab, and the object becomes its instance. Child instances become nested. [S6 `PrefabUtility.SaveAsPrefabAssetAndConnect`] | The same (`createPrefabFromEntity`, then `tagEntityTreeAsInstance`). Nested instances below the root become reference rows. | match |
| U25 | Create a prefab from an instance root | Asks: Original Prefab or Prefab Variant. The API makes a Variant unless the instance is unpacked first. [M22 `PrefabVariants`, S6 `PrefabUtility.SaveAsPrefabAsset`] | Always an original: the root instance is flattened, nested instances stay reference rows, and the live tree is relinked to the new prefab. That is Unity's "Original" branch. | **diverges**: the Variant choice waits on U3. |

### Identity, undo, runtime

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U26 | Object identity inside an instance | Objects in a prefab have fileIDs. A reference into an instance goes through a stripped placeholder: the source fileID plus the `PrefabInstance`. [M6 `yaml-prefab-serialization`] | `nodeGuid` names a template node. A member's guid is pinned on its member row (scene v16), so a scene reference survives a template renumber. § "Identity" (I4–I8). | match by design. Open breaks: #1659, #1680. |
| U27 | Undo | Apply, Revert, Unpack and Replace record undo when run as a user action. Leaving Prefab Mode drops that prefab's undo history. [S6 `InteractionMode`, M22 `EditingInPrefabMode`] | Apply, Revert, Detach and Create Prefab are undoable (`applyToPrefabWithUndo`, `revertOverridesWithUndo`, `detachPrefabInstanceWithUndo`). The agent `create` op's undo relinks the tree but leaves the file. **Leaving prefab edit drops its history** (owner, 2026-09-28, #1704): however the edit world is left (Exit, a scene load, opening another prefab, re-opening the same one from inside it), the adoption owner drops its stack instead of parking it (`sceneAdoption.ts`, S8), so a re-open starts with nothing to undo. It used to be kept, and after an outside write (an Apply, a Replace, a checkout) it replayed onto a changed document: an undone delete came back at a number the Apply had given another row. **One deliberate difference:** an asset-document entry recorded there (material, clip, particle…, `_isFileDirect`) survives, parked under the prefab's key as it is across any discard: it edits another file, and dropping it would strand an asset edit with no undo (#1409). Like every asset-document entry, its undo and redo refuse unless the asset still holds that step's side, so an edit made to that asset elsewhere since is not reverted (#1710, [editor.md](editor.md) § An asset-DOCUMENT undo checks the asset still holds its side). Re-opening the prefab you are already editing also drops the history: that rebuilds the world from disk, which an outside write can have changed during the visit (the hot reload skips the edit world). | match, except the asset-document entries above. |
| U28 | Runtime instantiate | `Object.Instantiate` makes no prefab connection. [S6 `Object.Instantiate`] | `spawnPrefabInstance` stamps `PrefabInstance` on every spawned entity, and nested rows expand at load, not at build. | **diverges**, deliberate: the runtime uses `PrefabInstance` for member guids and frame identity. The owner rules on whether it stays. |
| U29 | Reordering children inside an instance | Not an override since 2022.3. Existing reorder overrides are discarded on upgrade. [M22 `UpgradeGuide2022LTS`] | A reorder is an `EntityAttributes.sortOrder` value override ([prefab-structural-overrides.md](./prefab-structural-overrides.md) § Edge cases). | **diverges**, deliberate: sits beside U7. The owner rules on it. |

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
  version: 1 | 2;
  name: string;
  rootLocalId: number;  // localId of the root entity (1)
  entities: PrefabEntity[];
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
- **`editor/scene/prefab.ts`'s `tagEntityTreeAsInstance`** — stamps that trait after a Create
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

### Editor writes and the override mark (#1709)

In the FILE an override is presence-based, as above. In the LIVE world it is a runtime mark
(`runtime/loaders/overrideMarks.ts`), and the save keeps a member field that differs from the
template only when it is marked (`captureInstanceOverrides`' mark gate). The gate exists so that a
re-imported template does not freeze an unedited instance's stale values. It also means an editor
write that changes a member field without marking it is dropped by the next save. #1709 found that
in the UI resize/move handles, in every `EntityAttributes.sortOrder` rewrite (reorder, sibling
renumber, reparent, duplicate, paste, scene move) and in re-adding a trait the template defines
(#1677). Undo had the opposite gap: it restored the value but kept the mark, so an undone edit was
saved as an override pinned at the old value, and later template edits stopped reaching it.

Every editor mark write now goes through `editor/undo/overrideMarkWrites.ts`, under three rules:

- **A deliberate field edit marks unconditionally** (`markOverrideIfInstance`): the Inspector, a
  gizmo commit, agent `setTrait`. The user typed that value, so it stays an override even when it
  equals the base.
- **A write the user did not aim at that field follows the save's by-value rule**
  (`reconcileOverrideMarks`, and `writeTraitFieldMarked` for `sortOrder`). It marks where the live
  value differs from `instanceBase` and unmarks where it equals it. A renumber rewrites every
  sibling's `sortOrder`, and marking them all would pin the instance's whole child order against
  the template. The UI handle commit and a re-added trait use the same rule.
- **Every undo puts back the marks it found** (`markStateOf` / `putMarkState`; a move's undo
  restores the whole set with `putBackMarks`; a renumber's undo is built by `makeSortOrderRenumberAction`). The
  snapshot must be taken before the edit's FIRST write: `reparentEntity` once took it after its own
  marked `sortOrder` write, and its undo put the new mark back. The gizmos' marks belong to their one undo builder,
  `buildTransformUndoAction`'s `markFields` (`editor/scene/gizmoUndo.ts`).

⚠️ **By value cannot keep a reorder local when the template's siblings TIE.** 651 of the 843
sibling groups across the repo's 325 templates carry equal `sortOrder`s, mostly all 0
(measured 2026-09-28). No value sorts between two tied siblings, so the Hierarchy renumbers
the group. Every child from the drop point on then differs from its base, is marked, and stops
following template reorders. That is correct by value, because it is the order on screen. Writing
distinct `sortOrder`s into templates is #1714.

**Not marked, deliberately:** `set-traits` through `modoki_eval` (`app/debug/liveMutate.ts`) is a
raw live write with no undo that also runs in play mode and on the device. A mark there would outlive
Stop. Agent authoring goes through `setTrait`, which marks. Pose, timeline and preview writes, guid
mints, `parentId` and `sourceScene` are not mark-gated.

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
(`captureInstanceOverrides`), the editor apply (`applyOverridesByRootInstance`), and the
loader apply (`applyOverridesByLocalToEcs`) — used to treat `field in meta.fields` as
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

## Core operations (`editor/scene/prefab.ts`)

- **`serializePrefab(selectedEntityId, existingId?, opts?)`** — collects the selected
  tree (`collectTree`, BFS), assigns `localId`s, snapshots each trait, remaps
  parent links to localIds, and rewrites asset path refs to GUIDs. Pass
  `existingId` to preserve a prefab's UUID on re-save. `opts.preserveLocalIds` /
  `opts.name` keep a re-save from renumbering members or renaming the file — see
  "localId stability" above.
- **`instantiatePrefab(prefab, parentId?)`** — editor-side spawn into the current
  world: spawns entities, remaps `parentId`s, adds the `PrefabInstance` trait,
  sets `rootInstanceId`, returns the root ECS id. `setPrefabSource(rootEcsId,
  source)` then stamps the `source` path on the instance. It is **synchronous**, so
  any nested (`v2`) child must already be cached — a nested row whose child file is
  not in the cache is silently skipped.
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
  back it.
- **`getPrefabSource(source)`** — fetch (and cache) a prefab file by GUID or path; a fetch that a write or a
  trash overtook is not seated (#1669). A WRITE is `commitPrefabWrite` (prefabCommit.ts, #1692), never a
  cache set. The cache lets the serialize loop and the
  Inspector read override diffs synchronously. (The runtime resource cache uses
  its own `getCachedPrefab()` in `meshTemplateCache.ts`.)
- **`applyToPrefab` / `applyToPrefabSelective`** — write live overrides back into
  the source file and refresh sibling instances.

### Apply takes what it applied OUT of the source instance's overrides (#1469)

> **Illustrates I2** (own edits are measured against the effective base).

Apply refreshes **every** instance of the source, the one it was applied from included: each is
captured against the OLD document, rebuilt from the new one, and has its capture re-applied. A match
with the new base is **not** what drops an applied field from the source instance. The field is still
override-MARKED (`overrideMarks.ts`), and the capture keeps a marked field that differs from the old
base. The rebuild then re-applies it through `applyOverridesByRootInstance`, which re-seeds the mark.
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
  component as a `traitRemovals`. Still open (#1737): a restored REFERENCE row's frame gets the layer's statements
  about its own members only from the nested capture, which a frame that did not exist has none of. It shows the
  inner template's values until a reload; nothing wrong is listed or saved;
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
  which a refused Apply otherwise left behind with no undo.
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
- **Not yet (#1715)**: an ADDED node, and a move inside a nested instance, go to the frame's own prefab only (a move OUT
  of a nested frame goes to the outer one, `nestedFrameMoves`, #1437); the enclosing levels take fields, tags, removed
  components and removed members (`writeMemberRemoval`). An added node is a live entity whose guid other refs name, so
  writing it into another prefab's row needs #1660's guid carry across that prefab's rebuild — a different fix shape. A template reference node above the chain is not a place Apply writes, so U13 cannot drop its
  statement (#1731; Unity would — that needs the node as a write target, #1715's family). Where it states the applied
  field, the prefab IS written (every other instance takes the value), and THIS instance keeps the value it shows as
  its own edit — left out of the refresh's subtraction, still marked and still listed, since it differs from its base —
  rather than flipping to the node's. The key's effect says so in its `note`; nothing lands in `skipped`. (It used to
  push "not applied, the node still wins" after writing, which neither the file nor the instance matched.)

**The resolved base is the enclosing layer WHOLE (#1506).** `frameBase` (`prefabBase.ts`, #1693; `enclosingLayer` reads
its layer) answers what the layers enclosing an instance author on it: field overrides AND structure lists. `enclosingRowOverrides` is its
field half, with tokens resolved. The layer can be one of two things:
- **a row frame**: every row from the top down, fields and structure in ONE fold (`foldPath`), each level's
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

### Undoing an Apply

> **Illustrates I9, I10 and I11** (a write is one step, is conditional, and lands in the world it began in).

An Apply changes two things: the prefab file, and every live instance of it. So its undo
(`applyPrefabUndo.ts`) puts back both. It installs the prefab snapshot, then reloads the live world from
the `serializeScene` snapshot taken on that side of the Apply. Only the scene snapshot tells the
applied instance (an override again after the undo) apart from the ones that merely inherited the
value (back to the old base). Neither a rebase nor a rebuild from the prefab's document can recover that.

**The snapshot is reloaded under the key of the world the undo belongs to when it RUNS**
(`currentSceneKey()`, the key Stop's restore uses), not under a path captured at the Apply (#1575):
- **a scene's path**: reloaded there, and the editor's path and base re-synced. It is saved only when the Apply saved
  it (a promotion), and then only over what the editor last wrote there (#1695, below);
- **the prefab-edit world's synthetic path**: reloaded there, not saved (#1573, § Prefab edit mode);
- **an untitled scene** (`null`): reloaded under `''`, as `restoreAuthoredSnapshot` reloads one on
  Stop. Nothing is fetched, the world is not marked as a loaded scene, the editor's path stays null
  (so Save still asks where), and nothing is saved. `replaceWorldContent`, which builds an untitled
  world, cannot do this: its populate callback is synchronous, and a prefab instance needs the async
  loader.

Before #1575 an untitled scene matched neither captured path, so only the file came back. The other
instances kept the applied value, the applied one lost its override, and a later Save As wrote that as
an override on each. Reading the key at undo time also covers an untitled scene saved with **Save As**
after the Apply. That save sets the editor's path but keeps the undo history, so the Apply entry is
still undone, now under a real path.

**The reload happens only if that world is still live.** The file install and the member-path repair
before it are awaited. A scene load, an Exit from prefab edit, or a Create Scene can land in that
window. The reload is skipped in any of three cases, and only the file is restored, with a warning:
- the key changed;
- the world object changed (checked for every key);
- a scene load is swapping the world (`isSceneLoadSwapping()`, or `sceneManager.getNext()`). A load
  that is only WAITING for this undo does not count: skipping on it recreated the window #1579 closed.

The world is compared for every key because a scene load swaps the world first. It sets the path and
the history only in its tail, after awaiting the scene managers, so for that window the key still
reads as the old scene's. Every untitled world shares the key `null`, which is why the world check was
first written for that case. A skipped restore also skips `rederiveBaseInstances`, which would
otherwise rebuild the prefab's base instances in whatever world is live. **And the step throws.** It
applied only half, the file and not the world, so the undo manager drops it with a loud report
(#310's policy, [editor.md](editor.md) § A throwing undo/redo closure). The entry is never left on a
redo stack as though undone. Where the history has already swapped, the manager would drop it anyway
(§ A step that awaits across a scene switch). Otherwise its redo would load this snapshot under the
new scene's key and save it there.

**These are guards at the step, and since #1579 they are defence in depth.** Opening a scene,
Create Scene, entering or leaving prefab edit, and pressing Play all wait for the undo in flight
before they swap, and refuse new undo steps until they land. So the undo applies whole, file and
world, and the switch lands after it. The guards still cover a route that swaps through
`sceneManager` directly. Mechanism: [editor.md](editor.md) § A user world switch waits for the undo
in flight.

**The file is written only over the other side of the Apply (#1664).** The prefab file is global, but an
Apply's entry lives on one scene's history. It survives a prefab-edit round trip (entering prefab edit
parks the scene's stack, and Back restores it), and it survives another scene's Apply of the same prefab
or a `git pull`. Before #1664 an undo wrote the pre-Apply document over whatever the file had become, and
redo brought back only the Apply, so the later edit was lost for good.

Each half is one `commitPrefabWrite` (#1692) with `expected` set to the other side: undo expects the Apply's written
document, and redo expects the one the undo wrote. The world reload is the commit's rebuild. The write carries
`ifMatch` on those bytes, which `/api/write-file` checks against the bytes on disk. A file holding the same document
in other bytes (a formatter, a CRLF checkout) is re-read and compared as a document, so it does not refuse; anything
else that rewrote the file does. The restore writes the editor's serialization of the snapshot, not the bytes the
file held before the Apply. That is deliberate: the Apply itself rewrote the whole file that way, and an id-less file
gets its id minted on both sides up front (so every undo would otherwise re-mint it).

**The scene half is conditional too (#1695).** The forward Apply saves the scene only when a promotion restructured
it. Its undo and redo then save it only while the file holds what the EDITOR last wrote there, from any save
(`saveScene({ ifMatch })` over `lastWrittenSceneBytes`, serialize.ts), and they save nothing when the Apply saved nothing: the restore is left unsaved, as any undo leaves it. Unity dirties rather than
saves. Before, both always saved a titled scene. So a change made to the scene file while its history was parked (leave
the scene, `modoki_mutate_scene` it, come back, Cmd+Z) was overwritten by the in-memory snapshot. A refused scene save
leaves the file alone and is reported (#308's report, with a toast: the user can fix it). It is not thrown, because
the world has already followed the step. ⚠️ Keyed on the editor's LAST write, not on the other half's save: a first
version was, so the user's own Cmd+S between the Apply and its undo made every later undo refuse — blaming an outside
change, and offering "reopen it", which would have lost the promoted node for good (close-out review).

**A write that does not land changes nothing, and the step throws (#1668).** This covers a refusal and a
failed write alike. The editor cache is set only after the write lands. Before #1668 the cache was seeded
first and the write's result was ignored, so a failed write rebuilt and saved the world against a
document the disk did not hold.

The throw comes before the member-path repair and the world reload, so nothing is half-applied. The undo
manager drops the entry (#310). It throws an `UndoRefusedError`, which the reporter renders as "refused"
with its own toast. The toast reads *"Undo of "Apply to Prefab" refused: the prefab changed on disk since
the Apply, and was left as it is"*, not the generic *"FAILED … part of it may already have been
applied"*. It throws rather than using #308's report-and-return because that path moves the entry to the
other stack as though it had applied. A refused entry would also refuse again on every retry, and so
block every older undo behind it.

**Several files: the refusal names the file that refused, and any file left stranded (#1732).**
`commitPrefabWrites` reports `failed` (the file whose precondition or write refused) and `stranded` (the files a
mid-way failure wrote and whose rollback also failed). The undo's detail names `failed`, not the Apply's primary
file: after a [P, O] Apply, an outside edit of O was reported as "P changed on disk", naming the file that had not
changed. The forward Apply says "nothing was applied" only when nothing was stranded, and the dialog's notice no longer
frames every refusal that way (`applyOutcomeNotice`: "Apply to Prefab refused: <reason>"). Otherwise it names the stranded
file, which holds the Apply on disk while the editor still holds the document it read, so the next Apply refuses it
as changed on disk until the scene is reopened. Tests: `applyTwoFileUndo.test.ts` § #1732.

Tests: `engine/tests/editor/untitledApplyUndo.test.ts` (each rule above mutation-checked),
`prefabEditApplyUndo.test.ts`, `applyPrefabDirtiesBase.test.ts`, and `applyUndoIfMatch.test.ts` for the
if-match, the failed write, the forward Apply's own precondition and its world hold (#1667). The scene half:
`engine/packages/modoki/tests/editor/applyToPrefabUndo.test.ts` and `saveSceneIfMatch.test.ts`. That last one runs against a fake route holding the exact bytes it received,
with the route's own if-match rule.

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
  document differs from the cache (by content), inner frames first (see below). Kept bases are not the only carried roots: a `Persistent` root is carried
  whatever scene owns it. Everything the reload re-expanded from disk compares equal and is left
  alone. A world replaced while the nested prefabs load rebuilds nothing. A reload that is deferred
  (Play, a preview envelope) rebuilds when it finally runs, because the record, not a remembered
  baseline, says what each frame was built from.
- **Every refresh captures a root against ITS document.** `refreshInstances` (Apply's fan-out, its
  undo/redo, the rebase) uses each root's own record as the capture baseline, and falls back to the
  caller's `oldPrefab` only when there is no record. `rebuildInstance` translates from that baseline by
  `nodeGuid` (`translateLocalIds`, `memberTranslation.ts`). Before the close-out review, an Apply on one instance rebuilt a
  stale nested frame in ANOTHER against the cached rows and moved its edits onto other members, for
  good. A root whose stale frame is only NESTED is skipped, with a warning. The fan-out runs **deepest
  first**: an instance the author dropped inside another instance of the same source is captured by
  the outer rebuild through `captureNestedRef`, which reads the CACHED document. Outer first, it read
  the not-yet-refreshed inner against the new rows, so a node the Apply had just promoted was saved as
  removed. That predates #1483; the second close-out review found it.
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
  Still open (#1741): an Apply made from the OUTER root of a nested frame's own edit (U14). The side captures only the
  outer root's own members, so the nested frame's edit, which the Apply took out, is not restored.
- **Leaving prefab-edit mode re-reads the edited prefab, by EVERY route** (`settleLeaveDebts`,
  `sceneAdoption.ts`). `refreshPrefabSourceForPath` skips the prefab open in prefab-edit mode, so after an
  exit without saving, the editor's copy could be older than the file the scene had just loaded from.
  Every instance of it was then refused, and a later rebase rebuilt carried ones back to the old
  template. The repair re-reads it once the edit flag no longer names it, then rebases, because a
  `Persistent` root is carried through prefab-edit mode and back, so a SAVED edit reaches it only there.
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
  the dialog and the agent op share) rebuilds through `rebuildInstanceFromCapture`, and Detach's undo
  rebases after the reattach (`reattachDetachedInstance`). In production the template changes between
  a Detach and its undo only across a world reload, which leaves the tree plain with no frame record, so
  the detach snapshot carries each frame root's record and the reattach puts it back; without it the
  rebase skipped the frame (close-out review). Always, not only where the world has none: the restored
  localIds index the snapshot's document, and Create Prefab's Replace undo otherwise kept the SAME
  prefab's newer record over them, so the instance read as stale (re-review). Detach's redo keeps
  the snapshot of the detach it just made (`detachPrefabInstanceWithUndo`): the undo's rebase can bring
  members in, and replaying the FIRST snapshot on the next undo left one of them plain. ⚠️ Not `rebuildInstance(…, cache, …, baseline = the Revert's document)`: `baseline` is two
  things there — the numbering of what is carried, and the document the LIVE tree was expanded from,
  whose chain the nested capture subtracts (not mark-gated for structure). At undo time they differ, so
  `rebuildInstanceFromCapture` translates the carried state into the frame's recorded document and
  passes THAT as the baseline, which is the rule `refreshInstances` follows. It only picks the
  document; the effective base is still computed in one place (`captureNestedInstanceOverrides` →
  `chainLayer`). A stale NESTED frame refuses the step before anything
  is rebuilt, with `UndoRefusedError` as Apply's undo refuses (#1664): `runStep` drops it (#310), marks
  nothing edited, and toasts the reason.
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

**A rebuild carries what its teardown reaches OUTSIDE its live subtree (#1499).** The teardown
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
| An added reference node (on the entry, a member row, a plain node's children, another reference node) | `spawnUnresolvedReference`, under the node's parent. The loader's and the editor's `spawnNestedInstance` both call it, so a rebuild (Apply, Revert, Refresh) respawns it. The loader keeps no orphan rows for it: its record holds them, and kept ones outlived its re-expansion and overwrote a later edit. | `captureChild` writes the node (`asAddedNode`). |
| A template's reference row inside a resolved instance | None: the frame is the template's. | The scene's edits to that frame ride member rows. `rowBackedTest` counts a row naming a reference row whose child cannot be read as unbacked, so the orphan store keeps it (the nested root's own row included, which it used to drop) and the save writes it back. |
| A reference row in PREFAB EDIT | The row is a top-level entry of the edit world, so it takes the first path. | `serializePrefabEditWorld` writes the row from the baseline, because the edit world's entry went through `editWorldRefs`. |

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
once the prefab resolves. Two open gaps (#1722): a duplicate or paste of a prefab MEMBER strips the markers along with
`PrefabInstance`, so a placeholder under it loses its record (#1762), and a ref inside the record to an entity copied
alongside it is not remapped to the copy (#1763). In prefab edit, a copy of a missing row has no baseline row. It is written from its record
when nothing in the record was rewritten into the edit world's ids and it states no guid; the save refuses otherwise.
The guid test is what refuses a SCENE placeholder pasted into prefab edit, whose member rows pin scene guids (#1293). The Hierarchy
labels the placeholder **Missing Prefab** (`EntityInfo.missingPrefab`), so it does not read as an empty object to clean
up. A duplicate re-mints the record's guids on its own, so a copied scene child's ref into a member of the record still
names the original's member (the copy's remap, `planCopyGuids`, cannot see members that do not exist).

The TEMPLATE writers refuse rather than write a scene record into a template (I8): Create Prefab of a tree holding a
placeholder (the human path and the agent `prefab create` op, over the live tree they write), and an Apply that would
promote one. What an `+added` key promotes is the node's IDENTITY subtree (I6), so Apply asks that, not the key's text
(a placeholder under a plain added node is named by no key of its own) and not the live tree (a placeholder under a
member moved into the node stays behind with the member). Apply of anything else on the
instance goes ahead. A rebuild's preload fetches a placeholder's source (`preloadNestedPrefabsForSubtree`), so a
prefab restored on disk re-expands on the next rebuild.

Known gaps, filed as one class in #1738 (a writer meeting a reference it cannot read, with no record for it):
- **A prefab-edit save of a template holding an added reference NODE whose prefab is missing** (the template's own
  key node, or a pasted scene one) is refused, not written: the template capture leaves a placeholder out, and the
  save has no baseline for a node the way it has one for a row. Safe, but the prefab cannot be saved until the child
  resolves or the node is deleted.
- **A missing row moved under a member of a nested row, in prefab edit,** is written under its row parent: the save
  keeps the record and drops the move.
- **A pre-v5 template's** path-keyed `nestedOverrides` / `nestedStructure` for a missing nested frame are not kept:
  with no `nodeGuid` there are no rows for the orphan store to hold.
- **A prefab trashed inside the editor while an instance of it is expanded**, then saved with no reload: the instance
  carries no marker, the trash evicts both caches, and the save falls back to the root's trait snapshot. Since #1702 an
  editor trash no longer reloads the open scene, which would have routed it through the load path (by reading, not
  driven).

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
  `applyToPrefab` / `applyToPrefabSelective` push live overrides back to the
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
gone from the file too, and when a newer scene request superseded it while it waited (#1745). In prefab-edit mode `modoki_save_all` writes any parked work (asset docs, base-scene
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
  (`serializePrefab` → `collectTree(rootId)`), so an `addEntity` with `parentId: 0` succeeds live and
  is silently absent from the saved file.
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

Every file this serializer writes carries `PREFAB_FORMAT_VERSION` (**6** since #1533, **5** from #1468; this
paragraph said **2** until #1468, which is the drift a hardcoded number in prose always ends in —
read `runtime/core/version.ts`, which is where the constant lives now and which lists what each
version added). It used to be derived from
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
- **Instantiation** (`instantiatePrefab` editor / `instantiatePrefabIntoWorld`
  runtime) recurses on a `prefab` row, expanding the child from cache, applying
  its overrides/structure, and parenting its root to the outer member. The outer
  pass sets `rootInstanceId` only on its *own* members so inner ids aren't
  stomped.
- **Cycle safety** is two-layered: `wouldCreateCycle` rejects a *save* that would
  nest a prefab inside one of its own descendants (A → B → A) — a prefab-edit save,
  Create Prefab's Replace, and Apply's promotion of an added node (`addedNestsPrefab`,
  #1446: it used to write the row, which expanded to nothing, so the user's instance
  vanished on the refresh). Both read every prefab a file EXPANDS (`expandedPrefabRefs`:
  rows, and the reference nodes rows add, in `added` or `nestedStructure`), never trait
  data — a spawner trait's `prefab` field is not nesting. A SCENE may hold such a nesting; only a file may not. A `_stack` of
  prefab GUIDs in the instantiate path is the backstop (an on-disk cycle can never
  hang the loader). Because a prefab can never transitively contain itself,
  refreshing every instance of one source is order-independent.
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
    `captureNestedInstanceOverrides` / `reapplyNestedInstanceOverrides` lose a nested
    instance's per-copy overrides across a rebuild *with no warning at all*.

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
    under the ref the new instance actually CARRIES. `setPrefabSource` resolves a path to a GUID
    whenever the manifest can, and nothing used to cache under that guid, so a prefab dropped in
    mid-session was unreachable however warm the scene load had been.
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
  three times doing exactly that.** The sync reads are not three; in `prefab.ts` alone there are
  **seven** (`planPrefabRows`, `instantiatePrefab`, `wouldCreateCycle`, `captureNestedRef`,
  `applyStructureByRootInstance`, and two inside the nested-override capture/replay pair), plus
  `Inspector.tsx` and the prefab-edit save. They are reached by different call chains, so a sweep
  anchored on `captureInstanceStructure` cannot see the one that reaches `planPrefabRows` through
  `tagEntityTreeAsInstance` — which is how `assetOps`' async redo survived a manual sweep AND an
  adversarial review. A source census used to pin three anchors separately for that reason; it was
  **deleted** once the cache became populated by construction (see below), because it needed a new
  anchor per reader and that treadmill was its own maintenance defect.

  ⚠️ **`applyToPrefab` is the one worth remembering**, because it shows what the cold read
  actually costs. It captures the structure and uses the result to BUILD the key set it hands
  to `applyToPrefabSelective`, so a cold miss did not merely hide a row — it silently dropped
  a hand-added nested subtree from an action whose entire promise is "apply all of it". It was
  found by a source census on its first run, having been missed by both a manual sweep and an
  adversarial review — which is the argument for the construction-level fix below rather than for
  keeping the census.

  ⚠️ **One behaviour change worth knowing, because warming changes what a GUARD can see.**
  `planPrefabRows` runs `wouldCreateCycle` BEFORE the cache lookup, and that guard returns
  `false` on a miss — so a cold cache made it blind. With the tree warmed it now has the data
  to refuse: `modoki_prefab create` over an EXISTING path, on an entity holding an instance of
  a prefab that nests the target guid, used to flatten-and-succeed and now fails the op with
  `could not serialize prefab from entity N`. That is the guard working, but it is a new
  refusal rather than a silent mis-save.
- **A prefab's effective ROOT, without spawning** (#1031): `effectivePrefabRootTraits`
  in `runtime/loaders/prefabOverrides.ts` answers "what traits would a spawned
  instance's root carry?" — for code that must not spawn: the `UIEntries` pool
  provider (`rootSize`, `rootAuthoredUI`, `isCached`) and the scene validator's
  entry-prefab pass. It mirrors `instantiatePrefabIntoWorld` step for step:
  - the root is `rootLocalId ?? 1` — **not** "the first row", which the provider and
    the validator used to fall back to and the spawner never did;
  - a **nested-instance root row** resolves to the CHILD prefab's root, with the row's
    `overrides` merged UNDER whatever an outer layer addresses at that row (outer
    wins), its `nestedOverrides` threaded on, and its `removedTraits` applied in the
    child. The row's own `traits` are not part of the answer — the spawner reads
    only `parentId` there;
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
  one. The merge ORDER is control flow in the spawner and cannot be shared, so
  `tests/runtime/prefabOverrides.test.ts` spawns every fixture through the real
  spawner and requires field-by-field agreement.

  Before #1031 both callers read the root row's own `traits`, so a nested-instance
  root reported a 0 size and no authored `UIElement`, silencing every pooled-row
  authoring warning. **Latent, and not a shape the editor writes** — no prefab in
  `games/` or `demos/` has a nested-instance root, and the prefab serializer never
  collapses the selection root into a reference row (`editor/scene/prefab.ts`), so it
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
outer Apply's refresh, because the rebuild captures each nested instance and re-applies it
(`captureNestedInstanceOverrides`).


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
  defeating the guarantee `spawnPrefabInstance` sets `Transient` for. `rebuildInstance` now carries
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
