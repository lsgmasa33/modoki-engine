/** The account-generic contract's public surface (#675). See `types.ts` for the declaration
 *  surface and every doc comment — deliberately carries NO player-visible copy (guarded by
 *  `tests/runtime/accountNoCopy.test.ts`); a game's own account screen owns its wording. */

export {
  ALL_PROVIDERS, reauthProviderFor,
  type AccountProvider, type AccountState, type AvailableProviders, type SignInFailure,
} from './types';
