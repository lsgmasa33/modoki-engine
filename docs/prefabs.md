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
| **The two caches** | The editor cache is read synchronously by capture, the save and Apply. The runtime cache is refcounted, read by spawners, and keeps a per-key revision. ⚠️ `getCachedPrefab` takes a GUID. Given an asset path, it resolves it through `resolveRef`, which logs `[assetManifest] path reference no longer supported` as an ERROR and returns nothing. A verification probe that reads the runtime cache by path produces that line itself, and `modoki_diagnose` goes `ok:false` over it. That is how #1801 was filed as an engine bug. Probe by GUID. | `getCachedPrefabSync` (`prefab.ts`); `getCachedPrefab`, `getPrefabRevision` (`runtime/loaders/meshTemplateCache.ts`) |
| **Promotion** | Apply turning a node the scene added into a template row. | `insertAddedSubtree` |
| **Override mark** | A runtime flag on a field that makes a value difference count as an edit. It does not record which layer set the value. | `runtime/loaders/overrideMarks.ts` |

### Invariants

**Owner** is the function that answers the rule today. **Bypassed by** lists the places that
answer the same question for themselves. Each place in that column is a place the rule can break.

#### Effective base

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I1 | A frame's effective base is its template folded with every enclosing layer, from the outside in, the same way at every depth. A layer can carry every edit an instance can. | Runtime: the walk in `instantiatePrefabIntoWorld`, built from the shared folds. **Editor, comparison side: `frameBase` / `chainLayer` (`editor/scene/prefabBase.ts`, #1693)** — one fold (`foldPath`) with the same folds, in the editor expansion's order: a row's fields under the outer layer's forwarded ones, then every layer's member rows over both. **The step itself is shared since #1707** (`foldRowStep` / `foldPath`, `runtime/loaders/prefabOverrides.ts`): the validator and the UIEntries pool (`effectivePrefab*Traits`) compose each nested row with it too. It climbs by `ownerOf` and through a template reference node (#1506), and reads every level's document from its frame record (I3). | The expansion side is still twinned: `instantiatePrefab`, the editor's copy of the spawner. #1707 re-checked #1683's claim and pinned the two walks against each other (`engine/tests/editor/expansionTwinParity.test.ts`). The editor's nested-row apply, which is where a frame's removals run, was handed neither of the frame's moves. A slot's `moved` was lost outright: a pre-v5 member moved inside a scene-added reference node went back to its row on every rebuild of the instance around it. A member row's `parent` was recovered by `spawnNestedInstance`'s top-level apply, except where the same frame removes the member's old ancestor. That removal cascade stops only at a member it is told has moved, so the moved member was deleted with it. Both are fixed, and the apply now gets the runtime's `moved` and `members`. Making the editor call the runtime walk is #1783, with that harness as its pin and its blind spots listed. `effectivePrefab*Traits` still model neither a structural `removed` of the member nor an `added` node. The pose base of an applied nested move (`docChainLayer`), and `referenceRootPose`, fold one level. |
| I2 | Every "is this the instance's own edit?" question compares the live frame with its effective base. That covers the override list, the Inspector highlight, the save, the rebuild's capture, Apply's keys and write, and Revert. Every own edit found has one key, and the listing, Apply and Revert all handle it. | `frameBase`'s layer: through `instanceBase` / `enclosingRowOverrides` (fields) and `ownInstanceStructure` / `layerAuthoredStructureKeys` (structure) for the override list, the Inspector, Apply's structure refusal, and Revert; through `chainSlots` for Apply's targets and U13 (#1693); through `chainLayer` for the save (`captureNestedChannels`) and the rebuild (`captureNestedInstanceOverrides`), whose removed-components pass also measures a member against the traits the layer adds (`layerAddedTraits`, #1676). | `applyToPrefab` builds its keys from `captureInstanceOverrides` against the bare child. `instanceBase` folds the layer's fields but not its `removedTraits` or `added`. A layer's values arrive override-marked, so every bare-child diff has to subtract them by value. The listing and the Inspector pass the save's own mark gate (#1717): `gateOnMarks` (a diff with no mark is not an override; an added trait and a moved member's Transform are kept whatever the marks say) and `foldMarkedEqual` (a marked value equal to its base is one). The fold-in skips a field an enclosing row STATES, per field as the save's subtraction does, because the layer's value arrives marked too and would otherwise be listed as the nested instance's own; so a user's deliberate equal edit of a field the row states is not listed (the depth ≥ 2 case #1722 recorded). The moved-member question behind the Transform exemption is asked only for a Transform diff with no mark (`instanceMovedMembers` is lazy), since the Inspector recomputes on every dirty frame. |
| I3 | A frame is compared against the document it was EXPANDED from. No capture runs on a frame whose recorded rows differ from the cached ones. | The frame record, read through `levelDoc` (`prefabBase.ts`) by every level of `frameBase` / `chainLayer`, the scene save's top-level capture (`savedFrameDoc`, #1685) and its nested captures, the rebuild's readers (`expandedDocOf`) and the settle's save capture (#1693 retired the scoped `expandedFrom` map and the settle's cache swap onto it). The record also lists the nested rows its expansion could NOT expand and no layer removed (`unexpanded`, #1812): the save's removal pass (`nestedRowPresent`) and Create Prefab's refusal (`unexpandedNestedRows`) ask it whether a row was expanded, never the cache. Runtime only; it answers for a capture document holding the SAME ROWS as the record's (`rowsMeanTheSame`, not object identity: the runtime and editor caches hold separate copies of one file after any editor write), and a record no expansion wrote answers nothing, so they fall back to the cache. `framesBuiltFromOtherRows` refuses a frame whose record holds other rows, and `rebaseStaleInstances` repairs it. `rebuildInstanceFromCapture` puts a capture taken against an older document back onto the current one (Revert's undo, #1665). | The two staleness tests differ: `rowsMeanTheSame` for the refusal, `sameDocument` for the rebase. A frame with no record falls back to the current cache (`setFrameDocFallback`), and the refusal cannot judge it; every expansion path writes one (`instantiatePrefab`, Create Prefab's tag, a reattach, the loader, a carry across a world swap, an undo respawn). |

#### Identity

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I4 | A `localId` means something only together with the document it was read from. Across documents a node is named by `nodeGuid`, and translated to the `localId` of the document the frame expands NOW, where it is used. A write never hands a node a number the document it replaces used for another node, nor one an EARLIER write used and freed: a new row takes a number at or above the document's persisted high-water mark, `nextLocalId` (v8, #1774). The exception is a Replace or a rebuild over a pre-v5 document, whose numbers are its only identity and stay positional. **A nested frame's overrides survive a rebuild only while the frame expands the same prefab** (Unity drops them the same way when a nested prefab asset is swapped). Across two prefabs, an edit carries only where both documents hold the same `nodeGuid`, and every link of the frame's chain is found by identity (#1767). One difference from a reload is the rebuild's standing rule, not a translation gap: a scene-ADDED node under a dropped member is re-anchored to the frame root (§ Reconcile in `prefab-structural-overrides.md`), where a reload keeps it in the orphan row. | Numbering: `planPrefabRows`, whose plan `serializePrefab` records against the file it writes. The mark: `runtime/core/localIdCounter.ts`, read by every allocator and kept from going down by `commitPrefabWrites` (§ "The localId high-water mark"). A Replace keeps every matched row's number (`replaceNumbering`, #1759). So does a REBUILD of an existing prefab from a fresh tree, Import Model and the 2D skin-rig update (`serializeRebuildOver`, #1782): it matches each node to a row by its hierarchy PATH, the names from the root down, as Unity's model importer keeps identity across a reimport (hub ruling 2026-09-29). Two same-named nodes under different parents both keep their rows, and a path two nodes share mints. A Replace matches by bare name instead (U22). Then `tagEntityTreeAsInstance` reads its numbering from that file, which `planMatchesFile` checks row by row. **Translation: `runtime/loaders/memberTranslation.ts` (#1771)**, with `docRows`, `resolveMemberChain` and `translateLocalIds`. The callers are `foldMemberRowChannels` on load, R2's `rowBackedTest` (a member-row key is chained frame by frame, #1766), the rebuild's outer carry and each nested capture's re-apply (#1767), and `toLocalIdKeys` for Apply's keys. | Four readers still spell the chain walk themselves; each chains through the frame's current document, so it is duplication, not a defect: `templateFrameKeys` (`loadSceneFile.ts`), the member-path rewrite in `memberPaths.ts`, `byRowDepth` (`prefabEdit.ts`) and the member-row size check in `sceneValidation.ts`. |
| I5 | Only a write mints identity (a `nodeGuid`, a template `key`), and it carries the existing identity wherever a real correspondence exists. A reader never mints. | `nodeGuidsFor`, the one matcher (#1691): a prefab-edit save's preserved rows, then the live `nodeGuid`, then, on a Replace only, the one old row sharing a node's name (U22). Also `addedNodeIdentity`, whose `readOnly` mode never mints. | None known. Fixed at the owner: the prefab-edit save now remembers where each session-added member was written (#1662); Create Prefab's Replace serializes against the kept id (#1686); Apply's promotion carries the promoted guids (#1660, `carryPromotedGuids`). |
| I6 | Which frame an entity belongs to, what a frame holds, and where a member sits are decided by IDENTITY, never by the live tree. Delete, promotion, a move, Detach and the save's partition all act on the identity subtree. | `worldIdentityParents` (`ownerOf`, `parentOf`, `moved`, and `frameOf`: the frame an entity is a row of), `identitySubtree` (#1691, both in `identityParents.ts`), `memberRowsIn`, `instanceRowDomain` (the row claims, a partition), `rebuildTeardown`, `endFrames`, `planMoveUnlinks`. Apply's promotion delete, Detach, the save's partition and the scene-move refusal ask them (#1682, #1687). So does a copy: each copied node keeps its link only while the frame it is a row of is in the copy, an owned root whose owner is not (or not CONFIRMED: its owner link, when it has one, must name a copied node, and the owner's document must hold the row that expanded it) becomes an independent instance, and a member whose frame is not becomes a plain added node (`planCopyGuids`' `CopyLink`, applied by `copySnapshot` and the device `duplicate-entity` op, #1756). | `templateReferenceNode` climbs live parents, on purpose, for speed. A user Delete takes the LIVE subtree on purpose: it removes what is shown under the node (Unity's hierarchy delete), and `endFrames` unlinks a member moved out. Duplicate and paste copy the live subtree for the same reason, so a member dragged out of a copied instance is not copied (the copy saves it as removed); which of the copied nodes stay linked is decided by identity (#1756). "The members of frame R" is read as a raw `rootInstanceId` scan at several sites; for a member that field IS identity (stamped at expansion), so those are not bypasses. |
| I7 | A member's guid is the member row's pin, else the template's, else derived from its anchor through identity parents. Every place that predicts one derives it the same way. | `deriveInstanceMemberGuids` (after `applyStoredMemberRows`) walks up, over `deriveMemberGuid` and `entityStep`. `memberPathIndex` (`runtime/core/ecs/memberHome.ts`) walks the identity tree down, and `stampDerivedMemberGuids`, `promoteOwnedRoots`, `storedMemberGuids` and the loader's move drain share it. Create Prefab's stamp renames through `reloadDerivedGuids`, the loader's coverage walked down: it also continues into a KEYED stored root, a template reference node the reload derives (#1758). `promoteOwnedRoots` deliberately stops there, because such a node under a promoted root is saved with its guid (measured, #1758). **A pin is followed by one sequence**, `deriveMemberGuidsAfterPins` (derive, `dropCollidingPins`, then settle tokens and moves), which the load and every rebuild call (#1761, #1777). | Four sites predict guids with a walk of their own. The derivation's docblock names two: `derivedMemberPaths` (built on `memberPathRecords`, `runtime/loaders/memberPaths.ts`), and `planCopyGuids`, which since #1756 takes frame membership from the resolver's `frameOf` and duplicates only the walk loop. The other two are `liveMemberGuidRemap` and the prefab-edit world's `editGuidAt`. |
| I8 | A template holds no identity of one instance: no guids, no member rows or moves, and a ref from one member to another is written as a member token. | `serializePrefab` with `templateTokenizer` and `assertNoRuntimeGuids`; `toTemplateNodes` for a promotion; `templateValueWriter` (`prefabTemplateValue.ts`, #1659) for every value Apply writes. | None known in Apply. `serializePrefab`'s `templateTokenizer` and prefab edit's `editWorldRefs` are further copies of the idea for other carriers. |

#### Change propagation

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I9 | The caches hold the current template for everything that reads them. A synchronous reader never runs over a cold cache: a miss there reads as "not a prefab". A prefab write is one step: once it lands, both caches hold the written bytes under every key they use, and every live frame expanded from the old document is rebuilt or refused. | Warming: `installEditorPrefabCacheWarm` (before a scene swap) and `instantiatePrefabInstance`, with `preloadNestedPrefabs` / `preloadNestedPrefabsForSubtree` at the call sites. **The write step: `commitPrefabWrite(source, doc, { expected })`** (`editor/scene/prefabCommit.ts`, #1692). It is the only function that changes a `.prefab.json`. Once the write lands it seats the editor cache under the guid, the path and the caller's ref, and the runtime cache under the resolved path. Then it runs the caller's own `rebuild` (Apply's refresh, Create Prefab's tag), then `rebaseStaleInstances({ sources })` for every other frame of the source. Every writer goes through it: Apply and its undo, the prefab-edit save, Create Prefab (Replace and its undo), the agent `create`, the skin rig and its undo, the model regenerate, and the Assets model import and its undo. **Several files are one step too** (`commitPrefabWrites`, for an Apply that writes an inner prefab and its enclosing one, #1693/U13). Every file's precondition is checked before any is written. Each file is then written only over the bytes checked. A miss part-way puts back what was already written, and names the file that missed (`failed`) and any file it could not put back (`stranded`); both refusals word themselves from those (#1732, § Undoing an Apply). Then both caches for each file, one rebuild and one rebase. | No writer. **An outside edit** reaches the editor as a watcher event: the hot reload evicts the runtime cache, refreshes the editor cache (except the prefab open in prefab edit, `refreshPrefabSourceForPath`), reloads, then rebases; leaving prefab edit refreshes that one and rebases (`repairLeftPrefabEdit`, #1666). ⚠️ The commit seats the open prefab's entry too: a first version skipped it so the edit's save kept its baseline, and its own rebase then put the instances an Apply had just refreshed back onto the old document (close-out review). The edit session keeps its OWN baseline (`editBaselineFor`, § Prefab edit mode). **A server route's own rewrite or move** is marked as the editor's own, so no watcher event runs: the client adopts it instead (§ "A server-side prefab rewrite or move brings the client along", #1751). **A delete** (the Assets panel, the agent's `/api/delete-asset` through its renderer repair, every undo that trashes) is marked as the editor's own too, and evicts the EDITOR cache in the one repair every door runs, `applyAssetPathMoves`' delete branch (`evictDeletedEditorPrefabs`, #1805). A file or a whole folder is evicted: the path key, a guid key the manifest still maps there, and the guid of a document held under one of those. Before it, the editor cache kept answering after the trash while a world swap's re-fetch 404'd in the loader's, and an instantiate expanded a prefab that no longer existed. Live instances stay EXPANDED: that is #1738's evicted state, where every writer captures from the frame record (I18), so a save writes what the reload's Missing Prefab placeholder reads back. **The loader's entry is evicted in the same branch** (`evictDeletedPrefabs`, #1834), by path and every key under a deleted folder, keeping the scene's ownership. It was held back until #1819 landed: evicted, every reload after a trash gives placeholders, and an undo run against a placeholder was #1819's open class (the #1789 fuzzer's seeds 1 and 8); that undo now REFUSES by ruling R (`require`). It was built and backed out once more (hub ruling (B), 2026-09-29), on a diagnosis that the Apply's in-place rebuild dropped a trashed NESTED prefab's live members (hunt seed 6191). Traced, that seed was ruling R inside one fuzzer `undo` op (the Apply's undo reloads, the next undo in the op refuses) judged before its taint, a harness gap; but the in-place drop was real too (37 rebuilds in a 300-seed hunt tore down a nested frame they could not re-expand, invisible to the fuzzer because the save writes the frame's record either way). So an in-place rebuild now KEEPS such a nested frame (#1862, § Unity parity U9b), and the eviction went back in. Before it, a reload of the SAME scene (which acquires before it releases) re-expanded the deleted prefab from the stale entry, where a cold start shows the placeholder. **An undo or redo that puts the file back re-announces it** (`reannounceRestoredFiles`, `editor/panels/assetRestore.ts`, #1844): one rescan whose reply is loaded as the manifest, then `refetchOwnedPrefab` for each restored prefab a scene owns, which first forgets a 404 a reload in between remembered, then an in-place re-expansion of every live frame that recorded the restored prefab's row as unexpanded (`reexpandRestoredRows`, #1864). The EDITOR side does not come back from the loader either: the delete tombstones what it evicted, plus every guid the manifest maps into the deleted range (`editorPrefabDeleted`), and a swap's warm (`warmEditorPrefabCacheFor`) reads a tombstoned key from disk instead of seeding it from the loader. That read is a 404 while the file is gone, and the document once an undo restores it (or, where the manifest still maps the guid to the path and a new file took it, that file's, as the loader gave before); seating a document under the guid clears its tombstone. Before the tombstone, the first reload after a delete put the deleted prefab back in the editor cache (close-out review). **The pruned-manifest window is closed** (#1834, found through #1866): the dev editor's pruning manifest load (`createEditor.tsx`, Vite's `asset-manifest-updated`, which the delete's inline rescan broadcasts BEFORE the renderer repair runs) used to leave nothing to trace a prefab held under its guid alone to the deleted path, so the trashed document stayed readable under its guid. The prune now remembers each pruned guid's last path (`lastKnownPathOf`, `assetManifest.ts`), and the repair resolves a guid key through it. A packaged editor's IPC update is additive, so the guid still mapped there anyway. **Only a prefab DOCUMENT enters either cache** (`isPrefabDocument`, an object whose `entities` is an array of rows, #1813): it is asked by the loader's fetch, `replaceCachedPrefab`, the editor's fetch, and the editor cache's one seat `seatEditorEntry`. A file without that shape reads as a prefab that did not load (I18's placeholder), never as an empty document, which would expand to no root (#1768). The ~53 `.entities` readers then assume the shape. |
| I10 | A write over content the caller did not read is conditional, and a write that does not land changes nothing. A read that began before a write cannot put the older bytes back. | `commitPrefabWrite`'s `expected`, required on every write (#1692). It is one of three things. A document the caller READ is matched by the editor's serialization of it, and when that is refused, by the file re-read and parsed as every reader parses it, then written with `ifMatch` on those bytes; so a hand-formatted, CRLF or BOM file still counts as the document read. Raw bytes are matched as they are. `null` means nothing may be there (`createOnly`). A trash carries `ifMatch` on `/api/delete-asset` (#1679). The Apply undo's SCENE half saves only over what the editor itself last wrote to that file (`saveScene({ ifMatch })` over `lastWrittenSceneBytes`, #1695). `getPrefabSource` carries the runtime cache's revision token across its fetch (#1669), and so does every other read-side seed: a placement and the prefab edit-open refuse when a write landed since their read (`capturePrefabRead`, #1752, § A read-side seed carries its read's token). The runtime cache refuses a stale in-flight fetch (#863). | One deliberate unconditional write: the prefab-edit save's **Overwrite**, after the conflict was shown to the human (or an agent's explicit `overwrite:true`). |
| I11 | An operation that awaits between its steps lands whole, in the world it began in. | `beginWorldSwitch` / `prepareWorldSwitch`, which wait for what holds the world: an undo step (#1579), and a world-bound operation (`beginWorldBoundOperation`, #1667). The forward Apply holds it from its first line to its undo entry and refuses to start during a switch. Every `commitPrefabWrite` holds it from its write to its rebase. Nothing reachable from a write's rebuild may start a switch, or the two would wait on each other (`prefabCommit.test.ts` counts it). | A world swap that bypasses `beginWorldSwitch` (a hot reload) is read from #1698's adoption record instead. A write starts only once `adoptionsSettled()`, as does the forward Apply. After the write, a route mid-adoption (`pendingAdoptions()`) or a replaced world means it seats the caches and rebuilds nothing, since the new world's load builds from them. |

#### The rest of the model

| # | Rule | Owner |
|---|---|---|
| I12 | A runtime-generated (`Transient`) subtree is never authoring input. | `collectTransientSubtreeIds` / `filterAuthoringVisible` (`editor/scene/authoringScope.ts`); `authoringEntitiesFor` for Create Prefab. See § "Authoring scope — a runtime instance is not authoring input". |
| I13 | Only an authored world (stopped, with nothing posed) is captured or written. | `whyWorldNotAuthored` (`editor/scene/authoredWorld.ts`). |
| I14 | An entity is saved into exactly one scene file, the one its `sourceScene` names, and a rebuild keeps that. | `serializeScene`'s scene filter, `planReparent`, and `rebuildInstance`, which carries the stamp. |
| I15 | A template's `version` is the writer's constant, and a build never overwrites a file written in a newer format. | `PREFAB_FORMAT_VERSION`, `engine/plugins/prefabWriteGuard.ts`, `classifyExistingDocumentId`, which reads a prefab before answering `known` even when the manifest indexes it (#1678, `docs/format-versioning.md`). |
| I16 | A template never contains itself. | The prefab-edit refusal at every gesture (`prefabEditRefusal.ts`, § Prefab edit mode); `wouldCreateCycle` / `expandedPrefabRefs` (member rows included) over the WHOLE document, when writing: in `serializePrefab`, and again at `commitPrefabWrites`, the one door every editor prefab write passes (Apply's plan included), reading the batch's own documents first, then the editor cache, then the document the live world last EXPANDED each prefab from (`prefabNestingReader`, #1866): a prefab trashed mid-session is in no cache (#1805, #1834), and read as nesting nothing, an Apply promoting a live instance of trashed P into Q (which P nests) wrote Q → P → Q, which surfaced as "P nests itself" once P was restored (hunt seed 6031; with the manifest pruned the plan's own check had caught it only through a stale guid key, the window I9 records as closed); the expansion's ancestor stack, carried through reference nodes, when loading (#1817). A file that already contains itself loads with its self-referencing node refused and named (`[loadSceneFile] cycle: prefab "…" contains itself …`), not a stack overflow (both twins tested). The write check refuses to save such a document, so its repair is deleting the self-reference in prefab edit and saving. |
| I17 | An editor write that changes an instance member's field leaves its override mark in the state the save needs, and its undo puts the mark back. | `editor/undo/overrideMarkWrites.ts`. See § "Editor writes and the override mark". |
| I18 | A reference the load cannot expand is written back as the file held it, until an expansion replaces it. A reader never drops what it could not interpret. | The `UnresolvedPrefabRef` marker on the placeholder (`runtime/core/unresolvedPrefabRef.ts`) and its writers (`runtime/loaders/unresolvedPrefabRefs.ts`); a live frame whose document stopped resolving, its frame record (`captureDoc`); a template row a frame could not expand, the frame record's `unexpanded` list (#1812), so the row is not saved as removed once the cache holds its child; a legacy path-keyed channel no live frame reaches, R2's kept store (`keptOrphanRows.ts`). See § "A missing prefab keeps its record". |
| I22 | A prefab reference is its DOCUMENT's guid. A path becomes a guid once, at the entry that received it (a drag payload, an agent's `{path}`, the Assets panel), spelled as the disk spells it; a reader that holds the document or a guid never re-derives identity from a path through the renderer's manifest, and nothing writes a path into `PrefabInstance.source`. | `setPrefabSource(root, doc)` (`prefab.ts`) for every expansion's tag: the document's guid, or the guid ref a nested expansion reached an id-less document by, and never a path; a document with no guid is refused loudly (#1828). `instanceSourceRef` (document first) for the Create Prefab tag and untag (#1807). The route (`rebuildManifestInline` before `applyMovesInRenderer`) keeps the renderer's manifest current across a move. Tests: `prefabSourceWriter.test.ts`. |

#### Undo across worlds

The #1789 design studies proposed these three rules (§ "Undo replayed in a later world"), and #1819/#1827/#1793/#1818 built their owners on the owner's ruling R (2026-09-29: refuse, and drop the step).

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| I19 | An undo or redo step re-finds every entity it recorded, meaning its target and the parent it restores under, by the guid taken while the entity was alive ([engine-concepts.md](./engine-concepts.md) § Entity, #1222). It never substitutes a raw ECS id, the scene root or any other entity. When a ref the step NEEDS no longer resolves, the step refuses as a whole, before it changes anything (`UndoRefusedError`), and `runStep` drops its entry (#310). It is never a silent no-op reported as done. A ref whose miss the step has shown to be harmless stays tolerant: Create Prefab's prior links for a held nested instance, whose guid a reload re-mints (#1272, "an unresolved ref is not a lost link" in `reattachPrefabInstance`). An entity with no guid is re-found by its raw id only in the World it was recorded in. | `require` on the entity ref (`editor/undo/entityRef.ts`): `ref.require(expect?)`, `requireWith`, `requireAll`. A step asks it for every ref it needs before its first write; the toast names the entity ("is no longer in the scene"). `resolve` stays for readers that may drop a miss (selection, `cutSourceId`, `sceneDropTarget`, #1272's prior links). A delete's undo also asks `requireRootLinks` about each instance root its members link back to, and Detach's undo `requireDetachedLinks`. `reattachPrefabInstance` no longer keeps a raw `rootInstanceId` for a root that misses. | Asked by the field-write family, add/remove, create/subtree/duplicate/paste, both deletes, reparent, the scene move, Revert, Detach, the sibling renumber (`makeSortOrderRenumberAction`), the gizmo/collider-point/UI-handle drags, the Hierarchy drop (`placePrefabFromPath`, parent by guid, resolved inside `instantiatePrefabInstance` after its awaits) and the agent `prefab instantiate`/`prefab create`, and Create Prefab's human undo (#1795's second route; since the first route's ruling it writes no file at all, and also refuses a tree rebuilt from a changed document, `createdFrameRebuiltRefusal`). |
| I20 | An undo step also acts only on the same KIND of thing it recorded. A guid names one identity across worlds, but a world swap can turn that identity into another kind of thing: an instance root into a Missing Prefab placeholder (I18), a member into a row of a placeholder's kept record (no entity at all), or a placeholder back into an instance once its prefab returns. A step whose meaning depends on the kind refuses when the kind has changed. **The kind a step expects is the one its own forward step LEFT the entity in** (and a redo expects the kind from before it), not the kind the ref saw when it was taken. | `require`'s kind check: every ref records whether its entity was a placeholder (`EntityRef.kind`), and `require` refuses a change ("is a Missing Prefab now … restore the prefab and reload the scene"). That capture kind IS what the forward step leaves, since no editor step turns an entity into a placeholder or back; only a world swap does. A step with a finer expectation passes `expect.check`: Revert's undo needs an instance root of its source, Create Prefab's (agent) undo an instance root (`isInstanceRootCheck`), Detach's undo a still-plain tree, a delete's relink an instance root. | Create Prefab's human undo (#1795's second route). |
| I21 | A placeholder takes only the edits its writer saves. The save writes a placeholder as its kept record plus the live name, guid, parent, folder and, in the ENTRY shape, `sortOrder` and `isActive` (`asSceneEntry`'s `placement` and `order`; `asAddedNode` for a node). Where the entry states either as a ROOT OVERRIDE (`overrides[<its PrefabInstance.localId>].EntityAttributes`, which is where a live instance's save puts a reordered or deactivated root), the placeholder LOADS with that value (`keepUnresolvedEntry`) and the save writes a changed one back INTO the override, never into the traits beside it, where the override would win again once the prefab re-expanded (#1850: the placeholder loaded at sortOrder 0, and `orderEntitiesForSave` moved it among its siblings on every save→reload→save). Every other edit is refused where it is made. | The placeholder gate, `placeholderWriteRefusal` (`editor/undo/placeholderGate.ts`): it lets through `name` plus `PLACEHOLDER_PLACEMENT_FIELDS` (`runtime/loaders/unresolvedPrefabRefs.ts`, the list the writers share), and refuses the rest with a reason. Asked by `writeTraitFieldWithUndo` and its three multi-entity twins (a selection holding a placeholder refuses as a whole), `addTraitToEntitiesWithUndo`, `removeTraitFromEntitiesWithUndo`, and the agents' trait writer (`writeTraitAsEditor`, which apply-scene-ops' setTrait and the editor's set-traits share since #1816, with set-traits asking every target first in `editorTraitWriter.refusal`) and removeTrait. | **A placeholder saved as an added NODE (one inside an instance) keeps no `sortOrder` or `isActive`** (owner ruling, 2026-09-29): a reference node keeps its root's order and flag as an override on the prefab's ROOT ROW, which the placeholder cannot name without its prefab, and a value carried in the node's own traits would hold only until the prefab returned. So the gate refuses both there; the Hierarchy renumber numbers the other siblings around it (`renumberAround`; when two such placeholders tie with a sibling to place between them, the drop is refused, named). A placeholder moved INTO an instance takes `sortOrder` 0, where the load spawns a node placeholder (`spawnUnresolvedReference` sets none), so the editor shows the order the reload will. A top-level placeholder keeps its entry's root traits (a Transform, a UI trait), so the gizmo, collider-point and UI-handle drags, which write live while they run, ask the gate at their commit (`placeholderGestureRefusal`) and put the values back when it refuses. |

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
| #1665 | I3: Revert's undo rebuilt from the document the Revert read | OWNER: the undo is carried onto the CURRENT document (`rebuildInstanceFromCapture`), and it refuses only a stale nested frame. So one entity-side refusal already exists. |
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
  - `instantiatePrefab` refuses a raw parent id no live entity holds at ENTRY, before anything spawns. The second pass
    alone could not catch #1793's thrown redo: its dead id was recycled by the call's own first-pass spawn, so it read
    as live there. The second pass also refuses a parent that is no longer the entity the call was handed
    (`captureEntityIdentity`), and deletes what the call spawned first.
  - `subtreePaths` refuses a revisit, naming the entity, so a parent cycle is not a stack overflow.
  - Both are unreachable by any current gesture; `engine/tests/editor/instantiateStaleParent.test.ts` builds each bad
    input directly (a destroyed id, an id recycled mid-spawn, a cycle).

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
  such placeholders tie with a sibling to place between them).
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
  `rebuildInstance` (Revert, Refresh, and the Apply and Revert undo rebuilds). **Missing owner.**
- **M2 — the renderer's manifest follows a move before the renderer's own repair runs.** The owner is the route. The real
  `/api/move-file` and `/api/delete-asset` rebuild the manifest INLINE (`rebuildManifestInline` → the host's
  `rebuildManifest`, which pushes it: Vite's ws `asset-manifest-updated`, Electron's `modoki:bridge-manifest-updated`),
  THEN call `applyMovesInRenderer` on the same channel (Vite's `requestBrowser` shares the ws), and both land before the
  HTTP reply. The 150 ms debounced push is only the watcher's second rebuild. **It holds**, with one real window: an inline
  rebuild that throws (`manifestRebuilt: false` in the reply), after which only the debounced push follows.
  ✅ **A route the study missed (#1844): a file an undo or redo PUTS BACK** goes through `/api/write-file`, which rebuilds
  nothing, after the delete had pruned its guid. The owner is `reannounceRestoredFiles` (`editor/panels/assetRestore.ts`),
  called by the two sites that re-create a trashed file there: the delete's undo (`makeDeleteUndo`, its own-sidecar
  overwrite included) and the import's redo (`makeFileImportUndo`). Every other re-create goes through `commitPrefabWrite`,
  which registers the guid itself, and every Replace/Apply undo writes under `ifMatch`, so an absent file refuses. It
  POSTs `/api/rescan-assets` ONCE per step and loads the REPLY, rather than rebuilding inline in `/api/write-file`: M2
  holds for the routes above because their push and their later `applyMovesInRenderer` relay share one ordered channel,
  and a restore has no later relay, so the push would race the HTTP reply the step awaits. The reply is loaded
  ADDITIVELY: a restore only adds files, and a pruning load would be a second prune authority (packaged Electron has
  none) able to drop the guid of a file a concurrent route wrote after the scan was taken (close-out review). ⚠️ **Do not
  make it prune:** the host's push stays the single prune authority (hub ruling, 2026-09-29). ⚠️ **It refuses nothing
  itself, and must not** (hub ruling, 2026-09-29: never half-apply, never lose the user's step): the undo manager's gate refuses the states where a restore would matter (Play, a landing
  scene switch, Stop's restore) BEFORE it pops the entry: a subset of `whyWorldNotAuthored`, enough for a step that
  serializes nothing, and not to be leaned on by one that does. A first version threw from inside the step, which DROPS the entry, and the gate
  deliberately lets a step through where a file restore is safe (an entry pushed in the current preview session), so the
  delete's undo was lost there (close-out review, reproduced through `undoStep`). Tests: `restoreReannounce.test.ts`
  pins the reply-over-push load, the additive load and both gate cases; the fuzzer's REGRESSIONS #1844 (hunt seed 118)
  proves only that the step rescans, since the fuzzer's in-process push is synchronous.
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
- **The comment** at `prefab.ts`'s `setPrefabSource` said a raw path makes `getPrefabSource` hit `resolveRef`'s hard
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
  its undos may refuse and drop by design. A same-world op that makes one (a duplicate, a delete's undo) does not taint. The walk to the ends then skips its identity checks there; the per-step I6/I7 checks
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

The test's header lists what it cannot see (no concurrency, a simulated watcher, one scene, no Play). Read it before
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
- **`MODOKI_PREFAB_FUZZ_DUMP=<dir>`** writes every compared state while a replay runs.
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
- `renameCollision`: a Rename's undo or redo found its destination held by a document a Create Prefab wrote. Since the
  create's undo leaves its file (#1795), a prefab created at the name a rename freed still holds that path; the rename's
  step REFUSES, naming the taken path, moves nothing and is dropped (`destinationTakenRefusal`; hunt seed 6029). A
  collision with any other file is not this cause.

A watcher raise with any other cause FAILS the step, as `unexpected outside write`. Planting #1840 back (the router marking
by absolute path) turns every verify seed red that way on macOS, which a self-test pins. Every run counts the ops that
tainted, by cause, and the checks each taint turned off: the verify test prints one line, and a hunt prints both tallies
after its coverage. **Compare those counts between platforms.** A platform whose taints or skips run far above
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

**KNOWN_OPEN** (`prefabFuzz/knownOpen.ts`) is how verify stays green while a found bug is open.
- Each entry names its issue.
- It either stops a seed at that bug, with a predicate on the check AND the op shape that reaches it, or tolerates it with a
  named normalization.
- It carries a repro that a self-test must still see fail. Fixing the bug turns that self-test red, which removes the entry.
- A predicate sees only the ops before the failure, and keys on what the failure SHOWS (the I7 detail says whether the
  holders are rows of one frame; an identity failure says whether an entity was lost or changed guid), not on the op
  list alone. Op-list predicates claimed a fixed bug's regression in every verify seed. Two later reviews each planted
  an undo/redo regression that such a predicate swallowed with the whole file green. So the routes that key on an
  entity (#1793, #1794, #1796's re-tag, #1820's paste, #1826, #1830) also ask whether it is the one their mechanism's op
  touched. The runner records the guids each drop, paste, detach and Create Prefab introduced or covered, and hands
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

**Re-finds (a known fixed bug put back, measured 2026-09-29).** The generator's weights were NOT tuned against these.
Four generator changes came from reading the coverage tally. Three of them were not made for any re-find. The fourth,
the directed move-then-Apply branch, was added precisely so that #1751 F1's route is reached, so that re-find is by
construction. The four: Remove Component draws only from
entities that have a component (it was a no-op 97% of the time); reparent has a same-frame branch; an outside edit's
merged row numbers at or above the file's mark; and 20% of Applies first move a frame member under another member (the
only way `/api/prefab-member-paths` is called, 0 calls in 400 seeds before it). A re-find counts only if its seed passes
on the unmutated tree and its minimized repro does too.

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
[S6] = `…/6000.0/Documentation/ScriptReference/`, [CS] = Unity's editor C# source,
`github.com/Unity-Technologies/UnityCsReference` (master), cited where the Manual and the Scripting API say nothing.

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
| U9b | A prefab goes missing while its instances are live, and comes back | An instance merged before its asset was deleted keeps its objects: `MergeStatus.MergedAsMissingWithSceneBackup`, "Prefab source was missing, but Prefab data was found in the scene file - no merging was done"; such an instance "can be correctly restored only if CorrespondingObjects info is available", which it is "when a PrefabInstance with missing asset was merged before deleting the asset (kNormalMerge) or when it has a scene backup". [CS `Editor/Mono/Prefabs/PrefabUtility.cs`] Unity reconnects it when an asset with its GUID returns: INFERRED from the same comment and from instances naming their asset by GUID, not quoted from a document. | A live frame stays expanded (#1738's evicted state), a NESTED one too across every in-place rebuild (#1862): the teardown keeps a nested frame whose prefab the respawn cannot expand, and puts it back where it hung (`rebuildTeardown`'s kept set, `seatKeptFrames`); for a scene-added reference node it also skips the node's placeholder respawn from the structure (`withoutKeptNodes`). A Revert of the kept frame itself refuses, naming the prefab: there is no base to revert to (`revertRefusal`). A restore re-expands, in place, every frame that recorded the prefab's row as unexpanded (#1864, `reexpandRestoredRows`, run by the restore owner `reannounceRestoredFiles`). § "A missing prefab keeps its record". | match while live. **missing** across a reload: a nested frame of a prefab that is still missing reloads as an unexpanded row (#1790 ruling D) with its record kept, not its entities; Unity keeps a scene backup of them (#1867, a persisted-schema change for the owner's serialization gate). |

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
| U17 | Unpack Completely | Repeats until only plain GameObjects remain. Undoable. Acts on an instance root: `UnpackPrefabInstance` throws on a non-root, and the Hierarchy greys Unpack on one. [M6 `UnpackingPrefabInstances`, S6 `PrefabUtility.UnpackPrefabInstance`] | "Detach Prefab" (Hierarchy menu, agent `detach`): `detachPrefabInstance` strips `PrefabInstance` from the frame and every nested frame, bakes the values, and is undoable (`detachPrefabInstanceWithUndo`). A MEMBER is refused on both surfaces, naming its root (#1764, hub ruling on the owner's Unity rule): `detachRefusal` is the one predicate. The agent refuses with its text, the Hierarchy's row is greyed with it as hover text, and the shared wrapper refuses a member itself. Before, the Hierarchy quietly detached the root, and the agent unpacked only the member and answered ok. | match |
| U18 | Prefab Mode, isolation | The scene is hidden and the prefab is edited alone. [M6 `EditingInPrefabMode`] | Double-click opens it alone (`openPrefabForEditing`). § "Prefab edit mode". | match |
| U19 | Prefab Mode, in context | The scene stays visible but locked, shown gray, normal or hidden. It is the default for Open from the Inspector. [M6 `EditingInPrefabMode`] | None. | **missing**, L |
| U20 | Opening and nesting Prefab Mode | Open button / P key on an instance; opening a nested prefab stacks a breadcrumb. [M22 `EditingInPrefabMode`] | Only from the Assets panel. `editingPrefab` holds one prefab, and the breadcrumb is always `scene › prefab`. The Inspector's source link only selects the asset. | **missing**: Open S, the stack M |
| U21 | Saving in Prefab Mode | Auto Save is on by default and can be turned off. With it off, Unity asks on exit. [M22 `EditingInPrefabMode`] | Cmd+S only. Leaving asks through the unsaved-work modal. Entering, by contrast, saves the open SCENE without asking (`openPrefabForEditing`), which Unity does not do. That silent save is one way #1699 is reached. It is skipped when the caller asked to discard the scene's edits (the agent's `discardUnsaved`), and when a newer scene request superseded the open while it waited (#1745). | **diverges**, mild: Modoki behaves like Unity with Auto Save off. The owner rules on it (S if wanted). |
| U22 | Replace an existing prefab asset with a scene object | Asks first. "Unity tries to preserve references to the prefab and the individual parts… it matches the names of GameObjects." [M6 `CreatingPrefabs`] | Asks first (`confirmReplaceAsset`) and keeps the file guid. Each row keeps its `nodeGuid` where the replacing tree holds a member of the prefab it replaces, then by Unity's name rule; a name two nodes share, on either side, mints rather than guesses (#1686, `nodeGuidsFor`). A matched row keeps its `localId` too, and a new row is numbered above the old document's max: Unity's fileIDs are never reused (#1759, `replaceNumbering`; a pre-v5 document with no `nodeGuid` keeps positional numbering). Every other instance is rebuilt from the new document (`commitPrefabWrite`, #1685 fixed by #1692). | match (Modoki refuses Unity's "unpredictable" duplicate-name match) |
| U23 | Replace the asset of an instance | Swap which prefab an instance uses, from the Inspector's Prefab field or Hierarchy › Prefab › Replace, with "Replace and Keep Overrides" or "Replace and discard any overrides". Objects are matched by name or by hierarchy path (`ObjectMatchMode`). By default no property override is deleted; `PrefabReplacingSettings.prefabOverridesOptions` can clear them. [M6 `CreatingPrefabs`, S6 `PrefabUtility.ReplacePrefabAssetOfPrefabInstance`, `PrefabReplacingSettings`] | None. `PrefabInstance.source` is write-refused on every generic edit path (`traitEditPolicy`). | **missing**, L. The U22 matcher (`nodeGuidsFor`) covers `ByName`; `ByHierarchy` would be a second key on it. |
| U24 | Create a prefab from a plain object | Makes an original prefab, and the object becomes its instance. Child instances become nested. Their modifications go into the new asset, unused overrides included. An instance whose asset is missing is refused only when Unity has nothing to restore it from — "Can't save Prefab instance with missing asset and scene backup as a Prefab. You may unpack the instance and save the unpacked GameObjects as a Prefab." — that is, one neither merged before its asset was deleted nor holding a scene backup; one merged before the delete is saved. [S6 `PrefabUtility.SaveAsPrefabAssetAndConnect`, M22 `UnusedOverrides`, CS `PrefabUtility.SaveAsPrefabAssetArgumentCheck`. This row said "cannot be saved" without that condition until #1862 read the source.] | The same (`createPrefabFromEntity`, then `tagCreatedPrefab`). Nested instances below the root become reference rows. **Owner ruling D (#1790, relayed by the hub), per case:** (1) a live frame in the tree whose nested prefab could not be expanded (it does not load, or loads to no root) is REFUSED, naming the member and the prefab (`unexpandedNestedRefusal`). That is Unity's condition: a row the frame never expanded has nothing to restore it from. A nested frame KEPT across a rebuild after its prefab went (#1862) is live and off the `unexpanded` list, so it is written as a reference row from its record, as Unity saves an instance merged before its asset was deleted. It is asked after the nested warm, so a merely cold key is not refused. (2) What R2 kept for a swallowed root (an orphan member row, a legacy channel into a row its template lacks: Unity's unused overrides) is BAKED into the new template's row (`bakeKeptState`, through `templateRowOf`, which strips scene identity for #1293). A root that becomes a member of the new instance keeps only the orphan's identity (pinned `guid`, `name`) in the scene, moved to the new root in member-row form (`settleSwallowedKeptState`). A root the new instance's member rows do not name is left whole: a still-stored scene-added reference node, which the scene save writes over the template's node, and every root when the tag linked nothing. A kept LEGACY channel is baked through `toTemplateStructure`, so its nodes lose their guid and a `moved` (a scene guid) is not carried. The refusal is asked after a warm that also reaches every prefab the live documents nest (`preloadNestedPrefabsForSubtree`), so a nested row the scene removed is not refused while its prefab is readable. Create Prefab's undo restores the store. Its untag, and the tag, resolve the prefab by the document's own guid (`instanceSourceRef`, #1807), not by a path through the manifest, which follows a move only at its next push: right after a rename's undo it still named the renamed path, the untag matched nothing, and the tree stayed linked to the trashed prefab. The agent `prefab create` op calls the same two helpers. **Apply's promotion of a scene-added reference node follows the same ruling (#1802):** its recapture runs in the same bake scope (`withKeptStateBake`, one try/finally scope for both writers), so the promoted row carries the node's kept state in template form, and after the refresh the same settle moves the orphans' identity onto the instance's stored root (the node, given its guid back by `carryPromotedGuids`, is now a member of it). Apply's undo reloads the scene from its snapshot, which carries the store. A frame whose record says it could not expand a row (#1812) is refused even when the cache now holds the child. **A frame built from OTHER rows than the cache now holds** (I3, #1815) is refused too, on both callers with one wording (`staleFramesInTreeRefusal`, Apply's and Revert's `framesBuiltFromOtherRows` asked of every instance root in the tree, after the warm): the capture reads the cache first (`captureDoc`), and a row only the old document had came back as a template-added node. Refused rather than rebased, as Apply and Revert do. **Create Prefab from an instance ROOT is an unpack** (#1814, hub ruling under "prefab behaviour copies Unity"): the root's OWN kept state (its old prefab's orphan rows and legacy channels) is dropped, as Unity drops an unpacked instance's unused overrides. This is done in `tagCreatedPrefab` (`dropUnpackedRootKeptState`), after the tag and before the settle, and undo restores it. Two cases keep it: a Replace of the root's own prefab (the instance stays connected, so nothing is unpacked) and a tag that refused. | match |
| U25 | Create a prefab from an instance root | Asks: Original Prefab or Prefab Variant. The API makes a Variant unless the instance is unpacked first. [M22 `PrefabVariants`, S6 `PrefabUtility.SaveAsPrefabAsset`] | Always an original: the root instance is flattened, nested instances stay reference rows, and the live tree is relinked to the new prefab. That is Unity's "Original" branch. | **diverges**: the Variant choice waits on U3. |

### Identity, undo, runtime

| # | Behaviour | Unity | Modoki | Verdict |
|---|---|---|---|---|
| U26 | Object identity inside an instance | Objects in a prefab have fileIDs. A reference into an instance goes through a stripped placeholder: the source fileID plus the `PrefabInstance`. [M6 `yaml-prefab-serialization`] | `nodeGuid` names a template node. A member's guid is pinned on its member row (scene v16), so a scene reference survives a template renumber. § "Identity" (I4–I8). | match by design. Open breaks: #1659, #1680. |
| U27 | Undo | Apply, Revert, Unpack and Replace record undo when run as a user action. Leaving Prefab Mode drops that prefab's undo history. [S6 `InteractionMode`, M22 `EditingInPrefabMode`] | Apply, Revert, Detach and Create Prefab are undoable (`applyToPrefabWithUndo`, `revertOverridesWithUndo`, `detachPrefabInstanceWithUndo`). **Create Prefab's undo unlinks the tree and LEAVES the prefab file on disk**, the Hierarchy's as the agent `create` op's (#1795, hub ruling (i) 2026-09-29, Unity: undo reverts the scene object's connection, never the asset's creation). It used to trash the file, and a scene saved in between (a Cmd+S, an Apply's undo) still named it, so the next reload from disk made the tree a Missing Prefab nobody deleted. A file left behind is an ordinary unused asset. The redo re-links to it and writes nothing while it holds the document (its bytes, or the same document under a raised #1774 mark, which is how #1821's refusal went away), reading it where its guid lives NOW: a Rename since moves it, and another prefab created at the freed name may hold the path this step first wrote (hunt seed 6029); it writes it back, over nothing, only when it was deleted since; and a file changed since (a prefab-edit save, an outside edit) refuses the redo before any change (I10), since the re-tag plans the tree against the rows it wrote. The agent `create` op's redo asks the same file question, and writes nothing in any case: an absent file refuses it. Both undos refuse a tree the file's changed document rebuilt since (a prefab-edit save or an outside edit rebases the instance; unlinking it would keep the change as plain entities), `createdFrameRebuiltRefusal`, since the undo has no file write left to be conditional on. **A Replace is the deliberate difference:** its undo RESTORES the bytes it overwrote (#1264). That loses nothing and keeps the prefab's guid, so no scene can dangle, and the ruling was about a CREATED file. **Leaving prefab edit drops its history** (owner, 2026-09-28, #1704): however the edit world is left (Exit, a scene load, opening another prefab, re-opening the same one from inside it), the adoption owner drops its stack instead of parking it (`sceneAdoption.ts`, S8), so a re-open starts with nothing to undo. It used to be kept, and after an outside write (an Apply, a Replace, a checkout) it replayed onto a changed document: an undone delete came back at a number the Apply had given another row. **One deliberate difference:** an asset-document entry recorded there (material, clip, particle…, `_isFileDirect`) survives, parked under the prefab's key as it is across any discard: it edits another file, and dropping it would strand an asset edit with no undo (#1409). Like every asset-document entry, its undo and redo refuse unless the asset still holds that step's side, so an edit made to that asset elsewhere since is not reverted (#1710, [editor.md](editor.md) § An asset-DOCUMENT undo checks the asset still holds its side). Re-opening the prefab you are already editing also drops the history: that rebuilds the world from disk, which an outside write can have changed during the visit (the hot reload skips the edit world). | match, except the asset-document entries above. |
| U28 | Runtime instantiate | `Object.Instantiate` makes no prefab connection. [S6 `Object.Instantiate`] | `spawnPrefabInstance` stamps `PrefabInstance` on every spawned entity, and nested rows expand at load, not at build. | **diverges**, deliberate: the runtime uses `PrefabInstance` for member guids and frame identity. The owner rules on whether it stays. |
| U29 | Reordering children inside an instance | Not an override since 2022.3. Existing reorder overrides are discarded on upgrade. [M22 `UpgradeGuide2022LTS`] | A reorder is an `EntityAttributes.sortOrder` value override ([prefab-structural-overrides.md](./prefab-structural-overrides.md) § Edge cases). | **diverges**, deliberate: sits beside U7. The owner rules on it. |
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

Server-side rewriters, the member-path repair, duplicate, the GUID heal and the migration scripts all
parse and spread the document, so they carry the mark. None of them mints. `/api/prefab-member-paths` used to
read, wait on the renderer, then write with no precondition, so a commit landing in that window had its content
reverted, mark included. Since #1784 it re-reads each file after the wait and writes only over the text it planned
from; a file that changed is left and returned as `changed` (§ "A server-side prefab rewrite or move brings the
client along").

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
  doc)` then stamps the document's guid on the instance (I22). It is **synchronous**, so
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
  trash overtook is not seated (#1669, the token below). A WRITE is `commitPrefabWrite` (prefabCommit.ts, #1692), never a
  cache set. A write that does not land is a `conflict` or carries a reason in `error` (#1776), the one channel a refusal travels
  in whoever produced it: the route's own (`/api/write-file` refuses a path outside the asset roots with `{error,
  options}`, where it once sent an empty body), else `the request was refused (HTTP <status>)`. The agent `create` refuses
  with it (and the route's `options`), and `createPrefabFromEntity` returns it as `refused`, which both panels toast, as it
  does its other refusals (an unreadable file it would replace, a tree that cannot be serialized); before, all of these
  reached the human as a bare `null` the panels only logged. The cache lets the serialize loop and the
  Inspector read override diffs synchronously. (The runtime resource cache uses
  its own `getCachedPrefab()` in `meshTemplateCache.ts`.)
- **`applyToPrefab` / `applyToPrefabSelective`** — write live overrides back into
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
  The side also carries every frame NESTED in the applied instance (`BaseInstanceSide.nested`, #1741), captured with it
  and handed to the rebuild in place of the live frames. An Apply from the OUTER root of a nested frame's own edit
  (U14) takes that edit out of the frame, so at undo time the live frame shows the other side, and the rebuild's own
  capture read nothing of it: the undo showed O's row value on the dirty base. See § "A rebuild's nested frames".
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
| An added reference node (on the entry, a member row, a plain node's children, another reference node) | `spawnUnresolvedReference`, under the node's parent. The loader's and the editor's `spawnNestedInstance` both call it, so a rebuild (Apply, Revert, Refresh) respawns it — except over a node whose frame is still LIVE (its prefab went mid-session): the rebuild keeps that frame and skips the node's respawn (#1862, `withoutKeptNodes`), so its members survive and no placeholder stands beside it; a Revert of the node's own add removes it. The loader keeps no orphan rows for it: its record holds them, and kept ones outlived its re-expansion and overwrote a later edit. | `captureChild` writes the node (`asAddedNode`). |
| A template's reference row inside a resolved instance | None: the frame is the template's. | The scene's edits to that frame ride member rows. `rowBackedTest` counts a row naming a reference row whose child cannot be read as unbacked, so the orphan store keeps it (the nested root's own row included, which it used to drop) and the save writes it back. Whether the ROW itself is saved as removed is asked of the frame record (`unexpanded`, #1812), not the cache: a frame built while the child was unreadable lists the row, so a cache holding the child later (restored or re-warmed mid-session, or left stale by an Assets delete, #1805) does not turn a row the frame never had into the scene's removal of it. A layer that removes the row takes it off the list (`noteRowsRemoved`, in `applyStructureCore`), so a scene's removal is stated again. |
| A reference row in PREFAB EDIT | The row is a top-level entry of the edit world, so it takes the first path. | `serializePrefabEditWorld` writes the row from the baseline, because the edit world's entry went through `editWorldRefs`. |
| A document that LOADS but expands to no root (#1768): its `rootLocalId` names no row, or a reference row whose prefab cannot be read, or one that nests itself | Where it is a scene entry or an added node: the same placeholder as a document that does not load. One predicate (`expandsToRoot`, `runtime/loaders/prefabRoot.ts`) gates the entry site before `onDeletePlaceholder`, both `spawnNestedInstance` twins, both expansions (which spawn NOTHING rather than a root-less scatter of rows) and `rebuildInstance` (the live instance stays). A template ROW whose child expands to no root has no placeholder, as a missing child has none: both expansions list the row on the frame record as unexpanded, as they do a missing child (`nestedRowPresent` reads that; the document tests read that child as unreadable for a frame with no such record, `rowBackedTest`'s reader and `templateNodeGuids`' unread set, `legacyPathReached`), so its row is not saved as removed, and the scene's edits to its frame are kept (close-out F1). | As the row it replaces; a template row's frame, as the row "A template's reference row inside a resolved instance" above. |
| A LIVE frame whose document stops resolving mid-session (both caches evicted, no reload; #1738) | None: the frame is live. | The writers capture it against its frame record, the document it was expanded from (`captureDoc`, and `serializeScene`'s `levelDoc` fallback); the cache comes first, so a capture that works today writes the bytes it wrote. |
| The same frame NESTED, when an in-place rebuild (Apply's fan-out, Revert, their undos, a rebase) re-expands the frame that owns it (#1862) | None: the frame is KEPT, a template row's (an owned root) and a scene-added reference node's (a stored root under one of ours) alike. The teardown parks every such root whose own prefab the respawn cannot expand (asked of the cache the respawn reads, so a merely cold key is kept too), and `seatKeptFrames` puts it back under its parent member by guid and takes its row off the owner's `unexpanded` list. A kept frame whose row the new document no longer leaves unexpanded (dropped, removed by a layer, or expanded after all) goes, as the teardown would have taken it. | As the row above: from its frame record. The save is byte-for-byte the one the same Apply writes with the prefab present (`missingNestedFrameKeep.test.ts`). A RELOAD while the prefab is still missing gives an unexpanded row (ruling D), not the entities; the prefab's return re-expands it in place (#1864). |

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
placeholder (the human path and the agent `prefab create` op, over the live tree they write), and an Apply that would
promote one. What an `+added` key promotes is the node's IDENTITY subtree (I6), so Apply asks that, not the key's text
(a placeholder under a plain added node is named by no key of its own) and not the live tree (a placeholder under a
member moved into the node stays behind with the member). Apply of anything else on the
instance goes ahead. A rebuild's preload fetches a placeholder's source (`preloadNestedPrefabsForSubtree`), so a
prefab restored on disk re-expands on the next rebuild.

**How a live frame's document stops resolving.** Not by an editor trash: `/api/delete-asset` marks the vanished paths as
the editor's own writes, and nothing evicts either cache, so the deleted prefab stays readable until a reload, and the
reload takes the load path above (the stale entry is #1751's). The caches are emptied only by `seatCaches(key, null)`
(`prefabCommit.ts`), which runs on the undo of an Import Model or a rig prefab (not a Create Prefab's since #1795: it leaves the file). A live instance of that
prefab is reached there only past a dropped throwing undo, `worldLeft()` mid-commit, a carried `Persistent` tree, or a
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

## ⚠️ A server-side prefab rewrite or move brings the client along (#1751)

> **Illustrates I9** (after a write, both caches hold the written bytes) and **I10** (a write is conditional on
> what it read).

A server route that changes a prefab or scene file marks the write as the editor's own (`markEditorWrite`), so the
watcher does not hot-reload the open scene under its live edits. But the watcher event is ALSO what brings the
client up to date. The mark means two things, "don't reload the world" and "the client already holds these bytes",
and the second is true only for bytes the client sent. For a SERVER-computed rewrite or a move, something else has
to take the watcher's place.

A census of every `markEditorWrite` call site found three routes that change bytes or a path behind a prefab or scene
cache:

| Route | What it changes | Who brings the client along |
|---|---|---|
| `/api/prefab-member-paths` (#1437) | the member refs of every OTHER scene and prefab using a prefab whose member paths moved | the route returns `written` (each file's new bytes and `prior`); `repairMemberPathsEverywhere` → `adoptServerPrefabRewrites` (`editor/scene/serverPrefabRewrites.ts`) |
| `/api/move-file` | a prefab's PATH | `applyAssetPathMoves` re-keys both prefab caches (`rekeyCachedPrefab`, `rekeyEditorPrefabCache`) |
| `/api/delete-asset` | a prefab is gone | deliberately nobody: both caches keep the deleted document until a reload, which takes the missing-prefab load path; a writer that does lose it writes from the frame record (#1738, § "A missing prefab keeps its record") |

**The member-path repair, end to end:**
- **The route** asks the renderer which documents an asset view holds unsaved (`dirtyAsset`), and leaves those,
  named in `held`. It does NOT ask `liveScene`: the live world's own files (the open scene, a loaded base, the prefab
  open in prefab edit) are rewritten, because the live world already holds the repair (Apply's remap). Nor
  `pendingBaseScene`: that parks one field, and its flush (`/api/scene-mutate`) re-reads the file, so it lands on the
  repaired bytes. Holding a scene back for it left the scene unrepaired for good (close-out review).
- **Each write is conditional on the text the plan read** (#1784). After the renderer wait, each file is re-read and
  written with no await between them. A file that changed meanwhile is left and returned as `changed`.
- **The route carries the whole parsed document** (`{ ...doc, entities, moved }`), so the localId mark and any field
  no writer knows survive.
- **The client, for a prefab:** both caches through the commit's own `seatCaches`, which REPLACES the runtime entry.
  Not the watcher's `invalidatePrefab`: that evicts, which is #1308's blank for a pooled scroll view of a prefab the
  open scene owns.
- **The client, for the live world's files:** the editor's record moves with the file, but only when it held
  `prior`:
  - `lastWrittenSceneBytes` for the open scene (`adoptRewrittenSceneBytes`). Otherwise Apply undo's scene half is
    refused as an outside change.
  - The prefab-edit baseline (`adoptRewrittenEditBaseline`), only while that edit is open. Otherwise its save is
    refused as "changed on disk" against a file that holds exactly what the edit world shows.
  - A record that said something else stays: that is a real outside change, and the conditional write must still
    refuse over it.
- **The client, for any other rewritten scene:** its undo stack is marked stale (`recordSceneFileChanged`), as the
  watcher would.
- **The repair runs INSIDE the commit's `rebuild` step** (Apply, and Apply's undo), where world switches are held off
  (#1750's rule), so the step is whole by itself. From the editor the forward Apply was already held
  (`applyToPrefabWithUndo` holds it end to end); called unheld (`applyToPrefabSelective` alone), a switch could land
  between the commit and the repair, and the route would rewrite a file whose new world was loaded from the old
  bytes. A world that has left never reaches the step. Apply's undo asks whether its world is still live AFTER the route
  returns (by the same test as its own "still THAT world?" check), and its `worldLeft` tail (a swap that bypassed the
  #1579 barrier) still repairs the files so they follow the prefab on disk. Either way, when no live world holds the
  repair, no record moves and every rewritten scene's stack is marked stale.

**The prefab open in prefab edit is rewritten, not refused** (hub, 2026-09-29). Inside the Apply step its world is
adopted and savable, and it holds the repair. Refusing its file would leave House on disk with dangling tokens if the
edit were then discarded.

**A move MOVES both cache entries.** The runtime cache is keyed by PATH and read synchronously, so once the manifest
mapped the guid to the new path the entry was unreachable: a `UIEntries` pool went blank, and a later write's
`replaceCachedPrefab(newPath)` found no owner and evicted. `rekeyCachedPrefab` moves the entry, the owners and the
content revision to the new path. The moved entry always wins at the new key. The owners move with it, so the scene's
`releaseAllForScene` drops them there. A load of the old path still in flight is refused, and when owners are left with
no entry the file is fetched where it is now. The editor cache moves its path key too, the same way.
- **The order on the route:** the manifest broadcast reaches the renderer BEFORE the move repair, so the re-key's own
  `registerAsset` is only a backstop. For the frames between the two messages the guid already names the new path
  while the entry is still at the old one. That window predates #1751; closing it means sending the repair first.
- ⚠️ **A first version kept the old runtime key** to cover that window, and the kept entry then served stale content
  (close-out review). Renaming back after an edit read the pre-edit document; the revision was carried, so a pool
  never noticed. A swap (A→B, then C→A) read A's document for C. A marked create at the old path is never evicted by
  a watcher `add`, so the stale entry stayed.

Tests:
- `engine/tests/plugins/prefabMemberPathsRoute.test.ts`: the route.
- `engine/tests/editor/serverPrefabRewrites.test.ts`: the real route fed into the real adopt step, one case per
  symptom, the discarded edit included.
- `engine/tests/editor/duplicateCarriesRefs.test.ts`: "the file repair runs inside the commit step".
- `engine/packages/modoki/tests/runtime/prefabCacheMoveRekey.test.ts`: the move.

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
- **Instantiation** (`instantiatePrefab` editor / `instantiatePrefabIntoWorld`
  runtime) recurses on a `prefab` row, expanding the child from cache, applying
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
  3. **The load.** The expansion's ancestor stack reaches reference-node expansion in both twins (`spawnNestedInstance`,
     editor and loader). A node is refused only when its prefab is being expanded ABOVE it **and that prefab's own
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
