/** UINode — renders a single UI entity as a DOM element. Recursive for children. */

import React, { lazy, Suspense } from 'react';
import type { UINodeData } from './useUIEntities';
import { applyBindings } from './bindings';
import { resolveTemplate, evalVisibility } from './bindingResolver';

// A Canvas2D UI element embeds a pooled PixiJS canvas — a render2d feature. Gate the
// mount behind the flag (lazy) so a 3D-only build (render2d off) DCEs Canvas2DMount,
// and PixiJS with it (UINode is on the shared UI path, so a static import here pulls
// pixi.js into every game). A scene that actually uses Canvas2D resolves render2d=true
// via the detector, so `null` here only ever coincides with "no 2D content".
const Canvas2DMount = __MODOKI_MODULE_RENDER2D__
  ? lazy(() => import('../rendering/Canvas2DMount').then((m) => ({ default: m.Canvas2DMount })))
  : null;
import { resolveDomImageUrl, resolveSprite } from '../rendering/renderUtils';
import { isGuid } from '../loaders/assetManifest';
import { applyAnchorStyle } from './anchorCss';
import { NineSliceImage } from './NineSliceImage';
import { uiTextAnimation, ensureUITextAnimStyles } from './uiTextAnimation';
import { useFocusStore } from './focusManager';

/** The CSS-animated text span, isolated in React.memo. The game UI re-renders every
 *  frame (fps is in its store selector); re-creating the span each frame RESTARTS its
 *  CSS animation (it never advances → looks frozen). Memoizing on the primitive props
 *  (all value-stable frame-to-frame) makes React bail out, leaving the span's DOM
 *  untouched so the browser-driven animation runs uninterrupted. */
const AnimatedText = React.memo(function AnimatedText(
  { text, animation, ampPx, extra, perCharStagger, perCharLoop, perCharFade }:
  { text: string; animation: string; ampPx: number; extra?: Record<string, string>;
    perCharStagger?: number; perCharLoop?: boolean; perCharFade?: boolean },
) {
  // Typewriter: split into one span per glyph and stagger each by `perCharStagger`, so
  // whole glyphs pop in sequence (a width clip slices mid-glyph on a proportional font).
  // Reveal is by opacity with the layout pre-allocated → no reflow. Memoized on
  // primitives (like the whole-element path) so the parent's per-frame re-renders don't
  // rebuild the spans and restart the animation. aria-label carries the full string;
  // the per-glyph spans are aria-hidden so screen readers read it once, not letter-by-letter.
  if (perCharStagger != null) {
    const chars = Array.from(text);
    const typeDur = chars.length * perCharStagger;
    // Loop cycle = type + a hold long enough that the staggered erase finishes (and a
    // brief blank gap shows) before the first glyph retypes. -in pops fast per glyph.
    const total = typeDur + Math.max(1.6, typeDur * 4);
    const popDur = Math.min(0.1, Math.max(0.03, perCharStagger));
    // fadeIn off → each glyph appears/vanishes instantly (mechanical typewriter feel):
    // a steps() timing on the one-shot, and the -cycle-hard keyframe for the loop.
    const fade = perCharFade !== false;
    return (
      <span aria-label={text} style={{ display: 'inline-block', whiteSpace: 'pre-wrap' }}>
        {chars.map((ch, i) => {
          const delay = i * perCharStagger;
          const anim = perCharLoop
            ? `${fade ? 'mdk-ui-type-cycle' : 'mdk-ui-type-cycle-hard'} ${total.toFixed(3)}s linear ${delay.toFixed(3)}s infinite both`
            : `mdk-ui-type-in ${popDur.toFixed(3)}s ${fade ? 'ease-out' : 'steps(1,jump-start)'} ${delay.toFixed(3)}s 1 both`;
          return <span key={i} aria-hidden={true} style={{ animation: anim }}>{ch}</span>;
        })}
      </span>
    );
  }
  const style: React.CSSProperties = { display: 'inline-block', animation, willChange: 'transform', ...(extra as React.CSSProperties) };
  if (ampPx) (style as Record<string, string>)['--ui-amp'] = `${ampPx}px`;
  return <span style={style}>{text}</span>;
});

/** Convert a numeric value + unit string to a CSS value. Returns undefined if value is 0/falsy.
 *  Viewport units (vw/vh/vmin/vmax) use CSS custom properties set by UIRenderer so they
 *  resolve relative to the UI container, not the browser window. This is critical for the
 *  editor's simulated device viewport. */
export function cssVal(value: number, unit: string): string | number | undefined {
  if (!value) return undefined;
  switch (unit) {
    case '%':    return `${value}%`;
    case 'vw':   return `calc(${value} * var(--ui-vw, 1vw))`;
    case 'vh':   return `calc(${value} * var(--ui-vh, 1vh))`;
    case 'vmin': return `calc(${value} * var(--ui-vmin, 1vmin))`;
    case 'vmax': return `calc(${value} * var(--ui-vmax, 1vmax))`;
    default:     return value; // px
  }
}

export function hexToRgba(hex: number, opacity: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r},${g},${b},${opacity})`;
}

export function hexToColor(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

interface UINodeProps {
  node: UINodeData;
  storeState: Record<string, unknown>;
  onSelectEntity?: (entityId: number) => void;
  /** Editor injection: render the 2D canvas for a Canvas2D node inline in the UI
   *  tree, so it stacks by hierarchy exactly like the runtime. Returns null to
   *  hide 2D (the editor's 2D layer toggle). When omitted, the runtime mounts
   *  its pooled PixiJS canvas via Canvas2DMount. */
  renderCanvas2D?: (entityId: number) => React.ReactNode;
  /** Editor: render UI nodes as invisible layout-only structure — keeps the tree
   *  (so nested Canvas2D canvases still mount/position) while the UI layer is
   *  toggled off. Canvas content is unaffected (gated separately by renderCanvas2D). */
  uiVisualsHidden?: boolean;
}

function UINodeInner({ node, storeState, onSelectEntity, renderCanvas2D, uiVisualsHidden }: UINodeProps) {
  // Focus ring (controller/keyboard navigation, Part B). Runtime only — the editor's
  // click-to-select mode (onSelectEntity set) is authoring, not gameplay nav. The
  // selector subscribes THIS node to the focus store, so only the entering/leaving
  // node re-renders when focus moves. Hook runs before any early return (React rule).
  const isFocused = useFocusStore((s) => !onSelectEntity && s.focusedGuid !== '' && s.focusedGuid === node.guid);

  // isVisible is authored (or flipped by a button's UIAction `kind:'set'` binding). A
  // state-driven visibility binding (UIBinding.visibleBinding) can additionally hide the element
  // from a store field — BOTH must be true to render. Play-time only (gated on `!onSelectEntity`,
  // like the focus hook above): in the editor (authoring, empty storeState) the element must stay
  // visible + selectable — only the authored isVisible hides it there.
  if (!node.isVisible) return null;
  if (!onSelectEntity && node.binding?.visibleBinding &&
      !evalVisibility(storeState, node.binding.visibleBinding, node.binding.visibleOp || '', node.binding.visibleValue || '')) {
    return null;
  }

  // Resolve text
  let text = node.text || '';
  if (node.binding?.textBinding && text) {
    text = resolveTemplate(text, storeState);
  }

  // Build CSS style
  const style: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: node.flexDirection as any,
    flexWrap: node.flexWrap as any,
    justifyContent: node.justifyContent,
    alignItems: node.alignItems,
    gap: node.gap || undefined,
    flexGrow: node.flexGrow,
    flexShrink: node.flexShrink,
    width: cssVal(node.width, node.widthUnit),
    height: cssVal(node.height, node.heightUnit),
    paddingTop: cssVal(node.paddingTop, node.paddingTopUnit),
    paddingLeft: cssVal(node.paddingLeft, node.paddingLeftUnit),
    paddingRight: cssVal(node.paddingRight, node.paddingRightUnit),
    paddingBottom: cssVal(node.paddingBottom, node.paddingBottomUnit),
    marginTop: cssVal(node.marginTop, node.marginTopUnit),
    marginLeft: cssVal(node.marginLeft, node.marginLeftUnit),
    marginRight: cssVal(node.marginRight, node.marginRightUnit),
    marginBottom: cssVal(node.marginBottom, node.marginBottomUnit),
    minWidth: cssVal(node.minWidth, node.minWidthUnit),
    maxWidth: cssVal(node.maxWidth, node.maxWidthUnit),
    minHeight: cssVal(node.minHeight, node.minHeightUnit),
    maxHeight: cssVal(node.maxHeight, node.maxHeightUnit),
    alignSelf: node.alignSelf !== 'auto' ? node.alignSelf as any : undefined,
    zIndex: node.zIndex || undefined,
    overflow: node.overflow === 'scroll' ? 'auto' : node.overflow as any,
    boxSizing: 'border-box',
  };

  // ── Focus ring ──
  // Data-driven outline drawn when this element is the focused nav target. Kept as a
  // non-layout `outline` (+offset) so it never shifts the flexbox box. Pointer/touch
  // is unaffected — focus is only set when nav input arrives.
  if (isFocused) {
    style.outline = '2px solid #4aa3ff';
    style.outlineOffset = '2px';
  }

  // ── Style (box visuals) ──
  if (node.backgroundOpacity > 0) style.backgroundColor = hexToRgba(node.backgroundColor, node.backgroundOpacity);
  if (node.borderRadius) style.borderRadius = node.borderRadius;
  if (node.borderWidth) {
    style.borderWidth = node.borderWidth;
    style.borderStyle = 'solid';
    style.borderColor = hexToRgba(node.borderColor, node.borderOpacity ?? 1);
  }
  if (node.opacity < 1) style.opacity = node.opacity;

  // ── Image ──
  // 9-slice sprites render as a decorative overlay layer (see below); a plain image
  // renders as a CSS background. Built here, injected as the first child of the return.
  let nineSliceLayer: React.ReactNode = null;
  if (node.imageSrc) {
    // DOM images (CSS background / NineSliceImage <img>) MUST resolve to a browser-
    // decodable URL — the browser can't decode the KTX2 GPU variant. resolveDomImageUrl
    // returns the WebP variant (a 2d/ui texture always has one). warnKtx=true: this is the
    // production DOM, so a mis-typed 3d texture (no WebP sibling) warns rather than 404 silently.
    const imgUrl = resolveDomImageUrl(node.imageSrc, true);
    if (imgUrl) {
      // 9-slice: a UI sprite with authored border insets renders as 9 overlapping
      // divs (NineSliceImage) — seamless at any zoom, unlike CSS `border-image` whose
      // regions tile and leave subpixel seams under the editor's scaled preview.
      const sprite = isGuid(node.imageSrc) ? resolveSprite(node.imageSrc) : undefined;
      const border = sprite?.border;
      if (border && (border.l || border.r || border.t || border.b) && sprite?.sheetW && sprite?.sheetH && sprite.frame) {
        // Edge scale (Unity PPU-style): insets stay in SOURCE px, corners render at
        // insets × scale so they keep their intended on-screen size.
        const s = border.scale && border.scale > 0 ? border.scale : 1;
        // The overlay is z-index:-1; isolate so it stays behind the element's own
        // text/children but above the element background, contained to this element.
        style.isolation = 'isolate';
        nineSliceLayer = (
          <NineSliceImage
            url={imgUrl} imgW={sprite.sheetW} imgH={sprite.sheetH} frame={sprite.frame}
            l={border.l} r={border.r} t={border.t} b={border.b} scale={s}
          />
        );
      } else {
        // Plain image (raw texture, or an atlas-packed sprite with no source dims).
        style.backgroundImage = `url(${imgUrl})`;
        style.backgroundSize = node.imageMode === 'fill' ? '100% 100%' : node.imageMode === 'none' ? 'auto' : node.imageMode;
        style.backgroundPosition = 'center';
        style.backgroundRepeat = 'no-repeat';
      }
    }
  }

  // ── Text styling (only when text content exists) ──
  if (text) {
    if (node.fontFamily) style.fontFamily = node.fontFamily;
    style.fontSize = node.fontSize;
    style.fontWeight = node.fontWeight as any;
    if (node.fontStyle !== 'normal') style.fontStyle = node.fontStyle;
    style.color = hexToRgba(node.textColor, node.textOpacity ?? 1);
    style.textAlign = node.textAlign as any;
    // lineHeight is authored in PIXELS (like fontSize). React leaves `lineHeight`
    // unitless, which CSS reads as a font-size MULTIPLIER (e.g. 20 → 20×14px =
    // 280px/line). Emit explicit px so the authored value means pixels.
    if (node.lineHeight) style.lineHeight = `${node.lineHeight}px`;
    if (node.letterSpacing) style.letterSpacing = node.letterSpacing;
    if (node.textShadowBlur || node.textShadowOffsetX || node.textShadowOffsetY) {
      style.textShadow = `${node.textShadowOffsetX}px ${node.textShadowOffsetY}px ${node.textShadowBlur}px ${hexToRgba(node.textShadowColor, node.textShadowOpacity ?? 1)}`;
    }
    if (node.textStrokeWidth > 0) {
      (style as any).WebkitTextStroke = `${node.textStrokeWidth}px ${hexToRgba(node.textStrokeColor, node.textStrokeOpacity ?? 1)}`;
      // paint-order: stroke fill — paint the stroke first, then the fill on
      // top. Without this, -webkit-text-stroke is centered on the glyph and
      // half the width cuts INTO the letter, making thick strokes shrink the
      // visible glyph. With it, the fill covers the inner half and only the
      // outer half shows — i.e. a true outline.
      (style as any).paintOrder = 'stroke fill';
    }
    if (node.maxLines > 0) {
      style.overflow = 'hidden';
      style.display = '-webkit-box' as any;
      (style as any).WebkitLineClamp = node.maxLines;
      (style as any).WebkitBoxOrient = 'vertical';
      if (node.textOverflow === 'ellipsis') style.textOverflow = 'ellipsis';
    } else if (node.textOverflow === 'ellipsis') {
      style.overflow = 'hidden';
      style.textOverflow = 'ellipsis';
      style.whiteSpace = 'nowrap';
    }
  }

  // ── UIAnchor (absolute positioning) ──
  // CSS comes from the shared anchorCss builder — the live-DOM counterpart of
  // anchorLayout.resolveAnchorRect (pixel rects for the editor overlay). The two
  // encode identical 16-mode semantics and are kept in lockstep by a parity test (F4).
  if (node.anchor) {
    applyAnchorStyle(style, node.anchor);
  }

  // ── Click handler ──
  // A button is interactive if it dispatches an action OR applies declarative
  // bindings — any click-event binding (set write or call action).
  const isInteractive = !!node.action?.bindings?.some(b => (b.event || 'click') === 'click');

  // In editor mode, skip click handler on canvas2D containers — they're just mount points,
  // not something worth selecting. Let clicks pass through to children.
  const handleClick = onSelectEntity
    ? node.canvas2D
      ? undefined
      : (e: React.MouseEvent) => { e.stopPropagation(); onSelectEntity(node.entityId); }
    : isInteractive
      ? (e: React.MouseEvent) => {
          e.stopPropagation();
          // Run every click binding (set writes + call actions). Inert in edit mode.
          applyBindings(node.action!.bindings, 'click', { selfGuid: node.guid });
        }
      : undefined;

  if (onSelectEntity && !node.canvas2D) {
    style.pointerEvents = 'auto';
    style.cursor = 'pointer';
  } else if (isInteractive) {
    style.pointerEvents = 'auto';
    style.cursor = 'pointer';
  } else if (node.children.length === 0) {
    // Only disable pointer events on leaf nodes (containers must pass events to children)
    style.pointerEvents = 'none';
  }

  // Scroll containers must receive wheel/touch events themselves to scroll —
  // the UIRenderer root is pointer-events:none, so without this the container
  // inherits none and the user can't scroll (the scrollbar even ignores drags).
  if (node.overflow === 'scroll') style.pointerEvents = 'auto';

  // Editor 2D-only layer: strip UI visuals but keep layout, so nested Canvas2D
  // canvases still mount and position while the UI layer is hidden. The canvas
  // itself renders regardless (its own pointerEvents stay 'auto').
  if (uiVisualsHidden) {
    style.backgroundColor = undefined;
    style.backgroundImage = undefined;
    style.borderWidth = undefined;
    style.borderStyle = undefined;
    style.borderColor = undefined;
    style.boxShadow = undefined;
    style.pointerEvents = 'none';
    style.cursor = undefined;
    text = '';
    nineSliceLayer = null;   // 9-slice background is a UI visual — strip it too
  }

  // F8: an input/range elementType returns before the canvas2D branch below, so an
  // entity carrying BOTH a Canvas2D and a non-'div' elementType renders as the input
  // and its 2D canvas silently never mounts. Warn in dev so the misconfig is visible
  // (author the canvas on a separate child entity instead).
  if (import.meta.env?.DEV && node.canvas2D && node.elementType !== 'div') {
    console.warn(
      `[UINode] entity ${node.entityId}: elementType '${node.elementType}' takes precedence over its Canvas2D — the 2D canvas will NOT mount. Put the Canvas2D on its own child entity.`,
    );
  }

  // Input element: render <input> instead of <div> when elementType is 'input'.
  // In editor mode, render read-only so it looks the same but doesn't steal focus.
  if (node.elementType === 'input') {
    const inputValue = node.binding?.inputBinding
      ? String(storeState[node.binding.inputBinding] ?? '')
      : '';
    // Apply text styles to the input element
    if (node.fontFamily) style.fontFamily = node.fontFamily;
    style.fontSize = node.fontSize;
    style.fontWeight = node.fontWeight as any;
    style.color = hexToRgba(node.textColor, node.textOpacity ?? 1);
    if (onSelectEntity) {
      // Editor mode: read-only input, click selects entity instead of focusing
      style.pointerEvents = 'auto';
      style.cursor = 'pointer';
      return (
        <input
          style={style}
          value={inputValue}
          placeholder={node.placeholder}
          readOnly
          tabIndex={-1}
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelectEntity(node.entityId); }}
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          data-entity-id={node.entityId}
        />
      );
    }
    style.pointerEvents = 'auto';
    return (
      <input
        style={style}
        value={inputValue}
        placeholder={node.placeholder}
        onChange={node.action?.bindings?.length
          ? (e: React.ChangeEvent<HTMLInputElement>) => applyBindings(node.action!.bindings, 'change', { selfGuid: node.guid, eventValue: e.target.value })
          : undefined}
        onKeyDown={node.action?.bindings?.length
          ? (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              applyBindings(node.action!.bindings, 'submit', { selfGuid: node.guid, eventValue: (e.target as HTMLInputElement).value });
            }
          }
          : undefined}
        data-entity-id={node.entityId}
      />
    );
  }

  // Range slider: render <input type="range"> when elementType === 'range'.
  // Value reads through inputBinding (same store-field convention as text inputs);
  // onChange fires the UIAction 'change'-event bindings with the new numeric value.
  // Editor mode (onSelectEntity) makes the slider non-interactive so dragging
  // selects the entity instead of editing the value.
  if (node.elementType === 'range') {
    const rawValue = node.binding?.inputBinding
      ? Number(storeState[node.binding.inputBinding] ?? node.rangeMin)
      : node.rangeMin;
    const sliderValue = Number.isFinite(rawValue) ? rawValue : node.rangeMin;
    style.pointerEvents = 'auto';
    style.accentColor = hexToColor(node.textColor);
    if (onSelectEntity) {
      return (
        <input
          type="range"
          style={{ ...style, cursor: 'pointer' }}
          min={node.rangeMin}
          max={node.rangeMax}
          step={node.rangeStep || 1}
          value={sliderValue}
          readOnly
          tabIndex={-1}
          onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelectEntity(node.entityId); }}
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          data-entity-id={node.entityId}
        />
      );
    }
    return (
      <input
        type="range"
        style={style}
        min={node.rangeMin}
        max={node.rangeMax}
        step={node.rangeStep || 1}
        value={sliderValue}
        onChange={node.action?.bindings?.length
          ? (e: React.ChangeEvent<HTMLInputElement>) => applyBindings(node.action!.bindings, 'change', { selfGuid: node.guid, eventValue: Number(e.target.value) })
          : undefined}
        data-entity-id={node.entityId}
      />
    );
  }

  // Canvas2D: mount the 2D canvas inline among the UI children so it stacks by
  // hierarchy (DOM order). Runtime → pooled PixiJS canvas (Canvas2DMount). Editor
  // → injected editor canvas via renderCanvas2D (null when 2D layer is toggled off).
  // UIElement children (without Renderable2D) still render as DOM overlays on top.
  if (node.canvas2D) {
    const canvas2DContent = renderCanvas2D
      ? renderCanvas2D(node.entityId)
      : (!onSelectEntity && Canvas2DMount ? <Suspense fallback={null}><Canvas2DMount entityId={node.entityId} /></Suspense> : null);
    return (
      <div style={style} onClick={handleClick} data-entity-id={node.entityId}>
        {nineSliceLayer}
        {canvas2DContent}
        {node.children.map(child => (
          <UINode key={child.entityId} node={child} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} />
        ))}
      </div>
    );
  }

  // Whole-element CSS text animation (TextAnimation trait on a UIElement). Applied to
  // an inner span so its transform doesn't clobber the element's anchor/layout. The
  // play gate lives in the projection (uiTreeStore): node.textAnim is populated only
  // while the sim is running (freezes to base text when Stopped, like the 2D/3D
  // geometry paths), and its presence/absence drives the re-render on Play/Stop.
  let textContent: React.ReactNode = text;
  if (text && node.textAnim) {
    const a = uiTextAnimation(node.textAnim, node.fontSize || 16);
    if (a) {
      ensureUITextAnimStyles();
      textContent = <AnimatedText text={text} animation={a.animation} ampPx={a.ampPx} extra={a.style}
        perCharStagger={a.perChar?.staggerSec} perCharLoop={a.perChar?.loop} perCharFade={a.perChar?.fadeIn} />;
    }
  }

  return (
    <div style={style} onClick={handleClick} data-entity-id={node.entityId}>
      {nineSliceLayer}
      {textContent}
      {node.children.map(child => (
        <UINode key={child.entityId} node={child} storeState={storeState} onSelectEntity={onSelectEntity} renderCanvas2D={renderCanvas2D} uiVisualsHidden={uiVisualsHidden} />
      ))}
    </div>
  );
}

export const UINode = React.memo(UINodeInner);
