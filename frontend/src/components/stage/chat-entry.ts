/**
 * chat-entry.ts — the line shown in the Stage dialogue and kept in the story log.
 *
 * Why: the type used to live in ChatBox.tsx. StageDialogue, ChatLog and
 * StoryViewer all need it, so it lives in its own type-only module (ChatBox
 * was deleted in task 1.27).
 */

export type ChatEntry =
  | { kind: "narration"; text: string }
  | {
      kind: "dialogue";
      characterId: string;
      name: string;
      expression: string;
      expressionKey: string;
      text: string;
    }
  | { kind: "lesson"; title: string; text: string }
  | { kind: "question"; text: string }
  | {
      kind: "answer";
      characterId: string;
      name: string;
      expression: string;
      expressionKey: string;
      text: string;
    };
