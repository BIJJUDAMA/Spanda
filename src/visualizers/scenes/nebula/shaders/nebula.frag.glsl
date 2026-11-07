precision highp float;

varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);

  if (dist > 0.5) {
    discard;
  }

  // Soft luminous fluid droplet profile
  float core = smoothstep(0.5, 0.12, dist);
  float halo = exp(-dist * 5.4);
  // Additive blending stacks every overlap, so each point contributes a deliberately small light dose.
  float alpha = clamp((core * 0.34 + halo * 0.26) * vAlpha * 0.13, 0.0, 0.085);

  vec3 rgb = min(vColor * (0.76 + vGlow * 0.2), vec3(0.84));
  gl_FragColor = vec4(rgb, alpha);
}
