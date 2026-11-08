import { createConstellationGlowMaterial, frontNodeWeight, nodeTwinkle } from './constellation-glow';
import { SceneBeatResponse } from '../../beat-response';
import * as THREE from 'three';
import { PALETTES } from '../../palettes';
import { DYNAMIC_PROFILES, getEffectiveSensitivity, smoothDynamic } from '../../dynamics';
import type { RenderAudio, VisualScene, VisualSettings } from '../../types';

const vertex = `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const common = `
  varying vec2 vUv;
  uniform float uTime,uBass,uMid,uTreble,uPulse,uAspect,uBeat,uBeatAge,uFlowTime;
  uniform vec3 uA,uB,uC;
  vec3 palette(float t){return mix(mix(uA,uB,smoothstep(0.,.6,t)),uC,smoothstep(.5,1.,t));}
`;
const bounded = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

function reactiveUniforms() {
  return { uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uBeat: { value: 0 }, uBeatAge: { value: 100 }, uFlowTime: { value: 0 },
    uPulse: { value: 0 }, uAspect: { value: 1 }, uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } };
}
function updateReactiveUniforms(material: THREE.ShaderMaterial, elapsed: number, dt: number, audio: RenderAudio, settings: VisualSettings) {
  const u = material.uniforms;
  u.uTime.value = elapsed;
  const gain = getEffectiveSensitivity(settings.sensitivity);
  for (const [uniform, value] of [['uBass', audio.bass], ['uMid', audio.mid], ['uTreble', audio.treble], ['uPulse', audio.transient]] as const) {
    u[uniform].value = smoothDynamic(u[uniform].value, audio.silent ? 0 : bounded(value * gain * 2), dt, settings.response);
  }
  const p = PALETTES[settings.palette];
  u.uA.value.copy(p.a); u.uB.value.copy(p.b); u.uC.value.copy(p.c);
}

abstract class SurfaceScene implements VisualScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly geometry = new THREE.PlaneGeometry(2, 2);
  readonly material: THREE.ShaderMaterial;
  protected elapsed = 0;
  readonly rhythm = new SceneBeatResponse();
  private flowTime = 0;
  constructor(fragment: string, uniforms: Record<string, THREE.IUniform> = {}) {
    this.material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: common + fragment,
      uniforms: { ...reactiveUniforms(), ...uniforms }, depthTest: false, depthWrite: false });
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }
  update(dt: number, audio: RenderAudio, settings: VisualSettings) {
    const step = Math.max(0, Math.min(dt, .1));
    this.elapsed += step;
    updateReactiveUniforms(this.material, this.elapsed, step, audio, settings);
    this.rhythm.update(step, audio, settings);
    const u = this.material.uniforms;
    this.flowTime += step * (audio.silent ? .65 : 1.15 + u.uBass.value * .6 + u.uMid.value * .4 + this.rhythm.pulse * .8);
    u.uBeat.value = this.rhythm.pulse; u.uBeatAge.value = this.rhythm.age; u.uFlowTime.value = this.flowTime;
  }
  resize(width: number, height: number) { this.material.uniforms.uAspect.value = width / Math.max(1, height); }
  dispose() { this.geometry.dispose(); this.material.dispose(); this.scene.clear(); }
}

export class LiquidInterferenceScene extends SurfaceScene {
  constructor() {
    super(`
      vec3 ringTint(float phase, float offset){
        float band=mod(floor((phase+1.5707963)/6.2831853)+offset,3.);
        if(band<1.) return uA;
        if(band<2.) return uB;
        return uC;
      }
      void main(){
        vec2 p=(vUv-.5)*vec2(uAspect,1.)*3.;
        p+=sin(p.yx*3.+uFlowTime*.6)*(.025+uMid*.035);
        p/=1.+uBeat*.08;
        vec2 a=vec2(sin(uFlowTime*.27),cos(uFlowTime*.22))*.65;
        vec2 b=vec2(cos(uFlowTime*.18),sin(uFlowTime*.29))*.7;
        vec2 c=vec2(sin(uFlowTime*.24+.8),cos(uFlowTime*.16+1.))* .8;
        float phaseA=length(p-a)*(12.+uBass*8.)-uFlowTime*1.5;
        float phaseB=length(p-b)*(16.+uMid*8.)-uFlowTime*1.3;
        float phaseC=length(p-c)*(22.+uTreble*10.)-uFlowTime*1.05;
        vec3 waves=sin(vec3(phaseA,phaseB,phaseC));
        float wave=dot(waves,vec3(.45,.35,.2));
        vec3 rings=pow(.5+.5*waves,vec3(5.))*vec3(.45,.35,.2);
        vec3 tintA=ringTint(phaseA,0.);
        vec3 tintB=ringTint(phaseB,1.);
        vec3 tintC=ringTint(phaseC,2.);
        vec3 ringColor=(tintA*rings.x+tintB*rings.y+tintC*rings.z)
          /max(.0001,rings.x+rings.y+rings.z);
        float ridge=pow(.5+.5*wave,3.);
        float beatRing=exp(-abs(length(p-a)-uBeatAge*2.8)*8.)*uBeat;
        float light=.16+ridge*(.65+uBass*.4)+uPulse*.12;
        float edge=1.-smoothstep(.3,2.2,length(p));
        vec3 color=ringColor*light+beatRing*ringTint(uFlowTime*1.5,0.)*.28;
        gl_FragColor=vec4(color*(.25+.75*edge),1.);
      }`);
  }
}

export class TypographyScene extends SurfaceScene {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private text = '';
  constructor() {
    const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 512;
    const texture = new THREE.CanvasTexture(canvas);
    super(`uniform sampler2D uText;
      void main(){
        vec2 p=vUv-.5;
        p/=vec2(.8,min(.65,.8*uAspect/3.));
        p.x/=1.+uBass*.04+uBeat*.1;
        p.y/=1.+uBass*.06+uBeat*.16;
        p.y+=uBeat*.025;
        p.y+=sin(p.x*14.+uTime*1.2)*(.008+uMid*.035+uBeat*.012);
        p.x+=sin(floor((p.y+.5)*36.)*2.4+uTime*.6)*uPulse*.025;
        vec2 uv=p+vec2(.5);
        float mask=0.;
        if(uv.x>0.&&uv.x<1.&&uv.y>0.&&uv.y<1.) mask=texture2D(uText,uv).a;
        vec3 color=palette(clamp(vUv.x+sin(uTime*.15)*.15,0.,1.));
        float echo=max(texture2D(uText,clamp(uv+vec2(uBeat*.012,0.),0.,1.)).a,
          texture2D(uText,clamp(uv-vec2(uBeat*.012,0.),0.,1.)).a);
        gl_FragColor=vec4(color*(mask*(.7+uTreble*.3+uBeat*.18)+echo*uBeat*.12),1.);
      }`, { uText: { value: texture } });
    this.canvas = canvas; this.texture = texture;
  }
  override update(dt: number, audio: RenderAudio, settings: VisualSettings) {
    super.update(dt, audio, settings);
    const text = (settings.typographyText || 'SPANDA').trim().slice(0, 48) || 'SPANDA';
    if (text !== this.text) {
      this.text = text;
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.font = '700 220px "Segoe UI", sans-serif';
        const width = ctx.measureText(text).width;
        const size = Math.min(220, 220 * 1400 / Math.max(1, width));
        ctx.font = `700 ${size}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
        ctx.fillText(text, 768, 256);
        this.texture.needsUpdate = true;
      }
    }
  }
  override dispose() { this.texture.dispose(); super.dispose(); }
}

const COUNT = 128;
const CONNECTIONS = 384;
const MAX_NODES = 256;
const MAX_CONNECTIONS = 768;
export class ParticleConstellationScene implements VisualScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, .1, 100);
  readonly positions = new Float32Array(MAX_NODES * 3);
  readonly colors = new Float32Array(MAX_NODES * 4);
  private linkColors = new Float32Array(MAX_CONNECTIONS * 8);
  private opacity = Float32Array.from({ length: MAX_NODES }, (_, i) => i < COUNT ? 1 : 0);
  readonly nodeGlow = new Float32Array(MAX_NODES);
  readonly frontGlow = new Float32Array(MAX_NODES);
  readonly twinkles = new Float32Array(MAX_NODES);
  readonly glowMaterial = createConstellationGlowMaterial();
  private nodes: THREE.Points;
  private worldCenter = new THREE.Vector3();
  private towardCamera = new THREE.Vector3();
  private nodeDirection = new THREE.Vector3();
  private glowViewport = new THREE.Vector2();
  private growth = 0;
  readonly rhythm = new SceneBeatResponse();
  readonly geometry = new THREE.BufferGeometry();
  readonly links = new THREE.BufferGeometry();
  readonly linkPositions = new Float32Array(MAX_CONNECTIONS * 6);
  readonly material = new THREE.PointsMaterial({ color: 0xffffff, vertexColors: true, size: .045, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  readonly linkMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: .2, depthWrite: false });
  private time = 0;
  private energy = 0;
  private pulse = 0;
  constructor() {
    this.scene.background = new THREE.Color(0);
    this.camera.position.z = 7.4;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('beatGlow', new THREE.BufferAttribute(this.nodeGlow, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('frontGlow', new THREE.BufferAttribute(this.frontGlow, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('twinkle', new THREE.BufferAttribute(this.twinkles, 1).setUsage(THREE.DynamicDrawUsage));
    this.links.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.links.setAttribute('color', new THREE.BufferAttribute(this.linkColors, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, COUNT);
    this.links.setDrawRange(0, 0);
    this.nodes = new THREE.Points(this.geometry, this.material);
    const glow = new THREE.Points(this.geometry, this.glowMaterial);
    glow.frustumCulled = false;
    glow.onBeforeRender = renderer => {
      this.glowMaterial.uniforms.uScale.value = renderer.getDrawingBufferSize(this.glowViewport).y * .5;
    };
    this.scene.add(this.nodes, new THREE.LineSegments(this.links, this.linkMaterial), glow);
  }
  update(dt: number, audio: RenderAudio, settings: VisualSettings) {
    const step = Math.min(.1, Math.max(0, dt));
    this.time += step;
    this.energy = smoothDynamic(this.energy, audio.silent ? 0 : bounded(audio.mid * getEffectiveSensitivity(settings.sensitivity) * 2), step, settings.response);
    this.pulse = smoothDynamic(this.pulse, audio.silent ? 0 : bounded(audio.transient * settings.sensitivity), step, settings.response);
    this.rhythm.update(step, audio, settings);
    const beat = this.rhythm.pulse;
    this.growth = Math.min(MAX_NODES - COUNT, this.growth + step * .2 + (this.rhythm.triggered ? .4 : 0));
    const activeCount = Math.min(MAX_NODES, COUNT + Math.ceil(this.growth));
    this.geometry.setDrawRange(0, activeCount);
    const palette = PALETTES[settings.palette], anchors = [palette.a, palette.b, palette.c];
    for (let i = 0; i < activeCount; i++) {
      const baseAngle = i * 2.399963;
      const angle = baseAngle + this.time * .008;
      const fraction = i < COUNT ? (i + .5) / COUNT : ((i - COUNT + .5) * .7548776662467) % 1;
      const y = 1 - 2 * fraction;
      const targetOpacity = i < COUNT ? 1 : bounded(this.growth - (i - COUNT));
      this.opacity[i] += (targetOpacity - this.opacity[i]) * (1 - Math.exp(-step / .8));
      const field = baseAngle * 2 + y * 3;
      // Start at the original positions; slowly pull neighboring nodes in/out together.
      const pull = .3 * (Math.sin(field + this.time * .32) - Math.sin(field))
        + Math.sin(this.time * .22) * .08 + beat * .38 * Math.sin(field + this.time * .2);
      const radius = (2.5 + Math.sin(i * 1.71 + this.time * .3) * .25 + pull) * (1 + this.energy * .12 + this.pulse * .1 + beat * .1);
      const ring = Math.sqrt(1 - y * y);
      this.positions[i * 3] = Math.cos(angle) * ring * radius;
      this.positions[i * 3 + 1] = y * radius;
      this.positions[i * 3 + 2] = Math.sin(angle) * ring * radius;
      const phase = ((i / COUNT + this.time * .01) % 1) * 3;
      const slot = Math.floor(phase), mix = phase - slot, from = anchors[slot], to = anchors[(slot + 1) % 3];
      this.colors[i * 4] = from.r + (to.r - from.r) * mix;
      this.colors[i * 4 + 1] = from.g + (to.g - from.g) * mix;
      this.colors[i * 4 + 2] = from.b + (to.b - from.b) * mix;
      this.colors[i * 4 + 3] = this.opacity[i];
    }
    this.nodes.updateWorldMatrix(true, false);
    this.nodes.getWorldPosition(this.worldCenter);
    this.camera.getWorldPosition(this.towardCamera).sub(this.worldCenter).normalize();
    for (let i = 0; i < activeCount; i++) {
      this.nodeDirection.fromArray(this.positions, i * 3).applyMatrix4(this.nodes.matrixWorld)
        .sub(this.worldCenter).normalize();
      this.frontGlow[i] = frontNodeWeight(this.nodeDirection.dot(this.towardCamera));
      this.nodeGlow[i] = beat * this.frontGlow[i];
      this.twinkles[i] = nodeTwinkle(this.time, i);
    }
    this.geometry.attributes.beatGlow.needsUpdate = true;
    this.geometry.attributes.frontGlow.needsUpdate = true;
    this.geometry.attributes.twinkle.needsUpdate = true;
    let count = 0;
    const distance = .85 + this.energy * .5;
    const limit = Math.min(MAX_CONNECTIONS, CONNECTIONS + (activeCount - COUNT) * 3);
    // Keep the original network first; new nodes and their links fade in afterwards.
    for (let pass = 0; pass < 2; pass++) {
      const passLimit = pass === 0 ? CONNECTIONS : limit;
      for (let i = 0; i < activeCount && count < passLimit; i++) for (let j = i + 1; j < activeCount && count < passLimit; j++) {
        if ((pass === 0) !== (j < COUNT)) continue;
        const alpha = Math.min(this.opacity[i], this.opacity[j]);
        if (alpha < .001) continue;
        const a = i * 3, b = j * 3;
        const d = (this.positions[a] - this.positions[b]) ** 2 + (this.positions[a + 1] - this.positions[b + 1]) ** 2 + (this.positions[a + 2] - this.positions[b + 2]) ** 2;
        if (d < distance * distance) {
          for (let axis = 0; axis < 3; axis++) {
            this.linkPositions[count * 6 + axis] = this.positions[a + axis];
            this.linkPositions[count * 6 + 3 + axis] = this.positions[b + axis];
            this.linkColors[count * 8 + axis] = this.colors[i * 4 + axis];
            this.linkColors[count * 8 + 4 + axis] = this.colors[j * 4 + axis];
          }
          this.linkColors[count * 8 + 3] = alpha; this.linkColors[count * 8 + 7] = alpha;
          count++;
        }
      }
    }
    this.links.setDrawRange(0, count * 2);
    this.geometry.attributes.position.needsUpdate = true; this.links.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true; this.links.attributes.color.needsUpdate = true;
    this.material.size = .035 + this.energy * .025 + this.pulse * .04;
    this.linkMaterial.opacity = .14 + this.energy * .17;
  }
  resize(width: number, height: number) { this.glowMaterial.uniforms.uScale.value = Math.max(1, height) * .5; this.camera.aspect = width / Math.max(1, height); this.camera.position.z = this.camera.aspect < 1 ? 7.4 / Math.max(.35, this.camera.aspect) : 7.4; this.camera.updateProjectionMatrix(); }
  dispose() { this.geometry.dispose(); this.links.dispose(); this.material.dispose(); this.linkMaterial.dispose(); this.glowMaterial.dispose(); this.scene.clear(); }
}


export class KaleidoscopeScene extends SurfaceScene {
  private highEnvelope = 0;
  private highAttack = 0;
  private previousHigh = 0;
  constructor() {
    super(`uniform float uHigh,uHighAttack;
      void main(){
        vec2 p=(vUv-.5)*vec2(uAspect,1.)*2.;
        float radius=length(p)/(1.+uBass*.16+uBeat*.16);
        float sector=6.2831853/12.;
        float angle=atan(p.y,p.x)+uTime*.045+uBeat*.035;
        float folded=abs(mod(angle+sector*.5,sector)-sector*.5);
        vec2 q=vec2(cos(folded),sin(folded))*radius;
        q.x+=sin(q.y*9.-uTime*.22)*(.04+uMid*.08);
        q.y+=sin(q.x*18.+uTime*.9)*uHighAttack*.006;
        float rings=sin(radius*(15.+uBass*3.)-uTime*.5-uPulse*.5-uBeat*.9);
        float petals=sin(q.x*11.+cos(q.y*(30.+uTreble*8.+uHigh*14.)+uTime*.28)*1.6);
        float ridges=exp(-abs(petals+rings*.55)*(6.+uHigh*1.5));
        float facets=pow(.5+.5*cos(q.y*(45.+uHigh*24.)+rings*2.),4.);
        float fade=1.-smoothstep(.3,1.8,radius);
        vec3 color=palette(clamp(radius*.6+facets*.2,0.,1.));
        float shimmer=pow(.5+.5*cos(q.y*(78.+uHigh*44.)+q.x*18.-uTime*1.8),12.)*uHigh;
        float sparkle=pow(.5+.5*sin(q.x*85.+q.y*105.+uTime*6.),20.)*uHighAttack;
        float glint=(shimmer*.2+sparkle*.12)*(.3+.7*facets);
        vec3 detailColor=palette(clamp(radius*.6+.35,0.,1.));
        vec3 light=color*(.035+ridges*(.75+uBeat*.16)+facets*(.12+uBeat*.08)+uPulse*.08)+detailColor*glint;
        gl_FragColor=vec4(min(light,vec3(1.))*fade,1.);
      }`, { uHigh: { value: 0 }, uHighAttack: { value: 0 } });
  }
  override update(dt: number, audio: RenderAudio, settings: VisualSettings) {
    super.update(dt, audio, settings);
    const step = Math.max(0, Math.min(.1, dt));
    let peak = 0, power = 0, bins = 0;
    // Highest native log-frequency buckets emphasize upper treble (~4kHz+ at 44.1/48kHz capture).
    if (!audio.silent) for (let i = Math.floor(audio.spectrum.length * .77); i < audio.spectrum.length; i++) {
      const value = bounded(audio.spectrum[i]);
      peak = Math.max(peak, value); power += value * value; bins++;
    }
    const spectralHigh = bins ? peak * .7 + Math.sqrt(power / bins) * .3 : 0;
    const input = audio.silent ? 0 : Math.max(bounded(audio.treble), spectralHigh * .8);
    const drive = input * getEffectiveSensitivity(settings.sensitivity);
    const target = drive / (.25 + drive);
    const profile = DYNAMIC_PROFILES[settings.response] ?? DYNAMIC_PROFILES.punchy;
    const attack = Math.min(.025, Math.max(.006, profile.attackTau));
    const release = .06 + profile.releaseTau * .2;
    this.highEnvelope += (target - this.highEnvelope) * (1 - Math.exp(-step / (target > this.highEnvelope ? attack : release)));
    this.highAttack = Math.max(this.highAttack * Math.exp(-step / .07), Math.min(1, Math.max(0, target - this.previousHigh) * 2));
    this.previousHigh = target;
    if (this.highEnvelope < .0001) this.highEnvelope = 0;
    if (this.highAttack < .0001) this.highAttack = 0;
    this.material.uniforms.uHigh.value = this.highEnvelope;
    this.material.uniforms.uHighAttack.value = this.highAttack;
  }
}
