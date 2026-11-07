uniform float uTime;
uniform float uKick;
uniform float uPEnergy;
uniform float uTransient;
uniform float uStereoWidth;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uPixelRatio;

attribute float aSeed;
attribute float aPolarity; // +1.0 for +Y jet, -1.0 for -Y jet
attribute float aBaseDist;
attribute float aAngle;
attribute float aSize;

varying vec3 vColor;
varying float vAlpha;

void main() {
  // Outward relativistic streaming velocity along Y axis
  // Base speed + massive flare on kick transients and percussive energy
  float jetSpeed = 13.0 + (uKick * 8.0) + (uPEnergy * 6.0) + (uTransient * 2.5);

  float totalLength = 26.0 + (uKick * 4.0) + (uPEnergy * 3.0);
  float distY = 2.2 + mod(aSeed * 32.0 + uTime * jetSpeed, totalLength);

  // Collimated beam width: expands slightly with distance and flaring
  float stereoSpread = 1.0 + (uStereoWidth - 0.5) * 0.45;
  float beamRadius = (0.16 + distY * 0.038) * stereoSpread * (1.0 + uKick * 0.12);

  // Helical magnetic field winding
  float helixAngle = aAngle + distY * 0.75 + uTime * 7.0 * aPolarity;
  float x = cos(helixAngle) * beamRadius * aBaseDist;
  float z = sin(helixAngle) * beamRadius * aBaseDist;
  float y = distY * aPolarity;

  vec3 pos = vec3(x, y, z);

  // Transient flaring multiplier on kick / P-energy
  float flare = clamp(uKick * 0.55 + uPEnergy * 0.42 + uTransient * 0.28, 0.0, 0.8);

  // Color: synchrotron plasma emission
  vec3 jetColor = mix(uColorB, uColorC, clamp(distY / 16.0, 0.0, 1.0));
  jetColor = mix(jetColor, vec3(0.82, 0.9, 1.0), clamp(flare * 0.08 + (0.35 / distY), 0.0, 0.12));
  vColor = min(jetColor * (0.72 + flare * 0.16), vec3(0.76));

  // Alpha decays as jet travels outward into deep space
  float distFade = 1.0 - smoothstep(18.0, 38.0, distY);
  float coreFade = smoothstep(2.0, 4.0, distY); // Fade in at horizon boundary
  vAlpha = clamp(distFade * coreFade * (0.3 + flare * 0.2), 0.0, 0.42);

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float sizeMult = (1.0 + flare * 0.18) * uPixelRatio;
  gl_PointSize = (aSize * sizeMult * 24.0) / (-mvPosition.z);
  gl_PointSize = max(1.0, min(gl_PointSize, 32.0));
}
