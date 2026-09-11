/** Text ↔ value for Project Settings' `string-list` field — one entry per line.
 *
 *  ⚠️ The field keeps its TEXT as local state and derives the value, rather than rendering the text
 *  back from the value. Rendered from the parsed list, a trailing newline is trimmed away on every
 *  keystroke, so pressing Enter did nothing and a second entry could only be pasted. That went
 *  unnoticed until `ota.subgames` (#837) became the widget's first real user. */

/** The list a textarea's text means: one trimmed entry per line, blank lines dropped. */
export function parseStringList(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** The text to show for `value`, given what the field currently holds. Keeps the current text while
 *  it already MEANS `value` (a trailing newline, a blank line mid-edit), and replaces it only when
 *  the value changed from outside (a reload, a reset). */
export function stringListText(current: string, value: readonly string[]): string {
  const joined = value.join('\n');
  return parseStringList(current).join('\n') === joined ? current : joined;
}
