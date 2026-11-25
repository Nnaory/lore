# ruff: noqa: E501
"""Deterministic genre templates and kaomoji expressions for the Campaign Planner.

Why: the planner keeps the campaign structure (IDs, order, outcomes) in the app and uses these
templates as the base text. Gemini only rewrites the creative fields on top; when it fails the
template text is kept, so planning never fails because of the creative step. The strings were
generated from the constants in `frontend/src/lib/ai/campaign-planner-engine.ts` (and
`GENRE_LABEL` from `providers/gemini-campaign-planner-provider.ts`), not retyped, so both sides
produce the same campaign text. Long lines are expected here.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TemplateCharacter:
    character_id: str
    name: str
    role: str
    description: str


# Kit cast (docs/DESIGN-SYSTEM.md section 6). The first two are genre-flavoured in each template
# below; the other three are the same in every genre. Order is fixed: eldric, mira, hazel, varr, nyx.
# Layer 3 (the story engine) only uses characters[0] (guide) and characters[1] (companion).
CAST_IDS: tuple[str, ...] = ("eldric", "mira", "hazel", "varr", "nyx")

EXTRA_CAST: tuple[TemplateCharacter, ...] = (
    TemplateCharacter(
        character_id="hazel",
        name="Hazel",
        role="Witch of the Ember Marsh",
        description="A practical experimenter who turns theory into experiments the player can try.",
    ),
    TemplateCharacter(
        character_id="varr",
        name="Varr",
        role="Warden of the Outer Gate",
        description="A stern examiner who tests understanding before letting the player pass.",
    ),
    TemplateCharacter(
        character_id="nyx",
        name="Nyx",
        role="The Hollow Voice",
        description="A rival voice that plants plausible misconceptions for the player to catch.",
    ),
)


@dataclass(frozen=True)
class GenreTemplate:
    tone: str
    setting: str
    premise: str
    main_conflict_template: str  # contains the "{topic}" placeholder
    world_rules: tuple[str, ...]
    characters: tuple[TemplateCharacter, ...]


BASE_EXPRESSIONS: dict[str, str] = {
    "neutral": "(-_-)",
    "worried": "(>_<)",
    "thinking": "(¬_¬)",
    "surprised": "(O_O)",
    "approving": "(^_^)",
    "stern": "(ಠ_ಠ)",
}

GENRE_LABEL: dict[str, str] = {
    "fantasy": "fantasy (ancient realms, fading magic)",
    "modern": "non-fiction / modern day (the real world, today)",
    "science_fiction": "science fiction (research stations, future technology)",
    "mystery": "mystery",
    "historical": "historical",
    "survival": "survival",
    "horror": "atmospheric horror (no gore)",
    "custom": "a genre chosen by the player",
}

GENRE_TEMPLATES: dict[str, GenreTemplate] = {
    "fantasy": GenreTemplate(
        tone="mysterious",
        setting="an ancient realm held together by fading wards",
        premise="A world whose old safeguards are failing, where only those who truly understand the underlying principles can restore them.",
        main_conflict_template="The central ward is failing, and only knowledge of {topic} can restore it.",
        world_rules=(
            "The world follows consistent, learnable principles; understanding them is the only reliable path forward.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A patient guardian of the old knowledge who tests understanding rather than obedience.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A curious learner who voices the questions the player should be asking.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "modern": GenreTemplate(
        tone="grounded",
        setting="a contemporary city facing a quiet crisis of failing systems",
        premise="Ordinary systems are breaking down, and practical understanding of the material is the only tool available.",
        main_conflict_template="A critical system is failing, and resolving it requires applying {topic}.",
        world_rules=(
            "The world behaves like reality; every problem has a principled solution.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="An experienced professional who frames problems in practical terms.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A sharp colleague who works through ideas out loud.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "science_fiction": GenreTemplate(
        tone="wondrous",
        setting="a research frontier where theory decides survival",
        premise="At the edge of known space, only rigorous understanding of the material keeps fragile systems alive.",
        main_conflict_template="The station's core process is failing; only {topic} can stabilize it.",
        world_rules=(
            "Technology follows the material's principles exactly; sloppy thinking has visible consequences.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A rigorous researcher who values correct reasoning over instinct.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A hands-on engineer who turns theory into working solutions.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "mystery": GenreTemplate(
        tone="suspenseful",
        setting="a place where the truth is hidden behind layered clues",
        premise="Something is wrong, and the only way to the truth is mastering the material's underlying logic.",
        main_conflict_template="The case cannot be closed without a firm grasp of {topic}.",
        world_rules=(
            "Every clue follows the material's logic; conclusions must be earned.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A methodical investigator who models careful reasoning.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="An observant witness who notices what others miss.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "historical": GenreTemplate(
        tone="reflective",
        setting="a pivotal moment in history where knowledge changes fate",
        premise="In an era of change, understanding the material determines which future arrives.",
        main_conflict_template="The moment turns on whether anyone can apply {topic} correctly.",
        world_rules=(
            "The era behaves according to its own constraints; the material's principles still hold.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A keeper of records who connects ideas across time.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A curious newcomer who asks the questions history forgot.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "survival": GenreTemplate(
        tone="tense",
        setting="a harsh environment where every resource matters",
        premise="Survival depends on applying the material correctly under pressure, with no room for guesswork.",
        main_conflict_template="Supplies are running out; only correct use of {topic} buys more time.",
        world_rules=(
            "Resources are finite and mistakes cost something real.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A pragmatic survivor who plans before acting.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A careful caretaker who values precision under pressure.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "horror": GenreTemplate(
        tone="eerie",
        setting="a place where misunderstanding has a price",
        premise="Something watches, and safety belongs only to those who understand the material's rules.",
        main_conflict_template="The threat recedes only when {topic} is applied correctly.",
        world_rules=(
            "The threat is bound by consistent rules; knowing them is protection.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A wary figure who knows the rules and enforces them quietly.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A perceptive companion who senses what the rules imply.",
            ),
            *EXTRA_CAST,
        ),
    ),
    "custom": GenreTemplate(
        tone="unspecified",
        setting="a world shaped by the player's chosen genre",
        premise="A custom-built world where the material's principles drive every challenge.",
        main_conflict_template="The campaign conflict can only be resolved by applying {topic}.",
        world_rules=(
            "The world's custom rules must stay consistent with the material's principles.",
            "Academic accuracy is never sacrificed for narrative flair.",
        ),
        characters=(
            TemplateCharacter(
                character_id="eldric",
                name="Eldric",
                role="Keeper of the Beacon",
                description="A steady presence who frames each challenge.",
            ),
            TemplateCharacter(
                character_id="mira",
                name="Mira",
                role="Apprentice Cartographer",
                description="A loyal companion who helps the player reason through problems.",
            ),
            *EXTRA_CAST,
        ),
    ),
}
