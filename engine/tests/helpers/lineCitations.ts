/**
 * Detectors for line-number citations in committed markdown. (#680, #686)
 *
 * A `saveSync.ts:1745` citation rots on the next edit above line 1745 and **nothing can detect
 * it** — no test records what line 1745 was supposed to point at, so a drifted number and a
 * correct one are indistinguishable. The suite therefore cites by SYMBOL, and these functions
 * make that mechanical.
 *
 * They live here, shared, because `qa/` and `docs/` are guarded by two different test files and a
 * duplicated detector is a detector that drifts. Every shape below was found in production, each
 * one AFTER a sweep using the previous shapes reported itself clean — budget for a seventh.
 */

/**
 * Strip a trailing line reference — `foo.ts:525`, `foo.ts:525-573`, `foo.ts:288,310`, `foo.ts#L525`.
 *
 * ⚠️ This helper once carried a comment arguing the OPPOSITE — that `file_path:line_number` was
 * "the repo's own citation convention (CLAUDE.md: it is clickable)" and that dropping line numbers
 * "would make every case vaguer to satisfy a tool". Overturned in #680: that convention is not in
 * this repo's CLAUDE.md (it is the coding agent's harness rule about printing a clickable reference
 * in a terminal — a different medium from a file read months later), and the trade was priced
 * without the rot. Measured on one merge: `systems.ts` moved by ONE net line and invalidated eight
 * citations; `accounts.md:762-775` had already slid onto the wrong heading.
 */
export function stripLineRef(path: string): string {
  return path.replace(/(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*|#L\d+(?:-L?\d+)?)$/, '');
}

/**
 * Suffixes that make a bare filename a source citation.
 *
 * Wide on purpose. The list this replaced held 10 web extensions, so every native, shader and
 * packaging file the docs cite could carry a rotting line number past the gate — and `docs/
 * native-and-sdks.md` alone cited `CAPPlugin.m`, `CAPPlugin.h`, `Plugin.java`, `Bridge.java`,
 * `OtaCore.swift` and `BridgeWebViewClient.java` that way.
 */
export const SOURCE_SUFFIXES =
  /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|json|jsonc|sh|bash|zsh|md|ya?ml|toml|swift|java|kt|kts|gradle|rs|go|rb|py|wgsl|glsl|frag|vert|css|scss|html?|xml|plist|pbxproj|podspec|entitlements|xcconfig|properties|cfg|ini|txt|m|mm|h|hpp|c|cc|cpp|pch|storyboard|xib)$/i;

/**
 * Does this code-span token cite a source location by line?
 *
 * REJECT-BY-SHAPE for anything containing `/`, so a path is covered whatever suffix arrives next
 * and the rule cannot go stale; the suffix list above only has to carry bare filenames, which is
 * the shorthand these docs use constantly.
 *
 * ⚠️ A PURE shape test does not work and was tried: `UIElement.width:640` and
 * `Physics2D.gravityX:250` are `Trait.field:value`, identical in shape to `file.ext:line`, and both
 * are live in `qa/cases/**`. The URL guard is the other half — `example.com:8080` is `.com:8080` by
 * shape. A dotted IP falls out of the {2,8} run length: `127.0.0.1:5196` ends in a 1-char segment.
 */
export function citesALine(token: string): boolean {
  // The trailing class carries `*` and the curly apostrophe for a reason: markdown wraps a citation
  // in emphasis (`**`foo.ts:12`**`) and English wraps it in a possessive (``foo.ts:12`’s`). Two of
  // the 80 citations in the guarded docs were invisible to an earlier, narrower class — the token
  // never reached the detector at all, so the gate was green over a live rotting reference.
  const t = token
    // Possessive first, and as its own step: the class below strips the apostrophe but stops at
    // the `s`, so ``projects.ts:40`'s`` survived it intact.
    //
    // ⚠️ Reachable only through the PROSE path (`nonCodeText` + whitespace split). Via `codeTokens`
    // the wrappers sit outside the backticks and never arrive, so this is dead on that route — it
    // earns its place on the other one, where an unbackticked `**saveSync.ts:1745**` in a heading
    // or a table cell is exactly what turns up.
    .replace(/['’]s$/i, '')
    .replace(/["'`*_.,;:)\]}’”]+$/, '')
    .replace(/^["'`*_([{“‘]+/, '')
    .trim();
  const stripped = stripLineRef(stripLineRef(t));
  if (stripped === t) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.includes('//')) return false;
  // A JSON/object literal is not a path, however many slashes it carries. `docs/debug-tools-mcp.md`
  // documents a payload `{"clipPath":"/assets/anim/probe.anim.json","time":0,"value":1}` — the
  // trailing `"value":1` strips like a line ref and the embedded asset path satisfied the `/`
  // shortcut below, so the whole blob was reported as a citation.
  if (/["{}]/.test(stripped)) return false;
  if (stripped.includes('/')) return true;
  // `BridgeActivity.onResume():97` — a Class.method() reference with a line glued on. Nothing
  // legitimately ends in `()` and carries a colon-number, so this is unambiguous; the suffix list
  // cannot catch it because `onResume` is not a file extension.
  if (stripped.endsWith('()')) return true;
  return SOURCE_SUFFIXES.test(stripped);
}

/**
 * Is this whole code SPAN a bare line citation — `` `:170` ``, reusing a filename named earlier?
 *
 * Takes a span, not a token, and that is the point: `codeTokens` splits on whitespace, turning
 * `lsof -i :5198 | xargs kill` into a `:5198` indistinguishable from a line number. Every clone has
 * its own port, so `qa/` is full of those and three cases tripped it. A real bare citation stands
 * alone in its backticks; a port always rides inside a longer command or URL.
 *
 * Three digits for a single number, because `CurveEditor` publishes handle ids as
 * `particle:curve:${slug}:${i}` with `i` unbounded — a 12-point curve elided as `` `:11` `` would
 * otherwise fail this gate telling its author to "name the function", impossible for an id.
 *
 * A RANGE or LIST is accepted at two digits (`:45-47`): an index is a single number, so a span with
 * a separator in it is a citation whatever its magnitude. `docs/native-and-sdks.md` had exactly
 * that shape and it slipped the first three-digit floor.
 */
export function isBareLineSpan(span: string): boolean {
  const s = span.trim();
  return /^:\d{3,}(?:[-,]\d+)*$/.test(s) || /^:\d+[-,]\d+(?:[-,]\d+)*$/.test(s);
}

/**
 * The `~L202` / `#L202` marker — the EIGHTH shape, and it was live and already drifted when found
 * (`docs/engine-oss-publishing.md` cited "release.yml ~L202").
 *
 * It defeats both other detectors: whitespace-splitting yields a bare `~L202` with no filename
 * attached, and the prose rule needs the literal word "line". Requiring the `~` or `#` prefix is
 * what keeps it safe — a bare `L202` could be a label or a part number, `~L202` could not.
 */
export function citesALineByMarker(text: string): string[] {
  // URLs are exempt, for the same reason `citesALine` exempts them: `#L120` is how you permalink a
  // line in SOMEBODY ELSE'S repo, and this convention governs citations into THIS one. `docs/` links
  // KTX-Software this way today. Without this the only escape an author had was loosening the
  // shared detector — the exact move the gate's own failure message tells them not to make.
  const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  return [...withoutUrls.matchAll(/[~#]L\d{2,}(?:-L?\d+)?/g)].map((m) => m[0]);
}

/**
 * The document with its code spans and fenced blocks blanked out — i.e. the PROSE.
 *
 * The docs gate reads code spans via `codeTokens`, which is right for `citesALine`'s contract but
 * one-directional: it stopped seeing an UNBACKTICKED `saveSync.ts:1745`, and a markdown link label,
 * a heading and a table cell are all realistic places for one. Running the whitespace split over
 * what is left of the body recovers those without re-introducing the false positive `codeTokens`
 * fixed (two adjacent spans fusing into one token across the whitespace between them), because the
 * spans that fused are exactly what this removes.
 */
export function nonCodeText(md: string): string {
  return (
    md
      .replace(/```[a-z]*\n[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]+`/g, ' ')
      // Unwrap `[label](target)` to `label`. Without this the whole construct stays one whitespace
      // token, so a citation used as a LINK LABEL — `[saveSync.ts:1745](../x.ts)` — survives the
      // split glued to its target and no detector sees it. The target itself is a path, not a
      // source citation, so dropping it is right rather than merely convenient.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 ')
  );
}

/**
 * Line numbers written in PROSE — "(line 79)", "lines ~91–108".
 *
 * Exported and unit-tested deliberately: this was once a bare `const` inside its assertion, which
 * made the rule unfalsifiable — a typo would have left the gate green over all 62 prose references
 * it exists to catch, with nothing anywhere going red.
 *
 * The unit-suffix exclusion is the false friend reading the corpus does not reveal: a RENDERED line
 * is measured in px. `docs/ui-system.md` describes autoFitText turning "a correct 2-line wrap
 * (229px) into one non-wrapping line 199px". Digits followed by a unit are a quantity.
 */
export function citesALineInProse(text: string): string[] {
  return [
    ...text.matchAll(/\blines? *~? *\d{2,}(?![\d.]*\s*(?:%|(?:px|ms|s|em|rem|pt|dp|fps)\b))/gi),
  ].map((m) => m[0]);
}

/**
 * Tokens inside inline code spans and fenced blocks — never bare prose.
 *
 * BOTH are split on whitespace. An inline span used to be kept whole, which quietly defeated
 * this guard for the commonest citation shape in the repo: `` `engine/scripts/launch-editor.sh
 * games/3d-test` `` became one token containing a space, and the placeholder filter (which skips
 * anything with whitespace, for `games/<id>/…`) then dropped it without ever checking either
 * path existed. A renamed script would have passed silently — in the guard whose entire job is
 * catching renamed references.
 */
export function codeTokens(md: string): string[] {
  const inline = [...md.matchAll(/`([^`\n]+)`/g)].flatMap((m) => m[1].split(/\s+/));
  const fenced = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split(/\s+/));
  return [...inline, ...fenced].filter(Boolean);
}
/**
 * Whole inline code spans, unsplit.
 *
 * Needed because **this repo has asset filenames containing spaces** — e.g.
 * `games/3d-test/runtime/assets/scenes/2D Animation.scene.json`. Splitting that span on whitespace
 * yields `…/scenes/2D` plus `Animation.scene.json`, and the checker then reports a perfectly correct
 * citation as two missing paths. The caller uses this to ask "is the ENTIRE span a real path?" before
 * falling back to the token split.
 *
 * This cannot re-open the hole the split was introduced to close: a span is only accepted whole when
 * it EXISTS on disk, so a span naming something missing is still split and still checked token by
 * token.
 */
export function codeSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}
