/**
 * Session_Id generator for the Sandbox_Frame (Requirement 27.14, 28.11).
 *
 * Each mount of a Sandbox_Frame gets a new id, and a message that carries any other id is ignored.
 * That is how messages left over from an earlier iframe are told apart from the current one. The
 * id comes from `crypto.getRandomValues`, available in every supported browser and in Node, and
 * there is deliberately no `Math.random` fallback: a guessable id would defeat the check.
 *
 * The result matches `SESSION_PATTERN` in `protocol.ts` (32 lowercase hex characters). This file
 * has no imports because the Sandbox_Runtime bundle may include it.
 */

/** 16 random bytes are 32 hex characters. */
const SESSION_BYTES = 16;

/** A fresh Session_Id: 32 lowercase hexadecimal characters from `crypto.getRandomValues`. */
export function newSessionId(): string {
  const bytes = new Uint8Array(SESSION_BYTES);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}
