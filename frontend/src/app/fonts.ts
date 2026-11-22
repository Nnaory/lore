/**
 * LORE fonts. In app/layout.tsx:
 *
 *   import { jetbrainsMono, spaceGrotesk } from './fonts';
 *   <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
 *
 * JetBrains Mono is REQUIRED for every ASCII layer: the engine assumes a 0.6em advance.
 */
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';

export const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});
