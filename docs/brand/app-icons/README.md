# App icon sources

The helmet artwork behind every raster icon (PWA, apple-touch, Android launcher).
Do not hand-edit the PNGs: edit these SVGs and run `pnpm icons:build`
(`scripts/build-icons.ts`, needs Chrome/Chromium).

- `icon-512-dark.svg`: PWA "any" icons and apple-touch-icon.
- `icon-512-maskable.svg`: PWA maskable icon (corners dropped when rendered) and
  the helmet artwork reused for the Android adaptive layer and legacy icons.
- `icon-512-light.svg`: kept for the brand set; not rendered by the build.

The helmet sits `translate(96 67)` instead of `(96 96)`: the drawing's ink is not
centred in its 64-unit box, so it is lifted by `OPTICAL_LIFT` (5.8 units × 5) to
look centred (MZY-290). `__tests__/lib/iconCentering.test.ts` checks the PNGs.
