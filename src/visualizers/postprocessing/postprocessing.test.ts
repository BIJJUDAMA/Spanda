import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { PostProcessingManager } from './composer';
import { createEmptyRenderAudio } from '../types';

describe('PostProcessingManager', () => {
  it('initializes and resizes composer passes without crashing in mock or WebGL', () => {
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer();
    } catch {
      renderer = {
        render: vi.fn(),
        setSize: vi.fn(),
        setPixelRatio: vi.fn(),
        dispose: vi.fn(),
        domElement: document.createElement('canvas'),
      } as unknown as THREE.WebGLRenderer;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const post = new PostProcessingManager(renderer, scene, camera);

    expect(post).toBeDefined();
    post.resize(1920, 1080);
    expect(post.bloomPass).toBeDefined();
    expect(post.aberrationPass).toBeDefined();
    if (post.bloomPass) {
      expect(post.bloomPass.threshold).toBeCloseTo(0.88);
      expect(post.bloomPass.radius).toBeCloseTo(0.22);
    }

    const audio = createEmptyRenderAudio();
    audio.kick = 1.0;
    audio.transient = 1.0;
    audio.subBass = 1.0;
    for (let i = 0; i < 20; i++) {
      post.update(0.016, audio);
    }

    if (post.bloomPass) {
      // Bloom strength must never exceed 0.20 even under maximum kick and transient energy to avoid whiteout
      expect(post.bloomPass.strength).toBeLessThanOrEqual(0.20);
      expect(post.bloomPass.strength).toBeGreaterThanOrEqual(0.10);
    }

    post.render();

    const nextScene = new THREE.Scene();
    const nextCamera = new THREE.PerspectiveCamera();
    post.setSceneAndCamera(nextScene, nextCamera);

    post.dispose();
  });

  it('handles mock renderer where EffectComposer succeeds or fails gracefully', () => {
    const mockRenderer = {
      render: vi.fn(),
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      dispose: vi.fn(),
      domElement: document.createElement('canvas'),
      getRenderTarget: vi.fn(),
      setRenderTarget: vi.fn(),
      clear: vi.fn(),
    } as unknown as THREE.WebGLRenderer;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const post = new PostProcessingManager(mockRenderer, scene, camera);

    expect(post).toBeDefined();
    post.resize(800, 600);
    post.update(0.016, createEmptyRenderAudio());
    post.render();
    post.dispose();
  });
});
