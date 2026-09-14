import { WebPlugin } from '@capacitor/core';

import type { ModokiSystemPlugin } from './definitions';

export class ModokiSystemWeb extends WebPlugin implements ModokiSystemPlugin {
  // A browser has no per-app Settings page to open.
  async openAppSettings(): Promise<{ opened: boolean }> {
    return { opened: false };
  }
}
