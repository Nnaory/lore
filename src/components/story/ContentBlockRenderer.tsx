/**
 * ContentBlockRenderer
 *
 * Renders a single SceneContent block based on its type.
 * Used to render revealed content blocks in the chat log.
 */

import type { SceneContent } from "@/lib/types/scene";
import type { CharacterIndex } from "@/lib/story/story-player";
import { NarrationBlock } from "./NarrationBlock";
import { CharacterBubble } from "./CharacterBubble";
import { LearningCard } from "./LearningCard";

type ContentBlockRendererProps = {
  block: SceneContent;
  characterIndex: CharacterIndex;
};

export function ContentBlockRenderer({
  block,
  characterIndex,
}: ContentBlockRendererProps) {
  if (block.type === "narration") {
    return <NarrationBlock text={block.text} />;
  }

  if (block.type === "dialogue") {
    return (
      <CharacterBubble
        characterId={block.character_id}
        expressionKey={block.expression}
        text={block.text}
        characterIndex={characterIndex}
        isMC={false}
      />
    );
  }

  if (block.type === "learning_info") {
    return (
      <LearningCard
        title={block.title}
        body={block.body}
        conceptIds={block.concept_ids}
      />
    );
  }

  // Exhaustive check — TypeScript ensures all cases are covered
  const _exhaustive: never = block;
  return null;
}
