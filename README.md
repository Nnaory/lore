# LORE — Interactive Learning Visual Novel

> **Learn by Living the Knowledge.**

LORE transforms educational topics and materials into immersive, interactive visual novel adventures powered by **programmatic animations (`@remotion/player`)** and **multi-agent AI orchestration (`Python + LangChain + LangGraph`)**.

LORE is not a conventional quiz app with a story wrapper. Players step into a narrative world where concepts are visually explained by an expressive character, problems manifest on an interactive Remotion canvas, and understanding is demonstrated through meaningful decisions and direct canvas interactions.

---

## Product Vision & Core Flow

1. **Prompt & Configure (`learn something?`)** — Users enter what they want to learn (topic prompt or uploaded material) and configure their preferred number of chapters and genre/atmosphere.
2. **AI Scope Grilling (Human-in-the-Loop)** — If the topic scope is too broad for the requested chapter count, the AI interviews ("grills") the user to narrow down the exact sub-topics and learning focus before generation begins.
3. **Credit Estimation & Simulation** — Before running heavy generation, LORE calculates and simulates the credit cost based on chapter count, interactive canvas complexity, and material depth.
4. **NotebookLM-Style Background Synthesis** — A stateful **LangGraph** background pipeline synthesizes the curriculum, branching narrative scripts, character emotion beats, and parametric Remotion animation blueprints in parallel.
5. **Interactive 3-Pane Visual Novel Stage** — Players experience the generated campaign across three synchronized panels:
   - **Character Stage (Top-Left):** Expressive character with dynamic emotions and gestures while explaining or reacting.
   - **Interactive Remotion Canvas (Top-Right):** Client-side `@remotion/player` rendering animated visual explanations that pause on key frames to become interactive puzzles/simulations.
   - **Dialogue & Chat Controller (Bottom):** Narrative dialogue stream with a `fast | animate` toggle, free-form `type something` input (to ask the character questions in-world), and `log chat` history.

---

## System Architecture Overview

LORE separates the **Presentation & Deterministic Game Engine** (Next.js) from the **Stateful AI Orchestrator** (Python LangGraph):

```text
+-----------------------------------------------------------------------+
|                    FRONTEND (Next.js 16 + React 19)                   |
|                                                                       |
|  +-----------------------+  +--------------------------------------+  |
|  | Character Stage       |  | Interactive Remotion Canvas          |  |
|  | (Sprite / Motion /    |  | (@remotion/player + Interactive      |  |
|  |  Emotion State)       |  |  React Primitives via JSON Schema)   |  |
|  +-----------------------+  +--------------------------------------+  |
|  +-----------------------------------------------------------------+  |
|  | Dialogue & Chat Box: [fast | animate] [type something] [log]    |  |
|  +-----------------------------------------------------------------+  |
|  +-----------------------------------------------------------------+  |
|  | Deterministic Game Engine (HP, Knowledge State, Credit Ledger)  |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------+-----------------------------------+
                                    |
                     REST / SSE (Lightweight JSON)
                                    |
+-----------------------------------v-----------------------------------+
|              AI ORCHESTRATOR (Python + FastAPI + LangGraph)           |
|                                                                       |
|  1. Scope Analyzer & Griller Graph (Human-in-the-Loop `interrupt`)    |
|  2. Credit Estimator & Simulator                                      |
|  3. NotebookLM-Style Background Generator (`Send` parallel chapters): |
|     - Curriculum & Story Architect                                    |
|     - Character Dialogue & Emotion Scriptwriter                       |
|     - Remotion Scene Choreographer (JSON Keyframes & Primitives)      |
|     - Pydantic + Semantic Graph Validator                             |
|  4. Live In-Character Chat Responder (`type something` handler)       |
+-----------------------------------------------------------------------+
```

---

## Technology Stack

### Frontend & Game Client (`/src`)
| Technology | Purpose |
|---|---|
| **Next.js 16 (App Router)** | Web application framework & routing |
| **React 19 + TypeScript 5** | Strictly typed UI components & custom hooks |
| **Remotion (`@remotion/player`)** | Client-side programmatic animation & interactive canvas (planned v2) |
| **Tailwind CSS 4** | Styling & Dark Sci-Fi / Editorial design tokens |
| **Zod** | Runtime validation for incoming LangGraph JSON blueprints |
| **Lucide React** | Minimalist iconography |
| **Vitest + Testing Library** | Unit & component integration testing |

### Backend AI Orchestrator (`/backend` — Planned v2)
| Technology | Purpose |
|---|---|
| **Python 3.12 + FastAPI** | Async API server & Server-Sent Events (SSE) streaming |
| **LangChain + LangGraph** | Stateful multi-agent workflows, human-in-the-loop grilling, parallel chapter generation |
| **Pydantic v2** | Strict structured output schemas matching frontend Zod contracts |

---

## Documentation Index

| Document | Description |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | UI/UX wireframes, 3-pane stage layout, Preparation/Grilling flow, Remotion interaction patterns, and visual identity |
| [`docs/DOCS.md`](docs/DOCS.md) | Complete product & technical architecture, LangGraph pipeline, Remotion JSON contracts, credit simulation, and game engine rules |

---

## Repository Structure

```text
lore/
├── docs/
│   ├── DESIGN.md                 # UI/UX Design System, Wireframes & Interaction Spec
│   ├── DOCS.md                   # Product & Technical Architecture (v2 Overhaul)
│   └── assets/                   # Architecture & UI wireframe images
│       ├── wireframe-preparation.png
│       └── wireframe-main-stage.png
├── src/                          # Next.js Frontend & Deterministic Game Engine
│   ├── app/                      # App Router pages & legacy prototype API routes
│   ├── components/               # UI components (Campaign, Story, Puzzle)
│   ├── data/                     # Sample/dummy campaign fixtures
│   └── lib/                      # Deterministic game logic, types, and validators
├── tests/                        # Vitest unit and integration test suites
└── package.json
```

---

## Development Commands

```bash
# Install frontend dependencies
npm install

# Start the Next.js development server
npm run dev

# Run unit and integration tests
npm test

# Run linter
npm run lint

# Build for production
npm run build
```

---

## Current Status

LORE is currently undergoing a **major architectural overhaul (v1 $\rightarrow$ v2)**:
- **v1 Foundation (Complete in Repo):** Core deterministic game logic (HP system, knowledge tracking across retries, story player state machine, Zod validators, and dummy-first TypeScript AI pipeline).
- **v2 Overhaul (In Design / Transition):**
  - Migrating AI orchestration from Next.js Route Handlers to **Python + LangChain + LangGraph**.
  - Introducing the **Preparation + AI Grilling + NotebookLM-style Background Generation** flow.
  - Rebuilding the main gameplay view into the **3-Pane Interactive Layout** featuring **Character Stage**, **Interactive `@remotion/player` Canvas**, and **Chat/Playback Controller** (`fast | animate`, `type something`, `log chat`).
  - Adding the **Credit Simulation System**.

---

## License

Private. All rights reserved.
