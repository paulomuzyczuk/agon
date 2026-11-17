import { readFileSync } from 'fs';
import { join } from 'path';
import { inflateSync } from 'zlib';
import { OPTICAL_LIFT } from '@/scripts/build-icons';

// Regression test for MZY-290: the helmet in the launcher/PWA icons sat ~4 %
// below centre. Decodes the COMMITTED PNGs (8-bit RGBA, non-interlaced, which
// is what `pnpm icons:build` writes) and measures where the ink is.

const ROOT = join(__dirname, '..', '..');
const RES = 'android/app/src/main/res';

interface Image {
  w: number;
  h: number;
  px: Uint8Array; // RGBA
}

function decodePng(file: string): Image {
  const buf = readFileSync(join(ROOT, file));
  let pos = 8; // signature
  let w = 0;
  let h = 0;
  let bpp = 4;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const [depth, color, , , interlace] = [data[8], data[9], 0, 0, data[12]];
      if (depth !== 8 || (color !== 6 && color !== 2) || interlace !== 0) {
        throw new Error(`${file}: need 8-bit non-interlaced RGB(A)`);
      }
      bpp = color === 6 ? 4 : 3; // a fully opaque icon is stored without alpha
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = new Uint8Array(w * h * 4); // always RGBA out
  const row = new Uint8Array(h * stride); // unfiltered scanlines
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= bpp ? row[y * stride + i - bpp]! : 0;
      const up = y > 0 ? row[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= bpp ? row[(y - 1) * stride + i - bpp]! : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + left;
      else if (filter === 2) v = x + up;
      else if (filter === 3) v = x + ((left + up) >> 1);
      else {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      row[y * stride + i] = v & 255;
    }
  }
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) px[p * 4 + c] = row[p * bpp + c]!;
    px[p * 4 + 3] = bpp === 4 ? row[p * bpp + 3]! : 255;
  }
  return { w, h, px };
}

interface Placement {
  /** Bounding-box centre minus canvas centre, % of the canvas (+ = low/right). */
  bboxX: number;
  bboxY: number;
  /** Same for the ink's centre of mass. */
  massY: number;
  /** Farthest ink pixel from the canvas centre, % of the canvas width. */
  reach: number;
}

/** Ink = opaque pixels (foreground layer) or pixels unlike the background. */
function placement(img: Image, background: 'transparent' | 'panel'): Placement {
  const { w, h, px } = img;
  const at = (x: number, y: number) => y * w * 4 + x * 4;
  const ref = at(Math.floor(w / 2), 6);
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  let sumY = 0;
  let n = 0;
  let reach = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      const ink =
        background === 'transparent'
          ? px[i + 3]! > 20
          : px[i + 3]! > 20 &&
            Math.abs(px[i]! - px[ref]!) +
              Math.abs(px[i + 1]! - px[ref + 1]!) +
              Math.abs(px[i + 2]! - px[ref + 2]!) >
              60;
      if (!ink) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      sumY += y;
      n += 1;
      reach = Math.max(reach, Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2));
    }
  }
  return {
    bboxX: (((x0 + x1) / 2 - w / 2) / w) * 100,
    bboxY: (((y0 + y1) / 2 - h / 2) / h) * 100,
    massY: ((sumY / n - h / 2) / h) * 100,
    reach: (reach / w) * 100,
  };
}

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

describe('launcher icon: the helmet is centred (MZY-290)', () => {
  it.each(DENSITIES)('adaptive foreground, %s', (d) => {
    const p = placement(
      decodePng(`${RES}/mipmap-${d}/ic_launcher_foreground.png`),
      'transparent',
    );
    // Balanced between bounding box and mass: neither is more than ~2 % off,
    // and their midpoint is on the centre. (Before the fix: bbox +4.2 %.)
    expect(Math.abs(p.bboxY)).toBeLessThan(2.2);
    expect(Math.abs(p.massY)).toBeLessThan(2.2);
    expect(Math.abs((p.bboxY + p.massY) / 2)).toBeLessThan(0.7);
    expect(Math.abs(p.bboxX)).toBeLessThan(1);
    // Android crops the 108 dp layer to a 66 dp circle: stay inside it.
    expect(p.reach).toBeLessThan((33 / 108) * 100);
  });

  it.each([
    ['public/icons/icon-512.png'],
    ['public/icons/icon-maskable-512.png'],
    ['public/icons/icon-192.png'],
    ['public/icons/apple-touch-icon.png'],
  ])('PWA icon %s', (file) => {
    const p = placement(decodePng(file), 'panel');
    expect(Math.abs((p.bboxY + p.massY) / 2)).toBeLessThan(0.7);
    expect(Math.abs(p.bboxX)).toBeLessThan(1);
  });

  it.each(['ic_launcher', 'ic_launcher_round'])('legacy %s, xxxhdpi', (n) => {
    const p = placement(decodePng(`${RES}/mipmap-xxxhdpi/${n}.png`), 'panel');
    expect(Math.abs((p.bboxY + p.massY) / 2)).toBeLessThan(0.7);
    expect(Math.abs(p.bboxX)).toBeLessThan(1);
  });

  it('the brand SVGs carry the same lift the generator uses', () => {
    for (const v of ['dark', 'light', 'maskable']) {
      const svg = readFileSync(
        join(ROOT, `docs/brand/app-icons/icon-512-${v}.svg`),
        'utf8',
      );
      expect(svg).toContain(`translate(96 ${96 - 5 * OPTICAL_LIFT}) scale(5)`);
    }
  });
});
