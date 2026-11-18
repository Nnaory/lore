import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "New Story — LORE",
  description: "Turn your learning material into an interactive story.",
};

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
