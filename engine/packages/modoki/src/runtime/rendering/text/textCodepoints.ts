/**
 * A string's codepoints, iterating by CHARACTER rather than by UTF-16 unit — so an astral glyph
 * (an emoji, most CJK extension blocks) yields its one real codepoint instead of a surrogate pair
 * the atlas has no entry for.
 *
 * ⚠️ Extracted from `Scene2D.tsx` (#1038), where it was module-private. `measureText2D` needs the
 * SAME codepoint set the renderer ensures glyphs for — a second copy that diverged would make a
 * measurement disagree with the draw it is supposed to predict, which is the whole failure this
 * file's callers exist to avoid.
 */
export function textCodepoints(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}
