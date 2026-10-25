/** Incremental Server-Sent Events parser: returns the data payload of each complete event. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      }
      // id:, event:, retry: and comments are irrelevant here.
    }
    return out;
  }

  flush(): string[] {
    const out = this.feed('\n\n');
    this.buffer = '';
    return out;
  }
}
