import type { SensorContact } from '@/lib/bluetoothHeartRate';

// Heart-rate strap state + display helpers for app/record, split out of the
// page to keep it under its file-size ratchet.

export type HeartRateState =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'connecting'; deviceName: string }
  | {
      kind: 'connected';
      deviceName: string;
      bpm: number | null;
      lastUpdatedAt: number | null;
      sensorContact: SensorContact;
    }
  | {
      kind: 'disconnected';
      deviceName: string;
      lastBpm: number | null;
      lastUpdatedAt: number | null;
    }
  | {
      kind: 'error';
      message: string;
      /** Bluetooth permission refused (native app) — offer the settings screen. */
      permissionDenied?: boolean;
    };

const STALE_AFTER_MS = 5000;

export function isStale(
  state: Extract<HeartRateState, { kind: 'connected' }>,
  nowTick: number,
): boolean {
  return (
    state.lastUpdatedAt != null &&
    nowTick - state.lastUpdatedAt > STALE_AFTER_MS
  );
}

export function sensorContactLabel(contact: SensorContact): string {
  switch (contact) {
    case 'supported-detected':
      return 'skin contact detected';
    case 'supported-not-detected':
      return 'no skin contact — check strap fit';
    case 'not-supported':
    default:
      return 'contact status not reported by this strap';
  }
}
