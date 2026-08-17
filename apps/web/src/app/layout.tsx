import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

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
    <html lang="en" className="dark">
      <body className="bg-gray-950 text-gray-100">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
