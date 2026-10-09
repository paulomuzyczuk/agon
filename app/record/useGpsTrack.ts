'use client';

import { useEffect, useRef, useState } from 'react';
import { getGpsSource } from '@/lib/gps';
import { appendGpsSample } from '@/lib/liveRecordingDb';
import { createGpsLink, type GpsLink, type GpsState } from './gpsLink';

// React wrapper around ./gpsLink.ts (MZY-281): holds the GPS state for the
// record page and starts the warm-up watcher on mount in the Android app. In
// the browser the source is unavailable and the state stays 'unsupported'.

export function useGpsTrack(onSample: (recordingId: string) => void) {
  const [gps, setGps] = useState<GpsState>({ kind: 'idle' });
  const linkRef = useRef<GpsLink | null>(null);
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;

  // Created on first use, never during render (no plugin on the server).
  function link(): GpsLink {
    linkRef.current ??= createGpsLink({
      source: getGpsSource(),
      setState: setGps,
      appendGpsSample,
      onSample: (id) => onSampleRef.current(id),
    });
    return linkRef.current;
  }

  useEffect(() => {
    const l = link();
    if (l.isAvailable()) l.warmUp();
    else setGps({ kind: 'unsupported' });
    return () => linkRef.current?.dispose();
  }, []);

  return {
    gps,
    /** GPS is on and has a usable fix — enough to start a GPS-only recording. */
    hasFix: gps.kind === 'ok',
    startRecording: (id: string, startedAt: number) =>
      link().startRecording(id, startedAt),
    stopRecording: () => link().stopRecording(),
    retry: () => link().retry(),
    openSettings: () => link().openSettings(),
  };
}
