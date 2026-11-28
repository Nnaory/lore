/**
 * Tests — animation endpoint step and user messages
 *
 * `aiUrl("animations")` points at the backend animation route, and `messageForCode` gives every
 * new animation code its own plain message of at most 160 characters (design 7.5 and 11.1).
 * The codes and texts that existed before must keep producing exactly the same strings.
 */

import { describe, expect, it } from "vitest";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { aiUrl } from "@/lib/generation/ai-endpoints";

const MAX_MESSAGE_CHARS = 160;

/** New codes and the exact text design 11.1 gives each of them. */
const NEW_MESSAGES: Record<string, string> = {
  ANIMATION_NOT_CONFIGURED:
    "Lesson animations are not turned on for this server. The standard drawings will be used.",
  ANIMATION_QUOTA_EXCEEDED:
    "This device reached its limit of saved animations. The standard drawings will be used.",
  ANIMATION_VERIFICATION_FAILED:
    "An animation could not be made to run correctly. The standard drawing will be used.",
  ANIMATION_TIMEOUT: "An animation took too long to make. Try again, or skip it.",
  ANIMATION_VERIFIER_UNAVAILABLE:
    "The animation checker is unavailable right now. Try again, or skip it.",
  ANIMATION_STORAGE_FAILED: "An animation could not be saved. Try again, or skip it.",
  STREAM_INTERRUPTED:
    "The connection dropped while the animation was being made. Try again, or skip it.",
  NETWORK: "Couldn't reach the server. Check your connection and try again.",
};

/** Codes that existed before animations, with the text they produced before. */
const OLD_MESSAGES: Record<string, string> = {
  MATERIAL_ANALYSIS_FAILED:
    "We couldn't find learning concepts in this material. Try including more sections.",
  PROVIDER_NOT_CONFIGURED:
    "The AI storyteller isn't set up on this server yet. Contact the admin or check the API key, then try again.",
  PROVIDER_UNAVAILABLE: "The AI storyteller is busy right now. Wait a moment, then try again.",
  RATE_LIMITED: "The AI storyteller is busy right now. Wait a moment, then try again.",
  TIMEOUT: "The AI storyteller is busy right now. Wait a moment, then try again.",
  INVALID_REQUEST:
    "The material couldn't be sent. Try deselecting some sections, then try again.",
  STORY_GENERATION_FAILED:
    "The story could not be built from this material. Try again, or change the selected sections.",
  CAMPAIGN_VALIDATION_FAILED:
    "The story could not be built from this material. Try again, or change the selected sections.",
  VALIDATION_FAILED:
    "The story could not be built from this material. Try again, or change the selected sections.",
  OUTPUT_PARSE_FAILED:
    "The story could not be built from this material. Try again, or change the selected sections.",
  UNKNOWN: "Something went wrong while building your story. Try again.",
  SOMETHING_ELSE: "Something went wrong while building your story. Try again.",
};

describe("aiUrl animations step", () => {
  it("points at the backend animation route", () => {
    expect(aiUrl("animations")).toBe("/api/v1/ai/animations");
  });
});

describe("messageForCode for animation codes", () => {
  const codes = Object.keys(NEW_MESSAGES);

  it.each(codes)("%s has its own message of at most 160 characters", (code) => {
    const message = messageForCode(code);
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(message).not.toBe(BUILD_MESSAGES.unexpected);
  });

  it.each(codes)("%s uses the text from design 11.1", (code) => {
    expect(messageForCode(code)).toBe(NEW_MESSAGES[code]);
  });

  it("NETWORK reuses the existing network message", () => {
    expect(messageForCode("NETWORK")).toBe(BUILD_MESSAGES.network);
  });

  it("gives the animation codes different texts, so each failure can be told apart", () => {
    const animationCodes = codes.filter((code) => code !== "NETWORK");
    const texts = new Set(animationCodes.map((code) => messageForCode(code)));
    expect(texts.size).toBe(animationCodes.length);
  });
});

describe("messageForCode for codes that existed before", () => {
  it.each(Object.keys(OLD_MESSAGES))("%s still returns the same text", (code) => {
    expect(messageForCode(code)).toBe(OLD_MESSAGES[code]);
  });
});
