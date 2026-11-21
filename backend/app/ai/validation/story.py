"""Semantic validator for a StoryBlueprint (cross-reference checks).

Why: port of `frontend/src/lib/validation/story-validator.ts`. A schema cannot say that
`next_scene_id` must name an existing scene or that a bad branch may only start from a wrong
choice. The Story Generator does not call this (it uses `validate_generated_story`, which has the
generation-specific rules), but saved projects and the tests use it as the structural baseline,
and the generated stories must satisfy it. Same error codes, messages and `path` strings as the
TypeScript version. An empty list means valid.
"""

from __future__ import annotations

from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.story import (
    EndingScene,
    PuzzleScene,
    Scene,
    StoryBlueprint,
)
from app.ai.validation import validation_error


def collect_scenes(story: StoryBlueprint) -> list[Scene]:
    """All scenes of all chapters, in document order."""
    return [scene for chapter in story.chapters for scene in chapter.scenes]


def validate_story(
    story: StoryBlueprint, material: MaterialBlueprint | None = None
) -> list[dict[str, str]]:
    """Return the problems found in `story`; pass `material` to check concept references."""
    errors: list[dict[str, str]] = []
    scenes = collect_scenes(story)

    seen_scene_ids: set[str] = set()
    for scene in scenes:
        if scene.scene_id in seen_scene_ids:
            errors.append(
                validation_error(
                    "DUPLICATE_SCENE_ID",
                    f'Duplicate scene_id "{scene.scene_id}" found in story "{story.story_id}".',
                    f"scenes[{scene.scene_id}]",
                )
            )
        seen_scene_ids.add(scene.scene_id)

    for scene in scenes:
        if isinstance(scene, EndingScene):
            continue
        if scene.next_scene_id is not None and scene.next_scene_id not in seen_scene_ids:
            errors.append(
                validation_error(
                    "INVALID_NEXT_SCENE_REF",
                    f'Scene "{scene.scene_id}" references next_scene_id "{scene.next_scene_id}" '
                    f'which does not exist in story "{story.story_id}".',
                    f"scenes[{scene.scene_id}].next_scene_id",
                )
            )

    known_characters = set(story.character_ids)
    for scene in scenes:
        for character_id in scene.characters_present:
            if character_id not in known_characters:
                errors.append(
                    validation_error(
                        "INVALID_CHARACTER_REF",
                        f'Scene "{scene.scene_id}" references character_id "{character_id}" '
                        "which is not listed in story.character_ids.",
                        f"scenes[{scene.scene_id}].characters_present",
                    )
                )

    for scene in scenes:
        for block in getattr(scene, "content", []):
            if block.type == "dialogue" and block.character_id not in known_characters:
                errors.append(
                    validation_error(
                        "INVALID_DIALOGUE_CHARACTER_REF",
                        f'A dialogue block in scene "{scene.scene_id}" references character_id '
                        f'"{block.character_id}" which is not in story.character_ids.',
                        f"scenes[{scene.scene_id}].content[dialogue]",
                    )
                )

    known_puzzle_ids = {p.puzzle_id for p in story.puzzles}
    for scene in scenes:
        if isinstance(scene, PuzzleScene) and scene.puzzle_id not in known_puzzle_ids:
            errors.append(
                validation_error(
                    "INVALID_PUZZLE_REF",
                    f'Puzzle scene "{scene.scene_id}" references puzzle_id "{scene.puzzle_id}" '
                    "which does not exist in story.puzzles.",
                    f"scenes[{scene.scene_id}].puzzle_id",
                )
            )

    # Bad branches: each key must be a WRONG choice of the scene's puzzle, each value a scene.
    for scene in scenes:
        if not isinstance(scene, PuzzleScene) or not scene.on_incorrect_scene_id:
            continue
        puzzle = next((p for p in story.puzzles if p.puzzle_id == scene.puzzle_id), None)
        for choice_id, branch_scene_id in scene.on_incorrect_scene_id.items():
            path = f"scenes[{scene.scene_id}].on_incorrect_scene_id[{choice_id}]"
            if puzzle is not None:
                if not any(c.choice_id == choice_id for c in puzzle.choices):
                    errors.append(
                        validation_error(
                            "INVALID_BAD_BRANCH_CHOICE_REF",
                            f'Puzzle scene "{scene.scene_id}" maps choice "{choice_id}" to a bad '
                            f'branch, but puzzle "{puzzle.puzzle_id}" has no such choice.',
                            path,
                        )
                    )
                elif choice_id == puzzle.correct_choice_id:
                    errors.append(
                        validation_error(
                            "INVALID_BAD_BRANCH_CHOICE_REF",
                            f'Puzzle scene "{scene.scene_id}" maps the correct choice '
                            f'"{choice_id}" to a bad branch; only wrong choices can branch.',
                            path,
                        )
                    )
            if branch_scene_id not in seen_scene_ids:
                errors.append(
                    validation_error(
                        "INVALID_BAD_BRANCH_SCENE_REF",
                        f'Puzzle scene "{scene.scene_id}" sends choice "{choice_id}" to scene '
                        f'"{branch_scene_id}", which does not exist in story "{story.story_id}".',
                        path,
                    )
                )

    known_ending_ids = {e.ending_id for e in story.endings}
    for scene in scenes:
        if isinstance(scene, EndingScene) and scene.ending_id not in known_ending_ids:
            errors.append(
                validation_error(
                    "INVALID_ENDING_REF",
                    f'Ending scene "{scene.scene_id}" references ending_id "{scene.ending_id}" '
                    "which does not exist in story.endings.",
                    f"scenes[{scene.scene_id}].ending_id",
                )
            )

    if material is not None:
        known_concepts = {c.concept_id for c in material.concepts}
        for puzzle in story.puzzles:
            for concept_id in puzzle.concept_ids:
                if concept_id not in known_concepts:
                    errors.append(
                        validation_error(
                            "INVALID_CONCEPT_REF",
                            f'Puzzle "{puzzle.puzzle_id}" references concept_id "{concept_id}" '
                            f'which does not exist in material "{material.material_id}".',
                            f"puzzles[{puzzle.puzzle_id}].concept_ids",
                        )
                    )

    for entry in story.knowledge_mapping:
        if entry.introduced_in_scene_id not in seen_scene_ids:
            errors.append(
                validation_error(
                    "INVALID_KNOWLEDGE_MAPPING_SCENE_REF",
                    f'knowledge_mapping for concept "{entry.concept_id}" references '
                    f'introduced_in_scene_id "{entry.introduced_in_scene_id}" '
                    "which does not exist.",
                    f"knowledge_mapping[{entry.concept_id}].introduced_in_scene_id",
                )
            )
        if entry.tested_in_puzzle_id not in known_puzzle_ids:
            errors.append(
                validation_error(
                    "INVALID_KNOWLEDGE_MAPPING_PUZZLE_REF",
                    f'knowledge_mapping for concept "{entry.concept_id}" references '
                    f'tested_in_puzzle_id "{entry.tested_in_puzzle_id}" which does not exist.',
                    f"knowledge_mapping[{entry.concept_id}].tested_in_puzzle_id",
                )
            )

    # The mapped concept must really appear in the scene it names (when that scene teaches).
    for entry in story.knowledge_mapping:
        if entry.introduced_in_scene_id not in seen_scene_ids:
            continue  # already reported
        scene_concepts: set[str] = set()
        for chapter in story.chapters:
            scene = next(
                (s for s in chapter.scenes if s.scene_id == entry.introduced_in_scene_id), None
            )
            if scene is None:
                continue
            for block in getattr(scene, "content", []):
                if block.type == "learning_info":
                    scene_concepts.update(block.concept_ids)
        if scene_concepts and entry.concept_id not in scene_concepts:
            errors.append(
                validation_error(
                    "KNOWLEDGE_MAPPING_CONCEPT_NOT_IN_SCENE",
                    f'knowledge_mapping entry for concept "{entry.concept_id}" lists scene '
                    f'"{entry.introduced_in_scene_id}" as its introduction scene, but that '
                    f"scene's learning_info blocks do not reference concept "
                    f'"{entry.concept_id}".',
                    f"knowledge_mapping[{entry.concept_id}].introduced_in_scene_id",
                )
            )

    # ...and the mapped puzzle must really test that concept.
    for entry in story.knowledge_mapping:
        if entry.tested_in_puzzle_id not in known_puzzle_ids:
            continue  # already reported
        puzzle = next((p for p in story.puzzles if p.puzzle_id == entry.tested_in_puzzle_id), None)
        if puzzle is not None and entry.concept_id not in puzzle.concept_ids:
            errors.append(
                validation_error(
                    "KNOWLEDGE_MAPPING_CONCEPT_NOT_IN_PUZZLE",
                    f'knowledge_mapping entry for concept "{entry.concept_id}" lists puzzle '
                    f'"{entry.tested_in_puzzle_id}" as its test puzzle, but that puzzle\'s '
                    f'concept_ids do not include "{entry.concept_id}".',
                    f"knowledge_mapping[{entry.concept_id}].tested_in_puzzle_id",
                )
            )

    return errors
