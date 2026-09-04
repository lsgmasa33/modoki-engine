/** The account-generic contract for a game with sign-in — provider identity, the sign-in/out/delete
 *  state machine, and re-auth arm selection, as PURE types plus one function (#675).
 *
 *  ## What moved here, and what deliberately did not
 *
 *  Split out of Court's `runtime/accountUi.ts` (#675, itself split out of #658). The owner's ruling
 *  (2026-09-04): **the account/conflict UI is game-specific.** The issue that proposed this move
 *  warned that "an engine module that hardcodes English is worse than a duplicated one — it is a
 *  localisation blocker in a place a game cannot reach", and that is avoided here by moving ZERO
 *  English, not by moving it carefully. So this module carries the DECISIONS a sign-in flow makes —
 *  which state it is in, which provider re-authenticates before a delete — and none of the copy.
 *  Every string a player reads (`providerLine`, `signInErrorText`, `syncLine`, `relativeTime`, the
 *  row-visibility builders `accountRows`/`AccountRows`) stays in the game that owns the screen —
 *  Court's `runtime/accountUi.ts` today, the only consumer that exists (#675 flagged **zero second
 *  consumers** — this was not built speculatively).
 *
 *  ## Layering
 *
 *  L2, and it imports no other L2 folder — this module has no imports at all. Pure and clock-free:
 *  `reauthProviderFor` takes no injected clock because it needs none.
 */

/** Which arm the player signed in through.
 *
 *  ⚠️ This is the CANONICAL type — `@court/app-services`'s `AuthProvider` (`auth.ts`) is a type
 *  alias of this one, not a structural copy. That package already depends on
 *  `@modoki/engine/runtime` elsewhere (`ads.ts`, `index.ts`, `milestones.ts`, `track.ts`), so a
 *  type-only import here costs it nothing — no Capacitor pulled in, no plain-unit-test hazard — and
 *  aliasing is what makes the two types unable to drift apart. */
export type AccountProvider = 'apple' | 'google' | 'unknown';

/** What the account screen is showing. `working` is not cosmetic — it is what stops a second tap
 *  starting a second sign-in sheet over the first. */
export type AccountState =
  | { kind: 'signed-out' }
  /** `overdue` (#594): this attempt has outrun its watchdog and is still running. Display-only —
   *  it never changes what the row OFFERS, only what it SAYS — and is only ever set for
   *  `what: 'deleting'`: past `beginAccountDelete`'s destructive re-arm the continuation is
   *  uncancellable by design (see `systems.ts`'s `accountDeleteDestructive`), so the watchdog for
   *  that case keeps asserting `working` rather than releasing the screen back to a stale truth. */
  | { kind: 'working'; what: 'signing-in' | 'signing-out' | 'deleting'; overdue?: boolean }
  /** `providers` is EVERY provider linked to the account, never empty — see `CourtUser.providers`
   *  in `@court/app-services`. It is a list because Firebase USED TO link Apple and Google onto one
   *  `uid` when the same email used both (#384), and there was then no honest single answer.
   *
   *  ⚠️ That linking setting changed 2026-09-01 and is NOT retroactive — an account merged before the
   *  change (including the owner's own) still reports more than one provider; only an account created
   *  after the change gets exactly one. See `CourtUser.providers` in `auth.ts` for the full account. */
  | { kind: 'signed-in'; providers: readonly AccountProvider[]; lastSyncedAt: number; uid: string }
  /** A sign-in that failed for a reason the player can act on. `cancelled` never reaches here —
   *  backing out of a sheet is not an error and must show nothing at all.
   *
   *  ⚠️ `stillSignedIn` distinguishes a failure that left the player with an ACCOUNT from one that
   *  did not, and it exists because the delete flow produced the wrong screen: a failed delete put
   *  up "Sign in with Apple / Continue with Google" for someone who was still signed in, and hid
   *  the Sign out / Delete rows they might reasonably want. Found in close-out review. */
  | { kind: 'error'; text: string; stillSignedIn?: boolean };

/**
 * Which providers this platform can complete. Passed in rather than read, so this module stays pure
 * — `@court/app-services`' `providersFor(getPlatform())` supplies the real one.
 *
 * ⚠️ **Apple is hidden on Android** (owner, 2026-08-27): the plugin would need a web-redirect flow
 * Court has not configured, so the button would dead-end. A control that cannot complete reads as a
 * broken game. Apple must keep appearing on iOS — App Store guideline 4.8 requires it wherever
 * another third-party sign-in is offered, and that is Apple's store rule, not Google's.
 */
export interface AvailableProviders {
  apple: boolean;
  google: boolean;
}

/** Every provider available — the default `reauthProviderFor` (and Court's own `accountRows`) fall
 *  back to when the caller has no platform-specific answer (a design-time preview, a test). */
export const ALL_PROVIDERS: AvailableProviders = { apple: true, google: true };

/** Why a sign-in failed, EXCLUDING `cancelled` — the one union every surface that reports a
 *  sign-in failure shares (`accountUi.ts`'s `signInErrorText`, the post-purchase card's latched
 *  outcome in `systems.ts`, and `PurchaseNoticeInputs.signInFailure` in `storeUi.ts`). Named rather
 *  than re-typed at each site: `cancelled` is absent BY CONSTRUCTION — backing out of the sheet is a
 *  decision, not a failure — and a hand-copy of that carve-out is exactly the kind of list that
 *  goes stale invisibly when `AuthFailure` gains a member. */
export type SignInFailure = 'network' | 'not-configured' | 'credential-in-use' | 'failed';

/**
 * Which arm to re-authenticate through before deleting the account, or `null` when this platform
 * can complete none of the account's providers (#593).
 *
 * ⚠️ **Re-authentication here IS a sign-in.** `@capacitor-firebase/authentication` (8.4.0) exposes
 * no `reauthenticate*` method at all — `signInWith*`, `linkWith*` and `deleteUser`, nothing else —
 * and the JS SDK's `reauthenticateWithCredential` is out of reach because the credential lives in
 * the NATIVE SDK (the same fact that makes `cloudSave.ts` use the native Firestore plugin). So a
 * fresh credential is minted by running the provider's sign-in again, and this decides which one.
 *
 * **The account's OWN list is what is iterated, filtered by what the platform can complete** — not
 * the platform's list filtered by the account. Signing in through a provider the account does not
 * carry would mint a DIFFERENT `uid`, which is the wrong account to delete.
 *
 * ⚠️ **Deterministic per PLATFORM, not across them** — an earlier draft of this banner claimed two
 * devices could not pick differently for one account, and that is false: `providersFor` hides Apple
 * on Android, so a linked `['apple','google']` account picks `apple` on iOS and `google` on Android.
 * That is harmless, and it is the point rather than a leak — every arm the account carries
 * authenticates the SAME `uid`, so which one re-authenticates does not change what gets deleted. The
 * fixed list order is what makes the choice deterministic on a given device; it is not, and does not
 * need to be, a cross-device agreement.
 *
 * `null` is a real answer, not a failure: an account whose only provider is `unknown` (a leftover
 * anonymous sign-in) has no sheet to run, and Apple-only on Android has no arm Court has configured.
 * The caller must still let deletion proceed — App Store 5.1.1(v) is not conditional on which
 * provider the player used, so refusing there would trade one unreachable delete for another.
 */
export function reauthProviderFor(
  providers: readonly AccountProvider[],
  available: AvailableProviders = ALL_PROVIDERS,
): 'apple' | 'google' | null {
  for (const provider of providers) {
    if (provider === 'apple' && available.apple) return 'apple';
    if (provider === 'google' && available.google) return 'google';
  }
  return null;
}
