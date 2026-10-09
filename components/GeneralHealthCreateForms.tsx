'use client';

import { useState } from 'react';
import { LabPanelForm } from './LabPanelForm';
import {
  ENTRY_TYPES,
  postLog,
  SubmitRow,
  todayISO,
  type EntryType,
} from './generalHealthForm';

// Creation forms for the general-health domains that only had a read view +
// script/API entry until now (CLAUDE.md "General Health" — "Still not built:
// dedicated PWA creation forms"). One type-switcher over seven small forms,
// each posting a distinct `mode` to /api/general-health/log. Mirrors
// MealLogForm's economy (no form library) but stacked full-width since these
// entities carry more fields than a meal-log row.

export function GeneralHealthCreateForms({
  onCreated,
}: {
  onCreated: () => void;
}) {
  const [type, setType] = useState<EntryType>('lab_panel');

  return (
    <section className="card hc-form" style={{ marginTop: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>Add entry</h2>
      <div className="hc-type-row">
        {ENTRY_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`hc-type-btn${type === t.value ? ' active' : ''}`}
            onClick={() => setType(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {type === 'lab_panel' && <LabPanelForm onCreated={onCreated} />}
      {type === 'medication' && <MedicationForm onCreated={onCreated} />}
      {type === 'injury' && <InjuryForm onCreated={onCreated} />}
      {type === 'medical_visit' && <MedicalVisitForm onCreated={onCreated} />}
      {type === 'vaccination' && <VaccinationForm onCreated={onCreated} />}
      {type === 'health_condition' && (
        <HealthConditionForm onCreated={onCreated} />
      )}
      {type === 'new_routine' && <NewRoutineForm onCreated={onCreated} />}
    </section>
  );
}

function MedicationForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'medication' | 'supplement'>('medication');
  const [dosage, setDosage] = useState('');
  const [schedule, setSchedule] = useState('');
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return setError('Name is required.');
    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'medication',
        name,
        kind,
        dosage: dosage || undefined,
        schedule: schedule || undefined,
        active,
        notes: notes || undefined,
      });
      setName('');
      setDosage('');
      setSchedule('');
      setNotes('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="hc-field">
          <label>Kind</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="medication">Medication</option>
            <option value="supplement">Supplement</option>
          </select>
        </div>
      </div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Dosage (optional)</label>
          <input
            placeholder="e.g. 500 mg"
            value={dosage}
            onChange={(e) => setDosage(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Schedule (optional)</label>
          <input
            placeholder="e.g. once daily"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
        </div>
      </div>
      <div className="hc-field">
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            style={{ width: 'auto', marginRight: '0.4rem' }}
          />
          Currently active
        </label>
      </div>
      <div className="hc-field">
        <label>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}

function InjuryForm({ onCreated }: { onCreated: () => void }) {
  const [onsetDate, setOnsetDate] = useState(todayISO());
  const [bodyPart, setBodyPart] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!bodyPart.trim()) return setError('Body part is required.');
    const sev = severity ? Number(severity) : undefined;
    if (sev != null && (Number.isNaN(sev) || sev < 1 || sev > 10)) {
      return setError('Severity must be 1-10.');
    }
    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'injury',
        onsetDate,
        bodyPart,
        description: description || undefined,
        severity: sev,
        notes: notes || undefined,
      });
      setBodyPart('');
      setDescription('');
      setSeverity('');
      setNotes('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Onset date</label>
          <input
            type="date"
            value={onsetDate}
            onChange={(e) => setOnsetDate(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Body part</label>
          <input
            placeholder="e.g. left knee"
            value={bodyPart}
            onChange={(e) => setBodyPart(e.target.value)}
          />
        </div>
        <div className="hc-field" style={{ flex: 0.5 }}>
          <label>Severity (1-10)</label>
          <input
            type="number"
            min="1"
            max="10"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          />
        </div>
      </div>
      <div className="hc-field">
        <label>Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="hc-field">
        <label>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}

function MedicalVisitForm({ onCreated }: { onCreated: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [visitType, setVisitType] = useState('');
  const [provider, setProvider] = useState('');
  const [reason, setReason] = useState('');
  const [findings, setFindings] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!visitType.trim()) return setError('Visit type is required.');
    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'medical_visit',
        date,
        visitType,
        provider: provider || undefined,
        reason: reason || undefined,
        findings: findings || undefined,
        followUpDate: followUpDate || undefined,
      });
      setVisitType('');
      setProvider('');
      setReason('');
      setFindings('');
      setFollowUpDate('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Visit type</label>
          <input
            placeholder="e.g. dental cleaning"
            value={visitType}
            onChange={(e) => setVisitType(e.target.value)}
          />
        </div>
      </div>
      <div className="hc-field">
        <label>Provider (optional)</label>
        <input value={provider} onChange={(e) => setProvider(e.target.value)} />
      </div>
      <div className="hc-field">
        <label>Reason (optional)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="hc-field">
        <label>Findings (optional)</label>
        <textarea
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
        />
      </div>
      <div className="hc-field">
        <label>Follow-up date (optional)</label>
        <input
          type="date"
          value={followUpDate}
          onChange={(e) => setFollowUpDate(e.target.value)}
        />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}

function VaccinationForm({ onCreated }: { onCreated: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [vaccine, setVaccine] = useState('');
  const [doseNumber, setDoseNumber] = useState('');
  const [provider, setProvider] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!vaccine.trim()) return setError('Vaccine is required.');
    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'vaccination',
        date,
        vaccine,
        doseNumber: doseNumber ? Number(doseNumber) : undefined,
        provider: provider || undefined,
        nextDueDate: nextDueDate || undefined,
      });
      setVaccine('');
      setDoseNumber('');
      setProvider('');
      setNextDueDate('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Vaccine</label>
          <input value={vaccine} onChange={(e) => setVaccine(e.target.value)} />
        </div>
        <div className="hc-field" style={{ flex: 0.5 }}>
          <label>Dose #</label>
          <input
            type="number"
            min="1"
            value={doseNumber}
            onChange={(e) => setDoseNumber(e.target.value)}
          />
        </div>
      </div>
      <div className="hc-field">
        <label>Provider (optional)</label>
        <input value={provider} onChange={(e) => setProvider(e.target.value)} />
      </div>
      <div className="hc-field">
        <label>Next due date (optional)</label>
        <input
          type="date"
          value={nextDueDate}
          onChange={(e) => setNextDueDate(e.target.value)}
        />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}

function HealthConditionForm({ onCreated }: { onCreated: () => void }) {
  const [conditionType, setConditionType] = useState<
    'allergy' | 'chronic_condition' | 'other'
  >('allergy');
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState('');
  const [diagnosedDate, setDiagnosedDate] = useState('');
  const [status, setStatus] = useState<'active' | 'resolved' | 'managed'>(
    'active',
  );
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return setError('Name is required.');
    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'health_condition',
        conditionType,
        name,
        severity: severity || undefined,
        diagnosedDate: diagnosedDate || undefined,
        status,
        notes: notes || undefined,
      });
      setName('');
      setSeverity('');
      setDiagnosedDate('');
      setNotes('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Type</label>
          <select
            value={conditionType}
            onChange={(e) =>
              setConditionType(e.target.value as typeof conditionType)
            }
          >
            <option value="allergy">Allergy</option>
            <option value="chronic_condition">Chronic condition</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="hc-field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Severity (optional)</label>
          <input
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="active">Active</option>
            <option value="managed">Managed</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>
      <div className="hc-field">
        <label>Diagnosed date (optional)</label>
        <input
          type="date"
          value={diagnosedDate}
          onChange={(e) => setDiagnosedDate(e.target.value)}
        />
      </div>
      <div className="hc-field">
        <label>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}

function NewRoutineForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [routineType, setRoutineType] = useState<'skincare' | 'dental'>(
    'skincare',
  );
  const [timeOfDay, setTimeOfDay] = useState<'am' | 'pm' | 'any'>('any');
  const [notes, setNotes] = useState('');
  const [steps, setSteps] = useState([{ product: '', notes: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStep = (i: number, patch: Partial<(typeof steps)[number]>) => {
    const next = [...steps];
    next[i] = { ...next[i]!, ...patch };
    setSteps(next);
  };

  async function submit() {
    if (!name.trim()) return setError('Name is required.');
    const validSteps = steps
      .filter((s) => s.product.trim() !== '')
      .map((s) => ({ product: s.product, notes: s.notes || undefined }));
    if (validSteps.length === 0) return setError('Add at least one step.');

    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'new_routine',
        name,
        routineType,
        timeOfDay,
        notes: notes || undefined,
        steps: validSteps,
      });
      setName('');
      setNotes('');
      setSteps([{ product: '', notes: '' }]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="hc-row">
        <div className="hc-field">
          <label>Name</label>
          <input
            placeholder="e.g. Evening skincare"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="hc-field">
          <label>Type</label>
          <select
            value={routineType}
            onChange={(e) =>
              setRoutineType(e.target.value as typeof routineType)
            }
          >
            <option value="skincare">Skincare</option>
            <option value="dental">Dental</option>
          </select>
        </div>
        <div className="hc-field" style={{ flex: 0.6 }}>
          <label>Time of day</label>
          <select
            value={timeOfDay}
            onChange={(e) => setTimeOfDay(e.target.value as typeof timeOfDay)}
          >
            <option value="any">Any</option>
            <option value="am">AM</option>
            <option value="pm">PM</option>
          </select>
        </div>
      </div>

      <p className="muted small" style={{ margin: '0.6rem 0 0' }}>
        Steps, in order
      </p>
      {steps.map((s, i) => (
        <div className="hc-step-row" key={i}>
          <input
            className="nt-select"
            placeholder="product / step"
            value={s.product}
            onChange={(e) => setStep(i, { product: e.target.value })}
          />
          <input
            className="nt-input"
            placeholder="notes (optional)"
            value={s.notes}
            onChange={(e) => setStep(i, { notes: e.target.value })}
          />
          <button
            className="nt-btn-ghost"
            onClick={() => setSteps(steps.filter((_, j) => j !== i))}
            disabled={steps.length === 1}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="nt-field-row">
        <button
          className="nt-btn-ghost"
          onClick={() => setSteps([...steps, { product: '', notes: '' }])}
        >
          + step
        </button>
      </div>

      <div className="hc-field">
        <label>Notes (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <SubmitRow busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}
