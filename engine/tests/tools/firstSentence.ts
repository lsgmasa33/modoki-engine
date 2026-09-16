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
