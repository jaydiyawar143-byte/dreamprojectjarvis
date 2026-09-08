"use client";

// ---------------------------------------------------------------------------
// UI V2 — the JARVIS Orb: a layered, audio-reactive particle core.
//
// Raw three.js rather than react-three-fiber, for two reasons that matter here:
// disposal is explicit (an orb that leaks a WebGL context on every route change
// would degrade the whole app), and the render loop stays out of React's
// reconciler, so an audio-rate animation never triggers a re-render.
//
// FOUR LAYERS, because depth comes from parallax rather than from any single
// clever effect. Each is its own point cloud with its own radius, density,
// brightness and rotation rate:
//
//   core      small, dense, hot        - the energy source; bass swells it
//   shell     the main body            - mid frequencies push it outward
//   halo      sparse, wide, dim        - atmosphere, drifts slowly
//   orbital   a flattened, tilted ring - visible orbital motion, counter-spun
//
// Rotating them at DIFFERENT rates about DIFFERENT axes is what makes the thing
// read as a volume you could walk around instead of a spinning texture. A
// single cloud, however dense, always reads flat.
//
// AUDIO. Uniforms are driven from real analysis (lib/voice/audio-analyser).
// Bands are mapped to different behaviours on purpose - bass swells the core,
// mid pushes the shell out, treble adds high-frequency jitter - so speech looks
// like speech rather than like a volume meter.
//
// PERFORMANCE. The particle budget is chosen from what the device reports, the
// pixel ratio is capped, and the loop stops entirely when the tab is hidden or
// the canvas scrolls out of view. Every uniform eases toward its target, so a
// state change costs nothing extra.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ORB_APPEARANCE, type OrbState } from "./orb-state";
import type { AudioLevels } from "@/lib/voice/audio-analyser";

/** Above this the cost is real and the visible gain is not. */
const MAX_PIXEL_RATIO = 1.75;

/**
 * What fraction of the full particle budget this machine should draw.
 *
 * DRAWING POINTS IS A GPU JOB, so the signals are chosen accordingly. An
 * earlier version stepped down whenever `hardwareConcurrency <= 4`, which was
 * simply the wrong question: this workload is fill-rate bound, not CPU bound,
 * and a 4-core machine with 16GB and a discrete GPU was being given 45% of the
 * particles for no reason. The orb looked like thin dust on perfectly capable
 * hardware.
 *
 * What actually predicts trouble is a small screen (a phone: weakest GPU and
 * smallest canvas, where density buys nothing anyway) and genuinely low memory.
 * Core count is used only as a last-resort signal for a very weak device.
 *
 * Every signal here is optional and often absent, so the default is the FULL
 * budget: the real safety nets are the pixel-ratio cap and the visibility
 * pause, both of which apply unconditionally.
 *
 * Exported so the budget policy is testable without a GPU.
 */
export function particleBudget(
  nav: { deviceMemory?: number; hardwareConcurrency?: number } | undefined,
  viewportWidth: number
): number {
  // A phone: small canvas, weakest GPU, and density that nobody could resolve.
  if (viewportWidth > 0 && viewportWidth < 720) return 0.45;
  if (!nav) return 0.8;

  const memory = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;

  // Genuinely low-end: 2GB of reported memory, or a dual-core.
  if ((memory !== undefined && memory <= 2) || (cores !== undefined && cores <= 2)) return 0.45;
  // Modest: 4GB.
  if (memory !== undefined && memory <= 4) return 0.7;

  return 1;
}

interface LayerSpec {
  name: string;
  /** Particle count at full budget. */
  count: number;
  radius: number;
  /** 0 = a thin shell, 1 = filled solid through the centre. */
  jitter: number;
  sizeScale: number;
  /** Multiplies the state's base intensity for this layer. */
  intensityMul: number;
  /** Multiplies the state's spin. Negative counter-rotates. */
  spinMul: number;
  /** Squashes the layer on Y, turning a sphere into an orbital disc. */
  flatten?: number;
  /** Fixed tilt so an orbital band reads as a ring rather than a sphere. */
  tilt?: [number, number, number];
}

export const LAYERS: LayerSpec[] = [
  // Dense and hot. Small radius so it reads as a source, not a second shell.
  { name: "core", count: 2200, radius: 0.72, jitter: 0.92, sizeScale: 1.25, intensityMul: 2.1, spinMul: -1.7 },
  // The body of the orb. High jitter fills the volume: a THIN shell piles up
  // particles along a view ray at the limb, which additive blending turns into
  // a bright ring with a hole in the middle.
  { name: "shell", count: 6400, radius: 1.62, jitter: 0.58, sizeScale: 1, intensityMul: 1.25, spinMul: 1 },
  // Sparse, wide, dim - the atmosphere the core sits inside.
  { name: "halo", count: 2400, radius: 2.25, jitter: 0.34, sizeScale: 0.72, intensityMul: 0.5, spinMul: 0.45 },
  // A flattened, tilted band. This is the layer that actually reads as ORBIT.
  {
    name: "orbital",
    count: 1100,
    radius: 1.98,
    jitter: 0.1,
    sizeScale: 0.9,
    intensityMul: 0.95,
    spinMul: 2.4,
    flatten: 0.09,
    tilt: [0.42, 0, 0.28],
  },
];

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uTurbulence;
  uniform float uScale;
  uniform float uPulse;
  uniform float uSize;

  attribute float aRandom;
  attribute float aSize;

  varying float vDepth;
  varying float vEnergy;

  // Cheap 3D value noise. Good enough for organic displacement and far cheaper
  // than simplex at this particle count.
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
              dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
          mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
              dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
      mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
              dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
          mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
              dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
      u.z);
  }

  void main() {
    vec3 dir = normalize(position);

    // Slow drift so the field is never static, even in silence.
    float n = noise(position * 1.4 + uTime * 0.16);
    float fine = noise(position * 4.2 - uTime * 0.42);

    // Breathing when quiet; audio takes over when there is any.
    float breathe = sin(uTime * 1.1 + aRandom * 6.28318) * uPulse;

    // Bands do different jobs so speech is legible as speech.
    float swell = uBass * 0.30 + uLevel * 0.16;
    float push = uMid * uTurbulence * 0.44;
    float jitter = uTreble * 0.12 * fine;

    float displacement = n * uTurbulence * 0.34 + breathe + swell + push + jitter;

    vec3 displaced = position + dir * displacement;
    displaced *= uScale;

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mv;

    // Perspective sizing: nearer points are larger, which is most of what makes
    // the cloud read as a volume instead of a flat disc.
    //
    // The constant is calibrated, not arbitrary: at the default camera distance
    // it puts a typical particle at roughly two device pixels and the rare
    // large motes at six. An earlier value of 300 produced ~20px points, which
    // fused into a single plasma blob instead of a particle field.
    float perspective = 46.0 / max(0.001, -mv.z);
    gl_PointSize = aSize * uSize * perspective * (0.75 + uLevel * 0.55);

    vDepth = clamp((-mv.z - 1.8) / 6.0, 0.0, 1.0);
    vEnergy = clamp(displacement * 1.6 + uLevel * 0.5, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;

  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uIntensity;

  varying float vDepth;
  varying float vEnergy;

  void main() {
    // Round, soft-edged point. Discarding outside the disc keeps the square
    // sprite from ever showing.
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    // Two-stop falloff: a tight bright centre inside a wide soft halo, which is
    // what gives the field its glow without a post-processing pass.
    float core = smoothstep(0.5, 0.0, d);
    float halo = smoothstep(0.5, 0.12, d);
    // Lower than it looks like it should be: with additive blending and many
    // thousands of overlapping points, per-particle alpha compounds quickly and
    // a higher value blows the centre out to flat white.
    float alpha = core * 0.50 + halo * 0.30;

    // Hotter particles shift toward the accent, so energy reads as colour and
    // not only as brightness.
    vec3 color = mix(uColor, uAccent, vEnergy);

    // Depth fade gives the far side of the sphere its recession.
    float depthFade = mix(0.32, 1.0, 1.0 - vDepth);

    gl_FragColor = vec4(color * uIntensity * depthFade, alpha * depthFade * uIntensity);
  }
`;

export interface WebGLOrbProps {
  state: OrbState;
  /** Live audio, or silence. Read every frame; never stored in React state. */
  levelsRef: React.MutableRefObject<AudioLevels>;
  className?: string;
  /** Damps motion for users who ask for reduced motion. */
  reducedMotion?: boolean;
}

/**
 * Seeds a layer with a genuinely uniform 3D distribution.
 *
 * `flatten` squashes Y, which turns the same sphere sampler into an orbital
 * disc without needing a second code path.
 */
function seedLayer(count: number, radius: number, jitter: number, flatten = 1): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Inverse-CDF sampling. Naively using two uniform angles clumps points at
    // the poles, which shows up immediately as two bright spots.
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (1 - Math.random() * jitter);

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * flatten;
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  return positions;
}

export function WebGLOrb({ state, levelsRef, className, reducedMotion = false }: WebGLOrbProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The render loop reads state through a ref so a state change never restarts
  // the scene - the uniforms simply ease to a new target.
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false, // Additive points gain nothing from MSAA.
        powerPreference: "high-performance",
      });
    } catch {
      // No WebGL. The parent renders the 2D fallback instead; nothing to clean.
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5.6);

    // Shared by every layer. One object, so a single per-frame update drives
    // all of them; only uIntensity is per-layer.
    const uniforms = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uTurbulence: { value: ORB_APPEARANCE.idle.turbulence },
      uScale: { value: ORB_APPEARANCE.idle.scale },
      uPulse: { value: ORB_APPEARANCE.idle.pulse },
      uSize: { value: 1 },
      uColor: { value: new THREE.Color().setHSL(ORB_APPEARANCE.idle.hue / 360, 0.85, 0.6) },
      uAccent: { value: new THREE.Color().setHSL(ORB_APPEARANCE.idle.hue / 360, 0.9, 0.86) },
    };

    const budget = particleBudget(
      typeof navigator === "undefined" ? undefined : navigator,
      typeof window === "undefined" ? 0 : window.innerWidth
    );

    interface BuiltLayer {
      spec: LayerSpec;
      group: THREE.Group;
      points: THREE.Points;
      geometry: THREE.BufferGeometry;
      material: THREE.ShaderMaterial;
    }

    const layers: BuiltLayer[] = LAYERS.map((spec) => {
      const count = Math.max(120, Math.round(spec.count * budget));

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(seedLayer(count, spec.radius, spec.jitter, spec.flatten ?? 1), 3)
      );

      const randoms = new Float32Array(count);
      const sizes = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        randoms[i] = Math.random();
        // A few much larger points read as bright motes among the dust.
        sizes[i] = (0.4 + Math.random() * 0.85 + (Math.random() > 0.985 ? 1.6 : 0)) * spec.sizeScale;
      }
      geometry.setAttribute("aRandom", new THREE.BufferAttribute(randoms, 1));
      geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

      // Uniform OBJECTS are shared by reference except uIntensity, which is the
      // point: the core runs hot and the halo runs cool, so the orb has a
      // luminous centre instead of being uniformly dense dust.
      const material = new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uIntensity: { value: ORB_APPEARANCE.idle.intensity } },
        vertexShader,
        fragmentShader,
        transparent: true,
        // Additive is what makes overlapping particles build into a glow. Depth
        // writes must be off or near points would punch holes in far ones.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      // Each layer gets its own group so it can carry an independent rotation -
      // this is where the parallax comes from.
      const group = new THREE.Group();
      if (spec.tilt) group.rotation.set(spec.tilt[0], spec.tilt[1], spec.tilt[2]);

      const points = new THREE.Points(geometry, material);
      group.add(points);
      scene.add(group);

      return { spec, group, points, geometry, material };
    });

    // ---- sizing -----------------------------------------------------------
    const resize = () => {
      const { clientWidth, clientHeight } = host;
      if (clientWidth === 0 || clientHeight === 0) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      // Keep the orb the same visual size on a narrow screen, where a fixed
      // FOV would otherwise crop it.
      uniforms.uSize.value = Math.min(1.35, Math.max(0.62, clientWidth / 620));
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // ---- visibility -------------------------------------------------------
    // A GPU loop for an orb nobody can see is pure waste, and on a laptop it is
    // measurable battery. Both conditions are cheap to observe.
    let onScreen = true;
    const intersection = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.01 }
    );
    intersection.observe(host);

    const isHidden = () => document.visibilityState === "hidden";

    // ---- loop -------------------------------------------------------------
    const clock = new THREE.Clock();
    let frame = 0;

    // Eased values, so switching state is a transition rather than a jump.
    const current = { ...ORB_APPEARANCE.idle };
    let hue = ORB_APPEARANCE.idle.hue;
    const smoothed: AudioLevels = { level: 0, bass: 0, mid: 0, treble: 0 };

    const tick = () => {
      frame = requestAnimationFrame(tick);

      const delta = Math.min(clock.getDelta(), 0.05);
      if (!onScreen || isHidden()) return;

      const target = ORB_APPEARANCE[stateRef.current];
      const damp = reducedRef.current ? 0.35 : 1;

      // Exponential easing, frame-rate independent.
      const ease = (from: number, to: number, rate: number) =>
        from + (to - from) * (1 - Math.exp(-rate * delta));

      current.intensity = ease(current.intensity, target.intensity, 4);
      current.turbulence = ease(current.turbulence, target.turbulence * damp, 3.4);
      current.scale = ease(current.scale, target.scale, 4);
      current.pulse = ease(current.pulse, target.pulse * damp, 3.4);
      current.spin = ease(current.spin, target.spin * damp, 2.6);

      // Hue takes the short way round the wheel, or cyan to violet would sweep
      // through the entire spectrum on the way.
      let dh = target.hue - hue;
      if (dh > 180) dh -= 360;
      if (dh < -180) dh += 360;
      hue = (hue + dh * (1 - Math.exp(-3.2 * delta)) + 360) % 360;

      // Audio: fast attack so a syllable lands, slower release so it does not
      // strobe between words.
      const live = levelsRef.current;
      const gain = target.audioResponse;
      const blend = (from: number, to: number) =>
        ease(from, to * gain, to * gain > from ? 22 : 7);

      smoothed.level = blend(smoothed.level, live.level);
      smoothed.bass = blend(smoothed.bass, live.bass);
      smoothed.mid = blend(smoothed.mid, live.mid);
      smoothed.treble = blend(smoothed.treble, live.treble);

      uniforms.uTime.value += delta * (reducedRef.current ? 0.4 : 1);
      uniforms.uLevel.value = smoothed.level;
      uniforms.uBass.value = smoothed.bass;
      uniforms.uMid.value = smoothed.mid;
      uniforms.uTreble.value = smoothed.treble;
      uniforms.uTurbulence.value = current.turbulence;
      uniforms.uScale.value = current.scale;
      uniforms.uPulse.value = current.pulse;

      (uniforms.uColor.value as THREE.Color).setHSL(hue / 360, 0.85, 0.6);
      (uniforms.uAccent.value as THREE.Color).setHSL(((hue + 26) % 360) / 360, 0.9, 0.86);

      // Loud audio brightens the whole field, which is most of why speech reads
      // as "alive" rather than "spinning".
      const lit = current.intensity + smoothed.level * 0.45;
      const tilt = Math.sin(uniforms.uTime.value * 0.22) * 0.16;

      for (const layer of layers) {
        // Bass drives the core hardest, so a voice swells the centre rather
        // than only widening the shell.
        const bassBoost = layer.spec.name === "core" ? smoothed.bass * 0.5 : 0;
        layer.material.uniforms.uIntensity!.value = lit * layer.spec.intensityMul + bassBoost;

        // Different rates about slightly different axes: this is the parallax.
        layer.group.rotation.y += current.spin * layer.spec.spinMul * delta;
        if (!layer.spec.tilt) {
          layer.group.rotation.x = tilt * (layer.spec.name === "halo" ? 0.5 : 1);
        } else {
          // The orbital band keeps its fixed tilt and precesses slowly, which
          // reads as a ring going round rather than a disc wobbling.
          layer.group.rotation.z = layer.spec.tilt[2] + Math.sin(uniforms.uTime.value * 0.16) * 0.1;
        }
      }

      renderer.render(scene, camera);
    };
    tick();

    // ---- teardown ---------------------------------------------------------
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();

      for (const layer of layers) {
        layer.group.remove(layer.points);
        scene.remove(layer.group);
        layer.geometry.dispose();
        layer.material.dispose();
      }

      renderer.dispose();
      // Browsers cap live WebGL contexts (commonly 16). Without this, enough
      // route changes silently stop the orb rendering at all.
      renderer.forceContextLoss();

      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [levelsRef]);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
