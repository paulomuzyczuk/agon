import { Capacitor } from '@capacitor/core';
import { isNativeApp, runtimePlatform } from '@/lib/platform';

// lib/platform.ts is the single native-runtime check (MZY-274).

jest.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: jest.fn(), getPlatform: jest.fn() },
}));
const mockCapacitor = jest.mocked(Capacitor);

describe('platform', () => {
  it('reports the web build as web', () => {
    mockCapacitor.isNativePlatform.mockReturnValue(false);
    mockCapacitor.getPlatform.mockReturnValue('web');
    expect(isNativeApp()).toBe(false);
    expect(runtimePlatform()).toBe('web');
  });

  it('reports the Android shell as native android', () => {
    mockCapacitor.isNativePlatform.mockReturnValue(true);
    mockCapacitor.getPlatform.mockReturnValue('android');
    expect(isNativeApp()).toBe(true);
    expect(runtimePlatform()).toBe('android');
  });

  it('falls back to web for an unknown platform string', () => {
    mockCapacitor.getPlatform.mockReturnValue('electron');
    expect(runtimePlatform()).toBe('web');
  });
});
