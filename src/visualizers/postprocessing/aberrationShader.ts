export const ChromaticAberrationVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uOffset: { value: 0.0 },
    uVignette: { value: 0.25 },
    uScanlines: { value: 0.05 },
    uTime: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uOffset;
    uniform float uVignette;
    uniform float uScanlines;
    uniform float uTime;
    varying vec2 vUv;

    void main() {
      vec2 center = vec2(0.5);
      vec2 dir = vUv - center;
      float dist = length(dir);

      // Radial chromatic dispersion (RGB channel split)
      vec2 rUv = vUv + dir * uOffset * 0.04;
      vec2 gUv = vUv;
      vec2 bUv = vUv - dir * uOffset * 0.04;

      float r = texture2D(tDiffuse, rUv).r;
      float g = texture2D(tDiffuse, gUv).g;
      float b = texture2D(tDiffuse, bUv).b;

      // Vignette
      float vig = 1.0 - smoothstep(0.4, 0.95, dist) * uVignette;

      // Subtle analog CRT scanlines
      float scan = 1.0 - sin(vUv.y * 800.0 + uTime * 2.0) * uScanlines * 0.5;

      gl_FragColor = vec4(vec3(r, g, b) * vig * scan, 1.0);
    }
  `,
};
