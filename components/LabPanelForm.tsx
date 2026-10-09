'use client';

import { useState } from 'react';
import { postLog, SubmitRow, todayISO } from './generalHealthForm';

// Lab panel creation form (header + marker results), split out of
// GeneralHealthCreateForms.tsx for the file-size budget.

export function LabPanelForm({ onCreated }: { onCreated: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [panelType, setPanelType] = useState('');
  const [labName, setLabName] = useState('');
  const [notes, setNotes] = useState('');
  const [results, setResults] = useState([{ marker: '', value: '', unit: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setResult = (i: number, patch: Partial<(typeof results)[number]>) => {
    const next = [...results];
    next[i] = { ...next[i]!, ...patch };
    setResults(next);
  };

  async function submit() {
    if (!panelType.trim()) return setError('Panel type is required.');
    const parsedResults = results
      .filter((r) => r.marker.trim() !== '')
      .map((r) => {
        const numeric = Number(r.value);
        const isNumeric = r.value.trim() !== '' && !Number.isNaN(numeric);
        return {
          marker: r.marker,
          valueNumeric: isNumeric ? numeric : undefined,
          valueText: isNumeric ? undefined : r.value || undefined,
          unit: r.unit || undefined,
        };
      });
    if (parsedResults.length === 0) return setError('Add at least one marker.');

    setBusy(true);
    setError(null);
    try {
      await postLog({
        mode: 'lab_panel',
        date,
        panelType,
        labName: labName || undefined,
        notes: notes || undefined,
        results: parsedResults,
      });
      setPanelType('');
      setLabName('');
      setNotes('');
      setResults([{ marker: '', value: '', unit: '' }]);
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
          <label>Panel type</label>
          <input
            placeholder="e.g. blood panel"
            value={panelType}
            onChange={(e) => setPanelType(e.target.value)}
          />
        </div>
      </div>
      <div className="hc-field">
        <label>Lab name (optional)</label>
        <input value={labName} onChange={(e) => setLabName(e.target.value)} />
      </div>

      <p className="muted small" style={{ margin: '0.6rem 0 0' }}>
        Markers
      </p>
      {results.map((r, i) => (
        <div className="hc-step-row" key={i}>
          <input
            className="nt-select"
            placeholder="marker (e.g. testosterone)"
            value={r.marker}
            onChange={(e) => setResult(i, { marker: e.target.value })}
          />
          <input
            className="nt-input"
            placeholder="value"
            value={r.value}
            onChange={(e) => setResult(i, { value: e.target.value })}
          />
          <input
            className="nt-input"
            placeholder="unit"
            value={r.unit}
            onChange={(e) => setResult(i, { unit: e.target.value })}
            style={{ flex: '0.6' }}
          />
          <button
            className="nt-btn-ghost"
            onClick={() => setResults(results.filter((_, j) => j !== i))}
            disabled={results.length === 1}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="nt-field-row">
        <button
          className="nt-btn-ghost"
          onClick={() =>
            setResults([...results, { marker: '', value: '', unit: '' }])
          }
        >
          + marker
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
