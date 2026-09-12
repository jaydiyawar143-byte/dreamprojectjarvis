import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

// Self-hosted at build time by next/font — no runtime request to Google, no
// layout shift. Exposed as CSS variables so Tailwind's fontFamily can pick
// them up (see tailwind.config.js).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JARVIS - AI Operating System",
  description: "Your personal AI operating system for marketing and business",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `h-full` on both, matching the height chain in globals.css: this is an app
    // shell with internal scroll regions, not a scrolling document.
    <html lang="en" className={`dark h-full ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="h-full overflow-hidden bg-gray-950 font-sans text-gray-100">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
