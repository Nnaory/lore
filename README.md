# LORE — Interactive Learning Visual Novel

> **Learn by Living the Knowledge.**

LORE transforms educational materials into immersive, interactive, branching visual novel adventures. The player becomes the main character of a story where learning happens naturally through narrative situations, character interactions, conflicts, and meaningful decisions.

LORE is not a quiz platform with a story wrapped around it. It is an interactive narrative experience in which learning is part of the world, the conflict, and the player's decisions.

---

## Product Vision

Users provide educational materials, configure their preferred adventure settings, and receive an interactive learning campaign. Academic concepts become fictional situations where players must understand and apply knowledge to progress through the story.

See [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md) for the full product vision, principles, and success criteria.

---

## Core Features (Planned)

- **Material Upload** — PDF, DOCX, TXT, or pasted text input.
- **AI-Powered Generation** — Layered pipeline transforms materials into structured campaign data.
- **Interactive Visual Novel** — Narrative scenes, character dialogue, and meaningful branching choices.
- **Persistent Consequences** — Player decisions affect world state, relationships, and future story events.
- **Multi-Story Campaigns** — Multiple educational materials connected into one coherent adventure.
- **Evidence-Based Learning** — Progress tracked through demonstrated understanding, not item exposure.
- **Final Reflection** — Personalized epilogue and learning summary at campaign end.
- **Local Persistence** — Campaign progress saved in the browser via localStorage and IndexedDB.

> These features describe the planned product. See [docs/ROADMAP.md](docs/ROADMAP.md) for current implementation status.

---

## Technology Stack

| Technology | Purpose |
|---|---|
| Next.js 16 | Web framework |
| App Router | Application routing |
| TypeScript 5 | Static typing |
| React 19 | UI components |
| Tailwind CSS 4 | Styling |
| Lucide React | Icons |
| React State / Context | Application and game state (planned) |
| localStorage | Small local data (planned) |
| IndexedDB | Larger campaign data (planned) |
| Zod | Runtime data validation (planned) |
| PDF.js | PDF text extraction (planned) |
| Mammoth.js | DOCX text extraction (planned) |
| Vitest | Unit testing (planned) |
| Playwright | End-to-end testing (planned) |
| Vercel | Deployment |

LORE uses a fully custom UI architecture. shadcn/ui and Radix UI are deliberately excluded.

---

## Prerequisites

- Node.js 20 or later
- npm 10 or later

---

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd lore

# Install dependencies
npm install
```

---

## Development Commands

```bash
# Start the development server (with Turbopack)
npm run dev

# Build for production
npm run build

# Start the production server
npm start

# Run the linter
npm run lint
```

The development server runs at [http://localhost:3000](http://localhost:3000).

---

## Project Structure

```
lore/
├── src/
│   └── app/                  # Next.js App Router root
│       ├── layout.tsx        # Root layout
│       ├── page.tsx          # Landing page (default Next.js scaffold)
│       └── globals.css       # Global styles
├── public/                   # Static assets
├── docs/                     # Project documentation
│   ├── PRODUCT_VISION.md
│   ├── ROADMAP.md
│   ├── TECHNICAL_OVERVIEW.md
│   └── DEVELOPMENT_GUIDE.md
├── next.config.ts            # Next.js configuration
├── tsconfig.json             # TypeScript configuration
├── eslint.config.mjs         # ESLint configuration
└── package.json
```

> The directory structure above reflects the current repository state. The proposed full application structure is documented in [docs/TECHNICAL_OVERVIEW.md](docs/TECHNICAL_OVERVIEW.md).

---

## Documentation

| Document | Description |
|---|---|
| [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md) | Product identity, principles, experience workflow, and success criteria |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Full development roadmap with milestones 0–12 and current status |
| [docs/TECHNICAL_OVERVIEW.md](docs/TECHNICAL_OVERVIEW.md) | Architecture, AI generation pipeline, data contracts, and deployment strategy |
| [docs/DEVELOPMENT_GUIDE.md](docs/DEVELOPMENT_GUIDE.md) | Coding conventions, component patterns, and contributor guidelines |

---

## Current Development Status

**Milestone 0 — Project Foundation** is partially complete.

Completed:
- Next.js 16 initialized with TypeScript, App Router, and Tailwind CSS 4.
- Lucide React installed.
- ESLint configured.
- Git repository prepared.
- Initial documentation created.

In progress / remaining:
- Project conventions to be established.
- Application source code not yet started.

**Milestone 1 and beyond are planned. No application features have been implemented yet.**

---

## Roadmap Summary

| Milestone | Goal | Status |
|---|---|---|
| 0 | Project Foundation | 🔄 In Progress |
| 1 | Product Design and UI Foundation | 📋 Planned |
| 2 | Material Input and Processing | 📋 Planned |
| 3 | Adventure Configuration | 📋 Planned |
| 4 | AI Prompt Architecture and Data Contracts | 📋 Planned |
| 5 | Mock AI and Campaign Data | 📋 Planned |
| 6 | Narrative Game Engine | 📋 Planned |
| 7 | Visual Novel Experience | 📋 Planned |
| 8 | Campaign Continuity and Multi-Material Integration | 📋 Planned |
| 9 | Local Persistence and User Experience | 📋 Planned |
| 10 | AI API Integration | 📋 Planned |
| 11 | Learning Evaluation and Final Reflection | 📋 Planned |
| 12 | Quality Assurance and Final Testing | 📋 Planned |

See [docs/ROADMAP.md](docs/ROADMAP.md) for full milestone details.

---

## License

Private. All rights reserved.
