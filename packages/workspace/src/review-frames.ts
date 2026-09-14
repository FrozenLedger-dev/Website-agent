/**
 * Review frames: deterministic, in-memory views of a durable screenshot, sized
 * for a multimodal reviewer.
 *
 * A full-page capture can be 16,000 CSS pixels tall. Sent whole, a vision model
 * shrinks it to a thin strip nobody can read; cropped to the hero, it hides the
 * page. So a capture is cut into frames one viewport tall at native width —
 * never scaled — and when a page is taller than the frame budget allows, the
 * frames are sampled evenly from top to bottom, first frame at the top and last
 * at the bottom, so the whole composition stays represented. Each frame records
 * where it came from.
 *
 * The durable screenshot is only read. Frames are new bytes, never stored.
 *
 * Policy `statxai-visual-review-frames@1`.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const MAX_FRAMES_PER_CAPTURE = 4;
/** Images in one review request, and their total encoded bytes — well inside the provider's per-request limits. */
export const MAX_REVIEW_FRAMES = 48;
export const MAX_REVIEW_FRAME_BYTES = 20 * 1024 * 1024;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class UnsupportedPng extends Error {
  constructor(reason: string) {
    super(`Screenshot cannot be framed: ${reason}`);
    this.name = 'UnsupportedPng';
  }
}

interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  colorType: 2 | 6;
  /** Unfiltered scanlines, `channels` bytes per pixel, no filter bytes. */
  pixels: Buffer;
}

/** 8-bit RGB or RGBA, non-interlaced — what Chromium writes. Anything else is refused, not guessed at. */
export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new UnsupportedPng('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const data: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body.readUInt8(8);
      colorType = body.readUInt8(9);
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body.readUInt8(12) !== 0) {
        throw new UnsupportedPng(`bit depth ${depth}, colour type ${colorType}, interlace ${body.readUInt8(12)}`);
      }
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new UnsupportedPng('no image header');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length !== height * (stride + 1)) throw new UnsupportedPng('image data does not match its header');

  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      let value = line[x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new UnsupportedPng(`unknown filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, colorType: colorType as 2 | 6, pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Rows `[top, top + height)` of a decoded image as a PNG — filter 0, fixed compression, so the same rows always make the same bytes. */
export function encodeRows(image: DecodedPng, top: number, height: number): Buffer {
  const stride = image.width * image.channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    image.pixels.copy(raw, y * (stride + 1) + 1, (top + y) * stride, (top + y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(image.colorType, 9);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export interface ReviewFrameImage {
  readonly index: number;
  readonly count: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
  readonly png: Buffer;
  readonly sha256: string;
}

/**
 * The frame offsets for an image `imageHeight` tall, frames `frameHeight` tall,
 * at most `maxFrames` of them: every frame when they fit, otherwise evenly
 * spaced from the very top to the very bottom.
 */
export function frameOffsets(imageHeight: number, frameHeight: number, maxFrames: number): number[] {
  const height = Math.min(frameHeight, imageHeight);
  const total = Math.ceil(imageHeight / height);
  const last = imageHeight - height;
  if (total <= maxFrames) return Array.from({ length: total }, (_, i) => Math.min(i * height, last));
  if (maxFrames === 1) return [0];
  return Array.from({ length: maxFrames }, (_, i) => Math.round((i * last) / (maxFrames - 1)));
}

/** Frames of one durable screenshot, one viewport tall, at native width. */
export function frameScreenshot(png: Buffer, frameHeight: number, maxFrames: number): ReviewFrameImage[] {
  const image = decodePng(png);
  const height = Math.min(frameHeight, image.height);
  const offsets = frameOffsets(image.height, height, maxFrames);
  return offsets.map((offsetY, i) => {
    const bytes = encodeRows(image, offsetY, height);
    return {
      index: i + 1,
      count: offsets.length,
      offsetY,
      width: image.width,
      height,
      png: bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}
