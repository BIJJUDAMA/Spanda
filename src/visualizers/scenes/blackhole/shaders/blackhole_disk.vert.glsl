uniform float uTime;
uniform float uBass;
uniform float uSubBass;
uniform float uKick;
uniform float uMid;
uniform float uTreble;
uniform float uStereoWidth;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uPixelRatio;

attribute float aRadius;
attribute float aBaseAngle;
attribute float aRingIndex;
attribute float aRadialJitter;
attribute float aVerticalJitter;
attribute float aSize;

varying vec3 vColor;
varying float vAlpha;
varying float vBeaming;

void main() {
  // Keplerian angular velocity: omega = omega0 * (r / r_in)^(-1.5)
  // Inner boundary r_in is 3.2 (just outside photon sphere r_ph = 3.0)
  float rNorm = max(aRadius / 3.2, 1.0);
  float omega = 1.65 / (rNorm * sqrt(rNorm)); // r^-1.5 Keplerian decay

  // Current orbital angle with bass-responsive acceleration
  float angle = aBaseAngle + omega * uTime * (1.0 + uBass * 0.12 + uKick * 0.08);

  float r = aRadius + aRadialJitter * (1.0 + uSubBass * 0.12);

  // Unwarped equatorial disk coordinates
  float x0 = r * cos(angle);
  float z0 = r * sin(angle);
  float y0 = aVerticalJitter * (1.0 + sin(angle * 3.0 + uTime * 2.0) * 0.25);

  // Gravitational lensing deflection:
  // Light from matter behind the event horizon (z0 < 0) is bent over and under the horizon
  float r_ph = 3.0; // Photon sphere radius = 1.5 * r_s (r_s = 2.0)
  float behindFactor = 1.0 - smoothstep(-3.5, 1.5, z0); // Active behind the black hole
  float lensDist = max(length(vec2(x0, y0)), r_ph * 0.85);
  float lensDeflection = (r_ph * r_ph * 1.05 / lensDist) * behindFactor * (1.0 + (uStereoWidth - 0.5) * 0.18);

  // Deflect upward or downward framing the shadow
  float signY = (y0 >= 0.0) ? 1.0 : -1.0;
  if (abs(y0) < 0.02) {
    signY = (sin(angle) >= 0.0) ? 1.0 : -1.0;
  }

  float yLensed = y0 + signY * lensDeflection;

  // Accretion disk tilt / inclination angle:
  // Base inclination ~ 32 degrees (0.56 rad), modulated by stereo width
  float inclination = 0.56 + (uStereoWidth - 0.5) * 0.18;
  float cosInc = cos(inclination);
  float sinInc = sin(inclination);

  // Rotate around X-axis for viewing angle
  vec3 pos = vec3(
    x0,
    yLensed * cosInc - z0 * sinInc,
    yLensed * sinInc + z0 * cosInc
  );

  // Relativistic Doppler beaming calculation:
  // Velocity in disk plane is tangential to orbit:
  // v = omega * (-r*sin(theta), 0, r*cos(theta))
  vec3 vel = vec3(
    -r * sin(angle) * omega,
    -r * cos(angle) * omega * sinInc,
    r * cos(angle) * omega * cosInc
  );

  // Approaching side (vel.z > 0 towards viewer): Doppler boosted and blueshifted
  // Receding side (vel.z < 0 away from viewer): Doppler dimmed and redshifted
  float beta = clamp(vel.z / 4.2, -0.85, 0.85);

  // Relativistic beaming factor
  float beaming = pow(max(0.12, 1.0 + beta * 0.72), 2.2);
  vBeaming = beaming;

  // Color mapping:
  // Approaching: blueshifted towards uColorB/uColorC + white boost
  // Receding: redshifted towards uColorA + dimmed
  vec3 dopplerColor;
  if (beta >= 0.0) {
    float t = clamp(beta * 1.4 + uTreble * 0.4, 0.0, 1.0);
    vec3 blueShift = mix(uColorB, uColorC, t);
    // Relativistic boost adds bright photon highlight while preserving vibrant palette
    dopplerColor = mix(blueShift, vec3(0.82, 0.9, 1.0), clamp(beta * beta * 0.16, 0.0, 0.18));
  } else {
    float t = clamp(-beta * 1.3, 0.0, 1.0);
    dopplerColor = mix(uColorB, uColorA, t);
  }

  // Inner rings are hotter (closer to extreme gravitational friction)
  float innerHot = clamp((12.0 - aRadius) / 9.0, 0.0, 1.0);
  dopplerColor = mix(dopplerColor, uColorC, innerHot * 0.22);

  // Clamp before additive blending so palette hues survive dense particle overlap.
  vColor = min(dopplerColor * clamp(beaming, 0.62, 1.2), vec3(0.82));

  // Alpha: inner rings denser, modulated by beaming
  float baseAlpha = mix(0.3, 0.18, aRadius / 14.0);
  vAlpha = clamp(baseAlpha * (0.68 + beaming * 0.2) * (1.0 + uMid * 0.08 + uTreble * 0.05), 0.06, 0.3);

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Size attenuation with relativistic boost
  float sizeBoost = (1.0 + uBass * 0.10 + uMid * 0.06) * clamp(beaming, 0.72, 1.15);
  gl_PointSize = (aSize * sizeBoost * uPixelRatio * 19.0) / (-mvPosition.z);
  gl_PointSize = max(1.0, min(gl_PointSize, 34.0));
}
