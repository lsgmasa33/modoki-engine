import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

/**
 * Shifts .game-wrapper up when the virtual keyboard appears so the focused
 * input stays visible. Uses CSS transform (no canvas resize).
 *
 * iOS: Capacitor Keyboard plugin (resize:'none' works fine).
 * Android: Native WindowInsets dispatches 'nativeKeyboard' CustomEvent
 *   because resize:'none' (adjustNothing) breaks the plugin's detection.
 */
export function useKeyboardShift() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const applyShift = (keyboardHeight: number) => {
      const wrapper = document.querySelector('.game-wrapper') as HTMLElement | null;
      if (!wrapper || keyboardHeight <= 0) return;
      wrapper.style.transition = 'transform 0.25s ease-out';
      wrapper.style.transform = `translateY(-${keyboardHeight}px)`;
    };

    const clearShift = () => {
      const wrapper = document.querySelector('.game-wrapper') as HTMLElement | null;
      if (!wrapper) return;
      wrapper.style.transform = 'translateY(0)';
    };

    const platform = Capacitor.getPlatform();

    if (platform === 'android') {
      // Android: listen for native WindowInsets events
      const onNativeKeyboard = (e: Event) => {
        const { height, visible } = (e as CustomEvent).detail;
        if (visible) {
          applyShift(height);
        } else {
          clearShift();
        }
      };
      window.addEventListener('nativeKeyboard', onNativeKeyboard);
      return () => window.removeEventListener('nativeKeyboard', onNativeKeyboard);
    }

    // iOS: use Capacitor Keyboard plugin
    const showHandle = Keyboard.addListener('keyboardWillShow', (info) => {
      applyShift(info.keyboardHeight);
    });
    const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
      clearShift();
    });

    return () => {
      showHandle.then(h => h.remove());
      hideHandle.then(h => h.remove());
    };
  }, []);
}
