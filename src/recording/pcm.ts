export interface PcmPacket { rate: number; channels: number; samples: Float32Array; time: number }
export function decodePcm(data: ArrayBuffer): PcmPacket[] {
  const view = new DataView(data), packets: PcmPacket[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    if (data.byteLength - offset < 20) throw new Error('Incomplete recording audio header.');
    const rate = view.getUint32(offset, true), channels = view.getUint32(offset + 4, true);
    const count = view.getUint32(offset + 8, true), time = view.getFloat64(offset + 12, true);
    offset += 20;
    if (rate < 8000 || rate > 384000 || channels < 1 || channels > 32 || count % channels !== 0 || count > (data.byteLength - offset) / 4 || !Number.isFinite(time) || time < 0) throw new Error('Invalid recording audio packet.');
    packets.push({ rate, channels, time, samples: new Float32Array(data, offset, count) });
    offset += count * 4;
  }
  return packets;
}
export function stereoSample(samples: Float32Array, offset: number, channels: number, right: boolean) {
  if (channels === 1) return samples[offset];
  const side = right ? 1 : 0;
  let sample = samples[offset + side];
  if (channels === 4) return Math.max(-1, Math.min(1, sample + samples[offset + 2 + side] * .707));
  if (channels >= 3) sample += samples[offset + 2] * .707;
  if (channels === 5) sample += samples[offset + 3 + side] * .707;
  if (channels >= 6) sample += samples[offset + 3] * .25;
  if (channels >= 6) sample += samples[offset + 4 + side] * .707;
  if (channels === 7) sample += samples[offset + 6] * .5;
  if (channels >= 8) sample += samples[offset + 6 + side] * .707;
  return Math.max(-1, Math.min(1, sample));
}
