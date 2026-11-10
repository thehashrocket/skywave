/**
 * A response body, refused once it grows past `maxBytes`: a mirror serving
 * something far larger than the real file never fills this server's memory.
 */
export async function readCapped(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`${what} is larger than expected.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
