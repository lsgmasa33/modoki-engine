/** Project Settings window — a generic, schema-driven, tabbed form. The host
 *  registers the tab/field schema + load/save/pickPath via
 *  createEditor({ projectSettings }); this component renders it and persists on
 *  Apply. */

import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { getProjectSettings, type ProjectSettingsField } from '../createEditor';
import PhysicsLayersEditor from './PhysicsLayersEditor';
import SceneListEditor from './SceneListEditor';
import ModuleTogglesEditor from './ModuleTogglesEditor';
import QualityTiersEditor from './QualityTiersEditor';

type Values = Record<string, unknown>;

function getByPath(obj: Values, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Values)[k]), obj);
}

function setByPath(obj: Values, key: string, value: unknown): Values {
  const keys = key.split('.');
  const next: Values = structuredClone(obj);
  let cur = next;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]] as Values;
  }
  cur[keys[keys.length - 1]] = value;
  return next;
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '4px 8px',
  background: '#15151f', color: '#ddd', border: '1px solid #444', borderRadius: 3,
  fontFamily: 'monospace', fontSize: 12,
};
const browseBtn: React.CSSProperties = {
  padding: '4px 10px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40',
  color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap',
};

function Field({ field, value, onChange, onPick }: {
  field: ProjectSettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  onPick?: (mode: 'file' | 'folder') => Promise<string | null>;
}) {
  const label = (
    <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>
      {field.label}
      {field.help && <span style={{ color: '#666', marginLeft: 6 }}>{field.help}</span>}
    </div>
  );

  const uiId = `projectSettings.${field.key}`;

  switch (field.type) {
    case 'checkbox':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ddd', fontSize: 12 }}>
          <input data-ui-id={uiId} data-ui-kind="toggle" data-ui-label={field.label} data-ui-state={value ? 'checked' : 'unchecked'} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
          {field.help && <span style={{ color: '#666' }}>{field.help}</span>}
        </label>
      );
    case 'number':
      return (
        <div>{label}
          <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="number" style={inputStyle} value={value == null || value === '' ? '' : Number(value)}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
        </div>
      );
    case 'select':
      return (
        <div>{label}
          <select data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} style={inputStyle} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      );
    case 'combo': {
      // A visible dropdown of discovered options ("Name (ID)") PLUS a text box —
      // pick a known entry from the pull-down, or type a raw value (e.g. a team
      // not yet installed on this machine). The stored value is always the raw
      // string (the 10-char Team ID); the text box is the source of truth and the
      // select just writes into it. Selecting the leading placeholder is a no-op
      // (never clears an existing value).
      const opts = field.options ?? [];
      const cur = String(value ?? '');
      const known = opts.some((o) => o.value === cur);
      return (
        <div>{label}
          {opts.length > 0 && (
            <select data-ui-id={`${uiId}.select`} data-ui-kind="field" data-ui-label={`${field.label} (known)`} style={{ ...inputStyle, marginBottom: 4 }} value={known ? cur : ''}
              onChange={(e) => { if (e.target.value) onChange(e.target.value); }}>
              <option value="">{cur && !known ? `— custom: ${cur} —` : '— select a team —'}</option>
              {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="text" style={inputStyle} value={cur}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    }
    case 'string-list':
      return (
        <div>{label}
          <textarea data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
            value={Array.isArray(value) ? value.join('\n') : ''}
            placeholder={field.placeholder ?? 'one per line'}
            onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
        </div>
      );
    case 'path':
      return (
        <div>{label}
          <div style={{ display: 'flex', gap: 6 }}>
            <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="text" style={inputStyle} value={String(value ?? '')}
              placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
            {onPick && (
              <button data-ui-id={`${uiId}.browse`} data-ui-kind="button" data-ui-label={`Browse ${field.label}`} style={browseBtn} onClick={async () => {
                const picked = await onPick(field.pathMode ?? 'folder');
                if (picked != null) onChange(picked);
              }}>Browse…</button>
            )}
          </div>
        </div>
      );
    case 'readonly-text':
      return (
        <div>{label}
          <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="text" disabled style={{ ...inputStyle, color: '#888', background: '#101018', cursor: 'default' }}
            value={String(value ?? '')} placeholder={field.placeholder} />
        </div>
      );
    case 'scene-list':
      return <div>{label}<SceneListEditor value={value} options={field.options ?? []} onChange={onChange} /></div>;
    case 'physics-layers':
      return <div>{label}<PhysicsLayersEditor value={value} onChange={onChange} /></div>;
    case 'module-toggles':
      return <div>{label}<ModuleTogglesEditor value={value} onChange={onChange} /></div>;
    case 'quality-tiers':
      return <div>{label}<QualityTiersEditor value={value} onChange={onChange} /></div>;
    default:
      return (
        <div>{label}
          <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="text" style={inputStyle} value={String(value ?? '')}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
  }
}

const footerBtn: React.CSSProperties = {
  padding: '5px 18px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
};

export default function ProjectSettingsDialog() {
  const open = useEditorStore((s) => s.projectSettingsOpen);
  const close = useEditorStore((s) => s.closeProjectSettings);
  const schema = getProjectSettings();
  const [draft, setDraft] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    if (!open || !schema) return;
    let cancelled = false;
    setDraft(null);
    setActiveTab(0);
    schema.load()
      .then((v) => { if (!cancelled) setDraft(v ?? {}); })
      .catch((e) => { if (!cancelled) { console.error('[Editor] Failed to load project settings:', e); setDraft({}); } });
    return () => { cancelled = true; };
  }, [open, schema]);

  if (!open || !schema) return null;

  const apply = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    const res = await schema.save(draft);
    setSaving(false);
    if (res === true) { close(); return; }
    // Keep the dialog open AND say why: the draft is still in the fields, so the
    // user can fix the offending value in place. Failing silently here meant a
    // refused save looked identical to a click that did nothing.
    const msg = typeof res === 'string' ? res : 'Failed to save project settings';
    setSaveError(msg);
    console.error('[Editor]', msg);
  };

  const tab = schema.tabs[Math.min(activeTab, schema.tabs.length - 1)];

  // A config file that EXISTS but doesn't parse: the backend read falls back to the
  // ENGINE DEFAULTS so the editor still opens, which means every field below is a
  // plausible-looking lie (measured on games/sling: Bundle ID "com.modokiengine.prototype",
  // App name "Puzzle Prototype" — an identity that project retired). Saving is already
  // refused server-side, so the file is safe; the danger is purely that someone READS
  // these values and believes them. Say so, and take editing away until it's repaired —
  // a value you cannot act on is better than one you can't tell is wrong.
  const configErrors = (draft?.configErrors ?? []) as { file: string; message: string }[];
  const inert = configErrors.length > 0;

  // One notch down from the banner above: the file PARSED, but a field holds a value no
  // consumer handles, so what you see is a substituted default. Editing stays ENABLED —
  // unlike a malformed file, the rest of these values are the project's real ones, and
  // the fix is usually to pick the right entry in the very dropdown this is warning about.
  // Worth saying out loud because the coercion made the wrong value INVISIBLE: before it,
  // `sizeMode: "portrait"` showed as an unmatched blank; now the dropdown reads "Free" and
  // looks perfectly correct while the file still says portrait.
  const configWarnings = (draft?.configWarnings ?? []) as { path: string; message: string }[];

  return (
    // Close ONLY when the press STARTS on the scrim itself. Using onMouseDown +
    // target===currentTarget means a text drag-select that starts inside an input
    // and releases over the scrim no longer closes the dialog (the old onClick bug).
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '16px 20px', width: 540, maxWidth: '92vw', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', marginBottom: 12 }}>Project Settings</div>

        {draft === null ? (
          <div style={{ color: '#888', fontSize: 12 }}>Loading…</div>
        ) : (
          <>
            {inert && (
              <div style={{
                marginBottom: 12, padding: '8px 10px', background: '#3a2e1e', border: '1px solid #a80',
                color: '#f0d0a0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
              }}>
                {/* Name the FILES rather than claiming the whole screen is defaults: only
                    project.user.json failing leaves app identity perfectly real, and the two
                    files own different fields. Overclaiming here would be the same sin the
                    banner exists to fix. Editing is off wholesale regardless, because the
                    save refuses on either file — it is one Apply for both. */}
                <b>{configErrors.map((e) => e.file).join(' and ')} could not be read. The fields
                  {configErrors.length > 1 ? ' those files define' : ' that file defines'} are
                  showing ENGINE DEFAULTS, not this project's values.</b>
                {configErrors.map((e) => <div key={e.file} style={{ marginTop: 4 }}>{e.message}</div>)}
                <div style={{ marginTop: 4 }}>Editing is disabled until it is valid JSON again.</div>
              </div>
            )}

            {!inert && configWarnings.length > 0 && (
              <div data-testid="config-warnings" style={{
                marginBottom: 12, padding: '8px 10px', background: '#2e2a1e', border: '1px solid #776',
                color: '#e0d8b0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
              }}>
                <b>project.config.json holds {configWarnings.length === 1 ? 'a value' : 'values'} this
                  engine does not recognise. {configWarnings.length === 1 ? 'That field is' : 'Those fields are'} showing
                  a default instead.</b>
                {configWarnings.map((w) => <div key={w.path} style={{ marginTop: 4 }}>{w.message}</div>)}
                {/* Say what the save does, because it is deliberately NOT what you'd assume:
                    the file keeps its own word until this field is edited (see the write-path
                    note in project-config.ts) — so the disagreement persists on purpose. */}
                <div style={{ marginTop: 4 }}>
                  Saving other settings leaves the file&apos;s value as-is; set this field to change it.
                </div>
              </div>
            )}

            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #333', marginBottom: 12, flexWrap: 'wrap' }}>
              {schema.tabs.map((t, i) => (
                <button key={t.title} data-ui-id={`projectSettings.tabs.${i}`} data-ui-kind="tab" data-ui-label={t.title} data-ui-state={i === activeTab ? 'selected' : undefined} onClick={() => setActiveTab(i)}
                  style={{
                    padding: '5px 12px', border: 'none', borderBottom: i === activeTab ? '2px solid #2d6cdf' : '2px solid transparent',
                    background: 'transparent', color: i === activeTab ? '#fff' : '#999', cursor: 'pointer',
                    fontFamily: 'monospace', fontSize: 12, marginBottom: -1,
                  }}>{t.title}</button>
              ))}
            </div>

            {/* Active tab's groups. A <fieldset disabled> is what makes the whole form
                inert in ONE place: it disables every descendant control natively,
                including the ones inside the sub-editors (physics layers, scene list,
                module toggles) that never took a disabled prop. Tab switching stays
                live on purpose — reading around is fine, editing a lie is not.
                `display:contents` so the fieldset generates NO box: as a real flex item
                it does not shrink (fieldset ignores min-height:0), which pushed the
                scroll area past the dialog and put the footer on top of the fields —
                measured. The scrolling div below stays the layout box it always was. */}
            <fieldset disabled={inert} style={{ display: 'contents' }}>
            <div style={{
              overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16,
              opacity: inert ? 0.5 : 1,
            }}>
              {tab.groups.map((group) => (
                <div key={group.title}>
                  {group.title && (
                    <div style={{ color: '#7a7a9a', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, borderBottom: '1px solid #333', paddingBottom: 4 }}>
                      {group.title}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {group.fields
                      .filter((field) => !field.showIf || field.showIf.in.includes(String(getByPath(draft, field.showIf.key) ?? '')))
                      .map((field) => (
                        <Field key={field.key} field={field} value={getByPath(draft, field.key)}
                          onPick={schema.pickPath}
                          onChange={(v) => setDraft((d) => (d ? setByPath(d, field.key, v) : d))} />
                      ))}
                  </div>
                </div>
              ))}
            </div>
            </fieldset>
          </>
        )}

        {saveError && (
          <div style={{
            marginTop: 12, padding: '8px 10px', background: '#3a1e1e', border: '1px solid #a33',
            color: '#f2b8b8', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>{saveError}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button data-ui-id="projectSettings.footer.cancel" data-ui-kind="button" data-ui-label="Cancel" onClick={close} disabled={saving} style={footerBtn}>Cancel</button>
          <button data-ui-id="projectSettings.footer.apply" data-ui-kind="button" data-ui-label="Apply" onClick={apply} disabled={saving || draft === null || inert}
            title={inert ? 'Repair the config file first — a save onto a file that could not be read is refused.' : undefined}
            style={{ ...footerBtn, background: '#2d6cdf', borderColor: '#2d6cdf', color: '#fff', opacity: inert ? 0.4 : 1 }}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
