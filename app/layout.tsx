import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AppNav from "@/components/AppNav";

export const metadata: Metadata = {
  title: "Legends | Operating System",
  description: "Inventory Intelligence for eBay sports card businesses",
  icons: { icon: "/brand/command-l.svg" },
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body><div className="app-shell"><AppNav/>{children}</div></body>
    </html>
  );
}
