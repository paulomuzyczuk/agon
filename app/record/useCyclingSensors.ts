'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getBleTransport } from '@/lib/ble';
import {
  appendSpeedSample,
  appendCadenceSample,
  appendPowerSample,
} from '@/lib/liveRecordingDb';
import { deviceConflicts, type LiveSource } from '@/lib/sourceDevices';
import {
  createCyclingSensorHub,
  type CyclingSensorHub,
  type CyclingSensorState,
} from './cyclingSensorHub';

// React wrapper around the ride-only BLE sensors of app/record
// (./cyclingSensorHub.ts — pairing, frame handling, primary-device rule),
// plus their display helpers. Extracted from the page so it can stay under
// its file-size ratchet. See .claude/rules/live-recording.md.

export type { CyclingSensorRole, CyclingSensorState } from './cyclingSensorHub';

/** A sensor's state as the primary/conflict rules see it. */
function asLiveSource(s: CyclingSensorState): LiveSource {
  return {
    id: s.id,
    name: s.deviceName,
    role: s.role,
    connected: s.status === 'connected',
    pairedAt: s.pairedAt,
    reportsCadence: s.cadence != null,
  };
}

/**
 * Cycling-sensor connections for the recorder. Samples are appended to
 * IndexedDB while `recordingIdRef.current` is set; picker/connect failures
 * outside a single sensor's row go to `onError`.
 */
export function useCyclingSensors(
  recordingIdRef: MutableRefObject<string | null>,
  onError: (message: string) => void,
) {
  const [sensors, setSensors] = useState<CyclingSensorState[]>([]);
  const hubRef = useRef<CyclingSensorHub | null>(null);

  // Created on first use, never during render, so no transport is touched
  // on the server.
  function hub(): CyclingSensorHub {
    hubRef.current ??= createCyclingSensorHub({
      transport: getBleTransport(),
      setSensors,
      getRecordingId: () => recordingIdRef.current,
      onError,
      append: {
        speed: appendSpeedSample,
        cadence: appendCadenceSample,
        power: appendPowerSample,
      },
    });
    return hubRef.current;
  }

  useEffect(() => () => hubRef.current?.dispose(), []);

  return {
    sensors,
    /** Metrics currently reported by more than one connected device (MZY-271). */
    conflicts: deviceConflicts(sensors.map(asLiveSource)),
    connect: () => hub().connect('csc'),
    connectPowerMeter: () => hub().connect('power'),
    disconnect: (id: string) => hub().disconnect(id),
  };
}

const ROLE_LABEL = {
  speed: 'Speed sensor',
  cadence: 'Cadence sensor',
  power: 'Power meter',
};
const ROLE_UNIT = { speed: 'km/h', cadence: 'rpm', power: 'W' };

export function cyclingSensorLabel(s: CyclingSensorState): string {
  if (s.status === 'connecting') return 'Identifying sensor…';
  if (s.role === 'identifying')
    return 'Cycling sensor (waiting for first reading)';
  const reading =
    s.value != null
      ? `${round1(s.value)} ${ROLE_UNIT[s.role]}` +
        (s.role === 'power' && s.cadence != null
          ? ` · ${Math.round(s.cadence)} rpm`
          : '')
      : 'connected';
  return `${ROLE_LABEL[s.role]} — ${s.status === 'disconnected' ? 'disconnected' : reading}`;
}

/**
 * The live stat for one metric, or "—". Cadence falls back to a power
 * meter's crank cadence when no dedicated cadence sensor is connected.
 */
export function formatCyclingValue(
  sensors: CyclingSensorState[],
  role: 'speed' | 'cadence' | 'power',
  decimals: number,
): string {
  const live = sensors.filter((s) => s.status === 'connected');
  const direct = live.find((s) => s.role === role)?.value;
  const value =
    direct ??
    (role === 'cadence' ? live.find((s) => s.role === 'power')?.cadence : null);
  if (value == null) return '—';
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
