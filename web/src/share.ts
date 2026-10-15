/**
 * Put a plan in a link.
 *
 * The whole document set — plan, workflow, environment — is gzipped into the
 * URL fragment, so the link is the data and no server holds anything. A
 * fragment never leaves the browser, which is also why it is the right half of
 * the URL for this.
 *
 * Measured on the bundled corpus, the largest of them lands around 3,100
 * characters (`plate_assay`, of the twenty bundled in 0.1.9; 2,200 when D22
 * measured twelve), so there is no need for a size strategy — just a
 * ceiling, past which the link would break in some mail client and the person
 * should be pointed at a bundled plan or a raw URL instead.
 */

export const MAX_FRAGMENT = 8000;

export interface SharePayload {
  /** Absent when a workflow is being shared before anything scheduled from it. */
  readonly plan?: unknown;
  readonly workflow?: unknown;
  readonly environment?: unknown;
  /** Selection and view, so a link reopens on what was being pointed at. */
  readonly ui?: {
    readonly view?: string;
    readonly expanded?: readonly string[];
    /** Only when the person chose one; otherwise the documents decide (D46). */
    readonly layout?: string;
    /** Only when the person set it; otherwise the width decides (D70). */
    readonly details?: "show" | "hide";
    /** One job of a plan of several, when the person picked one (D75). */
    readonly job?: string;
  };
}

export class ShareTooLarge extends Error {
  constructor(readonly length: number) {
    super(
      `This plan needs ${length.toLocaleString()} characters in the link, past the ${MAX_FRAGMENT.toLocaleString()} that survive being pasted around. Send the file, or use a bundled plan.`,
    );
    this.name = "ShareTooLarge";
  }
}

/** Available wherever CompressionStream is — every current browser. */
const supported = (): boolean => typeof CompressionStream !== "undefined";

export async function encodeShare(payload: SharePayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const packed = supported() ? await gzip(bytes) : bytes;
  const text = base64url(packed);
  if (text.length > MAX_FRAGMENT) throw new ShareTooLarge(text.length);
  return text;
}

export async function decodeShare(fragment: string): Promise<SharePayload | undefined> {
  const trimmed = fragment.replace(/^#?d=/, "");
  if (!trimmed) return undefined;
  try {
    const packed = unbase64url(trimmed);
    const bytes = supported() ? await gunzip(packed) : packed;
    return JSON.parse(new TextDecoder().decode(bytes)) as SharePayload;
  } catch {
    return undefined;
  }
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** base64url: no padding, and safe in a URL without escaping. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
