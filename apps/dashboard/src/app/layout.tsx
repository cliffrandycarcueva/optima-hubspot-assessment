import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Optima Solutions — HubSpot Order Sync',
  description: 'Order synchronization history and recovery console.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
