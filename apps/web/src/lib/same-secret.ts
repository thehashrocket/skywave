/** Constant-time comparison; hashing first makes both sides the same length. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const ha = await digest(a);
  const hb = await digest(b);
  let diff = 0;
  ha.forEach((byte, i) => (diff |= byte ^ hb[i]!));
  return diff === 0;
}
