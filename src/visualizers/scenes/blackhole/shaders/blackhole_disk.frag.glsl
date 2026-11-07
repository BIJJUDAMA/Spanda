precision highp float;

varying vec3 vColor;
varying float vAlpha;
varying float vBeaming;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) {
    discard;
  }

  // Tight particle core with a restrained falloff keeps the disk granular.
  float core = 1.0 - smoothstep(0.08, 0.42, dist);
  float halo = exp(-dist * 7.0) * (1.0 - smoothstep(0.28, 0.5, dist));
  float alpha = clamp((core * 0.72 + halo * 0.16) * vAlpha, 0.0, 0.36);
  vec3 rgb = min(vColor * (0.76 + core * 0.2), vec3(0.84));
  gl_FragColor = vec4(rgb, alpha);
}
