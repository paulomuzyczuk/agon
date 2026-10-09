import type { MetadataRoute } from 'next';

// PWA manifest (Next.js App Router convention: app/manifest.ts → /manifest.webmanifest).
// Mobile-first, installable shell. Icons are intentionally omitted until real
// brand assets land (see design_system/v.1/assets/app-icons/) — add an
// `icons: [...]` array pointing at files under public/ then. Structure first.
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
  };
}
