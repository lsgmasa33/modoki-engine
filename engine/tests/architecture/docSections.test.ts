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
import { SECTION_CITE, citedDoc, headingIds } from '../helpers/docSections';

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

describe('citedDoc — a linked citation names its TARGET, not its text (#1519)', () => {
  /** The doc each `SECTION_CITE` match in `text` points at. */
  function docs(text: string): string[] {
    SECTION_CITE.lastIndex = 0;
    return [...text.matchAll(SECTION_CITE)].map((m) => citedDoc(text, m));
  }

  // The accept side the issue asked for: text and target name DIFFERENT files, and only the target
  // has the section. Reading the text went red on a correct citation (games/wordweave's store listing).
  it('a link whose text names another file resolves to the target', () => {
    expect(docs("see [Court's legal-drafts/README.md](../court/legal-drafts/README.md) § 3 for it"))
      .toEqual(['../court/legal-drafts/README.md']);
  });

  it('an abbreviated or backticked link text resolves to the target', () => {
    expect(docs('[rendering.md](../rendering.md) § 4')).toEqual(['../rendering.md']);
    expect(docs('[`qa/knowledge.md`](../../knowledge.md) §13b.')).toEqual(['../../knowledge.md']);
  });

  it('drops an anchor and decodes an escaped target', () => {
    expect(docs('[a.md](../My%20Docs/b.md#part-two) § 2')).toEqual(['../My Docs/b.md']);
  });

  it('a bare path, or one after a CLOSED link, is its own doc', () => {
    expect(docs('`docs/editor.md` § 5')).toEqual(['docs/editor.md']);
    expect(docs('[see here](https://x.test) then docs/build.md § 7')).toEqual(['docs/build.md']);
    // A link LATER on the line is not this path's link: `](…)` follows it, but no `[` opened before it.
    expect(docs('docs/build.md § 7, and [more](other.md)')).toEqual(['docs/build.md']);
  });

  it('an in-page anchor link keeps the text, since there is no doc to resolve', () => {
    expect(docs('[docs/build.md](#build) § 7')).toEqual(['docs/build.md']);
  });
});
