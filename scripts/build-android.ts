import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from './loadEnv';
import {
  androidVersionCode,
  parseAndroidServerUrl,
  parseAndroidSigningEnv,
} from '../lib/androidShell';
import { logger } from '../services/logger';

// Signed release APK for the Capacitor Android shell (MZY-274), sideloaded —
// no Play Store. Validates every input BEFORE Gradle runs, so a missing
// keystore or a plain-HTTP server URL fails in one readable line instead of
// a Gradle stack trace or, worse, an unsigned / broken APK.
//
//   pnpm android:build   → android/app/build/outputs/apk/release/app-release.apk
//
// Needs JAVA_HOME (JDK 21) and ANDROID_HOME (SDK platform 36 + build-tools);
// see docs/self-hosting/android-app.md.

loadEnv();

const repoRoot = process.cwd();
const androidDir = join(repoRoot, 'android');
const job = 'android-build';

function fail(message: string): never {
  logger.error(message, { job });
  process.exit(1);
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0)
    fail(
      `${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`,
    );
}

function findApksigner(androidHome: string): string | null {
  const buildTools = join(androidHome, 'build-tools');
  if (!existsSync(buildTools)) return null;
  const latest = readdirSync(buildTools).sort().at(-1);
  const path = latest ? join(buildTools, latest, 'apksigner') : null;
  return path && existsSync(path) ? path : null;
}

function main(): void {
  for (const name of ['JAVA_HOME', 'ANDROID_HOME'] as const) {
    if (!process.env[name] || !existsSync(process.env[name]!)) {
      fail(
        `${name} is not set or does not exist — see docs/self-hosting/android-app.md`,
      );
    }
  }

  let serverUrl: string;
  try {
    serverUrl = parseAndroidServerUrl(process.env.AGON_ANDROID_SERVER_URL).url;
    parseAndroidSigningEnv(process.env, repoRoot, existsSync);
  } catch (err) {
    const issues = (err as { issues?: Array<{ message: string }> }).issues;
    fail(issues ? issues.map((i) => i.message).join('; ') : String(err));
  }

  const versionCode = androidVersionCode(Date.now());
  const { version: versionName } = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
  ) as {
    version: string;
  };
  logger.info('building signed release APK', {
    job,
    serverUrl,
    versionCode,
    versionName,
  });

  run(
    join(repoRoot, 'node_modules', '.bin', 'cap'),
    ['sync', 'android'],
    repoRoot,
  );
  run(
    './gradlew',
    [
      'assembleRelease',
      `-PagonVersionCode=${versionCode}`,
      `-PagonVersionName=${versionName}`,
      '--console=plain',
    ],
    androidDir,
  );

  const apk = join(
    androidDir,
    'app',
    'build',
    'outputs',
    'apk',
    'release',
    'app-release.apk',
  );
  if (!existsSync(apk))
    fail(
      `Gradle succeeded but ${apk} is missing — was the release left unsigned?`,
    );

  const apksigner = findApksigner(process.env.ANDROID_HOME!);
  if (apksigner) run(apksigner, ['verify', apk], repoRoot);
  else
    logger.warn('apksigner not found; skipped signature verification', { job });

  logger.info('signed APK ready', { job, apk, versionCode });
}

main();
