import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { OutboxStatus } from '@/components/OutboxStatus';

// Mobile-first PWA shell (sihha shape). Phase 3 dashboard: read-only views over
// the dbt marts (writes stay in Telegram). The first feature view is
// /training-load (Fitness/Fatigue/Form).
export const metadata: Metadata = {
  title: 'Agon',
  description: 'Personal performance tracking platform for hybrid athletes.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OutboxStatus />
        {children}
      </body>
    </html>
  );
}
