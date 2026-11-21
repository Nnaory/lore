/**
 * User-facing messages for the AI generation flow.
 *
 * Maps the error codes the AI routes return (and client-side failures such as
 * a lost connection) to text the player can read. Pure and free of server
 * imports so any client module can use it.
 */

export const BUILD_MESSAGES = {
  network: "Couldn't reach the server. Check your connection and try again.",
  noConcepts: "We couldn't find learning concepts in this material. Try including more sections.",
  invalidRequest: "The material couldn't be sent. Try deselecting some sections, then try again.",
  storyFailed: "The story could not be built from this material. Try again, or change the selected sections.",
  busy: "The AI storyteller is busy right now. Wait a moment, then try again.",
  notConfigured:
    "The AI storyteller isn't set up on this server yet. Contact the admin or check the API key, then try again.",
  unexpected: "Something went wrong while building your story. Try again.",
} as const;

/** A user-facing message for an AI route error code. */
export function messageForCode(code: string): string {
  switch (code) {
    case "MATERIAL_ANALYSIS_FAILED":
      return BUILD_MESSAGES.noConcepts;
    case "PROVIDER_NOT_CONFIGURED":
      return BUILD_MESSAGES.notConfigured;
    case "PROVIDER_UNAVAILABLE":
    case "RATE_LIMITED":
    case "TIMEOUT":
      return BUILD_MESSAGES.busy;
    case "INVALID_REQUEST":
      return BUILD_MESSAGES.invalidRequest;
    case "STORY_GENERATION_FAILED":
    case "CAMPAIGN_VALIDATION_FAILED":
    case "VALIDATION_FAILED":
    case "OUTPUT_PARSE_FAILED":
      return BUILD_MESSAGES.storyFailed;
    default:
      return BUILD_MESSAGES.unexpected;
  }
}
