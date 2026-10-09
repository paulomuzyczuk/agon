import { z } from 'zod';
import { sampleDeviceFields } from './sampleDeviceSchema';
import { gpsSamplesField } from './gpsSampleSchema';

// Request body of POST /api/live-recording/finish-ride (MZY-168; power
// MZY-270). Lives here, not in the route file, because Next.js only allows
// handler exports from route.ts — and this way it's unit-testable
// (__tests__/lib/liveRecordingRideBody.test.ts).
export const FinishRideBodySchema = z.object({
  recordingId: z.string().min(1),
  startedAt: z.number().positive(),
  endedAt: z.number().positive(),
  samples: z.object({
    hr: z.array(
      z.object({
        tMs: z.number(),
        bpm: z.number().positive(),
        ...sampleDeviceFields,
      }),
    ),
    speed: z.array(
      z.object({
        tMs: z.number(),
        speedKmh: z.number().nonnegative(),
        // CSC cumulative wheel revolutions (uint32) — distance fallback, MZY-282.
        wheelRevs: z.number().int().nonnegative().optional(),
        ...sampleDeviceFields,
      }),
    ),
    cadence: z.array(
      z.object({
        tMs: z.number(),
        rpm: z.number().nonnegative(),
        ...sampleDeviceFields,
      }),
    ),
    // BLE Cycling Power (MZY-270). Defaulted so an older client (or a
    // recording buffered before the power store existed) still validates.
    power: z
      .array(
        z.object({
          tMs: z.number(),
          watts: z.number().int().min(0).max(3000),
          ...sampleDeviceFields,
        }),
      )
      .default([]),
    // The Android app's GPS track (MZY-282).
    gps: gpsSamplesField,
  }),
  // Optional override (MZY-282): without it the flush derives the distance
  // from the GPS track, else the wheel sensor (lib/liveRecordingDistance.ts).
  distanceKm: z.number().positive().optional(),
});

export type FinishRideBody = z.infer<typeof FinishRideBodySchema>;
