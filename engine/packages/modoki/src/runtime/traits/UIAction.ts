import { trait } from 'koota';
import type { UIActionBinding } from '../ui/bindings';

/** UIAction — event handlers for interactive UI elements.
 *
 *  A single flat list of bindings. Each binding fires on one event (click /
 *  change / submit) and either writes a property declaratively (`kind:'set'`) or
 *  dispatches a named action (`kind:'call'`). This unifies what used to be six
 *  separate fields (onClick/onClickPayload/onClickTarget/onClickSet/onChange/
 *  onSubmit) into one honest model — see runtime/ui/bindings.ts.
 *
 *   - A button that opens Credits and closes Settings = two `set` bindings on
 *     `click`.
 *   - A slider that drives a system = one `call` binding on `change`.
 *   - A slider that writes a field directly = one `set` binding on `change` with
 *     `value:'$value'` (the live slider number), no game code.
 *
 *  koota note: this is an AoS trait (callback form) because `bindings` is an
 *  array — koota forbids array fields in the plain object (SoA) form. The callback
 *  runs per entity, so each element gets its OWN fresh `bindings` array (no shared
 *  default). applyBindings only reads it and the editor replaces it immutably, so
 *  never mutate the live array in place. `.schema` is undefined for AoS traits;
 *  serialize/prefab snapshot fall back to the registered field list. */
export const UIAction = trait(() => ({
  bindings: [] as UIActionBinding[],
}));
