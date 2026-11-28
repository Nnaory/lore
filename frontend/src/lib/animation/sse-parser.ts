/**
 * Incremental Server-Sent Events parser (design 7.3, Requirement 25.2 and 25.12).
 *
 * `POST /api/v1/ai/animations` answers with an event stream, and the client reads it in chunks of
 * whatever size the network delivers. A chunk can end in the middle of a line, between the `\r` and
 * the `\n` of a CRLF, or between two events. This parser takes decoded text, one chunk at a time,
 * and returns the events that the chunk completed. Cutting the same stream at any other place
 * gives the same events (Requirement 17.9, tested by task 22.2).
 *
 * Splitting the bytes into characters is not done here. The caller decodes with
 * `TextDecoder.decode(chunk, { stream: true })`, which keeps a multi-byte character that was cut
 * in half until the rest arrives, so this parser only ever sees whole characters.
 *
 * Rules (the WHATWG event stream format, reduced to what the endpoint can send):
 * - A line ends with `\n`, `\r\n`, or `\r`. Nothing else is a line break: U+2028 and U+0085 are
 *   ordinary characters, and the endpoint writes JSON with non-ASCII text left unescaped.
 * - A `\r` at the very end of the buffer is held: the next chunk decides if it was a lone `\r` or
 *   the first half of `\r\n`.
 * - An empty line closes the event. It is returned only if it had at least one `data:` line;
 *   otherwise it is dropped. Either way the event name starts over.
 * - A line that starts with `:` is a comment (`: ping`) and is ignored.
 * - `event:` sets the name (`message` when never set or empty). `data:` adds a line, and the lines
 *   of one event are joined with `\n`. One space after the colon is removed, no more.
 *   `id:`, `retry:`, and any other field are ignored.
 * - `end()` drops what is unfinished: an event without its closing empty line, a last line without
 *   a line break, and a held `\r`. It also resets the parser. A stream whose very last byte is a
 *   lone `\r` therefore loses the event that `\r` would have closed. The endpoint closes events
 *   with `\n\n`, so this does not happen in practice.
 *
 * It returns nothing but plain data and never throws, and the file imports nothing.
 */

/** One event as read from the stream, before any JSON or schema check. */
export interface RawEvent {
  event: string;
  data: string;
}

export interface SseParser {
  /** Adds a chunk of decoded text and returns the events it completed, in order. */
  push(text: string): RawEvent[];
  /** Ends the stream: drops any unfinished event and resets the parser. */
  end(): void;
}

/** Name of an event that never had an `event:` line. */
const DEFAULT_EVENT = "message";

const LF = 0x0a;
const CR = 0x0d;
const COLON = ":";

/** A new parser. Each one has its own state. */
export function createSseParser(): SseParser {
  /** Text received but not yet part of a finished line. */
  let buffer = "";
  /**
   * How many characters at the start of `buffer` are known to hold no line break, so each push
   * scans only new text. A held `\r` is not counted: the next push looks at it again.
   */
  let scanned = 0;
  /** Name from the `event:` line of the event being read (empty when there is none yet). */
  let eventName = "";
  /** `data:` lines of the event being read. */
  let dataLines: string[] = [];

  /** Applies one complete line (no line break) and returns the event it closed, if any. */
  function readLine(line: string): RawEvent | undefined {
    if (line === "") {
      const name = eventName;
      const lines = dataLines;
      eventName = "";
      dataLines = [];
      if (lines.length === 0) return undefined;
      return { event: name === "" ? DEFAULT_EVENT : name, data: lines.join("\n") };
    }
    if (line.startsWith(COLON)) return undefined;

    const colon = line.indexOf(COLON);
    let field = line;
    let value = "";
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return undefined;
  }

  return {
    push(text: string): RawEvent[] {
      const events: RawEvent[] = [];
      if (text === "") return events;

      buffer += text;
      const length = buffer.length;
      let lineStart = 0;
      let i = scanned;
      while (i < length) {
        const code = buffer.charCodeAt(i);
        if (code !== LF && code !== CR) {
          i += 1;
          continue;
        }
        // The last character is a `\r`: it may be the first half of `\r\n`, so wait for the next
        // chunk. `i` stays on the `\r` and the next push starts the scan there.
        if (code === CR && i + 1 === length) break;

        const line = buffer.slice(lineStart, i);
        i += code === CR && buffer.charCodeAt(i + 1) === LF ? 2 : 1;
        lineStart = i;
        const event = readLine(line);
        if (event !== undefined) events.push(event);
      }

      buffer = buffer.slice(lineStart);
      scanned = i - lineStart;
      return events;
    },

    end(): void {
      buffer = "";
      scanned = 0;
      eventName = "";
      dataLines = [];
    },
  };
}
