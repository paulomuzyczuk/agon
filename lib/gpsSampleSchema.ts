import { z } from 'zod';
import { sampleDeviceFields } from './sampleDeviceSchema';

// One buffered phone-GPS fix (MZY-282) in the live-recording finish bodies
// (lib/gps/, lib/liveRecordingDb.ts GpsSampleRecord). Fractional everywhere:
// the stream columns are NUMERIC[].
export const gpsSampleSchema = z.object({
  tMs: z.number(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  altitudeM: z.number().nullable(),
  accuracyM: z.number().nonnegative(),
  speedMps: z.number().nonnegative().nullable(),
  ...sampleDeviceFields,
});

// Defaulted so an older client (or a recording buffered before GPS) validates.
export const gpsSamplesField = z.array(gpsSampleSchema).default([]);
