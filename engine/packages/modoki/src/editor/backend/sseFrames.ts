/** The one parser for a `text/event-stream` reply read off a `fetch` body (#1967). The build-family routes are POSTs, so
 *  `EventSource` (GET only) cannot open them; the editor (`backendEventStream`) and the MCP (`consumeBuildStream`) both
 *  read the body themselves and hand each decoded chunk here.
 *
 *  A frame is the text up to a blank line, and a chunk boundary can fall anywhere in it, a frame's middle included, so
 *  the parser buffers until the blank line arrives. Only the fields the build routes send are read: `event:` (default
 *  `message`) and `data:` (several lines join with `\n`, per the spec). Comments (`:`), `id:` and `retry:` are ignored.
 *
 *  ⚠️ Keep this file import-free: the MCP bundle imports it by relative path, as it does `failureBody.ts`. */

export interface SseFrame { event: string; data: string }

export interface SseParser {
  /** Feed one decoded chunk; every frame it completes is passed to `onFrame`, in order. */
  push(chunk: string): void;
  /** The stream ended: a last frame with no trailing blank line is still delivered. */
  end(): void;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let buf = '';
  const emit = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    let any = false;
    for (const raw of block.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') { data.push(value); any = true; }
    }
    if (any) onFrame({ event, data: data.join('\n') });
  };
  return {
    push(chunk) {
      // Normalised on the whole buffer, not the chunk: a CRLF can be split across two chunks.
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        emit(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    end() {
      if (buf.trim()) emit(buf);
      buf = '';
    },
  };
}
