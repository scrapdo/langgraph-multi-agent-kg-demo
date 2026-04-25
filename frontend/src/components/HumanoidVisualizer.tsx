import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: VisualizerState;
  /** 0-1 live audio level. Drives aura pulse and dot brightness. */
  level?: number;
  className?: string;
}

// --- Visualizer brief ------------------------------------------------------
//   * Like Perplexity's voice orb: soft-glowing, smoothly pulsing, ethereal
//   * But in a HEAD-AND-SHOULDERS silhouette, not a sphere
//   * Retro phosphor green on pure black
//   * Mysterious: the figure emerges from darkness, never fully illuminated
//
// How it works:
//   1. A luminance mask defines the silhouette (head + neck + shoulders).
//   2. ~520 particles are sampled from the mask, weighted by local density.
//   3. Each frame, every particle drifts slowly along a per-particle flow
//      field (sin-wave velocities). Nothing snaps — everything eases.
//   4. Particles are drawn with additive blending and a radial falloff, so
//      overlaps brighten naturally and the form has a glowing inner core.
//   5. A wide outer aura pulses with amplitude (Perplexity's defining move).
//   6. Speaking intensifies the drift and brightens rim-close dots; blinking
//      isn't a thing here — the whole image is too soft for binary events.

const RGB = { r: 110, g: 255, b: 145 };
const BG = 'rgb(0, 0, 0)';

const PARTICLE_COUNT = 780;

type ParticleZone = 'face' | 'eye-l' | 'eye-r' | 'mouth' | 'jaw';

interface Particle {
  x: number;          // current position, normalized -1..1
  y: number;
  baseX: number;      // spring-target position (anchors the silhouette)
  baseY: number;
  /** 0-1 local mask density at baseX,baseY — dense where the figure is lit,
   *  sparse where it fades into shadow. Drives per-particle brightness. */
  mass: number;
  /** Per-particle drift frequency and phase for the smooth flow field. */
  fxA: number; fyA: number; fxB: number; fyB: number;
  phaseA: number; phaseB: number;
  /** Anatomical zone — drives targeted motion (mouth speech, eye blinks). */
  zone: ParticleZone;
}

// --- Human silhouette mask -------------------------------------------------
// x,y are in [-1,1] space. Returns 0-1 density: 1 inside and lit, 0 outside
// or in deep shadow. Shape is a front-facing bust — head, neck tapering into
// shoulders. Edges feathered so particles near the boundary are dimmer,
// giving the "emerges from darkness" feeling automatically.

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function silhouetteMask(x: number, y: number): number {
  // Face only — no neck or shoulders. Round, slightly tall (rx 0.55, ry 0.62)
  // so it reads as a head while overall outline stays orb-ish like Perplexity's.
  // Center at (0, 0): the face fills the canvas center cleanly.
  const headDx = x / 0.55;
  const headDy = y / 0.62;
  const r = headDx * headDx + headDy * headDy;
  if (r > 1) return 0;
  // Soft feather only at the very edge so dots fade into the void.
  return 1 - smoothstep(0.85, 1.0, r);
}

// Anatomical zone classifier. Eyes / mouth / jaw / face. Drives targeted
// motion in the render loop — eye blinks, mouth speech vibrato, etc. Coords
// are the same -1..1 mask space used everywhere else in this file.
const EYE_Y = -0.12;
const EYE_RX = 0.10;
const EYE_RY = 0.07;
const EYE_LX = -0.18;
const EYE_RX_X = 0.18;
const MOUTH_MID_Y = 0.22;
const MOUTH_HALF = 0.07;
const JAW_TOP_Y = 0.32;
const JAW_BOTTOM_Y = 0.55;

function zoneFor(x: number, y: number): ParticleZone {
  const ldx = (x - EYE_LX) / EYE_RX;
  const ldy = (y - EYE_Y) / EYE_RY;
  if (ldx * ldx + ldy * ldy < 1) return 'eye-l';
  const rdx = (x - EYE_RX_X) / EYE_RX;
  const rdy = (y - EYE_Y) / EYE_RY;
  if (rdx * rdx + rdy * rdy < 1) return 'eye-r';
  if (Math.abs(y - MOUTH_MID_Y) < MOUTH_HALF) return 'mouth';
  if (y > JAW_TOP_Y && y < JAW_BOTTOM_Y) return 'jaw';
  return 'face';
}

// --- Per-figure rim lighting so the head reads as 3-D, not a flat oval ----
// Light from upper-left. Rim-lit figures are the whole mysterious-sci-fi
// look — bright on one side, dissolving into dark on the other.
function rimLight(x: number, y: number): number {
  const lightX = -0.7;
  const lightY = -0.9;
  // Treat silhouette as a rough sphere for normal estimation.
  const r2 = x * x + y * y;
  if (r2 > 1.2) return 0;
  const nz = Math.sqrt(Math.max(0.0001, 1.2 - r2));
  const dot = x * lightX + y * lightY + nz * 0.35;
  return clamp01(dot * 0.8 + 0.18);
}

// --- Particle sampling -----------------------------------------------------
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function generateParticles(): Particle[] {
  const rand = seeded(20260422);
  const out: Particle[] = [];
  // Rejection sampling across [-1,1]×[-1,1] weighted by silhouette mask.
  let attempts = 0;
  while (out.length < PARTICLE_COUNT && attempts < 20000) {
    attempts += 1;
    const x = rand() * 2 - 1;
    const y = rand() * 2 - 1;
    const mask = silhouetteMask(x, y);
    if (mask < 0.02) continue;
    const lit = rimLight(x, y);
    // Keep with probability mask × lit (weighted toward lit-side dense regions).
    const p = mask * (0.3 + 0.7 * lit);
    if (rand() > p) continue;
    out.push({
      x,
      y,
      baseX: x,
      baseY: y,
      mass: p,
      fxA: 0.00035 + rand() * 0.00045,
      fyA: 0.00028 + rand() * 0.00045,
      fxB: 0.00070 + rand() * 0.00060,
      fyB: 0.00090 + rand() * 0.00070,
      phaseA: rand() * Math.PI * 2,
      phaseB: rand() * Math.PI * 2,
      zone: zoneFor(x, y),
    });
  }
  return out;
}

// --- Component -------------------------------------------------------------

export function HumanoidVisualizer({ state, level, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const displayLevelRef = useRef<number>(0);
  const stateRef = useRef<VisualizerState>(state);
  const levelRef = useRef<number | undefined>(level);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  const particles = useMemo(generateParticles, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (t: number) => {
      const { width, height } = canvas.getBoundingClientRect();

      // Fully clear each frame — no trails, clean look like Perplexity's orb.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, width, height);

      const currentState = stateRef.current;
      const liveLevel = levelRef.current;

      // Smooth the audio level — Perplexity's blob reacts continuously, not
      // stepwise. Higher exponent = "snappier" reaction.
      const targetLevel =
        typeof liveLevel === 'number' && Number.isFinite(liveLevel)
          ? Math.max(0, Math.min(1, liveLevel))
          : currentState === 'speaking' ? 0.45 + 0.22 * Math.sin(t / 250)
          : currentState === 'thinking' ? 0.28 + 0.1 * Math.sin(t / 420)
          : currentState === 'listening' ? 0.18 + 0.06 * Math.sin(t / 560)
          : 0.07 + 0.04 * Math.sin(t / 740);
      displayLevelRef.current += (targetLevel - displayLevelRef.current) * 0.15;
      const energy = displayLevelRef.current;

      const cx = width / 2;
      const cy = height / 2;
      const scale = Math.min(width, height) * 0.44;

      // --- Outer aura (the Perplexity signature move) --------------------
      // Three concentric radial gradients that breathe with amplitude. Drawn
      // BEFORE particles so they layer underneath.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const r = scale * (1.4 + i * 0.7 + energy * (0.7 + i * 0.3));
        const grad = ctx.createRadialGradient(cx, cy, scale * 0.2, cx, cy, r);
        const alpha = (0.12 - i * 0.035) * (0.55 + energy * 0.9);
        grad.addColorStop(0, `rgba(${RGB.r}, ${RGB.g}, ${RGB.b}, ${alpha.toFixed(3)})`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // --- Particles -----------------------------------------------------
      // Drift amplitude grows with audio — the figure "pulses" while speaking.
      const driftScale = 0.006 + energy * 0.025;

      // Whole-head bob — a slow, low-amplitude wave that intensifies with
      // speech. Gives the figure a hint of natural sway when talking.
      const headBob = energy * 0.012 * Math.sin(t / 220);
      // Quick syllable-timed micro-nod that fires on speech amplitude — adds
      // cadence to the speaking motion so it doesn't feel like a constant pulse.
      const syllableNod = currentState === 'speaking' ? energy * 0.018 * Math.sin(t / 95) : 0;

      // --- Eye expression: blinks + slow gaze drift. Both run all the time
      // (idle / listening / thinking / speaking) so the figure feels alive
      // even when silent. Blink is a brief alpha dip on eye-zone dots; gaze
      // is a tiny xy translation across both eyes together.
      const blinkCycle = (t % 5200) / 5200;            // every 5.2s
      const blink = blinkCycle < 0.04
        ? 1 - Math.abs(blinkCycle - 0.02) / 0.02       // 0..1..0 over ~210ms
        : 0;
      const gazeX = Math.sin(t / 3700) * 0.006 + Math.sin(t / 5300) * 0.003;
      const gazeY = Math.sin(t / 4200) * 0.003;

      const speaking = currentState === 'speaking';
      const speechActive = speaking || currentState === 'thinking';

      ctx.globalCompositeOperation = 'lighter';
      for (const p of particles) {
        // Smooth flow-field drift.
        const dx = (Math.sin(t * p.fxA + p.phaseA) + 0.5 * Math.sin(t * p.fxB + p.phaseB)) * driftScale;
        const dy = (Math.cos(t * p.fyA + p.phaseA) + 0.5 * Math.sin(t * p.fyB + p.phaseB)) * driftScale;
        p.x = p.baseX + dx;
        p.y = p.baseY + dy;

        // --- Zone-specific motion ---
        let extraX = 0;
        let extraY = 0;
        let alphaMul = 1;

        if (p.zone === 'mouth' && speechActive) {
          // Split-vertical lip opening (upper rises, lower falls).
          const sign = p.baseY < MOUTH_MID_Y ? -1 : 1;
          const depth = 1 - Math.abs(p.baseY - MOUTH_MID_Y) / MOUTH_HALF;
          extraY += sign * energy * 0.045 * depth;
          // Speech vibrato — fast per-particle oscillation with phase variation
          // so dots near the mouth shimmer like a forming-words motion.
          if (speaking) {
            const vibrato = Math.sin(t / 55 + p.phaseA * 3) * energy * 0.014 * depth;
            const wobble = Math.cos(t / 70 + p.phaseB * 2) * energy * 0.010 * depth;
            extraY += vibrato;
            extraX += wobble;
          }
        } else if (p.zone === 'jaw' && speechActive) {
          // Jaw drops with audio (proxy for jaw rotation).
          const mid = (JAW_TOP_Y + JAW_BOTTOM_Y) / 2;
          const halfRange = (JAW_BOTTOM_Y - JAW_TOP_Y) / 2;
          const depth = 1 - Math.abs(p.baseY - mid) / halfRange;
          extraY += Math.max(0, depth) * energy * 0.022;
        } else if (p.zone === 'eye-l' || p.zone === 'eye-r') {
          // Subtle gaze drift — both eyes move together.
          extraX += gazeX;
          extraY += gazeY;
          // Blink: dim eye-zone dots briefly.
          alphaMul *= 1 - blink * 0.85;
        }

        // Head bob applies to upper-face particles (forehead, eyes, nose).
        // Lower face / mouth / jaw have their own motion bands above and
        // shouldn't get the bob layered on top — that would feel like the
        // mouth fights the jaw.
        if (p.baseY < 0.10) {
          extraY += headBob + syllableNod;
        }

        // Canvas y+ = down. Silhouette uses the same convention, so no flip.
        const px = cx + (p.x + extraX) * scale;
        const py = cy + (p.y + extraY) * scale;

        // Brightness: mass (mask × rim light) × per-particle slow pulse × energy.
        const pulse = 0.7 + 0.3 * Math.sin(t / 900 + p.phaseA);
        const brightness = p.mass * pulse * (0.65 + energy * 0.5) * alphaMul;

        // Crisp small dots — solid fill, no per-dot glow gradient. The orb
        // glow comes from the outer aura layered behind, not from each dot
        // bleeding into its neighbours. Keeps the face shape readable.
        const r = Math.max(0.9, scale * 0.0055);
        ctx.fillStyle = `rgba(${RGB.r}, ${RGB.g}, ${RGB.b}, ${Math.min(1, brightness).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [particles]);

  return (
    <div
      className={cn('relative w-full h-full overflow-hidden bg-black', className)}
      data-visualizer-state={state}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden />
    </div>
  );
}
