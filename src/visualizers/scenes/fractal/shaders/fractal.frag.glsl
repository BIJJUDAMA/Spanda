#ifdef GL_ES
precision highp float;
#endif

uniform float uTime;
uniform vec2 uResolution;
uniform float uSubBass;
uniform float uKick;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uHEnergy;
uniform float uTransient;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

varying vec2 vUv;

// Distance estimator for 3D Mandelbulb fractal
// Returns estimated distance to fractal surface and passes out orbit trap distance
float mandelbulbDist(vec3 pos, float power, out float trap) {
    vec3 z = pos;
    float dr = 1.0;
    float r = 0.0;
    trap = 1e5;

    for (int i = 0; i < 6; i++) {
        r = length(z);
        if (r > 2.0) break;

        trap = min(trap, r);

        // Convert to spherical coordinates
        float theta = acos(clamp(z.z / max(r, 1e-4), -1.0, 1.0));
        float phi = atan(z.y, z.x);
        dr = pow(r, power - 1.0) * power * dr + 1.0;

        // Scale and rotate
        float zr = pow(r, power);
        theta = theta * power;
        phi = phi * power;

        // Convert back to cartesian coordinates
        z = zr * vec3(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + pos;
    }
    return 0.5 * log(max(r, 1e-4)) * r / max(dr, 1e-4);
}

float map(vec3 pos, float power) {
    float dummy;
    return mandelbulbDist(pos, power, dummy);
}

// Numerical gradient calculation using regular tetrahedron vertices (4 DE evaluations)
vec3 calcNormal(vec3 p, float power) {
    const vec2 e = vec2(1.0, -1.0) * 0.003;
    return normalize(
        e.xyy * map(p + e.xyy, power) +
        e.yyx * map(p + e.yyx, power) +
        e.yxy * map(p + e.yxy, power) +
        e.xxx * map(p + e.xxx, power)
    );
}

void main() {
    vec2 res = max(uResolution, vec2(1.0));
    vec2 p = (gl_FragCoord.xy * 2.0 - res) / min(res.x, res.y);

    // Dynamic Mandelbulb power driven by subBass and kick transients
    float n = 5.0 + 1.8 * clamp(uSubBass, 0.0, 1.0) + 0.65 * clamp(uKick, 0.0, 1.0);

    // Camera origin rotating around target modulated by uTime and harmonic energy (uHEnergy)
    float rotAngle = uTime * 0.075 + uHEnergy * 0.12;
    float camDist = 2.85 - clamp(uSubBass * 0.12 + uKick * 0.06, 0.0, 0.18);
    float camHeight = 0.34 * sin(uTime * 0.10);
    vec3 ro = vec3(camDist * sin(rotAngle), camHeight, camDist * cos(rotAngle));
    vec3 ta = vec3(0.0, 0.0, 0.0);

    vec3 ww = normalize(ta - ro);
    vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
    vec3 vv = cross(uu, ww);
    vec3 rd = normalize(p.x * uu + p.y * vv + 1.55 * ww);

    // Raymarching: 48 max steps with 0.002 adaptive threshold
    float t = 0.05;
    float maxDist = 5.5;
    float hitDist = -1.0;
    float minD = 1e5;
    float finalTrap = 1.0;
    int stepsTaken = 0;

    for (int i = 0; i < 48; i++) {
        vec3 pos = ro + rd * t;
        float currentTrap;
        float d = mandelbulbDist(pos, n, currentTrap);
        minD = min(minD, d);
        if (d < 0.002) {
            hitDist = t;
            finalTrap = currentTrap;
            stepsTaken = i;
            break;
        }
        t += d * 0.75;
        if (t > maxDist) break;
    }

    vec3 finalColor;

    if (hitDist >= 0.0) {
        vec3 pos = ro + rd * hitDist;
        vec3 norm = calcNormal(pos, n);

        // Dynamic 3-point light setup
        vec3 lightKey = normalize(vec3(0.8, 1.2, 0.9));
        vec3 lightFill = normalize(vec3(-0.9, -0.4, -0.7));
        vec3 lightBack = normalize(vec3(0.0, -0.8, 1.1));

        float diffKey = max(dot(norm, lightKey), 0.0);
        float diffFill = max(dot(norm, lightFill), 0.0);
        float diffBack = max(dot(norm, lightBack), 0.0);

        // Fresnel rim light
        float fresnel = pow(clamp(1.0 + dot(rd, norm), 0.0, 1.0), 3.0);

        // Specular reflection modulated by uTreble
        vec3 viewDir = -rd;
        vec3 halfKey = normalize(lightKey + viewDir);
        float specPower = 28.0 + 36.0 * clamp(uTreble, 0.0, 1.0);
        float specIntensity = 0.10 + 0.34 * clamp(uTreble, 0.0, 1.0);
        float spec = pow(max(dot(norm, halfKey), 0.0), specPower) * specIntensity;
        vec3 specularCol = mix(vec3(1.0), uColorB, 0.35) * spec;

        // Dynamic 3-point palette lighting across fractal depth and trap
        float depthMix = clamp((length(pos) - 0.5) / 1.1, 0.0, 1.0);
        float trapMix = clamp(finalTrap * 1.5, 0.0, 1.0);
        vec3 surfaceCol = mix(uColorA, uColorB, depthMix);
        surfaceCol = mix(surfaceCol, uColorC, trapMix * 0.7 + 0.3 * (sin(pos.z * 3.0 + uTime * 0.5) * 0.5 + 0.5));

        // Ambient occlusion based on ray steps taken
        float ao = 1.0 - clamp(float(stepsTaken) / 48.0, 0.0, 0.78);

        // Diffuse composition
        vec3 lit = surfaceCol * (diffKey * 0.62 + diffFill * 0.20 + diffBack * 0.12 + 0.075) * ao;

        // Fresnel rim glow tinted by uColorC
        lit += uColorC * fresnel * (0.24 + 0.30 * uTransient);

        // Specular highlight
        lit += specularCol;

        // Transient ambient glow and chromatic kick flash
        lit += uColorB * (0.025 + 0.055 * uTransient);
        lit += uColorB * (0.045 * uTransient + 0.025 * uKick) + uColorA * (0.025 * uTransient);

        finalColor = lit;
    } else {
        // Deep space background with fractal proximity ambient glow
        float glow = 0.010 / (minD * minD + 0.025);
        vec3 bgGlow = mix(uColorA, uColorB, clamp(p.y * 0.5 + 0.5, 0.0, 1.0)) * (0.045 + 0.08 * uTransient) * glow;
        vec3 bgColor = mix(vec3(0.006, 0.008, 0.018), uColorA * 0.025, clamp(length(p) * 0.35, 0.0, 1.0)) + bgGlow;
        bgColor += uColorA * (0.018 * uTransient + 0.012 * uKick);
        finalColor = bgColor;
    }

    // Radial vignette falloff: strictly edge0 < edge1 for DirectX/ANGLE compliance
    finalColor *= (1.0 - smoothstep(0.6, 2.4, length(p)));

    // A soft shoulder preserves palette hue in bright areas instead of clipping
    // summed diffuse, Fresnel, specular, and beat light to flat white.
    finalColor = max(finalColor, vec3(0.0));
    finalColor = finalColor / (vec3(1.0) + finalColor);
    gl_FragColor = vec4(finalColor, 1.0);
}
