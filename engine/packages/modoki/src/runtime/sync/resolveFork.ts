/** Resolving a genuine fork once the player has answered (#532). */

import { scopeMarksToAccount } from './decide';
import { persist, type GroupOutcome } from './runGroupSync';
import type {
  AnySyncGroup, CloudGroup, ConflictChoice, GroupTransport, LocalGroup,
} from './types';

export interface ResolveForkOptions {
  transport: GroupTransport;
  uid: string;
  /** Wall-clock ms, injected — never read in here. */
  now: number;
}

/**
 * Apply the player's fork choice for one group and push it.
 *
 * ⚠️ **Re-reads local through the store rather than reusing the `LocalGroup` captured on the `fork`
 * outcome** — a write can have landed on the device while the dialog was open (another sync trigger,
 * another screen), and resolving against a stale snapshot would silently discard it.
 *
 * ⚠️ **The player's chosen content is written to the device even if the push below fails.** That is
 * the deliberate trade: the question WILL return on the next sync, because the fork is unresolved on
 * the server and this device carries no memory of having been asked. Losing the player's answer to a
 * dropped connection is the lesser evil against the alternative — silently believing a fork was
 * settled when the server never heard about it, which is the exact failure `GroupMarks` is built to
 * make impossible to forget (see its own doc).
 *
 * ⚠️ **This pushes DIRECTLY, not back through `runGroupSync`/`runCloudSync`.** Routing the answer through
 * the decision loop would re-derive `'fork'`: the device is still dirty (content differs from the
 * marks) against a server that still holds the OTHER lineage, so `decideGroup` sees exactly the
 * conditions that raised the dialog in the first place, and the player's answer would vanish right
 * back into the dialog it just came out of.
 */
export async function resolveGroupFork(
  group: AnySyncGroup,
  server: CloudGroup<never>,
  choice: ConflictChoice,
  opts: ResolveForkOptions,
): Promise<GroupOutcome> {
  const fresh = group.store.read();
  const local: LocalGroup<never> = {
    ...fresh,
    marks: scopeMarksToAccount(fresh.marks, opts.uid, group.fingerprint(fresh.content)),
  };
  const content = group.merge(local, server, choice);

  // ⚠️ **The merge taught the server nothing, so there is nothing to push** — the same derivation
  // `runGroupSync`'s fork branch makes, and it must be made here too or *keep the cloud* costs a
  // round trip and a version bump on every answer. That bump is not free noise: it moves the
  // server, so every OTHER device on the account then sees a lineage it has to adopt, for a
  // document whose content never changed.
  if (group.fingerprint(content) === group.fingerprint(server.content)) {
    const adopted: LocalGroup<never> = {
      content,
      version: server.version,
      // The server's, for the reason `adoptAndMaybeUpload` gives — this content IS the server's.
      updatedAt: server.updatedAt,
      marks: {
        lastSyncedVersion: server.version,
        lastSyncedFingerprint: group.fingerprint(server.content),
        uid: opts.uid,
        lastSyncedAt: opts.now,
      },
    };
    const ok = await persist(group, adopted);
    if (!ok) return { kind: 'failed', reason: 'content write was not durable' };
    return { kind: 'adopted', version: server.version };
  }

  const version = server.version + 1;

  // The upload has not been acknowledged yet — persist with the marks left describing the OLD
  // exchange, exactly like a plain upload's pre-push state. Only a successful push earns the marks.
  const preUpload: LocalGroup<never> = {
    content, version, updatedAt: local.updatedAt, marks: local.marks,
  };
  const preOk = await persist(group, preUpload);
  if (!preOk) return { kind: 'failed', reason: 'content write was not durable' };

  let result: 'ok' | 'conflict' | 'failed';
  try {
    result = await opts.transport.push(group.id, { content, version, updatedAt: local.updatedAt });
  } catch (e) {
    return { kind: 'failed', reason: `push failed: ${String(e)}` };
  }

  if (result === 'ok') {
    const acknowledged: LocalGroup<never> = {
      content,
      version,
      updatedAt: local.updatedAt,
      marks: {
        lastSyncedVersion: version,
        lastSyncedFingerprint: group.fingerprint(content),
        uid: opts.uid,
        lastSyncedAt: opts.now,
      },
    };
    const ok = await persist(group, acknowledged);
    if (!ok) return { kind: 'failed', reason: 'content write was not durable' };
    return { kind: 'uploaded', version };
  }
  if (result === 'failed') return { kind: 'failed', reason: 'push rejected' };
  // 'conflict' — the server moved again while the player was deciding. The player's answer is
  // already safe on the device (written above); the caller must re-run a full sync pass for this
  // group so it re-reads the server and re-decides against the new lineage.
  return { kind: 'restart' };
}
