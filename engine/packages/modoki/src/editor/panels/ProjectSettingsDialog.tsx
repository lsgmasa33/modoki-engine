/** Project Settings window — a generic, schema-driven, tabbed form. The host
 *  registers the tab/field schema + load/save/pickPath via
 *  createEditor({ projectSettings }); this component renders it and persists on
 *  Apply.
 *
 *  Three things a field carries beyond its input, all of them added because the form could not
 *  answer a question the person in front of it was actually asking:
 *   - `help` renders behind a hover `(i)` (#408), the editor's one convention for an explanation
 *     — shared `Info` in `fields.tsx`, not a second copy. It was permanent inline grey text, and
 *     one of these strings is a ~230-character paragraph sitting next to a checkbox.
 *   - a `path` field holding an image shows a THUMBNAIL and its pixel size, so "square, >=1024px"
 *     is checkable here rather than after a build.
 *   - a `path` field is a DROP TARGET; see {@link PathField} for the copy-or-reference rule. */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { getProjectSettings, type ProjectSettingsField } from '../createEditor';
import PhysicsLayersEditor from './PhysicsLayersEditor';
import SceneListEditor from './SceneListEditor';
import ModuleTogglesEditor from './ModuleTogglesEditor';
import QualityTiersEditor from './QualityTiersEditor';
import { committedPathWarning, imagePreviewPath, shouldAcceptSettingsDrop } from './projectSettingsPaths';
import { Info } from './fields';
import { fileToBase64 } from './fileBytes';
import { backendFetch, backendPostJson } from '../backend/editorBackend';

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

/** One settings field, rendered inert-but-readable when `disabled` (see `disabledIf`).
 *
 *  ⚠️ The disabling lives HERE, in ONE wrapper, and deliberately NOT as a `disabled` prop
 *  threaded through {@link FieldControl}'s twelve `case`s. That enumeration was tried and
 *  reached three of them (checkbox/number/select), so `disabledIf` on a `text`, `path`,
 *  `combo`, `string-list` or any sub-editor field was a SILENT no-op — the control stayed
 *  fully live while claiming to be greyed out. Same reasoning, and the same `<fieldset
 *  disabled>` primitive, as the whole-form `inert` wrapper further down: it disables every
 *  descendant control natively, including a field type nobody has added yet.
 *
 *  A real box, not `display:contents` — unlike that outer wrapper this one is a plain item
 *  in a non-scrolling column, so it has no shrink problem to dodge, and it needs a box for
 *  `opacity`/`pointerEvents` to apply at all. `minWidth:0` because a fieldset's intrinsic
 *  minimum width would otherwise stop it shrinking with the dialog. */
function Field({ disabled, ...props }: React.ComponentProps<typeof FieldControl> & { disabled?: boolean }) {
  return (
    <fieldset
      disabled={disabled}
      style={{
        border: 0, padding: 0, margin: 0, minWidth: 0,
        ...(disabled ? { opacity: 0.45, cursor: 'default', pointerEvents: 'none' } : {}),
      }}
    >
      <FieldControl {...props} />
    </fieldset>
  );
}

/** The absolute path of a dropped `File`, or '' when this host cannot say (a browser-hosted
 *  editor, which has no preload). Exposed by `engine/electron/preload.ts` via Electron's
 *  `webUtils` — `File.path` carried it until Electron 32 removed it. */
function droppedFilePath(file: File): string {
  const fn = (window as unknown as { __modokiElectron?: { getPathForFile?: (f: File) => string } })
    .__modokiElectron?.getPathForFile;
  try {
    return fn ? fn(file) : '';
  } catch {
    return '';
  }
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ok'; url: string; w: number; h: number }
  | { kind: 'error'; message: string };

/** Thumbnail + PIXEL SIZE for a path field pointing at an image.
 *
 *  The size is not decoration. Three of these fields carry a hard requirement in their help text
 *  ("square, ≥1024px", "ideally 2732²") and until now the dialog could not tell you whether the
 *  file obeyed — you found out from a build, or from a blurry icon on a phone. Same for the
 *  failure states: an `iconSource` naming a file somebody has since renamed used to look
 *  IDENTICAL to a correct one, and surfaced as a build error much later.
 *
 *  Fetched rather than pointed at with `<img src>` so the four outcomes stay distinguishable —
 *  `<img onError>` reports "something went wrong" for a 404, a 403 and a corrupt PNG alike, and
 *  "the file is not there" versus "the file is outside the project" are different problems with
 *  different fixes. */
function ImagePreview({ path, uiId }: { path: string; uiId: string }) {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: 'loading' });
    // The value arrives one keystroke at a time — this field is a text box, not only a drop
    // target — so a request per character would be a request per character.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await backendFetch(`/api/source-image?path=${encodeURIComponent(path)}`);
          if (cancelled) return;
          if (!res.ok) {
            const said = await res.json().then((j: { error?: string }) => j?.error).catch(() => undefined);
            if (!cancelled) setState({ kind: 'error', message: res.status === 404 ? 'file not found' : (said ?? `preview failed (${res.status})`) });
            return;
          }
          const blob = await res.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            if (cancelled) return;
            setState({ kind: 'ok', url: objectUrl as string, w: img.naturalWidth, h: img.naturalHeight });
          };
          img.onerror = () => { if (!cancelled) setState({ kind: 'error', message: 'not a readable image' }); };
          img.src = objectUrl;
        } catch (e) {
          if (!cancelled) setState({ kind: 'error', message: String(e) });
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Revoked on the way out, not on the next success: a field being retyped mounts a new
      // request per pause, and every blob would otherwise be held for the life of the dialog.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <div data-ui-id={`${uiId}.preview`} data-ui-kind="text" style={{ color: '#a06060', fontSize: 11, marginTop: 4 }}>
        {state.message}
      </div>
    );
  }
  return (
    <div data-ui-id={`${uiId}.preview`} data-ui-kind="text" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <img
        src={state.url}
        alt=""
        style={{
          width: 48, height: 48, objectFit: 'contain', borderRadius: 3, border: '1px solid #444',
          // A checkerboard, because these are transparent PNGs by nature (the monochrome icon,
          // the splash TITLE overlay) and a transparent image on a flat dark panel reads as an
          // empty box — indistinguishable from the failure this preview exists to reveal.
          backgroundColor: '#2a2a35',
          backgroundImage: 'linear-gradient(45deg, #22222c 25%, transparent 25%), linear-gradient(-45deg, #22222c 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #22222c 75%), linear-gradient(-45deg, transparent 75%, #22222c 75%)',
          backgroundSize: '8px 8px',
          backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
        }}
      />
      <span style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>
        {/* A decode that reports no intrinsic size (an SVG without one) would otherwise print
            "0 x 0" as if it were a measurement, in the one place this UI exists to report a real
            one. Only the ZERO case is handled: a browser may instead substitute the 300x150
            replaced-element default, which is indistinguishable here from a real 300x150 image —
            unverified either way, since jsdom always reports 0 and no shipped field takes an SVG.
            Do not widen this on a guess; observe it in the running editor first. */}
        {state.w > 0 && state.h > 0
          ? `${state.w} x ${state.h}${state.w === state.h ? '' : ' (not square)'}`
          : 'size not declared'}
      </span>
    </div>
  );
}

/** A `path` field: text box + Browse…, plus (#408 follow-up) an image preview and drag-and-drop.
 *
 *  Its own component rather than a `case` in {@link FieldControl} because it holds hooks, which a
 *  switch branch cannot.
 *
 *  **The drop rule is the owner's** (2026-08-29): a dropped file is COPIED into the project —
 *  these values are committed, so an absolute path to somewhere on this Mac is dead on every
 *  other clone (#394) — EXCEPT when the file is already inside the project, which is referenced
 *  where it lies rather than duplicated beside itself. Deciding that needs the dropped file's
 *  SOURCE path, which is why `preload.ts` exposes `webUtils.getPathForFile`; with no preload
 *  (a browser-hosted editor) there is no path, and the drop falls back to always copying, which
 *  is the safe direction — a redundant copy, never a dead reference. */
function PathField({ field, value, onChange, onPick, label, uiId }: {
  field: ProjectSettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  onPick?: (mode: 'file' | 'folder') => Promise<string | null>;
  label: React.ReactNode;
  uiId: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  // Read at drop time, not from a prop: one read covers both inert states and any future one.
  // See `shouldAcceptSettingsDrop`.
  //
  // ⚠️ `:disabled`, NOT `input.disabled`. The IDL property reflects the element's OWN `disabled`
  // content attribute and nothing else, so it reads `false` for an input that is disabled purely
  // by an ancestor `<fieldset disabled>` — which is every case here, since that is exactly how
  // this dialog disables things. The pseudo-class is the one that accounts for the ancestor.
  const inputRef = useRef<HTMLInputElement>(null);
  const isInert = () => inputRef.current?.matches(':disabled') ?? false;

  // #394 — said at the control, whatever produced the value: the picker relativises a file
  // inside the project, but one outside it has no relative form and the text box takes
  // anything. The gate guard catches a committed one; this catches it a step earlier.
  const pathWarning = committedPathWarning(field, value);
  const previewPath = imagePreviewPath(field, value);

  const adopt = async (payload: Record<string, unknown>, file: File | null) => {
    let res = await backendPostJson('/api/adopt-file', payload);
    // 400 is the backend saying "that file is not in the project and you sent me no bytes" — the
    // only case that needs the upload. Sending the bytes up front instead would base64 a 2732²
    // splash on EVERY drop, including the common one where the file is already in `art/` and not
    // a byte needs to move.
    if (!res.ok && res.status === 400 && file) {
      res = await backendPostJson('/api/adopt-file', { ...payload, name: file.name, content: await fileToBase64(file) });
    }
    const body = await res.json().catch(() => ({})) as { path?: string; error?: string };
    if (!res.ok || !body.path) throw new Error(body.error ?? `drop failed (${res.status})`);
    return body.path;
  };

  const onDrop = (e: React.DragEvent) => {
    if (!shouldAcceptSettingsDrop(isInert(), Array.from(e.dataTransfer.types))) return;
    e.preventDefault();
    setDragOver(false);
    setDropError(null);
    // Read BOTH payloads synchronously: a DataTransfer is emptied the moment this handler yields,
    // so anything read after the first `await` comes back blank.
    const assetJson = e.dataTransfer.getData('application/editor-asset');
    const file = e.dataTransfer.files?.[0] ?? null;
    const payload: Record<string, unknown> = {};
    if (assetJson) {
      try {
        payload.assetPath = (JSON.parse(assetJson) as { path?: string }).path;
      } catch { /* not our payload — fall through to the file branch */ }
    }
    if (payload.assetPath == null) {
      if (!file) return;
      const abs = droppedFilePath(file);
      if (abs) payload.abs = abs;
      payload.name = file.name;
    }
    void (async () => {
      try {
        onChange(await adopt(payload, file));
      } catch (err) {
        setDropError(String(err instanceof Error ? err.message : err));
      }
    })();
  };

  return (
    <div
      onDragOver={(e) => {
        if (!shouldAcceptSettingsDrop(isInert(), Array.from(e.dataTransfer.types))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={dragOver ? { outline: '1px dashed #6a8ec0', outlineOffset: 2, borderRadius: 3 } : undefined}
    >
      {label}
      <div style={{ display: 'flex', gap: 6 }}>
        <input ref={inputRef} data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="text" style={inputStyle} value={String(value ?? '')}
          placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        {onPick && (
          <button data-ui-id={`${uiId}.browse`} data-ui-kind="button" data-ui-label={`Browse ${field.label}`} style={browseBtn} onClick={async () => {
            const picked = await onPick(field.pathMode ?? 'folder');
            if (picked != null) onChange(picked);
          }}>Browse…</button>
        )}
      </div>
      {pathWarning && (
        <div data-ui-id={`${uiId}.warning`} data-ui-kind="text" style={{ color: '#e0b060', fontSize: 11, marginTop: 3 }}>{pathWarning}</div>
      )}
      {dropError && (
        <div data-ui-id={`${uiId}.dropError`} data-ui-kind="text" style={{ color: '#a06060', fontSize: 11, marginTop: 3 }}>{dropError}</div>
      )}
      {previewPath && <ImagePreview path={previewPath} uiId={uiId} />}
    </div>
  );
}

function FieldControl({ field, value, onChange, onPick }: {
  field: ProjectSettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  onPick?: (mode: 'file' | 'folder') => Promise<string | null>;
}) {
  const label = (
    <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>
      {field.label}
      {field.help && <Info text={field.help} />}
    </div>
  );

  const uiId = `projectSettings.${field.key}`;

  switch (field.type) {
    case 'checkbox':
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ddd', fontSize: 12 }}>
          <input data-ui-id={uiId} data-ui-kind="toggle" data-ui-label={field.label} data-ui-state={value ? 'checked' : 'unchecked'} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
          {field.help && <Info text={field.help} />}
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
      return <PathField field={field} value={value} onChange={onChange} onPick={onPick} label={label} uiId={uiId} />;
    // Masked because the value is a signing-key password and this dialog is routinely open while
    // the owner screen-shares or screenshots the editor (#370). It is masking, NOT secrecy: the
    // value round-trips through the same GET/POST as every other field and sits in plain text in
    // the gitignored project.user.json, which is the honest place for it.
    case 'password':
      return (
        <div>{label}
          <input data-ui-id={uiId} data-ui-kind="field" data-ui-label={field.label} type="password" autoComplete="off" style={inputStyle} value={String(value ?? '')}
            placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
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
        // 940, not the old 540: the Graphics tab's quality-tier MATRIX is four columns wide
        // (#403) and a 540px dialog scrolled it sideways at every window size, which defeats the
        // point of putting the tiers side by side. `92vw` still bounds it on a small display, and
        // the narrower tabs simply centre their content rather than stretching.
        padding: '16px 20px', width: 940, maxWidth: '92vw', maxHeight: '85vh',
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
                          disabled={field.disabledIf !== undefined && String(getByPath(draft, field.disabledIf.key) ?? '') === field.disabledIf.is}
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
