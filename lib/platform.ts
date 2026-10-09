// The single native-runtime check (MZY-274). Features that differ inside the
// Capacitor Android shell (native BLE via MZY-279, background GPS via MZY-281)
// branch on this — never on user-agent sniffing or `window.Capacitor` directly.
// On the web/PWA build Capacitor's core reports 'web', so both return the
// browser answer and behaviour is unchanged.
//
// Capacitor (MIT) — see CREDITS.md.

import { Capacitor } from '@capacitor/core';

export type RuntimePlatform = 'web' | 'android' | 'ios';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function runtimePlatform(): RuntimePlatform {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : 'web';
}
