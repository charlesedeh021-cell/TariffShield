import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TariffShield — Soroban customs-bond collateral rail',
  description:
    'US importers post yield-bearing USDC instead of dead-weight cash collateral. Soroban smart contracts auto-top-up bonds during tariff spikes. Stellar testnet build.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
