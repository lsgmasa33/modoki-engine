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

  switch (field.type) {
    case 'checkbox':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ddd', fontSize: 12 }}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
          {field.help && <span style={{ color: '#666' }}>{field.help}</span>}
        </label>
      );
    case 'number':
      return (
        <div>{label}
          <input type="number" style={inputStyle} value={value == null || value === '' ? '' : Number(value)}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
        </div>
      );
    case 'select':
      return (
        <div>{label}
          <select style={inputStyle} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
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
            <select style={{ ...inputStyle, marginBottom: 4 }} value={known ? cur : ''}
              onChange={(e) => { if (e.target.value) onChange(e.target.value); }}>
              <option value="">{cur && !known ? `— custom: ${cur} —` : '— select a team —'}</option>
              {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <input type="text" style={inputStyle} value={cur}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    }
    case 'string-list':
      return (
        <div>{label}
          <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
            value={Array.isArray(value) ? value.join('\n') : ''}
            placeholder={field.placeholder ?? 'one per line'}
            onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
        </div>
      );
    case 'path':
      return (
        <div>{label}
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="text" style={inputStyle} value={String(value ?? '')}
              placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
            {onPick && (
              <button style={browseBtn} onClick={async () => {
                const picked = await onPick(field.pathMode ?? 'folder');
                if (picked != null) onChange(picked);
              }}>Browse…</button>
            )}
          </div>
        </div>
      );
    case 'scene-list':
      return <div>{label}<SceneListEditor value={value} options={field.options ?? []} onChange={onChange} /></div>;
    case 'physics-layers':
      return <div>{label}<PhysicsLayersEditor value={value} onChange={onChange} /></div>;
    case 'module-toggles':
      return <div>{label}<ModuleTogglesEditor value={value} onChange={onChange} /></div>;
    default:
      return (
        <div>{label}
          <input type="text" style={inputStyle} value={String(value ?? '')}
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
    const ok = await schema.save(draft);
    setSaving(false);
    if (ok) close();
    else console.error('[Editor] Failed to save project settings');
  };

  const tab = schema.tabs[Math.min(activeTab, schema.tabs.length - 1)];

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
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #333', marginBottom: 12, flexWrap: 'wrap' }}>
              {schema.tabs.map((t, i) => (
                <button key={t.title} onClick={() => setActiveTab(i)}
                  style={{
                    padding: '5px 12px', border: 'none', borderBottom: i === activeTab ? '2px solid #2d6cdf' : '2px solid transparent',
                    background: 'transparent', color: i === activeTab ? '#fff' : '#999', cursor: 'pointer',
                    fontFamily: 'monospace', fontSize: 12, marginBottom: -1,
                  }}>{t.title}</button>
              ))}
            </div>

            {/* Active tab's groups */}
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={close} disabled={saving} style={footerBtn}>Cancel</button>
          <button onClick={apply} disabled={saving || draft === null}
            style={{ ...footerBtn, background: '#2d6cdf', borderColor: '#2d6cdf', color: '#fff' }}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
