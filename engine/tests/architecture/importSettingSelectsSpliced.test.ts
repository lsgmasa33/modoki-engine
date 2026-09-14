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
 *  one row pardoned `MaterialAssetView`'s shader picker AND `widgets.tsx`'s select — two different components —
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
import { readScannedSource, stripComments } from '@modoki/engine/testing';
import { callsTo, enclosingFunction, findNodes, flatText, lineOf, parseSource, ts, unwrapValue, valueCarrier } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';

const viewsDir = path.resolve(__dirname, '../../packages/modoki/src/editor/panels/assetViews');

/** Sites that legitimately need no splice, each `<file>::<mapped expression>` with why. All
 *  13 measured 2026-09-12 on work-ai2 (12 since #1170 folded ModelBatchView's select into MixedSelect) via the detector below; every row is one site.
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
  // ⚠️ The two halves of what used to be ONE file-less `'options'` row. Same expression, different
  // components, and each now has to argue for itself.
  { item: 'MaterialAssetView.tsx::options',
    reason: 'the shader-property enum dropdown: a {value,label} list the CALLER builds from the '
      + 'shader schema, so the bound value is always one of them by construction' },
  // ⚠️ #1170 moved the select behind DropdownField into MixedSelect, which now also renders
  // ModelBatchView's postprocessor list (its own row, "built at runtime from the registry", went
  // with it) and the Inspector's unit + UIAction mini selects.
  { item: 'widgets.tsx::normalized',
    reason: 'generic MixedSelect (behind DropdownField) — a list supplied by the caller. Nothing here '
      + 'knows the value domain, so splicing would be the wrong layer to do it at' },
] as const;

interface Site { file: string; line: number; expr: string; spliced: boolean }

/** Whether `e` can evaluate to an `<option …>` element: the element itself (parentheses peeled), either
 *  arm of a `? :`, or the right side of `&&` — `(l) => l === skip ? null : <option …/>` is a producer. */
function isOptionJsx(e: ts.Expression | undefined): boolean {
  const u = e && unwrapValue(e);
  if (!u) return false;
  if (ts.isConditionalExpression(u)) return isOptionJsx(u.whenTrue) || isOptionJsx(u.whenFalse);
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isOptionJsx(u.right);
  const tag = ts.isJsxElement(u) ? u.openingElement.tagName : ts.isJsxSelfClosingElement(u) ? u.tagName : undefined;
  return !!tag && ts.isIdentifier(tag) && tag.text === 'option';
}

/** Every option-producing `.map(cb)` in one view — `cb` an inline function whose result is an
 *  `<option>` (a concise body, or a `return` of its own) — with the list it maps and whether that list
 *  is spliced: `withCurrentValue(…)` called anywhere INSIDE the mapped expression.
 *
 *  ⚠️ **The `.map()`'s own receiver, not a text window (#1179).** The line scan this replaces wanted
 *  `=> <option` on one line, then read the list and `withCurrentValue(` from a two-line window above:
 *  an arrow whose `<option` a formatter put on the next line was not a site at all, and a spliced
 *  control directly above an unspliced one lent it its `withCurrentValue(` — the window's own comment
 *  said it was sized to make that unlikely, not impossible. */
function optionSitesIn(code: string, file: string): Site[] {
  const sf = parseSource(code, file);
  return findNodes(sf, (n): n is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(n) || ts.isFunctionExpression(n))
    .filter((cb) => (!ts.isBlock(cb.body) ? isOptionJsx(cb.body)
      : findNodes(cb.body, ts.isReturnStatement).some((r) => enclosingFunction(r) === cb && isOptionJsx(r.expression))))
    .map((cb) => {
      const c = valueCarrier(cb).parent;
      // ⚠️ An `<option>` producer that is not a `.map()` callback — `list.flatMap(…)`, `Array.from(list,
      // …)` — is still a site, keyed `<unparsed>`: it matches no exemption, so it fails loudly instead
      // of silently leaving the population (the text scan reported it that way too).
      const mapped = c && ts.isCallExpression(c) && c.arguments[0] === valueCarrier(cb) && ts.isPropertyAccessExpression(c.expression)
        && c.expression.name.text === 'map' ? c.expression.expression : undefined;
      return mapped
        ? { file, line: lineOf(c), expr: flatText(mapped), spliced: callsTo(mapped, 'withCurrentValue').length > 0 }
        : { file, line: lineOf(cb), expr: '<unparsed>', spliced: false };
    });
}

function optionSites(): Site[] {
  return fs.readdirSync(viewsDir).filter((n) => n.endsWith('.tsx'))
    .flatMap((f) => optionSitesIn(readScannedSource(path.join(viewsDir, f)).code, f));
}

describe('the option-site reader reads each .map()\'s own list (#1179)', () => {
  const sites = (src: string) => optionSitesIn(stripComments(src), 'View.tsx').map((x) => `${x.expr}${x.spliced ? ' (spliced)' : ''}`);

  it('finds a site whose <option> the formatter moved to the next line, and a block-bodied one', () => {
    expect(sites('const a = <select>{SIZES.map((s) =>\n  <option key={s} value={s}>{s}</option>)}</select>;'
      + '\nconst b = <select>{MODES.map(function (m) { const l = label(m); return (<option value={m}>{l}</option>); })}</select>;'))
      .toEqual(['SIZES', 'MODES']);
  });

  it('a spliced control directly above does not lend its splice to the next one', () => {
    expect(sites('<>\n<select>{withCurrentValue(SIZES, size).map((s) => <option key={s}>{s}</option>)}</select>\n'
      + '<select>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>\n</>')).toEqual(['withCurrentValue(SIZES, size) (spliced)', 'LEVELS']);
  });

  it('keys a cast list the way the ledger spells it, and reads a ternary splice as spliced', () => {
    expect(sites('<select>{(Object.keys(\n  LABELS,\n) as Mode[]).map((k) => <option key={k}>{k}</option>)}</select>')).toEqual(['(Object.keys( LABELS, ) as Mode[])']);
    expect(sites('<select>{(isMixed(k) ? LIST : withCurrentValue(LIST, v)).map((o) => <option key={o}>{o}</option>)}</select>')).toHaveLength(1);
    expect(sites('<select>{(isMixed(k) ? LIST : withCurrentValue(LIST, v)).map((o) => <option key={o}>{o}</option>)}</select>')[0]).toMatch(/\(spliced\)$/);
  });

  it('a .map() producing something other than an <option> is not a site', () => {
    expect(sites('const rows = ITEMS.map((i) => <li key={i}>{i}</li>); const n = ITEMS.map((i) => i * 2);')).toEqual([]);
    // The OUTER callback returns an <li>: not a site. The inner helper is an <option> producer no .map() keys — `<unparsed>`.
    expect(sites('const rows = ITEMS.map((i) => { const f = () => { return <option>{i}</option>; }; return <li>{f()}</li>; });')).toEqual(['<unparsed>']);
  });

  it('an <option> producer that is not a .map() callback is a site it cannot key — so it fails, not vanishes', () => {
    expect(sites('<>\n<select>{LIST.flatMap((o) => <option key={o}>{o}</option>)}</select>\n<select>{Array.from(LIST, (o) => <option key={o}>{o}</option>)}</select>\n</>'))
      .toEqual(['<unparsed>', '<unparsed>']);
    // …and so is one handed to .map() as something other than its callback.
    expect(sites('<select>{LIST.map(render, (o) => <option key={o}>{o}</option>)}</select>')).toEqual(['<unparsed>']);
  });

  it('a callback that returns an <option> from one arm of a ternary or behind && is still a site', () => {
    expect(sites('<select>{LEVELS.map((l) => l === skip ? null : <option key={l}>{l}</option>)}</select>')).toEqual(['LEVELS']);
    expect(sites('<select>{MODES.map((m) => ok && <option key={m}>{m}</option>)}</select>')).toEqual(['MODES']);
  });

  it('a withCurrentValue inside the callback does not splice the LIST', () => {
    expect(sites('<select>{LEVELS.map((l) => <option key={l} value={withCurrentValue([l], v)[0]}>{l}</option>)}</select>')).toEqual(['LEVELS']);
  });
});

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
    // Only an UNSPLICED site has to be keyable. A spliced one can be shaped however it likes —
    // `(isMixed(k) ? LIST : withCurrentValue(LIST, v))` — and rule 1 passes it on the splice alone.
    // An `<option>` producer that is not a `.map()` callback gets `<unparsed>`, which matches no
    // exemption, so it fails rule 1 loudly rather than slipping through as unrecognised.
    expect(sites.filter((s) => !s.spliced && s.expr === '<unparsed>')).toEqual([]);
  });

  // The stale-exemption test that used to sit here is gone: `assertExemptionLedger`'s over-blessed
  // arm is strictly stronger. The old one asked whether each expression still matched SOMEWHERE in
  // the tree, so splicing `MaterialAssetView.tsx`'s `options` left the row green on `widgets.tsx`'s
  // — a stale pardon, reported by nothing. The ledger asks per site.
});
