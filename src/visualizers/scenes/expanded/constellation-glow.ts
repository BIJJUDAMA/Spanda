import * as THREE from 'three';

/** Smoothly select the near cap, leaving the rear hemisphere unlit. */
export function frontNodeWeight(facing: number): number {
  const t = Math.max(0, Math.min(1, (facing - .15) / .55));
  return t * t * (3 - 2 * t);
}

/** Stable, staggered brightening instead of frame-by-frame random flicker. */
export function nodeTwinkle(time: number, node: number): number {
  const phase = node * 2.399963;
  const rate = 1.6 + .8 * (.5 + .5 * Math.sin(node * 1.71));
  return Math.pow(.5 + .5 * Math.sin(time * rate + phase), 8);
}

export function createConstellationGlowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 360 } },
    vertexShader: `
      attribute vec4 color;
      attribute float beatGlow;
      attribute float frontGlow;
      attribute float twinkle;
      uniform float uScale;
      varying vec4 vTint;
      varying float vSparkle;
      void main() {
        vTint = color;
        vSparkle = twinkle * (frontGlow * .13 + beatGlow * .87);
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp((.16 + .14 * vSparkle) * uScale / max(.1, -view.z), 1.0, 64.0);
      }
    `,
    fragmentShader: `
      varying vec4 vTint;
      varying float vSparkle;
      void main() {
        if (vSparkle < .001) discard;
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        float core = exp(-32.0 * r2);
        float rays = exp(-70.0 * abs(p.x) - 5.0 * abs(p.y))
          + exp(-70.0 * abs(p.y) - 5.0 * abs(p.x));
        float edge = 1.0 - smoothstep(.55, 1.0, r2);
        float alpha = min(1.0, core + .28 * rays) * vSparkle * edge * vTint.a;
        gl_FragColor = vec4(vTint.rgb, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}
