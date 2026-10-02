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
