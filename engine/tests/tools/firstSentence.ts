/** The §11 first-sentence rule, as ONE detector — shared by the two corpora it polices.
 *
 *  It landed in #1208 inside `mcpToolContracts.test.ts`, applied to the engine's own `modoki_*` and
 *  `device_*` surfaces. #1218 needed the same rule over GAME tools (`registerAgentTool` in
 *  `games/**`), which no surface loader can reach — they register at runtime from a loaded project,
 *  so the guard's population had never included them and five had drifted.
 *
 *  Extracted rather than copied, deliberately: two implementations of one rule diverge, and the
 *  divergence is invisible until a description passes one guard and fails the other. `gameToolFirstSentence.test.ts`
 *  and `mcpToolContracts.test.ts` now both call these.
 */

/** The first sentence of a description. Ends at `.`/`!` before whitespace, `?` before whitespace or
 *  a dash, or a newline. `e.g.`/`i.e.`/`etc.`/`vs.` do not end one — a review found four first
 *  sentences cut short there, which would have hidden whatever followed the abbreviation. */
export function firstSentence(d: string): string {
  const masked = d.replace(/\b(e\.g|i\.e|etc|vs)\./g, (m) => m.replace(/\./g, '\u0000'));
  const end = masked.match(/^[\s\S]*?(?:[.!](?=\s|$)|\?(?=\s|$|[—–-])|\n)/)?.[0].length ?? d.length;
  return d.slice(0, end).trim();
}

/** What is wrong with a first sentence, or null. It must say what the tool DOES:
 *  - not a caveat about the reply (`RETURNS {…}`, `NOTE …`, `⚠️`), which belongs after it;
 *  - not a question (`What references this?`), which names the need but not the tool;
 *  - no issue number, which is history an agent choosing a tool cannot use.
 *
 *  Under schema deferral this sentence is often the ONLY text read before a tool is chosen, so a
 *  sentence spent on provenance is a tool the agent cannot tell apart from its neighbours. */
export function firstSentenceDefect(d: string): string | null {
  const f = firstSentence(d);
  // Case-INSENSITIVE for the caveat words, except that a prose "Returns the …" is what a tool does;
  // only a returned SHAPE (`Returns {…}`/`RETURNS …`) or a `Note:`-style label is a caveat.
  if (/^(?:NOTE|RETURNS|WARNING|IMPORTANT|CAUTION)\b|^⚠/.test(f) || /^(?:note|warning|important|caution)\s*:|^returns\s*[{[]/i.test(f)) return 'leads with a caveat';
  if (/\?$/.test(f)) return 'is a question';
  if (/#\d+/.test(f)) return 'carries an issue number';
  return null;
}

/** History in a description, ANYWHERE in it (#1555): a past state narrated ("used to",
 *  "previously") or a bare issue number. A maintainer needs it; an agent choosing arguments does
 *  not, and a loaded schema is re-read every turn. Shared by `mcpDescriptionProse.test.ts` (both
 *  engine servers) and `gameToolFirstSentence.test.ts` (game tools), for the same reason as the
 *  first-sentence detector above. An issue number is `#` + digits wherever it sits — `(#32)`,
 *  `see #32.`, `(#373 part 2;` — the first version matched only the closed-paren form and missed the
 *  other two (#1555 review). Not after a word character or `&`, so an HTML entity (`&#39;`) and
 *  `#fff` stay out; at most five digits, so a six- or eight-digit colour (`#000000`) does too.
 *  ⚠️ A THREE-digit all-numeric colour (`#000`) still matches — none is on the surface; if one is
 *  ever needed, write it with a letter (`#0a0`) or add a ledger row. "Until now" is history told in
 *  the present tense, the form the second review found five of. */
export const DESCRIPTION_HISTORY = /\bused to\b|\bpreviously\b|\b[Uu]ntil now\b|(?<![\w&])#\d{1,5}\b/;
