'use client';

import type { GearMileageItem } from '@/lib/rideMarts';

// Gear mileage table — total km per shoe/bike/etc., summed across runs and
// rides (services/marts/gear.ts). First gear-facing page in the app; no
// direct prior art to mirror.

const AXIS = '#6b7280';

const CATEGORY_LABEL: Record<string, string> = {
  shoe: 'Shoe',
  bike: 'Bike',
  hrm: 'HRM',
  watch: 'Watch',
  wristband: 'Wristband',
  other: 'Other',
};

export function GearList({ gear }: { gear: GearMileageItem[] }) {
  if (gear.length === 0) {
    return <p style={{ color: AXIS }}>No gear yet.</p>;
  }

  return (
    <table
      className="gear-table"
      style={{ width: '100%', borderCollapse: 'collapse' }}
    >
      <thead>
        <tr style={{ textAlign: 'left', color: AXIS, fontSize: '0.8rem' }}>
          <th style={{ padding: '0.4rem 0.5rem 0.4rem 0' }}>Name</th>
          <th>Category</th>
          <th>Brand</th>
          <th style={{ textAlign: 'right' }}>Total km</th>
          <th style={{ textAlign: 'right' }}>Activities</th>
        </tr>
      </thead>
      <tbody>
        {gear.map((g) => (
          <tr
            key={g.gearId}
            style={{
              opacity: g.retired ? 0.55 : 1,
              borderTop: '1px solid #232830',
            }}
          >
            <td style={{ padding: '0.5rem 0.5rem 0.5rem 0' }}>
              {g.name}
              {g.retired && <span className="muted small"> (retired)</span>}
              {g.dueMaintenanceTasks.length > 0 && (
                <div className="small" style={{ color: '#e0a030' }}>
                  ⚠️ Due: {g.dueMaintenanceTasks.join(', ')}
                </div>
              )}
            </td>
            <td>{CATEGORY_LABEL[g.category] ?? g.category}</td>
            <td>{g.brand ?? '—'}</td>
            <td style={{ textAlign: 'right' }}>
              {g.totalKm != null ? g.totalKm.toFixed(1) : '—'}
            </td>
            <td style={{ textAlign: 'right' }}>{g.activityCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
