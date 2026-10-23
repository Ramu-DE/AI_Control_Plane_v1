import type { Metadata } from "next";
import "./globals.css";
import { ApiErrorToast } from "@/components/ApiErrorToast";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Takeda Agent Management Platform",
  description:
    "Build and govern AI agents: registry, agents, policies, playground, model governance, and audit.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col lg:flex-row">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
        </div>
        {/* Mounted once: a refused request is visible even on a page whose
            handler does not catch. See components/ApiErrorToast.tsx. */}
        <ApiErrorToast />
      </body>
    </html>
  );
}
