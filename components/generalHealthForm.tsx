'use client';

import { submitRows } from '@/lib/sync/client';
import { healthEntryRows, type HealthEntry } from '@/lib/sync/entryRows';

// Shared by the general-health creation forms (GeneralHealthCreateForms.tsx,
// LabPanelForm.tsx) — split out of GeneralHealthCreateForms to keep it under
// the file-size budget.

export type EntryType =
  | 'lab_panel'
  | 'medication'
  | 'injury'
  | 'medical_visit'
  | 'vaccination'
  | 'health_condition'
  | 'new_routine';

export const ENTRY_TYPES: { value: EntryType; label: string }[] = [
  { value: 'lab_panel', label: 'Lab panel' },
  { value: 'medication', label: 'Medication' },
  { value: 'injury', label: 'Injury' },
  { value: 'medical_visit', label: 'Medical visit' },
  { value: 'vaccination', label: 'Vaccination' },
  { value: 'health_condition', label: 'Allergy / condition' },
  { value: 'new_routine', label: 'Routine' },
];

// Through the device outbox (MZY-205): saved locally first, so a form
// submitted offline is kept and synced later (shown in the outbox bar). Only
// a server rejection throws — queued counts as saved. Since MZY-206 the entry
// is written as field-level rows (lib/sync/entryRows.ts) to /api/sync/push.
export async function postLog(body: HealthEntry): Promise<void> {
  const type =
    ENTRY_TYPES.find((t) => t.value === body.mode)?.label ?? String(body.mode);
  const what =
    'name' in body
      ? body.name
      : 'vaccine' in body
        ? body.vaccine
        : 'bodyPart' in body
          ? body.bodyPart
          : 'visitType' in body
            ? body.visitType
            : body.panelType;
  const result = await submitRows({
    label: `${type}: ${what}`,
    rows: healthEntryRows(body, () => crypto.randomUUID()),
  });
  if (result.state === 'rejected') throw new Error(result.error);
}

// The device's local calendar date. Not toISOString(): that's the UTC date,
// which in Berlin is already tomorrow for the last hour or two of the day.
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function SubmitRow({
  busy,
  error,
  onSubmit,
  label = 'Save',
}: {
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  label?: string;
}) {
  return (
    <>
      <div className="hc-field" style={{ marginTop: '0.7rem' }}>
        <button className="nt-btn" disabled={busy} onClick={onSubmit}>
          {busy ? 'Saving…' : label}
        </button>
      </div>
      {error && <p className="nt-error">{error}</p>}
    </>
  );
}
