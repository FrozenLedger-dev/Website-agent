/**
 * Review frames: exact, deterministic views of a durable screenshot.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_FRAMES_PER_CAPTURE, UnsupportedPng, decodePng, frameOffsets, frameScreenshot, pngDimensions } from '../src/index.js';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
};

/** Pixel value at (x, y, channel) — every row distinct, so a wrong row or offset is visible. */
const pixel = (x: number, y: number, ch: number) => (x * 7 + y * 13 + ch * 29) & 0xff;

/** A PNG whose scanlines cycle through all five filter types, as real encoders mix them. */
function png(width: number, height: number, channels: 3 | 4 = 3, interlace = 0): Buffer {
  const stride = width * channels;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) for (let ch = 0; ch < channels; ch += 1) line[x * channels + ch] = pixel(x, y, ch);
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[i + 1] = (line[i]! - predicted) & 0xff;
    }
    rows.push(out);
    prev = line;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(channels === 4 ? 6 : 2, 9);
  header.writeUInt8(interlace, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

describe('decoding', () => {
  it('reverses every scanline filter exactly, for RGB and RGBA', () => {
    for (const channels of [3, 4] as const) {
      const decoded = decodePng(png(23, 17, channels));
      expect([decoded.width, decoded.height, decoded.channels]).toEqual([23, 17, channels]);
      for (let y = 0; y < 17; y += 1) for (let x = 0; x < 23; x += 1) for (let ch = 0; ch < channels; ch += 1) {
        expect(decoded.pixels[(y * 23 + x) * channels + ch]).toBe(pixel(x, y, ch));
      }
    }
  });

  it('refuses what it cannot decode exactly rather than guessing', () => {
    expect(() => decodePng(Buffer.from('not a png at all, definitely not'))).toThrow(UnsupportedPng);
    expect(() => decodePng(png(8, 8, 3, 1))).toThrow(UnsupportedPng);
  });
});

describe('frame policy', () => {
  it('uses every frame when a page fits, the last one flush with the bottom', () => {
    expect(frameOffsets(900, 900, MAX_FRAMES_PER_CAPTURE)).toEqual([0]);
    expect(frameOffsets(600, 900, MAX_FRAMES_PER_CAPTURE)).toEqual([0]);
    expect(frameOffsets(3000, 844, MAX_FRAMES_PER_CAPTURE)).toEqual([0, 844, 1688, 2156]);
  });

  it('samples a very tall page evenly from its very top to its very bottom — never only the hero', () => {
    const offsets = frameOffsets(16_000, 900, MAX_FRAMES_PER_CAPTURE);
    expect(offsets).toEqual([0, 5033, 10067, 15100]);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)! + 900).toBe(16_000);
    expect(frameOffsets(16_000, 900, 2)).toEqual([0, 15100]);
    expect(frameOffsets(16_000, 900, 1)).toEqual([0]);
  });
});

describe('framing a screenshot', () => {
  it('cuts frames one viewport tall at native width, identified by position, byte-exact to the source rows', () => {
    const source = png(40, 3000, 3);
    const before = Buffer.from(source);

    const frames = frameScreenshot(source, 844, MAX_FRAMES_PER_CAPTURE);

    expect(frames.map((f) => [f.index, f.count, f.offsetY, f.width, f.height])).toEqual([
      [1, 4, 0, 40, 844], [2, 4, 844, 40, 844], [3, 4, 1688, 40, 844], [4, 4, 2156, 40, 844],
    ]);
    for (const frame of frames) {
      expect(pngDimensions(frame.png)).toEqual({ width: 40, height: 844 });
      expect(frame.sha256).toBe(createHash('sha256').update(frame.png).digest('hex'));
      const decoded = decodePng(frame.png);
      for (const y of [0, 421, 843]) expect(decoded.pixels[y * 40 * 3 + 5]).toBe(pixel(1, frame.offsetY + y, 2));
    }
    // The durable screenshot is only read.
    expect(source.equals(before)).toBe(true);
  });

  it('is deterministic: the same screenshot always makes the same frames', () => {
    const source = png(30, 2000, 4);
    expect(frameScreenshot(source, 900, 4).map((f) => f.sha256)).toEqual(frameScreenshot(Buffer.from(source), 900, 4).map((f) => f.sha256));
  });
});
