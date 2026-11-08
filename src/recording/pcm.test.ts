import { expect, it } from 'vitest';
import { decodePcm, stereoSample } from './pcm';
it('decodes timestamped stereo samples without JSON conversion', () => {
  const data = new ArrayBuffer(28), view = new DataView(data);
  view.setUint32(0, 48000, true); view.setUint32(4, 2, true); view.setUint32(8, 2, true); view.setFloat64(12, .25, true);
  view.setFloat32(20, .5, true); view.setFloat32(24, -.5, true);
  const [packet] = decodePcm(data);
  expect(packet.rate).toBe(48000); expect(packet.channels).toBe(2); expect(packet.time).toBe(.25);
  expect([...packet.samples]).toEqual([.5, -.5]);
  expect(() => decodePcm(data.slice(0, 27))).toThrow();
  view.setUint32(4, 0, true); expect(() => decodePcm(data)).toThrow();
});
it('duplicates mono, preserves stereo and includes a surround center channel', () => {
  expect(stereoSample(new Float32Array([.3]), 0, 1, true)).toBeCloseTo(.3);
  expect(stereoSample(new Float32Array([.2, .8]), 0, 2, true)).toBeCloseTo(.8);
  expect(stereoSample(new Float32Array([0, 0, 1, 0, 0, 0]), 0, 6, false)).toBeCloseTo(.707);
});
