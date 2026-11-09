import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "The Last Beacon — LORE",
  description: "An interactive learning visual novel.",
};

export default function GameLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
