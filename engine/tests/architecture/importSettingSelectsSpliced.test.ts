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
 *  `withCurrentValue(...)`, or its mapped expression appears in EXEMPT below with a reason.
 *  Exemptions are keyed by expression text rather than file:line so they survive an edit
 *  above them, and a genuinely new control cannot inherit one by accident.
 *
 *  Scope, stated so this is not mistaken for more than it is: the exemptions are all
 *  STRING-valued or dynamically-built lists. A string select can technically hit the same
 *  behaviour, but a hand-authored string is rejected upstream by the converters' union types,
 *  and no instance has ever been measured — where every measured instance has been numeric. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const viewsDir = path.resolve(__dirname, '../../packages/modoki/src/editor/panels/assetViews');

/** Mapped expressions that legitimately need no splice, each with why. */
const EXEMPT = new Map<string, string>([
  ['(Object.keys(LOAD_TYPE_LABELS) as AudioLoadType[])', 'string union, keyed off its own label map'],
  ['AUDIO_FORMATS', 'string union (mp3/aac/opus/wav/flac)'],
  ['FIELD_TYPE_OPTIONS', 'string-valued {value,label} list'],
  ['TEXTURE_TYPE_OPTIONS', 'string-valued {value,label} list'],
  ['FORMAT_OPTIONS_BY_TYPE[type]', 'string-valued {value,label} list, keyed by texture type'],
  ['VIDEO_PRESETS', 'string union (x264 preset names)'],
  ['(Object.keys(DELIVERY_LABELS) as VideoDelivery[])', 'string union'],
  ['(Object.keys(POLICY_LABELS) as VideoDeliveryPolicy[])', 'string union'],
  ['(Object.keys(RESIZE_LABELS) as VideoResizeMode[])', 'string union'],
  ['(Object.keys(AUDIO_LABELS) as VideoAudioMode[])', 'string union'],
  ['postprocessorIds', 'built at runtime from the registry — not a preset list'],
  ['options', 'generic DropdownField / MaterialAssetView — list supplied by the caller'],
]);

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
    const offenders = optionSites()
      .filter((s) => !s.spliced && !EXEMPT.has(s.expr))
      .map((s) => `${s.file}:${s.line} — ${s.expr}`);
    expect(
      offenders,
      'a numeric preset <select> that does not splice its bound value will silently display '
        + 'its FIRST option when a .meta.json holds an off-list number. Wrap the list in '
        + 'withCurrentValue(list, boundValue), or add the expression to EXEMPT with a reason.',
    ).toEqual([]);
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

  it('carries no exemption that no longer matches a call site', () => {
    const live = new Set(optionSites().map((s) => s.expr));
    const stale = [...EXEMPT.keys()].filter((e) => !live.has(e));
    expect(stale, 'a stale exemption silently pre-approves a future control').toEqual([]);
  });
});
