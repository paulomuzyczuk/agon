import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { sendMessage } from '../services/telegram/api';
import { computeDueTasks } from '../lib/gearMaintenance';
import {
  findActiveBikeGear,
  loadMaintenanceTasks,
  loadLastServices,
} from '../services/gearMaintenance';
import { gearMileage } from '../services/marts/gear';

// Bike maintenance alerts (backlog #3, mirrors the data-freshness dead-man's
// switch pattern in scripts/check-data-freshness.ts) — a much simpler check:
// no dbt/artifact step, just a direct query comparing each active bike's
// current mileage (services/marts/gear.ts gearMileage) against the
// maintenance-task catalog (lib/gearMaintenance.ts computeDueTasks).
//
//   pnpm gear:check-maintenance                 run checks, print, notify, exit
//                                                non-zero on anything due
//   pnpm gear:check-maintenance --no-telegram   print only
//
// Unlike the freshness check, "nothing due" is NOT itself worth a Telegram
// message — only a threshold crossing is, so a healthy bike never spams the
// phone (same "cried-wolf" reasoning CLAUDE.md gives for freshness thresholds).

async function notify(message: string): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (!chatId) {
    // eslint-disable-next-line no-console
    console.log(
      '(TELEGRAM_OWNER_CHAT_ID not set — printed above, not sent to Telegram)',
    );
    return;
  }
  try {
    await sendMessage(chatId, message);
  } catch (err) {
    logger.warn('gear-maintenance alert could not be sent', {
      job: 'gear-maintenance',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  loadEnv();
  const withTelegram = !process.argv.includes('--no-telegram');

  const bikes = await findActiveBikeGear();
  if (bikes.length === 0) {
    // eslint-disable-next-line no-console
    console.log('\nNo active bike in public.gear — nothing to check.\n');
    return;
  }

  const [tasks, lastServicesByGear, gear] = await Promise.all([
    loadMaintenanceTasks(),
    loadLastServices(),
    gearMileage(),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  const lines: string[] = [];
  let anyDue = false;
  for (const bike of bikes) {
    const totalKm = gear.find((g) => g.gearId === bike.gearId)?.totalKm ?? 0;
    const due = computeDueTasks(
      tasks,
      lastServicesByGear.get(bike.gearId) ?? [],
      totalKm,
      today,
    );
    if (due.length === 0) continue;
    anyDue = true;
    for (const t of due) {
      const over =
        t.kmSinceService != null && t.intervalKm != null
          ? `${Math.round(t.kmSinceService - t.intervalKm)} km over`
          : t.daysSinceService != null && t.intervalDays != null
            ? `${t.daysSinceService - t.intervalDays} days over`
            : 'overdue';
      lines.push(`🔧 ${bike.name}: ${t.name} — ${over}`);
    }
  }

  if (!anyDue) {
    // eslint-disable-next-line no-console
    console.log(
      `\n✅ All bike maintenance up to date (${bikes.length} bike(s) checked).\n`,
    );
    logger.info('gear-maintenance check complete', {
      job: 'gear-maintenance',
      due: 0,
    });
    return;
  }

  const message = `Bike maintenance due:\n${lines.join('\n')}`;
  // eslint-disable-next-line no-console
  console.log(`\n${message}\n`);
  logger.warn('gear-maintenance check found overdue tasks', {
    job: 'gear-maintenance',
    due: lines.length,
  });
  if (withTelegram) await notify(message);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.error(
      'gear:check-maintenance failed',
      { job: 'gear-maintenance' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
