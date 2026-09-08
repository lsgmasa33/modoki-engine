/** The banner an asset editor shows when it REFUSED to load a document it could not read (#896).
 *
 *  Presentation only — the decision is `assetDocLoad.classifyAssetDocFetchFailure`, and the
 *  refusal is enforced by the panel simply not putting a document in the store (its editing surface
 *  is gated on that document, so editing is disabled by construction rather than by a flag threaded
 *  through every field). This exists because SIX consumers need the identical banner — the five
 *  asset editors plus `MaterialBatchView` — and six copies of it would go out of sync on the first
 *  wording change.
 *
 *  ⚠️ **An earlier version of this block said `ParticleEditor` keeps its own "deliberately, not by
 *  oversight", because it renders an absolutely-positioned overlay.** That stopped being true when
 *  ParticleEditor adopted this component (#896 review 3) — the `style` override handles the overlay
 *  case, as `SpriteAnimEditor` and `ParticleEditor` both now demonstrate. The stale version was
 *  worse than no note: it told the next person that hand-rolling a copy was the sanctioned choice
 *  for exactly their case.
 *
 *  ⚠️ `AtlasAssetView` genuinely does keep its own, and that half was always true: it distinguishes
 *  a 'failed' state from a 'refused' one with a message, which this component has no shape for. The
 *  thing that must not fork is the DECISION, and that is shared regardless. */

import type { CSSProperties, ReactNode } from 'react';
import { discardDirtyAssets } from '../scene/dirtyAssets';

const wrap: CSSProperties = {
  color: '#e0a06c', fontSize: 11, lineHeight: 1.4, padding: '5px 8px', margin: '6px 8px',
  background: '#3a2e1e', border: '1px solid #5a452a', borderRadius: 4,
  display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0,
};

const retryBtn: CSSProperties = {
  background: '#2a2a40', color: '#cdd', border: '1px solid #444', borderRadius: 3,
  padding: '2px 8px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
};

/** ⚠️ **The caller must render this BEFORE its own "nothing open" / "loading" early return.** A
 *  refusal is precisely the state where the panel holds no document, so every one of those guards
 *  is true — and a banner placed after them can never render. `SkinEditor` and `TimelineEditor`
 *  both shipped it that way for one commit: the human saw "Double-click a .rig2d.json in Assets to
 *  edit" (for the rig they had just double-clicked) and "Loading timeline…" forever, with a console
 *  line as the only signal. Worse, SkinEditor's picker offers a one-click auto-rig that OVERWRITES
 *  the refused file. Refused is its own view, not a decoration on the empty one.
 *
 *  `style` overrides the in-flow default, for a panel that positions it absolutely inside a
 *  `position: relative` viewport (`SpriteAnimEditor`) or needs different margins (`SkinEditor`,
 *  whose root is a column and so takes the block form). */
/** A UNION, not two optional props: with both optional, a caller passing neither type-checked and
 *  rendered "⚠ Could not read undefined". Exactly one of the two is required. */
type RefusedBannerProps = {
  uiId: string;
  onRetry: () => void;
  /** Extra content under the sentence (e.g. a per-file list). */
  details?: ReactNode;
  style?: CSSProperties;
} & (
  /** Composes the standard sentence. */
  | { fileName: string; message?: never }
  /** Overrides it — for a refusal about SEVERAL files at once. */
  | { message: string; fileName?: never }
);

export function AssetLoadRefusedBanner(
  { fileName, message, details, uiId, onRetry, style }: RefusedBannerProps,
) {
  const text = message
    ?? `⚠ Could not read ${fileName} — editing is disabled so it is not overwritten with an empty document.`;
  return (
    <div data-ui-id={uiId} style={style ? { ...wrap, ...style } : wrap}>
      <div style={{ flex: 1 }}>
        <span>{text}</span>
        {details}
      </div>
      <button data-ui-id={`${uiId}.retry`} data-ui-kind="button" data-ui-label="Retry" onClick={onRetry} style={retryBtn}>Retry</button>
    </div>
  );
}

/** The banner an asset editor shows when its load OPENED ON A PARKED EDIT instead of the file
 *  (#902) — and the two exits out of that state.
 *
 *  ## Why this is a defect and not merely a nicety
 *
 *  Every parking editor asks the registry BEFORE it fetches, and that ordering is correct: a parked
 *  write is not on disk, so re-reading the file would show — and re-seed the live cache with — the
 *  PRE-edit document, which is the destruction `pendingAssetDoc`'s docblock, #831/#843 and
 *  QA-CTX-0008 all exist about. The problem is that the diversion was SILENT, and one sequence
 *  turns that into lost work:
 *
 *  1. the file is corrupt or too-new, so the panel REFUSES it and tells the human to repair and Retry;
 *  2. an agent op parks an edit for that path (every agent op parks unconditionally under manual
 *     persistence, and `pushAssetUndo`'s redo re-parks);
 *  3. the human repairs the file on disk and clicks **Retry**;
 *  4. the load takes the park branch, the banner clears, the panel opens — and Cmd+S full-replaces
 *     the repaired file with the parked document.
 *
 *  The human did exactly what the panel told them to and lost the repair.
 *
 *  ## The park still wins. What was missing is the exit.
 *
 *  ⚠️ **This deliberately does NOT re-open the precedence question.** Discarding a park to prefer
 *  the file is the silent destruction the ordering exists to prevent; the answer is to SAY which
 *  document was opened and let the human choose, which is the same answer `AtlasAssetView`'s flush
 *  conflict already gives, in its own words:
 *
 *  > *"Both exits are the HUMAN's to choose — the compare-and-swap exists to stop a SILENT
 *  > overwrite, not to stop a deliberate one — so both are offered, and neither happens on the
 *  > panel's own judgement."*
 *
 *  So: **Discard & reload** is literally that panel's two calls (`discardDirtyAssets([path])`, then
 *  the caller's reload), and **Keep editing** dismisses. Before this there was no path at all from a
 *  refused panel back to a repaired file.
 *
 *  ⚠️ **Lives in this file to share the palette, not because it is a refusal.** It is not one — the
 *  load succeeded. But `AssetLoadRefusedBanner`'s own comment warns that a hand-rolled copy of those
 *  five colour literals is exactly what it exists to prevent, and a fifth copy is a fifth copy
 *  whatever the semantics.
 *
 *  ⚠️ **The caller owns the flag, and it must be PER-COMPONENT.** Whether this load adopted a park
 *  is knowable only inside the load effect — the registry cannot answer it, because a park is
 *  equally there when the panel opened on the FILE and the human then edited. Keying it on the path
 *  would be `readFailed`'s mistake a third time (`metaReadFallback`'s `READ_FOR_PATH`): two panels
 *  can be open on one path, and one of them adopting says nothing about the other. */
export function ParkAdoptedBanner(
  { path, fileName, uiId, onReload, onKeep, style }: {
    path: string;
    fileName: string;
    uiId: string;
    /** Re-run this panel's load AFTER the park is discarded — the same call its Retry makes. */
    onReload: () => void;
    /** Dismiss the notice, keeping the unsaved edit. Keeping is already the state; this only hides. */
    onKeep: () => void;
    style?: CSSProperties;
  },
) {
  return (
    <div data-ui-id={uiId} style={style ? { ...wrap, ...style } : wrap}>
      <div style={{ flex: 1 }}>
        <span>
          {`⚠ Opened an UNSAVED edit for ${fileName} — it is newer than the file on disk, which was `}
          {'not re-read. Saving will replace the file with what you see here.'}
        </span>
      </div>
      <button
        data-ui-id={`${uiId}.discardAndReload`} data-ui-kind="button" data-ui-label="Discard and reload"
        title="Throw away the unsaved edit and re-read the file as it now is on disk"
        onClick={() => { discardDirtyAssets([path]); onReload(); }}
        style={retryBtn}
      >Discard &amp; reload</button>
      <button
        data-ui-id={`${uiId}.keep`} data-ui-kind="button" data-ui-label="Keep editing"
        title="Keep the unsaved edit and hide this notice"
        onClick={onKeep}
        style={retryBtn}
      >Keep editing</button>
    </div>
  );
}

export default AssetLoadRefusedBanner;

/** The notice a modal asset editor shows IN the dialog when its **Save** did not write (#901).
 *
 *  ⚠️ **Not an `AssetLoadRefusedBanner`, deliberately.** That one is about a failed LOAD and offers
 *  a Retry; this is about a refused SAVE in a dialog that is already staying open, where the retry
 *  is the dialog's own Save button and a second one beside it would be two ways to do one thing.
 *  What they share is the palette — and this file's header warns that a hand-rolled copy of those
 *  colour literals is exactly what it exists to prevent, which is why this lives here rather than
 *  in each modal.
 *
 *  The WORDING is not here: it is `panels/saveRefusal.ts`, so the two modals cannot drift and the
 *  decision is unit-testable without mounting a dialog (`docs/editor.md` § Panels).
 *
 *  ⚠️ **`role="alert"` is load-bearing, not decoration.** The message appears in a modal the human
 *  is already looking at, but it appears *after* a click on a control that visibly did nothing —
 *  the exact case a screen reader user gets no signal for otherwise. */
export function SaveRefusedNotice({ message, uiId }: { message: string; uiId: string }) {
  return (
    <div data-ui-id={uiId} role="alert" style={{ ...wrap, margin: 0, flex: 1, textAlign: 'left' }}>
      <span>{message}</span>
    </div>
  );
}
