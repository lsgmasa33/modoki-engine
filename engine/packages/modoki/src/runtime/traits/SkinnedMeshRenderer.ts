import { trait } from 'koota';

/** SkinnedMeshRenderer — one renderable mesh node of a rigged model (Unity's
 *  per-renderer `materials[]`). Lives on a CHILD entity of the `SkinnedModel`
 *  root; the root owns the clone + skeleton + mixer, and this entity configures
 *  the materials + visibility of ONE mesh node within that shared clone (it adds
 *  no THREE objects of its own — the skeleton stays a single shared instance).
 *
 *  - `node` — the GLB mesh-node name (e.g. `Eyes-Alien-Animal`). The render sync
 *    finds every submesh under that node in the root's clone.
 *  - `materials` — per-material-slot overrides: original material NAME → a
 *    `.mat.json` guid. A node reuses a handful of materials across its primitives
 *    (the 148-primitive eyes use just `Eye` + `Red-Eye`), so the slot key is the
 *    material name. A slot left unset keeps the baked GLB material. Populated by
 *    import (rebind-by-default) and editable per-slot in the Inspector.
 *  - `visible` — hide/show this mesh node (all its submeshes) without touching the
 *    rest of the model.
 *
 *  The render sync (`scene3DSync`) owns the live binding; this trait is pure DATA.
 *  Resolved to its rig root via `EntityAttributes.parentId`.
 *
 *  koota note: AoS (callback) form because `materials` is an object — koota
 *  forbids object fields in the plain (SoA) form (see UIAction). The callback runs
 *  per entity, so each gets its OWN fresh map; treat it as immutable (replace,
 *  don't mutate in place). `.schema` is undefined for AoS traits, so serialize/
 *  prefab snapshot fall back to the registered field list. */
export const SkinnedMeshRenderer = trait(() => ({
  node: '' as string,
  materials: {} as Record<string, string>,
  visible: true as boolean,
}));
