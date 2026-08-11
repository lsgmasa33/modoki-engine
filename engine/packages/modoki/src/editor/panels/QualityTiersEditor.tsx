/** Authored quality-tier editor — the widget behind the 'quality-tiers' Project Settings field
 *  (docs/rendering.md § "Quality tiers"). Edits `rendering.three.tiers`
 *  (`AuthoredTiers`): a project starts with ONE config — the default, i.e. nothing clamped —
 *  and may ADD a `mid` and/or `low` degradation on top of it, each seeded from the engine's
 *  measured `TIER_SETTINGS` so "Add low" gives today's measured behaviour as a starting point
 *  (owner requirement, plan §3), never ten blank fields.
 *
 *  The DECISIONS (seed, remove-by-omission, flip one post-FX effect) live in
 *  `qualityTiersModel.ts` and are unit-tested there — this file only renders them. See that
 *  module's header for why a removed tier's key is OMITTED, never nulled. */

import {
  POSTFX_EFFECTS,
  type TierRenderOverrides,
  type PostFXEffect,
} from '../../runtime/rendering/qualityTier';
import {
  type TieredKey,
  normalizeAuthoredTiers,
  addTier,
  removeTier,
  withField,
  withPostFX,
} from './qualityTiersModel';

const TIER_ORDER: readonly TieredKey[] = ['mid', 'low'];

const POSTFX_LABELS: Record<PostFXEffect, string> = {
  npr: 'NPR outline', ao: 'GTAO', dof: 'Depth of field', bloom: 'Bloom', vignette: 'Vignette',
};

type NumberField = 'pixelRatioCap' | 'shadowMapCeiling' | 'maxDirectional' | 'maxLocal' | 'iblOffAmbientBoost' | 'iblOffExposure' | 'targetFps' | 'pixiPixelRatioCap';
type CheckboxField = 'antialias' | 'shadows' | 'ibl' | 'pixiAntialias';

/** Per-field help, carrying the MEASUREMENT that justifies the seeded value (plan §3's tables)
 *  so the Inspector explains itself rather than presenting bare numbers. `mid` gets its own
 *  `shadowMapCeiling` text — the one seeded value with no measurement behind it. */
function fieldHelp(tier: TieredKey, field: NumberField | CheckboxField): string {
  switch (field) {
    case 'pixelRatioCap':
      return 'Y6, IBL already off: 1x = 22ms/45fps, 1.4x = 72ms/14fps, 2x = 69ms/14fps — a fill-bound GPU pays ~4x for 2x DPR, more than the headroom covers, so the saving goes to frame rate, not resolution.';
    case 'antialias':
      return 'Baked into the swapchain at renderer construction — cannot change live.';
    case 'shadows':
      return 'A 512 shadow map is measured unusable (see shadowMapCeiling below), so a tier with no room for a bigger map drops shadows rather than shipping acne.';
    case 'shadowMapCeiling':
      return tier === 'mid'
        ? '0 = no ceiling. ⚠️ The ONE seeded value here with neither a measurement nor a carry-forward — 512 is measured unusable and 2048 is what projects author, so 1024 is the step between. The field most likely to want a human eye on it.'
        : '0 = no ceiling. Y6: 2048 renders clean; 512 renders a dithered, under-sampled mess whatever the bias — resolution is the dominant term, not bias.';
    case 'maxDirectional':
    case 'maxLocal':
      return '0 = unlimited. A23 ladder: 1 directional = 21ms, +3 point = 34ms, +8 point = 165ms — superlinear, with a cliff between 5 and 10 lights. ⚠️ Not yet enforced by the renderer (autoLightCap.ts is unwired) — authored intent for when it is, not a live limit today.';
    case 'ibl':
      return 'Y6: IBL costs ~26ms of a ~53ms frame, entirely GPU. Off took sling 18.7→36.5 fps. Not fixable by shrinking the HDR — three’s PMREM samples a fixed-size CubeUV map regardless of source size.';
    case 'iblOffAmbientBoost':
    case 'iblOffExposure':
      return 'Compensation for IBL off, to put the lighting back: 30.4ms/32.9fps with it applied, vs 27.4/36.5 uncompensated and 53.4/18.7 with IBL left on. Clears the 33.3ms budget with the look preserved.';
    case 'targetFps':
      return tier === 'low'
        ? '0 = no tier cap. Capping to 30 halves per-second GPU and CPU work and cuts thermal throttling — it also buys feel: a device that cannot hold 60 judders between 40 and 55, where a 30 cap is a stable 30. ⚠️ THE ONE SEEDED VALUE IN THIS EDITOR THAT IS A DELIBERATE BEHAVIOUR CHANGE, not a carry-forward of what the fleet already did (owner, 2026-08-11) — every other seeded value preserves today.'
        : '0 = no tier cap. Left uncapped because no mid-band device has been measured missing 60 — inventing a cap here would be exactly the guess this table exists to avoid.';
    case 'pixiPixelRatioCap':
      return '0 = uncapped. The 2D twin of Pixel-ratio cap above, carrying the SAME Y6 measurement (1x = 22ms/45fps, 2x = 69ms/14fps, ~4x cost for 2x DPR) rather than a separate one — that is a fill-rate fact about a tile-based mobile GPU, not a Three.js fact, so it applies to a Pixi canvas identically. pixi.resolution is deliberately NOT tiered: it is a pin, and capping a pin would make the pin a lie.';
    case 'pixiAntialias':
      return 'Same live-change limitation as Antialias above: baked into the Pixi Application when a canvas slot is created, so a tier change catches up on the next slot rather than applying immediately.';
    default:
      return '';
  }
}

const POSTFX_HELP = 'iPhone 8: 27ms baseline → 56ms with NPR alone — screen-space, so the cost is per-pixel however simple the scene. NPR ~+29ms vs vignette ~6ms vs bloom ~4ms: seven-to-one, so each effect is gated individually rather than by one switch (owner, 2026-08-11).';

const card: React.CSSProperties = {
  border: '1px solid #333', borderRadius: 3, background: '#15151f', padding: '8px 10px', marginBottom: 8,
};
const cardHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
};
const tierTitle: React.CSSProperties = { color: '#fff', fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase' };
const removeBtn: React.CSSProperties = {
  padding: '2px 9px', border: '1px solid #663', borderRadius: 3, background: '#2a2020',
  color: '#e88', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
};
const addBtn: React.CSSProperties = {
  padding: '4px 10px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40',
  color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, marginBottom: 8,
};
const fieldRow: React.CSSProperties = { marginBottom: 6 };
const fieldLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, color: '#ddd', fontSize: 11 };
const fieldHelpStyle: React.CSSProperties = { color: '#666', fontSize: 10, marginTop: 2, lineHeight: 1.4 };
const numberInput: React.CSSProperties = {
  width: 90, boxSizing: 'border-box', padding: '2px 6px', background: '#0d0d14', color: '#ddd',
  border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11,
};
const defaultCard: React.CSSProperties = {
  border: '1px dashed #333', borderRadius: 3, background: '#101018', padding: '8px 10px',
  marginBottom: 8, color: '#888', fontSize: 11, lineHeight: 1.4,
};

function NumberRow({ tier, field, label, cfg, onChange, dataUiId }: {
  tier: TieredKey; field: NumberField; label: string; cfg: TierRenderOverrides;
  onChange: (next: TierRenderOverrides) => void; dataUiId?: string;
}) {
  return (
    <div style={fieldRow}>
      <label style={fieldLabel}>
        {label}
        <input type="number" style={numberInput} value={cfg[field]} data-ui-id={dataUiId}
          onChange={(e) => onChange(withField(cfg, field, e.target.value === '' ? 0 : Number(e.target.value)))} />
      </label>
      <div style={fieldHelpStyle}>{fieldHelp(tier, field)}</div>
    </div>
  );
}

function CheckboxRow({ tier, field, label, cfg, onChange, dataUiId }: {
  tier: TieredKey; field: CheckboxField; label: string; cfg: TierRenderOverrides;
  onChange: (next: TierRenderOverrides) => void; dataUiId?: string;
}) {
  return (
    <div style={fieldRow}>
      <label style={fieldLabel}>
        <input type="checkbox" checked={cfg[field]} data-ui-id={dataUiId}
          onChange={(e) => onChange(withField(cfg, field, e.target.checked))} />
        {label}
      </label>
      <div style={fieldHelpStyle}>{fieldHelp(tier, field)}</div>
    </div>
  );
}

function TierCard({ tier, cfg, onChange, onRemove }: {
  tier: TieredKey; cfg: TierRenderOverrides;
  onChange: (next: TierRenderOverrides) => void; onRemove: () => void;
}) {
  return (
    <div style={card}>
      <div style={cardHeader}>
        <span style={tierTitle}>{tier}</span>
        {/* `data-ui-id` so this is aimable by SELECTOR rather than by pixel. Every coordinate
            aim into a SCROLLING form is a guess that silently lands on whatever is at that
            point — verifying this button by eye cost a wrong conclusion (a screenshot that
            showed the `low` card was read as "mid is gone"). See docs/debug-tools-mcp.md. */}
        <button style={removeBtn} data-ui-id={`quality-tiers.remove.${tier}`} onClick={onRemove}>
          Remove {tier}
        </button>
      </div>
      <NumberRow tier={tier} field="pixelRatioCap" label="Pixel-ratio cap" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.pixelRatioCap`} />
      <CheckboxRow tier={tier} field="antialias" label="Antialias" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.antialias`} />
      <CheckboxRow tier={tier} field="shadows" label="Shadows" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.shadows`} />
      <CheckboxRow tier={tier} field="ibl" label="IBL (image-based lighting)" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.ibl`} />
      <NumberRow tier={tier} field="shadowMapCeiling" label="Shadow-map ceiling" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.shadowMapCeiling`} />
      <NumberRow tier={tier} field="maxDirectional" label="Max directional lights" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.maxDirectional`} />
      <NumberRow tier={tier} field="maxLocal" label="Max point/spot lights" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.maxLocal`} />
      <NumberRow tier={tier} field="iblOffAmbientBoost" label="IBL-off ambient boost" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.iblOffAmbientBoost`} />
      <NumberRow tier={tier} field="iblOffExposure" label="IBL-off exposure boost" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.iblOffExposure`} />
      <div style={{ color: '#aaa', fontSize: 11, marginTop: 2, marginBottom: 3 }}>2D layer & frame cap</div>
      <NumberRow tier={tier} field="targetFps" label="Target FPS" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.targetFps`} />
      <NumberRow tier={tier} field="pixiPixelRatioCap" label="2D pixel-ratio cap" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.pixiPixelRatioCap`} />
      <CheckboxRow tier={tier} field="pixiAntialias" label="2D antialias" cfg={cfg} onChange={onChange}
        dataUiId={`quality-tiers.field.${tier}.pixiAntialias`} />
      <div style={fieldRow}>
        <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>Post-FX</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {POSTFX_EFFECTS.map((effect) => (
            <label key={effect} style={{ ...fieldLabel, gap: 4 }}>
              <input type="checkbox" checked={cfg.postFX[effect]}
                onChange={(e) => onChange(withPostFX(cfg, effect, e.target.checked))} />
              {POSTFX_LABELS[effect]}
            </label>
          ))}
        </div>
        <div style={fieldHelpStyle}>{POSTFX_HELP}</div>
      </div>
    </div>
  );
}

export default function QualityTiersEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const authored = normalizeAuthoredTiers(value);

  return (
    <div style={{ color: '#ddd', fontSize: 12 }}>
      <div style={defaultCard}>
        <b style={{ color: '#aaa' }}>default</b> — this project&apos;s own <code>rendering.three</code> settings,
        with nothing clamped. Not stored here; there is nothing to edit — every device gets this
        until a tier below is added.
      </div>
      {TIER_ORDER.map((tier) => {
        const cfg = authored[tier];
        return cfg ? (
          <TierCard key={tier} tier={tier} cfg={cfg}
            onChange={(next) => onChange({ ...authored, [tier]: next })}
            onRemove={() => onChange(removeTier(authored, tier))} />
        ) : (
          <button key={tier} style={addBtn} data-ui-id={`quality-tiers.add.${tier}`}
            onClick={() => onChange(addTier(authored, tier))}>
            + Add {tier}
          </button>
        );
      })}
    </div>
  );
}
