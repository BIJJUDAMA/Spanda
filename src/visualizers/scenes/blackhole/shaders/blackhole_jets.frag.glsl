precision highp float;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) {
    discard;
  }

  float core = 1.0 - smoothstep(0.08, 0.42, dist);
  float halo = exp(-dist * 7.0) * (1.0 - smoothstep(0.28, 0.5, dist));
  float alpha = clamp((core * 0.72 + halo * 0.12) * vAlpha, 0.0, 0.32);
  gl_FragColor = vec4(min(vColor * (0.8 + core * 0.14), vec3(0.84)), alpha);
}
