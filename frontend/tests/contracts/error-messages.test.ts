/**
 * Tests - user-facing messages for AI route error codes.
 *
 * Moved here from the not-configured and request-campaign suites when the
 * messages left lib/setup/request-campaign.ts for lib/contracts.
 */

import { describe, it, expect } from "vitest";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";

describe("messageForCode", () => {
  it("explains a missing configuration separately from a busy provider", () => {
    expect(messageForCode("PROVIDER_NOT_CONFIGURED")).toBe(BUILD_MESSAGES.notConfigured);
    expect(messageForCode("PROVIDER_UNAVAILABLE")).toBe(BUILD_MESSAGES.busy);
    expect(BUILD_MESSAGES.notConfigured).not.toBe(BUILD_MESSAGES.busy);
  });

  it("explains a material-analysis failure", () => {
    expect(messageForCode("MATERIAL_ANALYSIS_FAILED")).toBe(BUILD_MESSAGES.noConcepts);
  });

  it("asks the user to retry when the AI provider is busy", () => {
    for (const code of ["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT"]) {
      expect(messageForCode(code)).toBe(BUILD_MESSAGES.busy);
    }
  });

  it("reports a rejected request", () => {
    expect(messageForCode("INVALID_REQUEST")).toBe(BUILD_MESSAGES.invalidRequest);
  });

  it("reports a story that could not be built", () => {
    for (const code of ["STORY_GENERATION_FAILED", "CAMPAIGN_VALIDATION_FAILED", "VALIDATION_FAILED", "OUTPUT_PARSE_FAILED"]) {
      expect(messageForCode(code)).toBe(BUILD_MESSAGES.storyFailed);
    }
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(messageForCode("SOMETHING_ELSE")).toBe(BUILD_MESSAGES.unexpected);
  });
});
