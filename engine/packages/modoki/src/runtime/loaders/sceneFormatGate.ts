/** The scene format-version gate (docs/format-versioning.md § 2b-bis — Scene is REFUSE).
 *
 *  A LEAF on purpose: it imports only the two DOM-free version modules, so the Node-side backend
 *  router (`engine/plugins/backend/editorBackendRouter.ts`) can call the same gate on
 *  `/api/scene-mutate`'s file-direct write as `SceneManager` and `loadSceneFile` call on a load.
 *  `loadSceneFile.ts` itself drags koota and the ECS world in, which that router must not. */

import { MIN_READABLE_SCENE_FORMAT_VERSION, SCENE_FORMAT_VERSION } from '../core/version';
import { classifyFormatVersion } from '../core/formatVersion';

/** Thrown by `loadSceneFile` when a scene's format version is `too-new`, `too-old` or `unreadable`
 *  (docs/format-versioning.md § 2b-bis — Scene is REFUSE). A named class rather than a bare
 *  `Error` so a caller several frames up (the editor's `loadScene` wrapper, item 2/3 of #784
 *  phase C3) can tell "this load was refused because of its format version" apart from every
 *  other reason a scene load can throw (a missing file, a bad prefab ref, …) without parsing
 *  the message. Mirrors `ImportWriteAborted` (`editor/scene/modelImport.ts`) and
 *  `MissingAssetError` (`runtime/loaders/assetFetch.ts`) — the established shape in this repo
 *  for "a specific, nameable reason a throw needs to survive to a caller that must react
 *  differently to it than to a generic failure". */
export class SceneFormatRefusedError extends Error {
  readonly reason: 'too-new' | 'too-old' | 'unreadable';
  constructor(message: string, reason: 'too-new' | 'too-old' | 'unreadable') {
    super(message);
    this.name = 'SceneFormatRefusedError';
    this.reason = reason;
  }
}

/** Refuse a scene this build cannot read, whatever the caller. The one gate: both `SceneManager`
 *  (before it acquires a scene's resources) and `loadSceneFile` (for every other caller) call it,
 *  so the two cannot disagree on a verdict.
 *
 *  `too-old` covers a version below `MIN_READABLE_SCENE_FORMAT_VERSION` AND a scene with no
 *  `version` at all. Both used to run a v3→v8 ladder; that ladder is gone (#1769), so loading
 *  either as-is would spawn its pre-v8 shapes as defaults and drop them on the next save. That is
 *  the silent data loss this refusal exists to prevent. */
export function assertSceneFormatReadable(data: unknown): void {
  const verdict = classifyFormatVersion(data, SCENE_FORMAT_VERSION, { minReadable: MIN_READABLE_SCENE_FORMAT_VERSION });
  if (verdict.kind === 'too-new') {
    throw new SceneFormatRefusedError(
      `Scene not loaded: its format version (${verdict.version}) is newer than this ` +
      `engine supports (${SCENE_FORMAT_VERSION}). Update the engine to open this scene.`,
      'too-new',
    );
  }
  if (verdict.kind === 'too-old' || verdict.kind === 'absent') {
    const found = verdict.kind === 'too-old' ? `format version ${verdict.version}` : 'no format version';
    // A versionless file is more likely hand-written than old: every editor since v3 stamps one.
    const why = verdict.kind === 'too-old'
      ? 'No released editor wrote an older scene.'
      : 'Every editor since format v3 writes one, so this file was probably written by hand.';
    throw new SceneFormatRefusedError(
      `Scene not loaded: it has ${found}, and this engine reads scenes from format version ` +
      `${MIN_READABLE_SCENE_FORMAT_VERSION} up. ${why}`,
      'too-old',
    );
  }
  if (verdict.kind === 'unreadable') {
    throw new SceneFormatRefusedError(
      `Scene not loaded: its format version is unreadable (${verdict.reason}). ` +
      `The file may be corrupt or hand-edited incorrectly.`,
      'unreadable',
    );
  }
}
