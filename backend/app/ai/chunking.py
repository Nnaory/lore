"""Split long story text into dialogue-box sized blocks (Layer 3).

Why: the Stage shows story text in a small dialogue box (3 lines of 68 characters on desktop), but
the model sometimes writes more than fits and the engine's template text can be long too. The
server therefore splits any narration, dialogue or lesson body longer than `MAX_CHUNK_CHARS` into
consecutive blocks, cutting at sentence ends, so the player reads it one box at a time instead of
losing the tail. `MAX_CHUNK_CHARS` is the only definition of that number in the backend; the
frontend keeps a twin constant that must be changed together with it.

Two pure parts, neither of which raises:
- `split_text` cuts one string. Text that already fits comes back untouched (its newlines matter,
  because the UI renders with `whitespace-pre-line`). Longer text is cut after `.`, `!`, `?`, `…`,
  `。` and at newlines, whole sentences are packed greedily into chunks, a single sentence that is
  too long is cut at its last space, and a token without spaces is cut hard at the limit. Inside
  a chunk, a newline between two sentences is kept, sentences that touched (after 。) still touch,
  and any other gap becomes one space. Every non-space character survives, in order.
- `chunk_story_content` applies that to the scene content of a story dict and returns a copy. A
  `learning_info` body is split into several `learning_info` blocks that all keep the same
  `title`, `concept_ids` and `visual`, because the client groups the chunks of one lesson step by
  identical title and visual.
- Over-long `puzzle["narrative_context"]` strings (over `MAX_CHUNK_CHARS - PUZZLE_SUFFIX_CHARS`,
  since the Stage appends `" Choose your answer on the board."`) are split so leading chunks
  become trailing narration blocks on the preceding content scene and only the last chunk stays on
  the puzzle.
"""

from __future__ import annotations

import copy
import re
from typing import Any

# Word-wrapped at 68 columns, text of this length always fits in the 3 lines of the box; a
# slightly larger limit sometimes needs a 4th line.
MAX_CHUNK_CHARS = 180
# The Stage appends " Choose your answer on the board." (33 chars) after puzzle.narrative_context.
PUZZLE_SUFFIX_CHARS = len(" Choose your answer on the board.")

# Closing quotes and brackets that may follow a sentence-ending mark: `He said "stop."`
_CLOSERS = re.escape("\"'\u201d\u2019)]\u00bb\u300d\u300f\uff09")
# One sentence: starts at a non-space character and ends after the first terminator. Latin marks
# need whitespace (or the end) after them, so "3.14" and "v.x" do not split; CJK marks do not.
# The last alternative lets a final sentence without a mark end at the end of the line.
_SENTENCE = re.compile(
    rf"\S.*?(?:[.!?\u2026]+[{_CLOSERS}]*(?=\s|$)|[\u3002\uff01\uff1f]+[{_CLOSERS}]*|$)",
    re.DOTALL,
)
# A whitespace run that contains a newline always ends a sentence.
_LINE_BREAK = re.compile(r"\s*\n\s*")


def _sentences(text: str) -> list[tuple[str, str]]:
    """Sentences of `text` as (sentence, separator before it); the first separator is empty.

    The separator is a newline when the original had one at that gap, nothing when the sentences
    touched (Chinese and Japanese write no space after 。), else a single space. Sentences are
    stripped and never empty.
    """
    found: list[tuple[str, str]] = []
    for line in _LINE_BREAK.split(text):
        previous_end: int | None = None
        for match in _SENTENCE.finditer(line):
            sentence = match.group().strip()
            if not sentence:
                continue
            if not found:
                separator = ""
            elif previous_end is None:
                separator = "\n"
            else:
                separator = " " if match.start() > previous_end else ""
            found.append((sentence, separator))
            previous_end = match.end()
    return found


def _split_long(sentence: str, limit: int) -> list[str]:
    """Cut one sentence longer than `limit` at spaces; hard-cut a token with no space."""
    pieces: list[str] = []
    rest = sentence
    while len(rest) > limit:
        window = rest[: limit + 1]
        cut = next((i for i in range(limit, 0, -1) if window[i].isspace()), 0)
        if cut > 0:
            pieces.append(rest[:cut].rstrip())
            rest = rest[cut:].lstrip()
        else:
            pieces.append(rest[:limit])
            rest = rest[limit:]
    if rest:
        pieces.append(rest)
    return pieces


def split_text(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split `text` into chunks of at most `limit` characters, at sentence ends where possible.

    Text of `limit` characters or fewer is returned as is, as `[text]`. Text with nothing but
    whitespace gives `[]`, so no chunk is ever empty.
    """
    limit = max(1, limit)
    if not text.strip():
        return []
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    current = ""
    for sentence, separator in _sentences(text):
        if current and len(current) + len(separator) + len(sentence) <= limit:
            current = f"{current}{separator}{sentence}"
            continue
        if current:
            chunks.append(current)
        if len(sentence) <= limit:
            current = sentence
        else:
            *whole, current = _split_long(sentence, limit)
            chunks.extend(whole)
    if current:
        chunks.append(current)
    return chunks


# The text field of each block type that the dialogue box shows.
_TEXT_FIELD = {"narration": "text", "dialogue": "text", "learning_info": "body"}


def _chunk_block(block: Any, limit: int) -> list[Any]:
    """The block itself, or consecutive copies of it that carry one chunk of its text each."""
    if not isinstance(block, dict):
        return [block]
    field = _TEXT_FIELD.get(block.get("type"))
    text = block.get(field) if field else None
    if field is None or not isinstance(text, str) or len(text) <= limit:
        return [block]
    chunks = split_text(text, limit)
    if not chunks:
        return [block]
    pieces: list[Any] = []
    for chunk in chunks:
        piece = copy.deepcopy(block)
        piece[field] = chunk
        pieces.append(piece)
    return pieces


def _chunk_puzzle_contexts(story: dict[str, Any], limit: int) -> None:
    """Split over-long `puzzle.narrative_context` into the preceding content scene + puzzle tail.

    The Stage renders `puzzle.narrative_context` followed by `" Choose your answer on the board."`
    (`PUZZLE_SUFFIX_CHARS`), so leaving all of it on the puzzle risks overflowing the dialogue box.
    """
    puzzles = story.get("puzzles")
    chapters = story.get("chapters")
    if not isinstance(puzzles, list) or not isinstance(chapters, list):
        return
    puzzle_by_id = {
        p["puzzle_id"]: p
        for p in puzzles
        if isinstance(p, dict) and isinstance(p.get("puzzle_id"), str)
    }
    puzzle_limit = limit - PUZZLE_SUFFIX_CHARS if limit > PUZZLE_SUFFIX_CHARS else max(1, limit)
    handled: set[str] = set()
    for chapter in chapters:
        scenes = chapter.get("scenes") if isinstance(chapter, dict) else None
        if not isinstance(scenes, list):
            continue
        previous_content_scene: dict[str, Any] | None = None
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            if isinstance(scene.get("content"), list):
                previous_content_scene = scene
            if scene.get("type") != "puzzle" or previous_content_scene is None:
                continue
            pid = scene.get("puzzle_id")
            if not isinstance(pid, str) or pid in handled:
                continue
            puzzle = puzzle_by_id.get(pid)
            ctx = puzzle.get("narrative_context") if puzzle else None
            if not isinstance(ctx, str) or len(ctx) <= puzzle_limit:
                continue
            chunks = split_text(ctx, puzzle_limit)
            if len(chunks) <= 1:
                continue
            handled.add(pid)
            for lead in chunks[:-1]:
                previous_content_scene["content"].append({"type": "narration", "text": lead})
            puzzle["narrative_context"] = chunks[-1]


def chunk_story_content(story: dict[str, Any], limit: int = MAX_CHUNK_CHARS) -> dict[str, Any]:
    """A copy of `story` whose over-long dialogue-box text and puzzle contexts are split.

    Scene content blocks (`narration`, `dialogue`, `learning_info`) are split at `limit`.
    Over-long `puzzle.narrative_context` strings are split at `limit - PUZZLE_SUFFIX_CHARS` with
    leading chunks appended to the preceding content scene and the final chunk kept on the puzzle.
    Other block types and fields are copied untouched, and `story` itself is never modified.
    """
    result = copy.deepcopy(story)
    chapters = result.get("chapters")
    if not isinstance(chapters, list):
        return result
    for chapter in chapters:
        scenes = chapter.get("scenes") if isinstance(chapter, dict) else None
        if not isinstance(scenes, list):
            continue
        for scene in scenes:
            content = scene.get("content") if isinstance(scene, dict) else None
            if not isinstance(content, list):
                continue
            scene["content"] = [piece for block in content for piece in _chunk_block(block, limit)]
    _chunk_puzzle_contexts(result, limit)
    return result
