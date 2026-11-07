#ifdef GL_ES
precision highp float;
#endif

uniform float uTime;
uniform vec2 uResolution;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uTransient;
uniform float uFlatness;
uniform float uKick;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

varying vec2 vUv;

void main() {
    vec2 res = max(uResolution, vec2(1.0));
    vec2 p = (gl_FragCoord.xy * 2.0 - res) / min(res.x, res.y);
    float r = length(p);
    float theta = atan(p.y, p.x);

    // Keep a slow drift during silence; the smoothed bands accelerate it gently
    // when music is present. Bass pushes the ring field toward the outer edges.
    float motion = 0.18 + min(0.72,
        uBass * 0.24 + uMid * 0.12 + uTreble * 0.06 + uTransient * 0.24 + uKick * 0.16);
    float flowTime = uTime * motion;
    float bassPush = uBass * 0.48 + uKick * 0.26 + uTransient * 0.22;

    // The inverse-radius depth mapping gives the tunnel perspective. A second
    // angular contour makes near and far rings change size and spacing slightly.
    float shapeCycle = 0.5 + 0.5 * sin(flowTime * 0.12 + 1.7 / (r + 0.22));
    float shape6 = cos(theta * 6.0 + flowTime * 0.035);
    float shape8 = cos(theta * 8.0 + 0.392699 + flowTime * 0.028);
    float contour = mix(shape6, shape8, shapeCycle);
    float depth = (1.55 + bassPush * 0.62) /
        max(0.055, r + 0.045 + contour * (0.012 + uMid * 0.026));
    float z = depth + flowTime;

    // Blend six and eight sided sections down the tunnel. Mid energy twists
    // their alignment with depth, while the beat keeps section motion bounded.
    float facets = mix(6.0, 8.0, 0.5 + 0.5 * sin(z * 0.16 + shapeCycle));
    float twist = flowTime * 0.035 + uMid * (sin(z * 0.22) * 0.24 + z * 0.012);
    float twistedTheta = theta + twist;
    float angleMod = contour * (0.13 + uMid * 0.34 + uFlatness * 0.35);
    float ringSpacing = 5.2 + 0.58 * sin(z * 0.17 + shapeCycle * 2.0);
    float ringWave = sin(z * ringSpacing + angleMod);
    float crossWave = cos(twistedTheta * 4.0 - flowTime * 0.22);
    float tunnelPattern = ringWave * crossWave;

    // Occasional polygon ribs and cross braces break up the repeated rings.
    float ribLine = pow(abs(cos(twistedTheta * facets)), 18.0);
    float braceBand = pow(abs(cos(z * 0.42 + shapeCycle)), 18.0);
    float supports = max(ribLine * smoothstep(0.93, 0.995, braceBand),
                         braceBand * smoothstep(0.94, 0.995, ribLine));

    // Treble flickers only along bright ring and brace edges.
    float ringEdge = smoothstep(0.72, 0.98, abs(tunnelPattern));
    float shimmer = max(0.0, sin(z * 24.0 - flowTime * 8.0))
        * uTreble * (0.08 + ringEdge * 0.42 + supports * 0.5);

    // Soft core glow with tight spatial decay (preserves deep contrast across mid/outer screen)
    float glow = exp(-r * 5.0) * (0.06 + uBass * 0.15);

    // Dynamic color gradient mixing
    float colorMix = sin(z * 0.38 + flowTime * 0.14) * 0.5 + 0.5;
    vec3 baseColor = mix(uColorA, uColorB, colorMix);
    baseColor = mix(baseColor, uColorC, tunnelPattern * 0.5 + 0.5);
    baseColor = mix(baseColor, uColorA, supports * 0.58);

    // Deep geometric ring contrast: power curve preserves dark space between glowing neon rings
    float ring = pow(clamp(abs(tunnelPattern), 0.0, 1.0), 2.2);
    vec3 finalColor = baseColor * (ring * 0.78 + supports * 0.48 + shimmer * 0.35) + (uColorA * glow);

    // Kick and transient beat trigger chromatic neon highlight flashes without solid whiteout
    float flash = max(uTransient, uKick);
    finalColor += baseColor * (flash * 0.22 * (ring + supports * 0.45));

    // Vignette falloff: strictly edge0 < edge1 for DirectX/ANGLE compliance
    finalColor *= (1.0 - smoothstep(0.4, 2.2, r));

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
