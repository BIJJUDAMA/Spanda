precision highp float;

uniform float uTime;
uniform float uBass;
uniform float uSubBass;
uniform float uKick;
uniform float uStereoWidth;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

varying vec2 vUv;

void main() {
  vec2 p = (vUv - vec2(0.5)) * 12.0;
  float width = clamp(uStereoWidth, 0.0, 1.0) - 0.5;
  p.x *= 1.0 + width * 0.12;
  p.y *= 1.0 - width * 0.08;
  float r = length(p);

  // Keep the horizon truly black; the narrow photon ring starts outside its rim.
  if (r < 2.015) discard;
  float ringRadius = 3.0 + clamp(uBass * 0.025 + uKick * 0.018, 0.0, 0.04);
  float ringDistance = abs(r - ringRadius);
  float photonRing = exp(-ringDistance * ringDistance * 16.0);
  float innerLensing = exp(-abs(r - 2.18) * 8.0);
  float outerLensing = exp(-abs(r - 3.75) * 2.4);
  float lensing = innerLensing * 0.12 + outerLensing * 0.075;

  float pulse = clamp(uBass * 0.12 + uSubBass * 0.08 + uKick * 0.10, 0.0, 0.22);
  float ringLight = photonRing * (0.30 + pulse);
  float light = ringLight + lensing;

  // Preserve palette hues; white is used only as a very small spectral lift.
  vec3 ringColor = mix(uColorB, uColorC, clamp(0.35 + uKick * 0.12, 0.0, 0.6));
  vec3 lensColor = mix(uColorA, uColorB, 0.55);
  vec3 color = mix(lensColor, ringColor, clamp(photonRing * 0.9, 0.0, 1.0));
  color = mix(color, vec3(0.82), photonRing * 0.12);

  // Low output and low alpha keep overlapping disk/jet light from clipping white.
  float alpha = clamp(light * 0.72, 0.0, 0.36);
  gl_FragColor = vec4(min(color, vec3(0.88)) * min(light, 0.82), alpha);
}
