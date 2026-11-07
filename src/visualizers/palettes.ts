import * as THREE from 'three';
import type { Palette } from './types';

export const PALETTES: Record<Palette, { a: THREE.Color; b: THREE.Color; c: THREE.Color }> = {
  aurora: {
    a: new THREE.Color(0.1, 0.9, 0.4),
    b: new THREE.Color(0.1, 0.7, 0.9),
    c: new THREE.Color(0.7, 0.2, 0.9),
  },
  ember: {
    a: new THREE.Color(0.9, 0.2, 0.1),
    b: new THREE.Color(1.0, 0.5, 0.0),
    c: new THREE.Color(1.0, 0.85, 0.2),
  },
  cosmic: {
    a: new THREE.Color(0.1, 0.3, 0.9),
    b: new THREE.Color(0.6, 0.1, 0.8),
    c: new THREE.Color(0.95, 0.2, 0.7),
  },
  cyberpunk: {
    a: new THREE.Color(1.0, 0.08, 0.58),
    b: new THREE.Color(0.0, 0.95, 1.0),
    c: new THREE.Color(1.0, 0.92, 0.0),
  },
  synthwave: {
    a: new THREE.Color(0.48, 0.12, 0.88),
    b: new THREE.Color(1.0, 0.35, 0.55),
    c: new THREE.Color(0.1, 0.9, 0.8),
  },
  matrix: {
    a: new THREE.Color(0.0, 1.0, 0.25),
    b: new THREE.Color(0.1, 0.8, 0.4),
    c: new THREE.Color(0.65, 1.0, 0.2),
  },
  monochrome: {
    a: new THREE.Color(0.7, 0.75, 0.82),
    b: new THREE.Color(0.4, 0.45, 0.55),
    c: new THREE.Color(0.95, 0.98, 1.0),
  },
};
