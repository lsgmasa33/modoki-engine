/** What "Publish OTA Update…" offers as a Bundle, and the engine-API line it shows for each (#837).
 *
 *  Decisions only; `PublishOtaDialog.tsx` renders them. The route (`/api/ota/publish`) makes the same
 *  split and is what actually refuses: this module exists so the dialog never offers a choice the
 *  route would not build, and never leaves the engine-API value to be guessed. */

export interface OtaPublishSettings {
  bundleName?: string;
  engineApi?: number;
  subgames?: readonly unknown[];
}

export interface OtaBundleChoice {
  bundleName: string;
  kind: 'shell' | 'subgame';
}

/** The shell first, then each listed sub-game id once. A malformed entry, or a sub-game named the
 *  same as the shell, is not offered: the route refuses both, and offering them would only move the
 *  refusal to after the click. */
export function otaBundleChoices(ota: OtaPublishSettings | undefined): OtaBundleChoice[] {
  const shell = ota?.bundleName || 'shell';
  const out: OtaBundleChoice[] = [{ bundleName: shell, kind: 'shell' }];
  const seen = new Set([shell]);
  for (const id of ota?.subgames ?? []) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ bundleName: id, kind: 'subgame' });
  }
  return out;
}

/** The engine-API line under the Bundle field. A sub-game's value is not known until its build
 *  stamps it, so the line states the value it must EQUAL rather than inventing one. */
export function otaEngineApiNote(choice: OtaBundleChoice, shellEngineApi: number | undefined): string {
  const shell = shellEngineApi === undefined ? 'unknown' : String(shellEngineApi);
  if (choice.kind === 'shell') {
    return `Engine API ${shell}: this project's ota.engineApi, stamped into the bundle.`;
  }
  return `Engine API: stamped by ${choice.bundleName}'s build from its own ota.engineApi, and refused ` +
    `before upload unless it equals this shell's ${shell}. A device loads a sub-game only on an exact match.`;
}
