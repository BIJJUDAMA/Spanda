uniform float uTime;
uniform float uBass;
uniform float uSubBass;
uniform float uKick;
uniform float uMid;
uniform float uTreble;
uniform float uHEnergy;
uniform float uPEnergy;
uniform float uTransient;
uniform float uChromaShift;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uPixelRatio;

attribute vec4 aSeed; // x: phase, y: speed, z: filament index, w: lifetime
attribute float aSize;
attribute float aAlpha;

varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

// 3D Simplex noise functions (Ashima Arts / Stefan Gustavson)
vec4 permute(vec4 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec3 potential(vec3 p) {
  return vec3(
    snoise(p),
    snoise(p + vec3(31.41, 15.92, 65.35)),
    snoise(p + vec3(71.18, 92.42, 11.23))
  );
}

// 3D Simplex Curl Noise field (v = curl psi = nabla x psi)
vec3 curlNoise(vec3 p) {
  const float e = 0.06;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  vec3 p_x0 = potential(p - dx);
  vec3 p_x1 = potential(p + dx);
  vec3 p_y0 = potential(p - dy);
  vec3 p_y1 = potential(p + dy);
  vec3 p_z0 = potential(p - dz);
  vec3 p_z1 = potential(p + dz);

  float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
  float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
  float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);

  return vec3(x, y, z) / (2.0 * e);
}

// Cosine gradient color blending through selected palette
vec3 paletteColor(float t) {
  t = fract(t);
  if (t < 0.5) {
    float f = smoothstep(0.0, 0.5, t);
    return mix(uColorA, uColorB, f);
  } else {
    float f = smoothstep(0.5, 1.0, t);
    return mix(uColorB, uColorC, f);
  }
}

void main() {
  vec3 basePos = position;
  float r0 = length(basePos.xz);
  float theta0 = atan(basePos.z, basePos.x);

  // 1. Gentle ambient vortex orbital flow
  float orbitSpeed = (0.22 / (sqrt(r0 + 0.8))) * aSeed.y * (1.0 + uBass * 0.4);
  float currentTheta = theta0 + uTime * orbitSpeed;

  vec3 pOrbital = vec3(
    r0 * cos(currentTheta),
    basePos.y + sin(currentTheta * 2.0 + uTime * aSeed.y * 0.5) * 0.35,
    r0 * sin(currentTheta)
  );

  // 2. 3D Simplex Curl Noise Field with fluid viscosity modulation
  // Harmonic energy increases fluid viscosity, dampening chaotic eddies into laminar flow
  float viscosity = clamp(uHEnergy * 1.25, 0.0, 0.85);
  float noiseFreq = mix(0.18, 0.08, viscosity);
  vec3 noiseCoord = pOrbital * noiseFreq + vec3(0.0, uTime * 0.12 * aSeed.y, 0.0);
  vec3 curl = curlNoise(noiseCoord);

  // Laminar streamline tangent around the nebula vortex
  vec3 laminarTangent = normalize(vec3(
    -pOrbital.z,
    cos(r0 * 0.6 - uTime) * 0.6,
    pOrbital.x
  ));

  // Blend turbulent curl eddies with laminar streamlines when harmonic energy is high
  vec3 fluidFlow = mix(curl, laminarTangent, viscosity);
  float flowAmplitude = mix(2.6, 1.5, viscosity) + uMid * 1.4;
  vec3 fluidPos = pOrbital + fluidFlow * flowAmplitude;

  // 3. Percussive energy and kick transient shockwave impulse from center (r -> infinity)
  float distToCenter = length(fluidPos);
  vec3 radialDir = normalize(fluidPos + vec3(0.0001));
  float shockwaveImpulse = (uPEnergy * 3.2 + uKick * 4.6 + uTransient * 2.0) / (1.0 + distToCenter * 0.22);
  float shockwaveRipple = sin(distToCenter * 1.8 - uTime * 7.0) * (uKick * 0.65 + uPEnergy * 0.35);

  vec3 finalPos = fluidPos + radialDir * (shockwaveImpulse + shockwaveRipple);

  // 4. Chroma pitch-class features rotate color gradients through palette
  float chromaRotation = uChromaShift + aSeed.z * 0.3;
  float colorParam = fract(aSeed.x * 0.15 + chromaRotation + distToCenter * 0.045 + uTime * 0.02);
  vec3 baseColor = paletteColor(colorParam);

  // Explosive luminescence and core heat from kick and treble sparkle
  float coreHeat = exp(-distToCenter * 0.38) * (uKick * 0.34 + uPEnergy * 0.2);
  float trebleSparkle = pow(sin(uTime * 15.0 + aSeed.x * 6.28), 8.0) * uTreble * 0.28;
  // Preserve the selected palette through peaks; white is reserved for a faint sparkle.
  float whiteLift = clamp(coreHeat * 0.08 + trebleSparkle * 0.12, 0.0, 0.055);
  vColor = mix(baseColor, vec3(1.0), whiteLift);
  vGlow = clamp(coreHeat * 0.18 + uTransient * 0.07, 0.0, 0.2);

  // Opacity & sizing
  vAlpha = aAlpha * (0.68 + 0.22 * sin(uTime * 1.6 + aSeed.x));

  vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Fluid point size attenuation
  float sizePulse = 1.0 + uBass * 0.14 + uKick * 0.18;
  gl_PointSize = (aSize * sizePulse * uPixelRatio) * (200.0 / -mvPosition.z);
  gl_PointSize = clamp(gl_PointSize, 1.0, 22.0);
}
