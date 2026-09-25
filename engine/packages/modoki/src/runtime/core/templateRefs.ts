/** Template-local REFERENCES: how a prefab template names one of its own members (#1352).
 *
 *  A template has no identity space of its own: a member's guid is cleared on write and derived per
 *  instance on load. So a reference held INSIDE a template to another of its members (a
 *  `UIAction.bindings[].target`, any `entityRef` field) cannot be a guid. Written verbatim it kept the
 *  SOURCE world's guid, and every instance drove that one source entity (or nothing, once it was gone).
 *
 *  A template stores such a reference as a MEMBER TOKEN instead: `@member:` + the member's step path
 *  below the root of the instance the value is applied to, dot-joined. The steps are the ones
 *  `deriveInstanceMemberGuids` walks (`memberStepId`, or `'+key'` for a template-keyed added node,
 *  #1387). A leading `^` step climbs to the ENCLOSING instance, so a nested member's value can name a
 *  member of the prefab that nests it. `@member:` alone names the root itself.
 *
 *  - **Frame.** A value is written in the frame of the instance it is applied to: a member's own trait
 *    bag in its prefab's frame, a row's `overrides`/`added` in the nested child's frame, a
 *    `nestedOverrides`/`nestedStructure` entry in the frame of the instance its path addresses.
 *  - **Rebase at read.** Each instantiate call knows its path from the top call (`segments`, one per
 *    nesting level), and rebases every value it applies ({@link rebaseMemberTokens}). Every token in
 *    one instantiate tree then names a path from the top call's root.
 *  - **Resolve.** After the derive pass, each top call's tokens are resolved to the guids its members
 *    derived (`resolveTemplateFrames` in loadSceneFile.ts). A token that resolves to nothing, such as
 *    one pointing into a user-added nested instance, stays as it is: visibly unresolved, never
 *    silently re-pointed.
 *
 *  Tokens are not guid-shaped on purpose. Entity-ref fields are validated as strings only, and a
 *  readable path is what makes rebasing a prefix join and not a hash lookup. See docs/scene-loading.md
 *  § "Guid uniqueness is a PER-FILE rule", "Template identity". */

import { mapStringValues, parseStep, formatStep, type MemberStep } from './assetRefRules';

export const MEMBER_TOKEN_PREFIX = '@member:';

/** A step: a numeric localId step, or `'+key'` for a template-keyed added node. Declared in
 *  `assetRefRules` beside the two functions that produce one (`memberStepId`, `addedKeyStep`) and
 *  re-exported here, because a member token IS a step path and every token caller wants the type. */
export type { MemberStep };

const UP = '^';

export function isMemberToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(MEMBER_TOKEN_PREFIX);
}

/** `up` enclosing-instance climbs, then `path` down from there. */
export function memberToken(up: number, path: readonly MemberStep[]): string {
  return MEMBER_TOKEN_PREFIX + [...Array<string>(up).fill(UP), ...path].join('.');
}

/** The parsed token, or null when it is not one (or is malformed: `^` after a path step). */
export function parseMemberToken(token: string): { up: number; path: MemberStep[] } | null {
  if (!isMemberToken(token)) return null;
  const body = token.slice(MEMBER_TOKEN_PREFIX.length);
  if (!body) return { up: 0, path: [] };
  let up = 0;
  const path: MemberStep[] = [];
  for (const part of body.split('.')) {
    if (part === UP) {
      if (path.length) return null;
      up++;
      continue;
    }
    // The step grammar is `parseStep`'s, not this function's (#1468 Phase 1). A token comes from a
    // file, so it is the one reader that REJECTS a part fitting neither shape rather than letting it
    // through as a step that names nothing.
    const step = parseStep(part);
    if (step === null) return null;
    path.push(step);
  }
  return { up, path };
}

/** The key a step path is indexed under: the same text a token carries. `memberPathSteps` is its
 *  inverse. */
export function memberPathKey(path: readonly MemberStep[]): string {
  return path.map(formatStep).join('.');
}

/** `value` with every member token rebased onto `segments`: the path from the top call's root to
 *  the instance the value is applied to, one segment per nesting level. A `^` climbs one segment. A
 *  token that climbs past the top keeps the climbs left over, counted from the top call's root: a
 *  template reference node's top call resolves those in the frame around it (#1541,
 *  `templateFrameClimber`), and anywhere else they name nothing, as before. Copy-on-write, like
 *  `remapGuidValues`. */
export function rebaseMemberTokens(value: unknown, segments: readonly (readonly MemberStep[])[]): unknown {
  if (!segments.length) return value;
  return mapStringValues(value, (s) => {
    const t = isMemberToken(s) ? parseMemberToken(s) : null;
    if (!t) return s;
    if (t.up > segments.length) return memberToken(t.up - segments.length, t.path);
    return memberToken(0, [...segments.slice(0, segments.length - t.up).flat(), ...t.path]);
  });
}

/** Does `value` hold a member token anywhere? */
export function hasMemberToken(value: unknown): boolean {
  let found = false;
  mapStringValues(value, (s) => { if (!found && isMemberToken(s)) found = true; return s; });
  return found;
}
