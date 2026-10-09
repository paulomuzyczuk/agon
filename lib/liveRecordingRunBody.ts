import { z } from 'zod';
import { sampleDeviceFields } from './sampleDeviceSchema';
import { gpsSamplesField } from './gpsSampleSchema';

// Request body of POST /api/live-recording/finish (a live-recorded run). Lives
// here, not in the route file, because Next.js only allows handler exports
// from route.ts — and this way it's unit-testable. Samples may carry the
// strap that produced them (MZY-271).
//
// MZY-282: `gps` carries the Android app's track, and `distanceKm` is an
// optional override — without it the flush derives the distance from the
// track (lib/liveRecordingDistance.ts). A run needs at least one HR sample
// or one GPS fix (a GPS-only run has no strap).
export const FinishRunBodySchema = z
  .object({
    recordingId: z.string().min(1),
    startedAt: z.number().positive(),
    endedAt: z.number().positive(),
    deviceName: z.string(),
    samples: z.array(
      z.object({
        tMs: z.number(),
        bpm: z.number().positive(),
        sensorContact: z.string(),
        ...sampleDeviceFields,
      }),
    ),
    gps: gpsSamplesField,
    distanceKm: z.number().positive().optional(),
  })
  .refine((b) => b.samples.length > 0 || b.gps.length > 0, {
    message: 'a run needs heart-rate samples or a GPS track',
    path: ['samples'],
  });
