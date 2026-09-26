import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexo POS",
  description: "მოლარის სისტემა",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ka">
      <body>{children}</body>
    </html>
  );
}
