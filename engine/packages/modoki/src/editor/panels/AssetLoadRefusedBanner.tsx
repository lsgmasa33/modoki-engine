/** The banner an asset editor shows when it REFUSED to load a document it could not read (#896).
 *
 *  Presentation only — the decision is `assetDocLoad.classifyAssetDocFetchFailure`, and the
 *  refusal is enforced by the panel simply not putting a document in the store (its editing surface
 *  is gated on that document, so editing is disabled by construction rather than by a flag threaded
 *  through every field). This exists because four editors need the identical banner and four copies
 *  of it would go out of sync on the first wording change.
 *
 *  ⚠️ `ParticleEditor` and `AtlasAssetView` keep their own — deliberately, not by oversight. Both
 *  render an ABSOLUTELY-POSITIONED overlay inside a viewport, and `AtlasAssetView` distinguishes a
 *  'failed' state from a 'refused' one with a message. This is the in-flow block the four remaining
 *  editors want. The thing that must not fork is the DECISION, and that is shared. */

import type { CSSProperties, ReactNode } from 'react';

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

export default AssetLoadRefusedBanner;
