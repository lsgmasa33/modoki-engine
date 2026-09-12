/** Guard: every NUMERIC preset `<select>` in an asset inspector splices its bound value in.
 *
 *  An HTML `<select>` whose `value` matches none of its `<option>`s displays its FIRST option
 *  — silently. So a `.meta.json` holding a legal but non-preset number renders as a DIFFERENT
 *  setting than the asset has, and nothing in the UI says so. `withCurrentValue` is the fix
 *  (`assetViews/importSettingOptions.ts`).
 *
 *  WHY A STATIC GUARD AND NOT JUST UNIT TESTS: the helper was already written, already
 *  correct, and already unit-tested when #131 was closed against the two views its title
 *  named. A close-out sweep then found SEVEN more unspliced numeric selects — atlas page size,
 *  model texture max-size and UASTC level, three font controls, and a second UASTC select in
 *  TextureAssetView, the very file the fix had just edited. Testing the helper proves nothing
 *  about the call sites, and the call sites are where every instance of this bug has been.
 *
 *  The rule: an option-producing `.map()` in `assetViews/**` either wraps its list in
 *  `withCurrentValue(...)`, or the pair `<file>::<mapped expression>` appears in EXEMPT below with a
 *  reason, and pardons exactly one site.
 *
 *  ⚠️ **Exemptions were keyed by expression text with NO FILE, and this header claimed that meant
 *  "a genuinely new control cannot inherit one by accident". That was false for a GENERIC name
 *  (#1123).** `'options'` is what a caller-supplied list is called in every generic control, so that
 *  one row pardoned `MaterialAssetView.tsx:206` AND `widgets.tsx:223` — two different components —
 *  and would have pardoned the next `options`-named select anywhere under `assetViews/**`, in any
 *  file, forever. The claim held only for distinctive names like `VIDEO_PRESETS`, which is why it
 *  read as true.
 *
 *  Keying `file::expr` keeps what the old key was RIGHT about — a row survives an edit above it,
 *  unlike `file:line` — while costing the two `options` sites one reason each, which is the sentence
 *  a file-less key never made anybody write. Spending rows one at a time (`assertExemptionLedger`)
 *  is what makes a copy-pasted second identical select in the SAME file an offender too.
 *
 *  Scope, stated so this is not mistaken for more than it is: the exemptions are all
 *  STRING-valued or dynamically-built lists. A string select can technically hit the same
 *  behaviour, but a hand-authored string is rejected upstream by the converters' union types,
 *  and no instance has ever been measured — where every measured instance has been numeric. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

const viewsDir = path.resolve(__dirname, '../../packages/modoki/src/editor/panels/assetViews');

/** Sites that legitimately need no splice, each `<file>::<mapped expression>` with why. All
 *  13 measured 2026-09-12 on work-ai2 via the detector below; every row is one site.
 *
 *  Scope, stated so this is not mistaken for more than it is: every row is a STRING-valued or
 *  dynamically-built list. A string select can technically hit the same behaviour, but a
 *  hand-authored string is rejected upstream by the converters' union types, and no instance has
 *  ever been measured — where every measured instance has been numeric. */
const EXEMPT = [
  { item: 'AudioAssetView.tsx::(Object.keys(LOAD_TYPE_LABELS) as AudioLoadType[])',
    reason: 'string union, keyed off its own label map' },
  { item: 'AudioAssetView.tsx::AUDIO_FORMATS', reason: 'string union (mp3/aac/opus/wav/flac)' },
  { item: 'FontAssetView.tsx::FIELD_TYPE_OPTIONS', reason: 'string-valued {value,label} list' },
  { item: 'TextureAssetView.tsx::TEXTURE_TYPE_OPTIONS', reason: 'string-valued {value,label} list' },
  { item: 'TextureAssetView.tsx::FORMAT_OPTIONS_BY_TYPE[type]',
    reason: 'string-valued {value,label} list, keyed by texture type' },
  { item: 'VideoAssetView.tsx::VIDEO_PRESETS', reason: 'string union (x264 preset names)' },
  { item: 'VideoAssetView.tsx::(Object.keys(DELIVERY_LABELS) as VideoDelivery[])',
    reason: 'string union' },
  { item: 'VideoAssetView.tsx::(Object.keys(POLICY_LABELS) as VideoDeliveryPolicy[])',
    reason: 'string union' },
  { item: 'VideoAssetView.tsx::(Object.keys(RESIZE_LABELS) as VideoResizeMode[])',
    reason: 'string union' },
  { item: 'VideoAssetView.tsx::(Object.keys(AUDIO_LABELS) as VideoAudioMode[])',
    reason: 'string union' },
  { item: 'ModelBatchView.tsx::postprocessorIds',
    reason: 'built at runtime from the registry — not a preset list' },
  // ⚠️ The two halves of what used to be ONE file-less `'options'` row. Same expression, different
  // components, and each now has to argue for itself.
  { item: 'MaterialAssetView.tsx::options',
    reason: 'the shader-property enum dropdown: a {value,label} list the CALLER builds from the '
      + 'shader schema, so the bound value is always one of them by construction' },
  { item: 'widgets.tsx::options',
    reason: 'generic DropdownField — a bare string list supplied by the caller. Nothing here knows '
      + 'the value domain, so splicing would be the wrong layer to do it at' },
] as const;

interface Site { file: string; line: number; expr: string; spliced: boolean }

function optionSites(): Site[] {
  const out: Site[] = [];
  for (const f of fs.readdirSync(viewsDir).filter((n) => n.endsWith('.tsx'))) {
    const lines = readScannedSource(path.join(viewsDir, f)).code.split('\n');
    lines.forEach((l, i) => {
      if (!/=>\s*<option/.test(l)) return;
      // The list and the .map() are often split across lines by the line length, so read a
      // small window back. Two lines is enough for every current call site and keeps the
      // window too small to accidentally borrow a neighbouring control's splice.
      const window = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
      // `\(?` at the end: an arrow param may or may not be parenthesised (`o =>` vs `(o) =>`)
      // and both spellings are in use here. Requiring the paren silently produced an
      // `<unparsed>` for MaterialAssetView, which the vacuity check below caught.
      const m = window.match(/([\w$.[\]'"]+|\([^()]*(?:\([^()]*\))?[^()]*\))\s*\.map\(\s*\(?/);
      out.push({
        file: f,
        line: i + 1,
        expr: (m?.[1] ?? '<unparsed>').trim(),
        spliced: /withCurrentValue\(/.test(window),
      });
    });
  }
  return out;
}

describe('asset-inspector preset selects are honest (#131)', () => {
  it('every option list is either spliced or a declared exemption', () => {
    assertExemptionLedger({
      label: 'EXEMPT in importSettingSelectsSpliced',
      population: optionSites()
        .filter((s) => !s.spliced)
        .map((s) => ({ item: `${s.file}::${s.expr}`, site: `${s.file}:${s.line} — ${s.expr}` })),
      exempt: EXEMPT,
      // ⚠️ A low secondary floor on purpose: the REAL detector-broke check is the next test, which
      // floors total sites at 25 and spliced ones at 14. Sized under the 13 measured so that
      // SPLICING one of these reaches the over-blessed arm ("blesses 1, found 0") — which is the
      // message that tells the author to delete the row — instead of being reported here as a
      // matcher that stopped matching.
      floor: 6,
      fix: 'a numeric preset <select> that does not splice its bound value will silently display '
        + 'its FIRST option when a .meta.json holds an off-list number. Wrap the list in '
        + 'withCurrentValue(list, boundValue).',
    });
  });

  it('finds the call sites at all — a regex that matches nothing would pass vacuously', () => {
    const sites = optionSites();
    // The count is deliberately a floor, not an equality: a new control must not fail this.
    expect(sites.length).toBeGreaterThanOrEqual(25);
    expect(sites.filter((s) => s.spliced).length).toBeGreaterThanOrEqual(14);
    // Only an UNSPLICED site has to parse. A spliced one can be shaped however it likes —
    // `(isMixed(k) ? LIST : withCurrentValue(LIST, v))` defeats the extractor and is exactly
    // right — and rule 1 already passes it on the splice alone. An unspliced site that fails
    // to parse gets `<unparsed>`, which matches no exemption, so it fails rule 1 loudly
    // rather than slipping through as unrecognised.
    expect(sites.filter((s) => !s.spliced && s.expr === '<unparsed>')).toEqual([]);
  });

  // The stale-exemption test that used to sit here is gone: `assertExemptionLedger`'s over-blessed
  // arm is strictly stronger. The old one asked whether each expression still matched SOMEWHERE in
  // the tree, so splicing `MaterialAssetView.tsx`'s `options` left the row green on `widgets.tsx`'s
  // — a stale pardon, reported by nothing. The ledger asks per site.
});
