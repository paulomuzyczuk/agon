import { execFileSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

// Regenerates every raster icon from the brand SVGs, so the helmet is placed in
// ONE spot and the next tweak isn't a hand edit of 19 PNGs (MZY-290).
//
//   pnpm icons:build                  write into the repo
//   pnpm icons:build --out=/tmp/x     write the same tree somewhere else
//   pnpm icons:build --lift=0         the pre-MZY-290 placement (to diff)
//
// Needs Chrome or Chromium (CHROME_BIN, default `google-chrome`): it is the one
// SVG renderer a dev machine reliably has. Outputs:
//   public/icons/*                 PWA icons (+ apple-touch) from the dark SVG;
//                                  the maskable one from the maskable SVG
//   android/app/src/main/res/mipmap-*/ic_launcher_foreground.png  adaptive layer
//   android/app/src/main/res/mipmap-*/ic_launcher{,_round}.png    legacy (< API 26)
// Splash screens are separate artwork and already centred.

const ROOT = resolve(__dirname, '..');
const SVG_DIR = 'docs/brand/app-icons';

// The helmet drawing is 64 units tall, but its ink is not centred in that box:
// crest top y≈6, visor bottom y≈67.25 (stroke caps included), so its bounding
// box centre sits 4.6 units low, and the mass sits lower still (the plume is
// thin, the helmet body heavy: alpha centroid ≈ +7 units). Centring on the
// bounding box alone left it looking top-heavy, so it is lifted by the midpoint
// of the two. Measured on the old xxxhdpi foreground: bbox +4.5, centroid +7.0.
export const OPTICAL_LIFT = 5.8;

// Android masks the 108 dp adaptive canvas to a ~66 dp circle: at this lift the
// crest tip (y≈22 of 108) and the visor (y≈83) stay inside it.
const ADAPTIVE_DP = 108;
const LEGACY_DP = 48;
// The old legacy icons drew the helmet 1.045× the adaptive layer's size.
const LEGACY_SCALE = 1.045;
const LEGACY_BG = '#C67139'; // @color/ic_launcher_background
const LEGACY_RX = (112 / 512) * ADAPTIVE_DP; // same corner radius as the PWA art
const DENSITY: Record<string, number> = {
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
};

interface Args {
  out: string;
  lift: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: ROOT, lift: OPTICAL_LIFT };
  for (const a of argv) {
    if (a.startsWith('--out=')) args.out = resolve(a.slice(6));
    else if (a.startsWith('--lift=')) args.lift = Number(a.slice(7));
    else throw new Error(`build-icons: unknown argument "${a}"`);
  }
  if (!Number.isFinite(args.lift)) {
    throw new Error('build-icons: --lift must be a number');
  }
  return args;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The brand SVGs place the 64-unit helmet with `translate(96 96) scale(5)`.
 * Re-seat it at `96 − 5·lift` so the three files stay the source of truth for
 * the PWA icons, and fail loudly when they were hand-edited out of step.
 */
function lifted(svg: string, lift: number, file: string): string {
  const from = 'translate(96 96) scale(5)';
  const to = `translate(96 ${96 - 5 * OPTICAL_LIFT}) scale(5)`;
  const current = svg.includes(from) ? from : to;
  if (!svg.includes(current)) {
    throw new Error(`build-icons: ${file} has no helmet transform to adjust`);
  }
  // The checked-in file must already hold the standard lift; --lift overrides it.
  if (current === from && lift !== 0) {
    throw new Error(
      `build-icons: ${file} still has the un-lifted transform "${from}"; ` +
        `expected "${to}". Edit the SVG or pass --lift=0.`,
    );
  }
  return svg.replace(current, `translate(96 ${96 - 5 * lift}) scale(5)`);
}

/** Inner artwork + group attributes of the maskable SVG (cream helmet, pale crest). */
function helmetArtwork(): { attrs: string; inner: string } {
  const svg = read(`${SVG_DIR}/icon-512-maskable.svg`);
  const m = svg.match(/<g transform="[^"]*"([^>]*)>([\s\S]*?)<\/g>/);
  if (!m) throw new Error('build-icons: no helmet group in the maskable SVG');
  return { attrs: m[1]!, inner: m[2]! };
}

const wrap = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ADAPTIVE_DP} ${ADAPTIVE_DP}" width="${size}" height="${size}">${body}</svg>`;

function foregroundSvg(lift: number, size: number): string {
  const { attrs, inner } = helmetArtwork();
  // 1:1 artwork, its 64-unit box centred on the 108 canvas, then lifted.
  return wrap(
    size,
    `<g transform="translate(22 ${22 - lift})"${attrs}>${inner}</g>`,
  );
}

function legacySvg(lift: number, size: number, round: boolean): string {
  const { attrs, inner } = helmetArtwork();
  const half = ADAPTIVE_DP / 2;
  const shape = round
    ? `<circle cx="${half}" cy="${half}" r="${half}" fill="${LEGACY_BG}"/>`
    : `<rect width="${ADAPTIVE_DP}" height="${ADAPTIVE_DP}" rx="${LEGACY_RX}" fill="${LEGACY_BG}"/>`;
  // Artwork point (32, 32 + lift) lands on the canvas centre.
  return wrap(
    size,
    `${shape}<g transform="translate(${half} ${half}) scale(${LEGACY_SCALE}) translate(-32 ${-(32 + lift)})"${attrs}>${inner}</g>`,
  );
}

function renderPng(svg: string, size: number, outFile: string, tmp: string) {
  const html = join(tmp, 'icon.html');
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg.replace(/ width="\d+" height="\d+"/, '')}`,
  );
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync(
    process.env.CHROME_BIN || 'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${outFile}`,
      `file://${html}`,
    ],
    { stdio: 'ignore' },
  );
}

function main() {
  const { out, lift } = parseArgs(process.argv.slice(2));
  const tmp = mkdtempSync(join(tmpdir(), 'agon-icons-'));
  const res = 'android/app/src/main/res';
  let n = 0;
  const emit = (svg: string, size: number, rel: string) => {
    renderPng(svg, size, join(out, rel), tmp);
    n += 1;
  };
  try {
    // PWA: dark art for the "any" icons, maskable art (square: Android applies
    // its own mask) for the maskable one.
    const dark = lifted(
      read(`${SVG_DIR}/icon-512-dark.svg`),
      lift,
      'icon-512-dark.svg',
    );
    emit(dark, 192, 'public/icons/icon-192.png');
    emit(dark, 512, 'public/icons/icon-512.png');
    emit(dark, 180, 'public/icons/apple-touch-icon.png');
    const maskable = lifted(
      read(`${SVG_DIR}/icon-512-maskable.svg`),
      lift,
      'icon-512-maskable.svg',
    ).replace(' rx="112"', '');
    emit(maskable, 512, 'public/icons/icon-maskable-512.png');

    // Android launcher icons, every density.
    for (const [name, d] of Object.entries(DENSITY)) {
      const dir = `${res}/mipmap-${name}`;
      const adaptive = ADAPTIVE_DP * d;
      const legacy = LEGACY_DP * d;
      emit(
        foregroundSvg(lift, adaptive),
        adaptive,
        `${dir}/ic_launcher_foreground.png`,
      );
      emit(legacySvg(lift, legacy, false), legacy, `${dir}/ic_launcher.png`);
      emit(
        legacySvg(lift, legacy, true),
        legacy,
        `${dir}/ic_launcher_round.png`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`build-icons: wrote ${n} PNGs under ${out} (lift ${lift})`);
}

if (require.main === module) main();
