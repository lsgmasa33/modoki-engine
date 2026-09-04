/**
 * Tripwire for `engine/tests/helpers/lineCitations.ts`. (#680, #686)
 *
 * The helper is shared by TWO gates — `qaCaseReferences.test.ts` (the QA cases and the suite's own docs) and
 * `docCitations.test.ts` (the durable feature docs). Its unit cover previously lived inside ONE of those
 * consumers, so it was coupled to that file surviving intact; delete or skip that describe block
 * and both gates keep passing over a detector nothing checks. `helpers/repoLayout.ts` already has
 * a dedicated tripwire (`repoLayoutGuard.test.ts`) for exactly this reason — this is that
 * convention applied to the second helper.
 *
 * These are POSITIVE CONTROLS: each asserts the detector still FIRES. An `offenders === []`
 * assertion in a consumer is satisfied just as well by a detector that has stopped detecting.
 */
import { describe, it, expect } from 'vitest';
import {
  citesALine,
  citesALineByMarker,
  citesALineInProse,
  codeSpans,
  codeTokens,
  isBareLineSpan,
  nonCodeText,
  stripLineRef,
} from '../helpers/lineCitations.js';

describe('lineCitations helper still detects (positive controls)', () => {
  it('every shape found in production is still caught', () => {
    // One entry per shape, in the order they were discovered — each was found only AFTER a sweep
    // using the previous ones reported itself clean.
    expect(citesALine('games/court/runtime/saveSync.ts:1745')).toBe(true); // 1 path
    expect(isBareLineSpan(':170')).toBe(true); //                            2 bare
    expect(citesALine('games/court/accounts.md:762-775')).toBe(true); //     3 doc
    expect(citesALineInProse('the handler (line 79) commits')).toHaveLength(1); // 4 prose
    expect(citesALineInProse('`resolveNav` (lines ~91–108)')).toHaveLength(1); // 5 prose-tilde
    expect(citesALine('CAPPlugin.m:82-93')).toBe(true); //                   6 objective-C
    expect(citesALine('BridgeActivity.onStop():118')).toBe(true); //         7 Class.method()
    expect(citesALineByMarker('the step (release.yml ~L202)')).toEqual(['~L202']); // 8 ~L marker
  });

  it('the extractors still return something for a normal document', () => {
    const md = 'Text with `a.ts` and a fence:\n```bash\nnpm run verify\n```\n';
    expect(codeTokens(md)).toContain('a.ts');
    expect(codeTokens(md)).toContain('verify');
    expect(codeSpans(md)).toContain('a.ts');
  });

  it('stripLineRef still strips, and leaves a bare path alone', () => {
    expect(stripLineRef('foo.ts:12-20')).toBe('foo.ts');
    expect(stripLineRef('foo.ts')).toBe('foo.ts');
  });

  it('the false friends that would get this guard disabled still pass', () => {
    // Each of these was a real false positive that fired on the corpus, or would have.
    expect(citesALine('http://127.0.0.1:5196/api/identity')).toBe(false); // port in a URL
    expect(citesALine('UIElement.width:640')).toBe(false); //                trait field
    expect(citesALine('{"clipPath":"/assets/a.json","value":1}')).toBe(false); // JSON payload
    expect(isBareLineSpan(':2')).toBe(false); //                             handle id
    expect(citesALineInProse('one non-wrapping line 199px wide')).toEqual([]); // rendered px
    expect(citesALineInProse('shrinks the line 40% of the time')).toEqual([]); // percentage
    expect(citesALineInProse('a 40-line function')).toEqual([]); //          compound
  });

  it('a range is a citation whatever its first digit — the rule its comment states', () => {
    // The implementation once required 2+ digits on the FIRST number, so `:9-12` passed while
    // `:45-47` failed, contradicting the rationale written directly above it.
    expect(isBareLineSpan(':9-12')).toBe(true);
    expect(isBareLineSpan(':45-47')).toBe(true);
  });

  it('an EXTERNAL permalink is not a citation into this repo', () => {
    // `#L120` is how you permalink a line in somebody else's repo, and docs/ links KTX-Software
    // that way. The marker detector runs over the raw body, so without the URL exemption this
    // fired with no allowlist able to express it.
    expect(
      citesALineByMarker('see https://github.com/KhronosGroup/KTX-Software/blob/x/toktx.cpp#L120'),
    ).toEqual([]);
    expect(citesALineByMarker('the step (release.yml ~L202)')).toEqual(['~L202']);
  });

  it('nonCodeText exposes the citations codeTokens cannot see', () => {
    // codeTokens reads only spans and fences. An unbackticked citation in a heading, a link label
    // or a table cell is invisible to it — this is the other half of the pair.
    const md = '### boot() — engine/x.ts:1054\n\n[saveSync.ts:1745](../y.ts)\n\n| a | prefab.ts:812 |\n';
    const hits = nonCodeText(md)
      .split(/\s+/)
      .filter((t) => citesALine(t));
    expect(hits).toHaveLength(3);
    // …and it blanks real spans, so two adjacent ones cannot fuse into a slash-bearing token.
    expect(nonCodeText('a `ok:true`/`changed:1` b')).not.toContain('ok:true');
  });

  it('emphasis and possessive wrappers do not hide a citation', () => {
    // The style THIS convention adopted is `` `file.ts`'s `symbol` `` — so a half-migrated
    // citation wears a possessive, and that was exactly the shape the first gate could not see.
    expect(citesALine('**`videoService.ts:135`**')).toBe(true);
    expect(citesALine("`projects.ts:40`'s")).toBe(true);
  });
});
