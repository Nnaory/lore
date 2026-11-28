"""Unit tests for the dialogue-box text splitter (no network, no database).

Why: the Stage shows story text in a box that holds about `MAX_CHUNK_CHARS` characters, and the
server splits anything longer into consecutive blocks (`app/ai/chunking.py`). A split that loses
a word, cuts mid-word when a space was available, mutates the story it was given, or drops the
fields a block carries (title, visual, speaker) would corrupt what the player reads, so each of
those is checked directly. The property-style tests use a seeded `random.Random` over a fixed
word list, so they are reproducible and add no dependency.
"""

from __future__ import annotations

import copy
import random
from typing import Any

import pytest

from app.ai.chunking import (
    MAX_CHUNK_CHARS,
    PUZZLE_SUFFIX_CHARS,
    chunk_story_content,
    split_text,
)

SENTENCE = "The magnitude of a vector is its length."  # 40 characters


def non_space(text: str) -> str:
    return "".join(text.split())


def sentences(count: int, sentence: str = SENTENCE) -> str:
    return " ".join([sentence] * count)


# --- split_text: text that fits ---------------------------------------------------------------


def test_the_limit_is_180_characters() -> None:
    # The only test that spells the number out: the frontend keeps a twin of it, and changing
    # one without the other must fail loudly. Every other test follows `MAX_CHUNK_CHARS`.
    assert MAX_CHUNK_CHARS == 180


@pytest.mark.parametrize(
    "text",
    [
        "Hi.",
        SENTENCE,
        "  leading and trailing space  ",
        "Line one.\nLine two.\n\nLine four after a blank line.",
        "no terminator at all",
        "x" * MAX_CHUNK_CHARS,
        "é中😀 " * 20,
    ],
)
def test_text_that_fits_is_returned_untouched(text: str) -> None:
    assert len(text) <= MAX_CHUNK_CHARS
    assert split_text(text) == [text]


def test_text_exactly_at_the_limit_is_untouched_and_one_over_is_split() -> None:
    at_limit = sentences(4) + " " + "y" * (MAX_CHUNK_CHARS - len(sentences(4)) - 1)
    assert len(at_limit) == MAX_CHUNK_CHARS
    assert split_text(at_limit) == [at_limit]
    assert len(split_text(at_limit + "z")) == 2


@pytest.mark.parametrize("text", ["", " ", "   \n\t  ", "\n\n"])
def test_empty_or_blank_text_gives_no_chunk(text: str) -> None:
    assert split_text(text) == []
    assert split_text(text + " " * 400) == []


# --- split_text: long text --------------------------------------------------------------------


def test_long_text_is_cut_between_sentences_and_every_chunk_fits() -> None:
    text = sentences(10)  # 409 characters
    chunks = split_text(text)
    assert len(text) > MAX_CHUNK_CHARS
    assert all(0 < len(c) <= MAX_CHUNK_CHARS for c in chunks)
    assert len(chunks) == 3
    # Whole sentences only: every chunk is a run of complete sentences.
    assert all(c.endswith(".") and c.startswith("The magnitude") for c in chunks)
    assert [c.count(SENTENCE) for c in chunks] == [4, 4, 2]
    assert " ".join(chunks) == text


def test_sentences_are_packed_greedily_into_each_chunk() -> None:
    assert split_text("Aaa. Bbb. Ccc. Ddd. Eee.", limit=10) == ["Aaa. Bbb.", "Ccc. Ddd.", "Eee."]
    assert split_text("Aaa. Bbb. Ccc. Ddd. Eee.", limit=14) == ["Aaa. Bbb. Ccc.", "Ddd. Eee."]
    assert split_text("Aaa. Bbb. Ccc.", limit=4) == ["Aaa.", "Bbb.", "Ccc."]


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        ("One! Two? Three.", 6, ["One!", "Two?", "Three."]),
        ("Wait\u2026 What now\u2026 Go.", 9, ["Wait\u2026", "What now\u2026", "Go."]),
        ("Wait... what?! Go.", 8, ["Wait...", "what?!", "Go."]),
        # No space follows \u3002 in Chinese and Japanese; none is added inside a chunk.
        (
            "\u4f60\u597d\u3002\u6211\u5f88\u597d\u3002\u518d\u89c1\u3002",
            4,
            ["\u4f60\u597d\u3002", "\u6211\u5f88\u597d\u3002", "\u518d\u89c1\u3002"],
        ),
        (
            "\u4f60\u597d\u3002\u6211\u5f88\u597d\u3002\u518d\u89c1\u3002",
            7,
            ["\u4f60\u597d\u3002\u6211\u5f88\u597d\u3002", "\u518d\u89c1\u3002"],
        ),
        ('He said "Stop." Then he left.', 16, ['He said "Stop."', "Then he left."]),
        ("First line\nSecond line\nThird line", 11, ["First line", "Second line", "Third line"]),
    ],
)
def test_sentence_ends_are_period_bang_question_ellipsis_cjk_and_newline(
    text: str, limit: int, expected: list[str]
) -> None:
    # With the limit this small, only what the rule splits can end up in separate chunks.
    assert split_text(text, limit=limit) == expected


def test_a_dot_inside_a_number_or_name_is_not_a_sentence_end() -> None:
    text = "Pi is about 3.14 and the point v.x lies on the axis. Next sentence here."
    assert split_text(text, limit=55) == [
        "Pi is about 3.14 and the point v.x lies on the axis.",
        "Next sentence here.",
    ]


def test_a_newline_between_sentences_is_kept_inside_a_chunk_and_still_a_boundary() -> None:
    text = "Step one.\nStep two. Step three.\n\nStep four."
    assert split_text(text, limit=24) == ["Step one.\nStep two.", "Step three.\nStep four."]
    # Without room for both, the newline ends a sentence like a period would.
    assert split_text("Alpha beta\ngamma delta", limit=12) == ["Alpha beta", "gamma delta"]


def test_one_long_sentence_is_cut_at_the_last_space_that_fits() -> None:
    words = ["vector"] * 60
    sentence = " ".join(words) + "."  # one sentence, 420 characters
    chunks = split_text(sentence)
    assert len(chunks) == 3
    assert all(len(c) <= MAX_CHUNK_CHARS for c in chunks)
    # Never mid-word: every chunk is made of whole words.
    assert all(w in ("vector", "vector.") for c in chunks for w in c.split())
    # Each cut is at the LAST space that fits: adding the next word would not have fit.
    for chunk, following in zip(chunks, chunks[1:], strict=False):
        assert len(chunk) + 1 + len(following.split()[0]) > MAX_CHUNK_CHARS


def test_a_token_without_spaces_is_cut_hard_at_the_limit() -> None:
    limit = MAX_CHUNK_CHARS
    assert split_text("x" * 500) == ["x" * limit, "x" * limit, "x" * (500 - 2 * limit)]
    assert split_text("ab " + "y" * 200) == ["ab", "y" * limit, "y" * (200 - limit)]
    assert split_text("x" * 40, limit=15) == ["x" * 15, "x" * 15, "x" * 10]


def test_a_sentence_after_a_long_one_may_share_the_last_piece() -> None:
    long = " ".join(["word"] * 50) + "."  # 250 characters
    chunks = split_text(long + " Short one.")
    assert all(len(c) <= MAX_CHUNK_CHARS for c in chunks)
    assert chunks[-1].endswith("Short one.")
    assert non_space("".join(chunks)) == non_space(long + " Short one.")


def test_a_custom_limit_is_used_and_a_nonsense_limit_does_not_raise() -> None:
    assert split_text("Aaa. Bbb.", limit=5) == ["Aaa.", "Bbb."]
    assert all(len(c) == 1 for c in split_text("abc def", limit=0))
    assert split_text("abc def", limit=-3) == ["a", "b", "c", "d", "e", "f"]


# --- split_text: properties -------------------------------------------------------------------

WORDS = [
    "vector",
    "the",
    "magnitude",
    "of",
    "3.14",
    "v.x",
    "e.g.",
    "\u2016v\u2016",
    "\u4e2d\u6587",
    "caf\u00e9",
    "\U0001f600",
    "x" * 30,
    "y" * 250,  # longer than the limit on its own
]
ENDINGS = ["", "", "", ".", "!", "?", "\u2026", "...", '."', "\u3002"]
GAPS = [" ", " ", " ", "  ", "\n", " \n ", "\n\n", "\t"]


def random_text(rng: random.Random) -> str:
    parts: list[str] = []
    for _ in range(rng.randint(1, 120)):
        parts.append(rng.choice(WORDS) + rng.choice(ENDINGS))
        parts.append(rng.choice(GAPS))
    return "".join(parts)


@pytest.mark.parametrize("seed", range(40))
@pytest.mark.parametrize("limit", [MAX_CHUNK_CHARS, 60, 25])
def test_random_text_keeps_every_character_in_order_and_every_chunk_fits(
    seed: int, limit: int
) -> None:
    text = random_text(random.Random(seed))
    chunks = split_text(text, limit)
    if len(text) <= limit:
        assert chunks == ([text] if text.strip() else [])
        return
    assert all(chunk for chunk in chunks)
    assert all(chunk == chunk.strip() for chunk in chunks)
    assert all(len(chunk) <= limit for chunk in chunks)
    assert non_space(" ".join(chunks)) == non_space(text)
    assert non_space("".join(chunks)) == non_space(text)


def test_splitting_twice_changes_nothing_more() -> None:
    text = random_text(random.Random(7))
    for chunk in split_text(text, 80):
        assert split_text(chunk, 80) == [chunk]


def test_the_input_string_is_not_modified_and_the_result_is_new_each_time() -> None:
    text = sentences(10)
    before = text
    first = split_text(text)
    first.append("changed")
    assert text == before
    assert split_text(text) != first


# --- chunk_story_content ----------------------------------------------------------------------

LONG = sentences(10)  # 409 characters, 3 chunks at the default limit
VISUAL = {"kind": "formula", "expression": "a + b", "terms": [{"symbol": "a", "meaning": "x"}]}


def story_with(content: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "story_id": "s",
        "title": "A story",
        "chapters": [
            {
                "chapter_id": "ch1",
                "title": "One",
                "scenes": [
                    {
                        "scene_id": "scene_1",
                        "type": "learning",
                        "characters_present": ["c1"],
                        "content": content,
                        "next_scene_id": "scene_2",
                    },
                    {
                        "scene_id": "scene_2",
                        "type": "puzzle",
                        "characters_present": ["c1"],
                        "puzzle_id": "p1",
                        "next_scene_id": "scene_3",
                    },
                    {
                        "scene_id": "scene_3",
                        "type": "ending",
                        "characters_present": [],
                        "ending_id": "e1",
                    },
                ],
            }
        ],
        "puzzles": [{"puzzle_id": "p1", "question": LONG}],
        "endings": [{"ending_id": "e1", "narration": LONG}],
    }


def content_of(story: dict[str, Any]) -> list[dict[str, Any]]:
    return story["chapters"][0]["scenes"][0]["content"]


def test_long_narration_dialogue_and_lesson_blocks_are_split_in_order() -> None:
    story = story_with(
        [
            {"type": "narration", "text": LONG},
            {"type": "dialogue", "character_id": "c1", "expression": "happy", "text": LONG},
            {"type": "learning_info", "title": "T", "body": LONG, "concept_ids": ["k1"]},
        ]
    )
    blocks = content_of(chunk_story_content(story))
    assert [b["type"] for b in blocks] == ["narration"] * 3 + ["dialogue"] * 3 + [
        "learning_info"
    ] * 3
    for block in blocks:
        text = block["body"] if block["type"] == "learning_info" else block["text"]
        assert 0 < len(text) <= MAX_CHUNK_CHARS
    assert " ".join(b["text"] for b in blocks[:3]) == LONG
    assert " ".join(b["text"] for b in blocks[3:6]) == LONG
    assert " ".join(b["body"] for b in blocks[6:]) == LONG


def test_the_story_that_was_passed_in_is_not_modified() -> None:
    story = story_with(
        [
            {"type": "narration", "text": LONG},
            {
                "type": "learning_info",
                "title": "T",
                "body": LONG,
                "concept_ids": ["k1"],
                "visual": VISUAL,
            },
        ]
    )
    before = copy.deepcopy(story)
    result = chunk_story_content(story)
    assert story == before
    assert result is not story
    assert result["chapters"] is not story["chapters"]
    result["chapters"][0]["scenes"][0]["content"][0]["text"] = "changed"
    assert story == before


def test_a_story_that_needs_no_split_comes_back_equal_but_as_a_copy() -> None:
    story = story_with(
        [
            {"type": "narration", "text": "Short."},
            {"type": "dialogue", "character_id": "c1", "expression": "happy", "text": "Hi.\nYou."},
        ]
    )
    result = chunk_story_content(story)
    assert result == story
    assert (
        result["chapters"][0]["scenes"][0]["content"][0]
        is not story["chapters"][0]["scenes"][0]["content"][0]
    )


def test_lesson_chunks_all_keep_title_concept_ids_and_visual() -> None:
    block = {
        "type": "learning_info",
        "title": "Magnitude",
        "body": LONG,
        "concept_ids": ["k1", "k2"],
        "visual": VISUAL,
    }
    chunks = content_of(chunk_story_content(story_with([block])))
    assert len(chunks) == 3
    for chunk in chunks:
        assert chunk["type"] == "learning_info"
        assert chunk["title"] == "Magnitude"
        assert chunk["concept_ids"] == ["k1", "k2"]
        assert chunk["visual"] == VISUAL
        assert set(chunk) == set(block)
    # Same values, but not the same objects: editing one chunk must not edit the others.
    assert chunks[0]["visual"] is not chunks[1]["visual"]
    assert chunks[0]["concept_ids"] is not chunks[1]["concept_ids"]
    chunks[0]["visual"]["expression"] = "changed"
    chunks[0]["concept_ids"].append("k3")
    assert chunks[1]["visual"] == VISUAL
    assert chunks[1]["concept_ids"] == ["k1", "k2"]


def test_a_lesson_without_a_visual_gets_no_visual_key_on_its_chunks() -> None:
    block = {"type": "learning_info", "title": "T", "body": LONG, "concept_ids": ["k1"]}
    chunks = content_of(chunk_story_content(story_with([block])))
    assert all("visual" not in chunk for chunk in chunks)


def test_narration_and_dialogue_chunks_keep_speaker_and_expression() -> None:
    block = {"type": "dialogue", "character_id": "char_02", "expression": "curious", "text": LONG}
    chunks = content_of(chunk_story_content(story_with([block])))
    assert len(chunks) == 3
    for chunk in chunks:
        assert (chunk["type"], chunk["character_id"], chunk["expression"]) == (
            "dialogue",
            "char_02",
            "curious",
        )


def test_short_blocks_between_long_ones_stay_where_they_were() -> None:
    story = story_with(
        [
            {"type": "narration", "text": "Before."},
            {"type": "narration", "text": LONG},
            {"type": "dialogue", "character_id": "c1", "expression": "e", "text": "Middle."},
            {"type": "learning_info", "title": "T", "body": "Short body.", "concept_ids": ["k"]},
            {"type": "narration", "text": "After."},
        ]
    )
    blocks = content_of(chunk_story_content(story))
    texts = [b.get("text", b.get("body")) for b in blocks]
    assert texts[0] == "Before."
    assert texts[4:] == ["Middle.", "Short body.", "After."]
    assert len(blocks) == 7


def test_everything_except_scene_content_is_left_alone() -> None:
    story = story_with([{"type": "narration", "text": LONG}])
    result = chunk_story_content(story)
    # Long text outside scene content (puzzle question, ending narration) is not split here.
    assert result["puzzles"] == story["puzzles"]
    assert result["endings"] == story["endings"]
    assert result["chapters"][0]["scenes"][1:] == story["chapters"][0]["scenes"][1:]
    first = result["chapters"][0]["scenes"][0]
    original = story["chapters"][0]["scenes"][0]
    assert {k: v for k, v in first.items() if k != "content"} == {
        k: v for k, v in original.items() if k != "content"
    }
    assert {k: v for k, v in result.items() if k != "chapters"} == {
        k: v for k, v in story.items() if k != "chapters"
    }


def test_blocks_of_other_types_keep_their_long_text() -> None:
    odd = {"type": "interaction", "text": LONG, "body": LONG}
    result = content_of(chunk_story_content(story_with([odd])))
    assert result == [odd]


def test_a_custom_limit_applies_to_the_story() -> None:
    story = story_with([{"type": "narration", "text": "Aaa. Bbb. Ccc."}])
    assert [b["text"] for b in content_of(chunk_story_content(story, limit=5))] == [
        "Aaa.",
        "Bbb.",
        "Ccc.",
    ]


@pytest.mark.parametrize(
    "story",
    [
        {},
        {"chapters": None},
        {"chapters": "x"},
        {"chapters": [None, 5, {"scenes": None}, {"scenes": [None, {"content": "x"}]}]},
        {
            "chapters": [
                {"scenes": [{"content": [None, 7, "text", {"type": 3}, {"type": "narration"}]}]}
            ]
        },
        {"chapters": [{"scenes": [{"content": [{"type": "narration", "text": 5}]}]}]},
    ],
)
def test_unexpected_shapes_pass_through_without_raising(story: dict[str, Any]) -> None:
    assert chunk_story_content(story) == story


def test_a_blank_block_over_the_limit_is_kept_not_dropped() -> None:
    block = {"type": "narration", "text": " " * (MAX_CHUNK_CHARS + 5)}
    assert content_of(chunk_story_content(story_with([block]))) == [block]


# --- puzzle.narrative_context -----------------------------------------------------------------


def _story_with_puzzle(narrative_context: str, with_preceding_scene: bool = True) -> dict[str, Any]:
    scenes: list[dict[str, Any]] = []
    if with_preceding_scene:
        scenes.append(
            {
                "scene_id": "s1",
                "type": "learning",
                "content": [{"type": "narration", "text": "Setup."}],
            }
        )
    scenes.append({"scene_id": "p1_scene", "type": "puzzle", "puzzle_id": "p1"})
    return {
        "chapters": [{"scenes": scenes}],
        "puzzles": [{"puzzle_id": "p1", "narrative_context": narrative_context}],
    }


def test_long_puzzle_narrative_context_splits_into_preceding_scene_and_puzzle_tail() -> None:
    # 200 chars -> 147 char budget for puzzle (180 - 33) -> moves leading chunks into s1 narration.
    long_ctx = sentences(5)  # 5 * 40 + 4 spaces = 204 chars
    story = _story_with_puzzle(long_ctx)
    before = copy.deepcopy(story)

    result = chunk_story_content(story)

    assert story == before
    scene_texts = [b["text"] for b in result["chapters"][0]["scenes"][0]["content"]]
    puzzle_tail = result["puzzles"][0]["narrative_context"]
    assert scene_texts[0] == "Setup."
    assert len(scene_texts) >= 2
    for chunk in scene_texts[1:]:
        assert len(chunk) <= MAX_CHUNK_CHARS
    assert len(puzzle_tail) + PUZZLE_SUFFIX_CHARS <= MAX_CHUNK_CHARS
    assert " ".join([*scene_texts[1:], puzzle_tail]).split() == long_ctx.split()


def test_short_puzzle_narrative_context_stays_untouched() -> None:
    short_ctx = sentences(3)  # 122 chars <= 147
    story = _story_with_puzzle(short_ctx)
    result = chunk_story_content(story)
    assert result["puzzles"][0]["narrative_context"] == short_ctx
    assert len(result["chapters"][0]["scenes"][0]["content"]) == 1


def test_puzzle_without_preceding_content_scene_is_not_truncated() -> None:
    long_ctx = sentences(5)
    story = _story_with_puzzle(long_ctx, with_preceding_scene=False)
    result = chunk_story_content(story)
    assert result["puzzles"][0]["narrative_context"] == long_ctx
