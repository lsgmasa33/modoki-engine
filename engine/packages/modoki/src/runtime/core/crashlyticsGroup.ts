/**
 * The Crashlytics GROUP for one JS report, and the plugin payload that carries it (#1063).
 *
 * ⚠️ **WITHOUT THIS, EVERY JS REPORT MOST LIKELY LANDS IN ONE CONSOLE ISSUE PER PLATFORM.** The
 * Firebase plugin groups on inputs a bare `{ message }` never supplies:
 * - **iOS** records an `NSError`, and Crashlytics groups those by DOMAIN and CODE. The plugin
 *   defaults them to `""` and `-1001`.
 * - **Android** builds a `JavaScriptException` inside the plugin, and Crashlytics groups a throwable
 *   by its STACK. That stack is then the plugin's own Java construction site.
 *
 * So every report shared both, and a brand-new kind of failure raised no new-issue alert. That is
 * read from the plugin's native source and from how Firebase documents grouping, not observed in the
 * console, which only the owner can open.
 *
 * **THE GRAIN IS KIND + NAME** (owner, 2026-09-11). A `journalError` groups by its event name, with
 * its payload ignored, so a varying transaction id cannot split one failure into many issues. An
 * uncaught error groups by kind and error type (`uncaught/TypeError`), and a console line by its
 * leading `[Tag]` when it has one. Two finer grains were rejected:
 * - **by throw site:** a release build is minified, so file and function names change every build
 *   and the same bug would re-alert on each one;
 * - **by exact message:** any id or count in the text makes one issue per occurrence.
 *
 * ⚠️ **DERIVED FROM THE MESSAGE, deliberately — not threaded through as a field.** Every issue-kind
 * report is composed inside the engine (`globalErrors.ts`, `gameJournal.ts`), so the `[label] rest`
 * grammar parsed here is the engine's own. Deriving it at the one place the plugin payload is built
 * reaches the boot queue, the cross-boot stash and its `[prev-boot]` replay for free, where a field
 * would have to ride through each of them. The stash's persisted envelope is `{ kind, text }` only,
 * so a field would also mean a schema change there. The cost: a producer that changes its label shape
 * silently degrades to a coarser group, never a finer one. `crashlyticsGroup.test.ts` drives every
 * producer through this function for exactly that reason.
 */

/** Longest group kept. A group is a console title, and nothing identifying lives past this. */
export const MAX_GROUP_CHARS = 120;

/** The group for a message with no `[label]`. Nothing the engine composes today lacks one. */
export const UNLABELLED_GROUP = 'unlabelled';

/** Android frame file name. Constant, so the group rides in the FUNCTION name alone. */
export const CRASHLYTICS_GROUP_FILE = 'modoki-report-group';

/** A leading `[label] ` — `console.error`, `uncaught-prev-boot`, `journalError`. */
const LABEL = /^\[([A-Za-z][\w.-]*)\] ?/;
/** The marker `globalErrors.ts` puts in front of a report replayed from a boot that died. */
const REPLAY_LABEL = 'prev-boot';
/** An error type at the start of `errorText` output: `TypeError: …`, `FirebaseError`, `Error\n…`.
 *  Only names ending in `Error`/`Exception` count, so ordinary text (`Note: …`) is not one. A
 *  browser's own `Uncaught ` prefix on `ErrorEvent.message` is skipped. ⚠️ The name must be followed
 *  by what `errorText` or a producer writes after one: `:`, a (CR)LF, the end, or ` (` — the
 *  `(file:line:col)` / `(t=Nms)` suffix `globalErrors.ts` appends. Not by a plain space: text such as
 *  `console.error('Error loading scene')` would otherwise group with every real lone `Error`. */
const ERROR_NAME = /^(?:Uncaught )?((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?=:|\r?\n| \(|$)/;
/** A console line's own leading tag, `[MeshCache] …`. Must start with a letter: `[42]` is data. */
const TAG = /^\[([A-Za-z][\w./-]{0,47})\]/;
/** A journal event name: everything up to the first whitespace. */
const TOKEN = /^\S{1,80}/;

function nameFor(label: string, rest: string): string | undefined {
  if (label === 'journalError') return TOKEN.exec(rest)?.[0];
  if (label === 'console.error' || label === 'console.warn') {
    const tag = TAG.exec(rest);
    if (tag) return tag[1];
  }
  return ERROR_NAME.exec(rest)?.[1];
}

/** The grouping key for one report's text, e.g. `journalError/court.iap.durability-unconfirmed`. */
export function crashlyticsGroup(message: string): string {
  let rest = message;
  const parts: string[] = [];
  const replay = LABEL.exec(rest);
  if (replay && replay[1] === REPLAY_LABEL) {
    parts.push(REPLAY_LABEL);
    rest = rest.slice(replay[0].length);
  }
  const label = LABEL.exec(rest);
  if (!label) {
    parts.push(UNLABELLED_GROUP);
  } else {
    parts.push(label[1]);
    const name = nameFor(label[1], rest.slice(label[0].length));
    if (name) parts.push(name);
  }
  return parts.join('/').slice(0, MAX_GROUP_CHARS);
}

/** Structurally the plugin's `StackFrame`. The engine does not depend on the plugin package. */
export interface CrashlyticsStackFrame {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
}

/** Structurally the plugin's `RecordExceptionOptions`, restricted to the fields sent here. */
export interface CrashlyticsExceptionOptions {
  message: string;
  domain?: string;
  code?: number;
  stacktrace?: CrashlyticsStackFrame[];
}

/**
 * The `recordException` payload for one report. A game's Crashlytics wrapper must send THIS, never a
 * hand-built `{ message }`, or its reports lose their group again.
 *
 * ⚠️ **ONE SHAPE PER PLATFORM, and the two must not be merged into one object.** Each uses the input
 * that platform documents grouping by:
 * - **iOS:** `domain` + a fixed `code`, because Crashlytics groups NSErrors by domain and code. A
 *   stacktrace is NOT also sent: when one is present the plugin ignores `domain`, `code` and
 *   `keysAndValues`, and records a generic "Uncaught JavaScript exception" instead.
 * - **Android:** a one-frame `stacktrace` whose function name is the group, because Crashlytics
 *   groups a throwable by its stack. Android ignores `domain` entirely.
 *
 * The full text, including the JS stack `errorText` rendered, stays in `message` on both.
 */
export function crashlyticsExceptionOptions(message: string, platform: string): CrashlyticsExceptionOptions {
  const group = crashlyticsGroup(message);
  if (platform === 'ios') return { message, domain: group, code: 0 };
  return { message, stacktrace: [{ functionName: group, fileName: CRASHLYTICS_GROUP_FILE, lineNumber: 0 }] };
}
