/** ProjectSettingsDialog — the malformed-config banner (#26), as INTEGRATION over the
 *  real component: the router half is covered in tests/plugins/editorActionRouter.test.ts,
 *  but the whole point of #26 is what the HUMAN sees, and that only exists here.
 *
 *  The bug: reading a malformed project.config.json falls back to the engine defaults
 *  (right — the editor must still open) while writing refuses. Together they showed a
 *  screen of plausible-looking lies; measured on games/sling, Bundle ID read
 *  com.modokiengine.prototype, the identity that project retired.
 *
 *  Why `:disabled` and not `.disabled` below: the IDL property reflects only an element's
 *  OWN disabled attribute, so a control disabled by an ancestor <fieldset disabled>
 *  reports `.disabled === false` while being genuinely inert. Asserting on the property
 *  would have passed against a fieldset that did nothing. Only the pseudo-class sees it. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';

const closeProjectSettings = vi.fn();
vi.mock('../../packages/modoki/src/editor/store/editorStore', () => ({
  useEditorStore: (sel: (s: unknown) => unknown) =>
    sel({ projectSettingsOpen: true, closeProjectSettings }),
}));

// Takes the settings object, like the real schema.save — the arg is unused here (the
// assertions are on whether/how often it was called), but declaring it 0-arg made the
// `save(v)` call below a type error the moment engine/tests/** started being typechecked
// (#23). That is exactly the mock-drifts-from-the-real-thing gap #23 exists to close.
const save = vi.fn(async (_settings: Record<string, unknown>) => true as const);
let load: () => Promise<Record<string, unknown>>;
// The schema object must be a STABLE singleton, exactly as the real getProjectSettings is
// (it returns a module-level `_projectSettings`). Returning a fresh object per call makes
// the dialog's `[open, schema]` effect re-run on every render, which resets activeTab and
// silently undoes a tab click — a mock artifact, not a component bug.
vi.mock('../../packages/modoki/src/editor/createEditor', () => {
  const schema = {
    tabs: [
      {
        title: 'General',
        groups: [{
          title: 'APP IDENTITY',
          fields: [
            { key: 'app.appId', label: 'Bundle ID', type: 'text' },
            { key: 'app.appName', label: 'App name', type: 'text' },
            { key: 'build.debugBuild', label: 'Debug build', type: 'checkbox' },
          ],
        }],
      },
      { title: 'Web', groups: [{ title: '', fields: [{ key: 'build.webBucket', label: 'Bucket', type: 'text' }] }] },
    ],
    // Both indirected through a lambda: the factory runs during the hoisted import,
    // BEFORE `const save`/`let load` below initialize, so capturing them by value is a TDZ error.
    load: () => load(),
    save: (v: Record<string, unknown>) => save(v),
  };
  return { getProjectSettings: () => schema };
});

import ProjectSettingsDialog from '../../packages/modoki/src/editor/panels/ProjectSettingsDialog';

const HEALTHY = { app: { appId: 'com.modokiengine.sling', appName: 'Sling' }, build: { debugBuild: false } };
/** What GET returns when the file exists but does not parse: the ENGINE DEFAULTS, plus
 *  the marker saying so. The identity here is the real measured one from #26. */
const MALFORMED = {
  app: { appId: 'com.modokiengine.prototype', appName: 'Puzzle Prototype' },
  build: { debugBuild: false },
  configErrors: [{ file: 'project.config.json', message: 'project.config.json exists but is not valid JSON (SyntaxError: …).' }],
};

/** Every form control in the dialog, and whether it is EFFECTIVELY disabled. */
const controls = (root: HTMLElement) =>
  [...root.querySelectorAll('input,select,textarea,button')] as HTMLElement[];
const inert = (root: HTMLElement) => controls(root).filter((c) => c.matches(':disabled'));
const live = (root: HTMLElement) => controls(root).filter((c) => !c.matches(':disabled'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ProjectSettingsDialog — a config file that does not parse (#26)', () => {
  it('shows no banner and leaves everything editable when the config is fine', async () => {
    load = async () => structuredClone(HEALTHY);
    const { container, findByDisplayValue, queryByText } = render(<ProjectSettingsDialog />);
    await findByDisplayValue('com.modokiengine.sling');
    expect(queryByText(/could not be read/)).toBeNull();
    expect(container.querySelector('fieldset')?.disabled).toBe(false);
    expect(inert(container)).toHaveLength(0);
  });

  it('names the unreadable file and says the values are engine defaults', async () => {
    load = async () => structuredClone(MALFORMED);
    const { findByText, getByText } = render(<ProjectSettingsDialog />);
    // The headline must NAME the file — "these are defaults" alone would overclaim when
    // only project.user.json failed, since the two files define different fields.
    await findByText(/project\.config\.json could not be read/);
    expect(getByText(/ENGINE DEFAULTS, not this project's values/)).not.toBeNull();
    // The server's own reason is shown verbatim, so the user knows WHAT to repair.
    expect(getByText(/is not valid JSON/)).not.toBeNull();
  });

  it('makes every field inert — including via the fieldset, which owns the sub-editors', async () => {
    load = async () => structuredClone(MALFORMED);
    const { container, findByDisplayValue } = render(<ProjectSettingsDialog />);
    const bundle = await findByDisplayValue('com.modokiengine.prototype');
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    expect(bundle.matches(':disabled')).toBe(true);
    // The checkbox too — it is a separate branch of Field() with its own markup.
    expect((container.querySelector('input[type=checkbox]') as HTMLElement).matches(':disabled')).toBe(true);
  });

  it('leaves the TAB buttons and Cancel live — reading around is fine, editing a lie is not', async () => {
    load = async () => structuredClone(MALFORMED);
    const { container, findByText, getByText } = render(<ProjectSettingsDialog />);
    await findByText(/could not be read/);
    expect(live(container).map((c) => c.textContent)).toEqual(['General', 'Web', 'Cancel']);
    // And switching tab really works, so the other tabs' values stay readable.
    fireEvent.click(getByText('Web'));
    await waitFor(() => expect(getByText('Bucket')).not.toBeNull());
  });

  it('disables Apply, so the save the server would refuse cannot even be attempted', async () => {
    load = async () => structuredClone(MALFORMED);
    const { getByText, findByText } = render(<ProjectSettingsDialog />);
    await findByText(/could not be read/);
    const apply = getByText('Apply');
    expect(apply.matches(':disabled')).toBe(true);
    fireEvent.click(apply);
    expect(save).not.toHaveBeenCalled();
    expect(closeProjectSettings).not.toHaveBeenCalled();
  });

  it('a malformed project.user.json alone says so — it does NOT claim the whole screen is defaults', async () => {
    // app identity is still perfectly real here; only the per-machine fields fell back
    // (and DEFAULT_PROJECT_USER_CONFIG carries the repo owner's real device UDID, so
    // that fallback is its own small lie). The banner must name the file, not the screen.
    load = async () => ({
      ...structuredClone(HEALTHY),
      configErrors: [{ file: 'project.user.json', message: 'project.user.json exists but is not valid JSON (…).' }],
    });
    const { findByText, queryByText } = render(<ProjectSettingsDialog />);
    await findByText(/project\.user\.json could not be read/);
    expect(queryByText(/project\.config\.json could not be read/)).toBeNull();
  });

  it('still renders normally when load() omits configErrors entirely (the healthy shape)', async () => {
    // GET omits the key rather than sending []; an undefined must not throw on .length.
    load = async () => structuredClone(HEALTHY);
    const { container, findByDisplayValue } = render(<ProjectSettingsDialog />);
    await findByDisplayValue('Sling');
    expect(live(container).length).toBe(controls(container).length);
  });
});

/** The coercion banner (#25 follow-up). Coercing an out-of-union value fixed one
 *  invisibility and created another: BEFORE it, `sizeMode: "portrait"` showed as an
 *  unmatched blank in the dropdown — odd enough to notice; AFTER it, the dropdown reads
 *  "Free" and looks perfectly correct while the file still says portrait. Since the write
 *  path deliberately keeps the file's word, the two disagree indefinitely. That is the
 *  same class of "plausible-looking lie" the malformed-file banner above exists for, so
 *  it gets the same treatment — one notch quieter, because everything else on screen is
 *  real and editing is safe. */
const WARNED = {
  ...HEALTHY,
  configWarnings: [{
    path: 'rendering.web.sizeMode',
    value: 'portrait',
    allowed: ['free', 'fixed', 'max'],
    using: 'free',
    message: 'rendering.web.sizeMode: "portrait" is not one of "free" | "fixed" | "max" — using "free".',
  }],
};

describe('ProjectSettingsDialog — an unrecognised config VALUE (#25 follow-up)', () => {
  it('says a default is being shown, and names the field and both values', async () => {
    load = async () => structuredClone(WARNED);
    const { findByTestId, getByText } = render(<ProjectSettingsDialog />);
    await findByTestId('config-warnings');
    expect(getByText(/does not recognise/)).not.toBeNull();
    // The server's own message verbatim: WHICH field, what the file says, what is used.
    expect(getByText(/rendering\.web\.sizeMode: "portrait" .* — using "free"\./)).not.toBeNull();
  });

  it('explains that saving does NOT rewrite the file — the surprising half of the contract', async () => {
    load = async () => structuredClone(WARNED);
    const { findByTestId, getByText } = render(<ProjectSettingsDialog />);
    await findByTestId('config-warnings');
    expect(getByText(/Saving other settings leaves the file's value as-is/)).not.toBeNull();
  });

  it('leaves EVERY control editable — unlike a malformed file, these values are real', async () => {
    // The fix is usually to pick the right entry in the very dropdown being warned about,
    // so disabling the form would lock the user out of the repair.
    load = async () => structuredClone(WARNED);
    const { container, findByTestId } = render(<ProjectSettingsDialog />);
    await findByTestId('config-warnings');
    expect(container.querySelector('fieldset')?.disabled).toBe(false);
    expect(inert(container)).toHaveLength(0);
  });

  it('a malformed file wins: no second banner competing with "cannot be read"', async () => {
    // Both can be sent in principle; a file that does not parse resolves to PURE defaults,
    // so attributing a specific field's fallback to a specific bad value would be a lie.
    load = async () => ({ ...structuredClone(MALFORMED), configWarnings: WARNED.configWarnings });
    const { findByText, queryByTestId } = render(<ProjectSettingsDialog />);
    await findByText(/could not be read/);
    expect(queryByTestId('config-warnings')).toBeNull();
  });

  it('renders nothing when the key is absent (the healthy shape)', async () => {
    load = async () => structuredClone(HEALTHY);
    const { findByDisplayValue, queryByTestId } = render(<ProjectSettingsDialog />);
    await findByDisplayValue('Sling');
    expect(queryByTestId('config-warnings')).toBeNull();
  });
});
