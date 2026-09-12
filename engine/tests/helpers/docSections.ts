/**
 * What a numbered doc SECTION looks like, and what a citation of one looks like — defined ONCE.
 *
 * Two guards ask overlapping questions about the same syntax and used to answer them with their
 * own copies: `docCitations.test.ts` resolves every prose `<doc>.md § N` repo-wide ("does this
 * pointer still resolve"), and `qaCaseReferences.test.ts` validates the `cites:` frontmatter on QA
 * cases ("is the dependency list complete"). Two definitions of one syntax is the shape this repo
 * keeps getting bitten by, and it bit here: the second copy was written narrower than the first —
 * lowercase-only suffixes and a 12-character window — so `§ 5A` matched as plain `§ 5` and a
 * citation that wrapped onto the next line was invisible. Ten dead pointers and three undeclared
 * dependencies sat in the corpus behind exactly that gap (#1095 review).
 */

/** Heading ids a markdown doc actually defines: `## 6. …`, `### 8a-bis. …`, `## ⚠️ 0. …`. */
export function headingIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^#{2,4}\s+(?:[^\w\s]+\s+)*([0-9]+[a-zA-Z]*(?:-bis)?)\./.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * A citation of a numbered section: the doc name, then the section mark, then the id.
 *
 * ⚠️ The gap deliberately allows a NEWLINE. Case prose wraps at ~100 columns, so a citation
 * routinely lands with the doc name on one line and the `§` on the next; a `[^\n§]` gap silently
 * skips those, and a completeness rule that cannot see a citation passes while the declaration it
 * is checking is incomplete — the failure it exists to prevent.
 *
 * ⚠️ The suffix is `[a-zA-Z]*`, not `[a-z]*`. With the lowercase form, `§ 5A` captured `5` and
 * stopped: ten citations to `5A`/`5B` resolved as a perfectly valid `§ 5`, losing the very
 * distinction they were written to draw. (Those two are now real headings — `qa/knowledge.md`
 * § 5a / § 5b — so the pointers resolve instead of relying on a letter nothing defined.)
 *
 * ⚠️ The tail is `(?!\d)(?!\.\d)`, NOT `(?![.\d])`. Its job is to refuse a DECIMAL (`§ 8.5`) while
 * accepting a section that ENDS A SENTENCE — and `(?![.\d])` refuses both, which blinds the
 * pattern to the commonest shape in the corpus. Measured: `§ 9.` matched nothing, and `§13b.` /
 * `§13d.C` backtracked to a bare `13`, silently repointing two correct citations at the wrong
 * section. Eight true declarations were deleted from `qa/cases/**` to match what the blinded
 * detector could see, and every floor stayed green through it (#1095 review). `[0-9]+` is greedy,
 * so `§ 12` was never at risk of matching as `1` and the stricter tail bought nothing.
 */
export const SECTION_CITE = /([A-Za-z0-9_./-]+\.md)`?\)?[^§]{0,60}§\s*([0-9]+[a-zA-Z]*(?:-bis)?)(?!\d)(?!\.\d)/g;
