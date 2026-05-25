import { describe, expect, it } from 'vitest';
import { float32ToWavBlob } from './wav';

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

function readAscii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + len));
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getInt16(0, true);
}

describe('float32ToWavBlob', () => {
  it('produces a valid RIFF/WAVE header', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = float32ToWavBlob(samples, 24000);
    expect(blob.type).toBe('audio/wav');
    const bytes = await blobBytes(blob);
    expect(readAscii(bytes, 0, 4)).toBe('RIFF');
    expect(readAscii(bytes, 8, 4)).toBe('WAVE');
    expect(readAscii(bytes, 12, 4)).toBe('fmt ');
    expect(readAscii(bytes, 36, 4)).toBe('data');
  });

  it('encodes mono 16-bit PCM at the given sample rate', async () => {
    const samples = new Float32Array(100);
    const sampleRate = 24000;
    const bytes = await blobBytes(float32ToWavBlob(samples, sampleRate));
    expect(readUint32LE(bytes, 16)).toBe(16); // PCM fmt chunk size
    expect(readUint16LE(bytes, 20)).toBe(1); // PCM
    expect(readUint16LE(bytes, 22)).toBe(1); // mono
    expect(readUint32LE(bytes, 24)).toBe(sampleRate);
    expect(readUint32LE(bytes, 28)).toBe(sampleRate * 2); // byte rate (mono * 16-bit)
    expect(readUint16LE(bytes, 32)).toBe(2); // block align
    expect(readUint16LE(bytes, 34)).toBe(16); // bits/sample
    expect(readUint32LE(bytes, 40)).toBe(samples.length * 2); // data length
  });

  it('clips samples outside [-1, 1] and encodes 0 / ±0.5 / ±1 correctly', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const bytes = await blobBytes(float32ToWavBlob(samples, 8000));
    const data = bytes.subarray(44);
    // DataView.setInt16 truncates toward zero, so 0.5 * 0x7FFF = 16383.5 → 16383.
    expect(readInt16LE(data, 0)).toBe(0);
    expect(readInt16LE(data, 2)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(readInt16LE(data, 4)).toBe(Math.trunc(-0.5 * 0x8000));
    // Clipped to ±full-scale.
    expect(readInt16LE(data, 6)).toBe(0x7fff);
    expect(readInt16LE(data, 8)).toBe(-0x8000);
  });

  it('emits a 44-byte header plus 2 bytes per sample', async () => {
    const samples = new Float32Array(1000);
    const bytes = await blobBytes(float32ToWavBlob(samples, 24000));
    expect(bytes.length).toBe(44 + samples.length * 2);
  });
});
