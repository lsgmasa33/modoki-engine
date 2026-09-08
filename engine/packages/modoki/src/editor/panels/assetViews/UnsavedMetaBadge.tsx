/** The `Unsaved ● ⌘S` marker for a parked `.meta.json` import-settings edit (#870).
 *
 *  ⚠️ **This is `SceneAssetView.tsx`'s existing marker, not a third convention.** Same text, same
 *  colour (`#e0a06c`), same size, same spacing, same conditional rendering — shown only while
 *  dirty. #870's own "what a fix has to prove" makes matching the siblings the design question,
 *  and there are exactly two conventions to choose between:
 *
 *   - **Inspector asset view** (`SceneAssetView.tsx`) — a conditional `Unsaved ● ⌘S` div with a
 *     `data-ui-id`. This one. The nine surfaces #870 covers are all Inspector asset views.
 *   - **Full-panel asset editor** (`useParkedAssetDoc.ts`'s `saveStatusLabel`, used by
 *     ParticleEditor / TimelineEditor / SkinEditor / SpriteAnimEditor / AnimationToolbar) — a
 *     PERSISTENT two-state span reading `Unsaved ● ⌘S` or `Saved ✓`. Not this one: it belongs to a
 *     panel that owns a whole document and has a status line to keep `Saved ✓` in.
 *
 *  ⚠️ #870's body originally named `AtlasAssetView.tsx:121` as the sibling to copy. It is not one —
 *  that subscription drives a flush-ERROR banner (a 409), not an unsaved marker. Corrected there.
 *
 *  A shared component rather than nine copies of the same four lines, so the convention cannot
 *  drift panel by panel — which is the failure #870 exists to prevent one level up. `SceneAssetView`
 *  is migrated onto it too, so the marker has exactly one definition; leaving its inline copy would
 *  have been two hand-synced sets of the same four values, which is the shadowing-constant shape
 *  CLAUDE.md's single-source-of-truth rule exists to stop.
 *
 *  It deliberately does NOT own the subscription: `useMetaDirty` does, because the batch views ask
 *  about N paths and a component taking a ready-made boolean stays usable for both. */
export function UnsavedMetaBadge({ dirty, dataUiId }: { dirty: boolean; dataUiId: string }) {
  if (!dirty) return null;
  return (
    <div data-ui-id={dataUiId} style={{ color: '#e0a06c', fontSize: '10px', marginTop: 2, marginBottom: 4 }}>
      Unsaved ● ⌘S
    </div>
  );
}
