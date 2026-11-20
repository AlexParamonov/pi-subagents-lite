/**
 * sse.ts — Server-Sent Events framing for one workflow stream connection.
 *
 * Bytes in, frames out: line splitting (LF, CRLF, lone CR), one `data:` line per payload line,
 * dispatch at the blank line. `id:` and `retry:` are not parsed (ADR-0013: an event id is display
 * metadata, never a decision input, never a resume position).
 */

/** One dispatched frame: its SSE event name (null for the unnamed channel) and its joined payload. */
export interface SseFrame {
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | null = null;

  /** Frames completed by this chunk; an unterminated frame stays buffered. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let line = this.takeLine();
    while (line !== null) {
      if (line === "") {
        const frame = this.takeFrame();
        if (frame) frames.push(frame);
      } else if (!line.startsWith(":")) {
        this.takeField(line);
      }
      line = this.takeLine();
    }
    return frames;
  }

  /** Next complete line, or null while the buffer holds none. */
  private takeLine(): string | null {
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char === "\n") return this.cut(index, 1);
      if (char === "\r") {
        // A trailing CR is an unfinished line ending: ending the line here would deliver the
        // frame's terminating blank line one character early.
        if (index + 1 === this.buffer.length) return null;
        return this.cut(index, this.buffer[index + 1] === "\n" ? 2 : 1);
      }
    }
    return null;
  }

  private cut(index: number, terminatorLength: number): string {
    const line = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index + terminatorLength);
    return line;
  }

  private takeField(line: string): void {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
  }

  private takeFrame(): SseFrame | null {
    const data = this.data.join("\n");
    const event = this.event;
    this.data = [];
    this.event = null;
    return data === "" ? null : { event, data };
  }
}
