'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  loadReplica,
  replicaStatus,
  replicaTables,
  replicaVersion,
  subscribeReplica,
} from './replica';

// React binding for the device replica (MZY-207): re-renders on every pull,
// local write or status change. `tables` is null until IndexedDB has loaded;
// `status.hydrated` is false until this device has completed its first pull.
export function useReplica() {
  useSyncExternalStore(subscribeReplica, replicaVersion, () => 0);
  useEffect(() => {
    void loadReplica();
  }, []);
  return { tables: replicaTables(), status: replicaStatus() };
}
