import type { MetadataRoute } from 'next';

// PWA manifest (Next.js App Router convention: app/manifest.ts → /manifest.webmanifest).
// Mobile-first, installable shell. Chrome only offers "Install app" with a
// 192 px and a 512 px PNG icon, so these are rendered from the brand SVGs in
// design_system/v.1/assets/app-icons/ (the maskable one without the rounded
// corners, because Android applies its own mask).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agon — Performance Tracking',
    short_name: 'Agon',
    description: 'Your body, logged. Your progress, earned.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    orientation: 'portrait',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
