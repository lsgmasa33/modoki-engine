/**
 * Unit cover for the shared section-citation syntax (#1095 review).
 *
 * Two corpus guards depend on this pattern — `docCitations.test.ts` (prose, repo-wide) and
 * `qaCaseReferences.test.ts` (QA frontmatter) — and BOTH read it as an oracle: a shape the regex
 * cannot see is not reported as a miss, it is reported as "nothing to check". That is exactly how
 * this pattern's first version did damage: it could not match a citation ending a sentence, the
 * completeness rule went quietly green over 132 → 124 citations, and eight true declarations were
 * deleted from the corpus to match what the detector could see. Both floors held throughout.
 *
 * So the fixtures below are the SHAPES THAT ACTUALLY OCCUR, asserted on the captured doc AND id.
 * Every one of them failed against the version that shipped.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_CITE, headingIds } from '../helpers/docSections';

/** All (doc, section) pairs in a string — `SECTION_CITE` is /g, so it must be reset per use. */
function cites(text: string): Array<[string, string]> {
  SECTION_CITE.lastIndex = 0;
  return [...text.matchAll(SECTION_CITE)].map(([, doc, section]) => [doc, section]);
}

describe('SECTION_CITE — the shapes the corpus actually writes', () => {
  it('matches a citation that ENDS A SENTENCE', () => {
    // The regression that deleted eight declarations: `(?![.\d])` refused the trailing period.
    expect(cites('recorded in qa/knowledge.md § 9. That same run')).toEqual([['qa/knowledge.md', '9']]);
  });

  it('keeps a LETTERED subsection whole rather than backtracking to its number', () => {
    // `§13b.` captured `13` and repointed a correct citation at the enclosing section.
    expect(cites('See [qa/knowledge.md](../../knowledge.md) §13b.')).toEqual([
      ['qa/knowledge.md', '13b'],
    ]);
    expect(cites('(`qa/knowledge.md` §13d.C). A')).toEqual([['qa/knowledge.md', '13d']]);
  });

  it('still refuses a DECIMAL, which is what the tail is for', () => {
    expect(cites('see docs/thing.md § 8.5 for the ratio')).toEqual([]);
  });

  it('matches across a LINE WRAP — case prose wraps at ~100 columns', () => {
    expect(cites('per `qa/knowledge.md`\n    § 8 the save')).toEqual([['qa/knowledge.md', '8']]);
  });

  it('takes the whole number, so § 12 is never read as § 1', () => {
    expect(cites('qa/knowledge.md § 12 covers multi-lane')).toEqual([['qa/knowledge.md', '12']]);
  });

  it('captures an UPPERCASE suffix rather than truncating it', () => {
    expect(cites('`qa/knowledge.md` § 5A calls that state')).toEqual([['qa/knowledge.md', '5A']]);
  });

  it('resolves the markdown-LINK form via its link text', () => {
    expect(cites('[qa/knowledge.md](../../knowledge.md) § 7 says')).toEqual([
      ['qa/knowledge.md', '7'],
    ]);
  });

  it('⚠️ attributes to the NEARER doc when two are named before one § — a known miss', () => {
    // Not a passing property: this documents the shape the pattern gets WRONG, so the next reader
    // meets it as a known limit rather than rediscovering it. `docCitations`'s rule-4 docblock
    // records the same miss. A per-doc anchored scan is the shape that does not have it.
    expect(cites('docs/editor.md and qa/knowledge.md § 8 says')).toEqual([['docs/editor.md', '8']]);
  });
});

describe('headingIds', () => {
  it('reads the numbered heading forms the docs use', () => {
    const ids = headingIds(['## 1. Start', '### 3b. Screenshot', '## ⚠️ 25. Warned', '#### 8a-bis. Odd'].join('\n'));
    expect([...ids].sort()).toEqual(['1', '25', '3b', '8a-bis']);
  });

  it('ignores an UNNUMBERED heading and body text that looks like one', () => {
    expect([...headingIds(['## Where things live', 'A line: 5. not a heading'].join('\n'))]).toEqual([]);
  });
});
