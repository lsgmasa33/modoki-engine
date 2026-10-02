/** OTA Keys dialog → "Sync to Project Settings": whether writing a key's public half into
 *  `ota.publicKey` needs the user to confirm it first (#1993).
 *
 *  Filling an EMPTY `ota.publicKey` is the ordinary first-time setup: no build trusts any key yet.
 *  Replacing a non-empty one is a ROTATION: every binary already shipped has the old public half baked
 *  in and rejects every release the new key signs, so those installs never update again. It used to be
 *  one click, which made "keygen minted a key on a second machine" a two-click way to strand them. */

export interface OtaKeySyncConfirmation { title: string; message: string; okLabel: string }

/** Null when the sync needs no confirmation; the question to ask otherwise. */
export function otaKeySyncConfirmation(configPublicKey: string | null | undefined, keyPublicKey: string, keyName: string): OtaKeySyncConfirmation | null {
  if (!configPublicKey || configPublicKey === keyPublicKey) return null;
  return {
    title: 'Replace the shipped OTA public key?',
    message: `Project Settings → OTA → Public key is ${configPublicKey}, and every build already shipped has it baked in.\n\n`
      + `Replacing it with key "${keyName}" (${keyPublicKey}) means none of those installs can verify an update again: they stay on what they have until a new store release reaches them.\n\n`
      + 'If the original key is only on another machine or in a backup, copy it into this project\'s build/ota-keys/ instead (docs/ota-updates.md § Signing key).',
    okLabel: 'Replace key',
  };
}

/** The POST body for the sync: the key's public half, PRECONDITIONED on the value the decision above was made against
 *  (`readPublicKey`, the click-time read; #2049). The route refuses 409 `{conflict:true}` when `ota.publicKey` holds
 *  anything else by the time the user answers, so a value an agent or another window set while the confirm was open is
 *  never replaced unasked. `''` is what an empty field reads as. */
export function otaKeySyncBody(keyPublicKey: string, readPublicKey: string | null | undefined): Record<string, unknown> {
  return { ota: { publicKey: keyPublicKey }, expected: { ota: { publicKey: readPublicKey ?? '' } } };
}

/** What the dialog says when that precondition refuses the write. */
export const OTA_KEY_SYNC_CONFLICT =
  'Project Settings → OTA → Public key changed while you were deciding, so nothing was written. '
  + 'The value shown is the one there now; press Sync again to decide against it.';
