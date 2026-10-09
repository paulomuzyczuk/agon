import { z } from 'zod';

// Optional per-sample device stamp (MZY-271) for the live-recording finish
// bodies. Optional so a recording buffered before device stamps existed (or
// an older client) still validates — its points just get no device.
export const sampleDeviceFields = {
  deviceId: z.string().min(1).max(200).optional(),
  deviceName: z.string().max(200).optional(),
  deviceKind: z.enum(['heart_rate', 'csc', 'power', 'gps']).optional(),
};
