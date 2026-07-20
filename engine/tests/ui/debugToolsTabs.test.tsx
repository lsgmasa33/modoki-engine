/** Cheats / Console / Device debug tabs + console capture — tests (Phase 4). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { registerUIAction, unregisterUIAction } from '@modoki/engine/runtime';
import {
  installConsoleCapture,
  getConsoleEntries,
  clearConsoleEntries,
  __resetConsoleCaptureForTest,
} from '../../packages/modoki/src/runtime/debug/consoleCapture';
import {
  registerDebugCommand,
  __resetDebugMenuRegistry,
} from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';
import { CheatsTab } from '../../packages/modoki/src/runtime/debug/tabs/CheatsTab';
import { ConsoleTab } from '../../packages/modoki/src/runtime/debug/tabs/ConsoleTab';
import { DeviceTab } from '../../packages/modoki/src/runtime/debug/tabs/DeviceTab';

afterEach(() => cleanup());

describe('consoleCapture', () => {
  beforeEach(() => __resetConsoleCaptureForTest());

  it('records console.* into the ring buffer and forwards to the original', () => {
    const original = console.log;
    installConsoleCapture();
    expect(console.log).not.toBe(original); // wrapped
    console.log('debug-capture-marker', 42);
    const hit = getConsoleEntries().find((e) => e.text.includes('debug-capture-marker'));
    expect(hit).toBeTruthy();
    expect(hit!.text).toContain('42');
    expect(hit!.level).toBe('log');
  });

  it('is idempotent (double install does not double-record)', () => {
    installConsoleCapture();
    installConsoleCapture();
    clearConsoleEntries();
    console.warn('once-only');
    expect(getConsoleEntries().filter((e) => e.text.includes('once-only'))).toHaveLength(1);
  });
});

describe('ConsoleTab', () => {
  beforeEach(() => {
    installConsoleCapture();
    __resetConsoleCaptureForTest();
  });

  it('shows captured entries and filters by level', () => {
    console.log('a-log-line');
    console.error('an-error-line');
    const { queryByText, getByText } = render(<ConsoleTab />);
    expect(queryByText('a-log-line')).not.toBeNull();
    expect(queryByText('an-error-line')).not.toBeNull();
    fireEvent.click(getByText('error'));
    expect(queryByText('a-log-line')).toBeNull();
    expect(queryByText('an-error-line')).not.toBeNull();
  });

  it('clears the captured entries', () => {
    console.log('to-be-cleared');
    const { queryByText, getByText } = render(<ConsoleTab />);
    expect(queryByText('to-be-cleared')).not.toBeNull();
    fireEvent.click(getByText('Clear'));
    expect(queryByText('to-be-cleared')).toBeNull();
  });
});

describe('CheatsTab', () => {
  beforeEach(() => __resetDebugMenuRegistry());

  it('runs a registered debug command', () => {
    const run = vi.fn();
    registerDebugCommand({ tab: 'Cheats', label: 'Give Gold', run });
    const { getByText } = render(<CheatsTab />);
    fireEvent.click(getByText('Give Gold'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lists registered UI actions', () => {
    registerUIAction('cheat.testAction', () => {});
    try {
      const { queryByText } = render(<CheatsTab />);
      expect(queryByText('cheat.testAction')).not.toBeNull();
    } finally {
      unregisterUIAction('cheat.testAction');
    }
  });
});

describe('DeviceTab', () => {
  it('renders platform + viewport info', () => {
    const { getByText } = render(<DeviceTab />);
    expect(getByText('Platform')).toBeTruthy();
    expect(getByText('web')).toBeTruthy(); // no Capacitor global in jsdom
    expect(getByText('Viewport')).toBeTruthy();
    expect(getByText('DPR')).toBeTruthy();
  });
});
