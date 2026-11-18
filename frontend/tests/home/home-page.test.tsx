/**
 * Tests — home page
 *
 * @vitest-environment jsdom
 *
 * The home page is a title over one chat field, with the demo link and the
 * saved stories below. There is no avatar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "@/app/page";
import { freshStore } from "../fixtures/fresh-store";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(freshStore);

describe("home page", () => {
  it("shows the title above the chat field", () => {
    render(<Home />);
    const title = screen.getByRole("heading", { level: 1, name: "LORE" });
    const field = screen.getByTestId("home-input");
    expect(title.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("home-attach")).toBeTruthy();
  });

  it("keeps the demo reachable", () => {
    render(<Home />);
    expect(screen.getByTestId("home-demo-link").getAttribute("href")).toBe("/game");
  });

  it("has no avatar", () => {
    render(<Home />);
    expect(screen.queryByText(/avatar/i)).toBeNull();
  });
});
