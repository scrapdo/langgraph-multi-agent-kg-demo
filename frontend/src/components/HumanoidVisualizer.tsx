import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: VisualizerState;
  /** 0-1 live audio level. Drives mouth pulse + scanline intensity. */
  level?: number;
  className?: string;
}

// --- Style: sci-fi, mysterious --------------------------------------------
//   Particle · Dots       — small green points, no fills/gradients/blurs
//   Form · Portrait       — chiaroscuro face emerging from shadow
//   Palette · retro green — phosphor CRT, 2 brightness tiers
//   Motion · Crisp        — snap-to-pixel breath, binary on/off twinkle
//   Stage · black void    — pure black, dots only
//
// Approach: stippled portrait. A 2D luminance field defines a face lit from
// upper-left; dots are sampled from it by probability — density IS the face.
// No eye circles, no mouth lines drawn. The face appears through the pattern
// of dots alone, half-hidden in shadow. Animation touches a small fraction
// of dots (mouth band, rim pulse, scan sweep) so the portrait stays stable.

const GREEN_BRIGHT = 'rgba(140, 255, 150, 1)';
const GREEN_MID = 'rgba(70, 200, 95, 1)';
const GREEN_DIM = 'rgba(35, 130, 55, 1)';

// Number of sample candidates. Higher = denser portrait, more CPU per frame.
const SAMPLE_COUNT = 2400;

interface Dot {
  /** Normalized coords, -1..1, (0,0) = face center. */
  x: number;
  y: number;
  /** Precomputed luminance at this point — determines brightness + animation response. */
  L: number;
  /** Face region tag — used to apply targeted animation (eyes, mouth, rim). */
  zone: 'face' | 'eye-l' | 'eye-r' | 'mouth-band' | 'rim-shadow';
  /** Per-dot phase for stepped twinkle. */
  phase: number;
}

// --- Luminance field: a rim-lit face, light from upper-left ---------------

function gauss(dx: number, dy: number, sx: number, sy: number): number {
  return Math.exp(-((dx * dx) / (2 * sx * sx) + (dy * dy) / (2 * sy * sy)));
}

function faceMask(x: number, y: number): number {
  // Vertical elongation, slight taper toward the chin.
  const rx = 0.82;
  const ry = 1.05;
  const r = (x * x) / (rx * rx) + (y * y) / (ry * ry);
  if (r > 1.0) return 0;
  // Soft edge — feather ~15% inside.
  return Math.min(1, (1 - r) * 6);
}

function luminance(x: number, y: number): number {
  // Directional light from upper-left. Brightness peaks around
  // (x=-0.2, y=-0.4), dark on the lower-right (shadow side).
  const gradient = Math.max(0, -0.55 * x - 0.45 * y + 0.45);

  // Spherical hint — brighter near face center, dimmer at edges.
  const sphereR = Math.max(0, 1 - (x * x) / 0.82 / 0.82 - (y * y) / 1.05 / 1.05);
  const sphere = Math.sqrt(sphereR);

  // Start with the combination.
  let L = gradient * 0.6 + sphere * 0.25;

  // Forehead highlight (upper-left of forehead).
  L += 0.22 * gauss(x + 0.15, y + 0.65, 0.28, 0.22);

  // Nose bridge — vertical highlight, from brow to nose tip.
  // Narrow in x, tall in y.
  L += 0.28 * gauss(x - 0.02, y + 0.05, 0.05, 0.28);

  // Lit cheekbone.
  L += 0.18 * gauss(x + 0.42, y - 0.02, 0.18, 0.22);

  // Chin highlight — soft.
  L += 0.12 * gauss(x - 0.08, y - 0.55, 0.22, 0.18);

  // Thin rim light on the SHADOW side (right edge) — narrow bright line
  // that gives the mysterious side-lit photo feel.
  L += 0.35 * gauss(x - 0.75, y, 0.05, 0.55);

  // --- Shadows (subtract) ----------------------------------------------
  // Eye sockets — deeper on the shadow side.
  L -= 0.55 * gauss(x + 0.28, y + 0.22, 0.11, 0.07);
  L -= 0.45 * gauss(x - 0.28, y + 0.22, 0.11, 0.07);

  // Under nose.
  L -= 0.18 * gauss(x, y - 0.15, 0.07, 0.05);

  // Mouth shadow — slightly asymmetric so the lit side reads as a lip edge.
  L -= 0.25 * gauss(x + 0.02, y - 0.4, 0.16, 0.06);

  // Under lower lip / chin crease.
  L -= 0.15 * gauss(x, y - 0.55, 0.18, 0.05);

  // Global darkening on the right half — broadens the shadow area.
  L *= 1 - 0.35 * Math.max(0, Math.min(1, (x + 0.05) * 0.9));

  // Clamp and mask to face silhouette.
  L = Math.max(0, Math.min(1, L));
  return L * faceMask(x, y);
}

// Deterministic RNG so the portrait is identical across re-mounts.
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function zoneFor(x: number, y: number): Dot['zone'] {
  if (x > 0.45) return 'rim-shadow';
  if (x > -0.42 && x < -0.12 && y > 0.15 && y < 0.32) return 'eye-l';
  if (x > 0.12 && x < 0.42 && y > 0.15 && y < 0.32) return 'eye-r';
  if (Math.abs(x) < 0.22 && y < -0.33 && y > -0.48) return 'mouth-band';
  return 'face';
}

function generatePortrait(): Dot[] {
  const rand = seeded(1337);
  const dots: Dot[] = [];
  // Jittered grid — each candidate cell places at most one dot, with
  // probability based on luminance. Gamma boost makes the face clearer.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const x = (rand() * 2 - 1) * 0.98;
    const y = (rand() * 2 - 1) * 1.15;
    const L = luminance(x, y);
    // Probability of keeping this dot — shaped so shadows are almost-never
    // populated and highlights are almost-always.
    const p = Math.pow(L, 1.15);
    if (rand() > p) continue;
    // Invert y so the face is drawn right-side-up on canvas (canvas y+ = down).
    dots.push({
      x,
      y: -y,
      L,
      zone: zoneFor(x, -y),
      phase: rand() * Math.PI * 2,
    });
  }
  return dots;
}

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

  const dots = useMemo(generatePortrait, []);

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
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillRect(0, 0, width, height);

      const currentState = stateRef.current;
      const liveLevel = levelRef.current;
      const targetLevel =
        typeof liveLevel === 'number' && Number.isFinite(liveLevel)
          ? Math.max(0, Math.min(1, liveLevel))
          : 0;
      displayLevelRef.current += (targetLevel - displayLevelRef.current) * 0.25;
      const energy = displayLevelRef.current;

      // Quantize amplitude to 5 levels for crisp stepped mouth motion.
      const mouthStep = Math.round(energy * 5) / 5;

      const cx = width / 2;
      const cy = height / 2;
      const scale = Math.min(width, height) * 0.42;

      // Snap-to-pixel breath.
      const breath = Math.round(Math.sin(t / 2400) * 2);

      // Scanline — a thin horizontal band that sweeps top→bottom. Dots the
      // band crosses get brightened; others stay at their base tier.
      // Speaking: fast sweep. Thinking: slow methodical. Others: idle.
      const scanSpeed =
        currentState === 'speaking' ? 1600 : currentState === 'thinking' ? 2600 : currentState === 'listening' ? 4800 : 7200;
      const scanY = ((t / scanSpeed) % 1) * 2.4 - 1.2; // normalized -1.2..1.2
      const scanBand = 0.06;

      // Blink — eye sockets go fully dark briefly.
      const blinkPhase = (t % 5400) / 5400;
      const blinkActive = blinkPhase > 0.96;

      const dotR = Math.max(1, Math.round(scale * 0.016));

      for (const dot of dots) {
        // --- per-zone transforms ----------------------------------------
        let skip = false;
        let px = cx + dot.x * scale;
        let py = cy + dot.y * scale + breath;

        if (dot.zone === 'eye-l' || dot.zone === 'eye-r') {
          // Blink: drop these dots entirely during the blink window.
          if (blinkActive) skip = true;
        } else if (dot.zone === 'mouth-band' && currentState === 'speaking') {
          // Mouth opens: lower mouth-band dots are pushed down in stepped
          // increments; upper ones nudge up slightly. Reads as a parting
          // mouth, not a cartoon smile.
          const yRel = dot.y; // canvas y-positive = down
          const sign = yRel > -0.4 ? 1 : -1;
          py += sign * mouthStep * scale * 0.11;
        }

        if (skip) continue;

        // --- brightness tier (crisp stepped flicker) --------------------
        let color: string;
        if (dot.L > 0.6) {
          color = GREEN_BRIGHT;
        } else if (dot.L > 0.35) {
          // Twinkle: once in a while a mid dot dims to DIM or pops to BRIGHT.
          const tw = Math.sin(dot.phase + t / 420);
          color = tw > 0.85 ? GREEN_BRIGHT : tw < -0.7 ? GREEN_DIM : GREEN_MID;
        } else {
          color = GREEN_DIM;
        }

        // Scanline sweep — dots within scanBand of scanY upgrade one tier.
        // Gives the sci-fi CRT feel without drawing actual lines.
        const dyNorm = -dot.y; // revert the earlier invert to match sweep axis
        if (Math.abs(dyNorm - scanY) < scanBand) {
          color = color === GREEN_DIM ? GREEN_MID : GREEN_BRIGHT;
        }

        // Rim-shadow dots get a small amplitude pulse when speaking —
        // outward shift gives the feel of light flaring on the edge.
        if (dot.zone === 'rim-shadow') {
          const outX = Math.sign(dot.x);
          px += outX * Math.round(energy * 5 / 2) * 2;
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [dots]);

  return (
    <div
      className={cn('relative w-full h-full overflow-hidden bg-black', className)}
      data-visualizer-state={state}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden />
    </div>
  );
}
