/** FloatingWidgetLayer — renders every currently-open floating stat widget. Mounted
 *  by the debug overlay OUTSIDE the modal, so spawned widgets stay on screen while
 *  the fullscreen modal is closed (i.e. while you're playing). */

import { useSyncExternalStore } from 'react';
import { getOpenWidgets, subscribeWidgets, getWidgetVersion } from './widgetStore';
import { FloatingWidget } from './FloatingWidget';

export function FloatingWidgetLayer({ anchor }: { anchor: 'viewport' | 'container' }) {
  useSyncExternalStore(subscribeWidgets, getWidgetVersion, getWidgetVersion);
  const open = getOpenWidgets();
  if (open.length === 0) return null;
  return (
    <>
      {open.map(({ def, pos }) => {
        const Body = def.Component;
        return (
          <FloatingWidget key={def.id} id={def.id} title={def.title} initialPos={pos} anchor={anchor}>
            <Body />
          </FloatingWidget>
        );
      })}
    </>
  );
}
