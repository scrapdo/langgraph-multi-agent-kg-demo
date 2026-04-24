import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: VisualizerState;
  /** 0-1 live audio level. Drives mouth opening + outer-ring pulse. */
  level?: number;
  className?: string;
}

// --- Style system: Particle=Dots, Form=Portrait, Palette=retro green, ---
// --- Motion=Crisp, Stage=black void ---------------------------------
//
// Renders a front-facing portrait composed entirely of small phosphor-green
// dots on a pure black canvas. No fills, no gradients, no blur. Motion is
// crisp — dots jump between stepped positions instead of easing, and fade
// through four discrete brightness levels (100/66/33/0%) instead of a
// smooth alpha.
//
// The dot cloud is deterministic (generated once from fixed seeds) so the
// portrait reads consistently across re-renders, but per-dot phases ensure
// the whole thing never animates in lock-step.

// Phosphor CRT green — full + dim levels. Two shades = enough visual depth
// without breaking the "retro terminal" feel.
const GREEN_BRIGHT = 'rgba(118, 255, 135, 1.00)';
const GREEN_MID = 'rgba(118, 255, 135, 0.66)';
const GREEN_DIM = 'rgba(118, 255, 135, 0.33)';
const STATE_ACCENT: Record<VisualizerState, number> = {
  idle: 0.55, // dots slightly dimmer by default
  listening: 0.85,
  thinking: 0.75,
  speaking: 1.0, // brightest + mouth opens
};

type DotZone = 'outline' | 'face' | 'eye' | 'eye-pupil' | 'nose' | 'mouth' | 'mouth-lower';

interface Dot {
  /** Position relative to portrait center, normalized (-1..1-ish). */
  x: number;
  y: number;
  zone: DotZone;
  phase: number;
}

// Deterministic seeded random so the portrait layout is stable across mounts.
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/**
 * Build a front-facing portrait as a point cloud.
 *
 *   - head outline (ellipse of dots)
 *   - face fill (sparse hexagonal grid inside the ellipse)
 *   - two eye clusters with a pupil spot marked separately (so we can blink)
 *   - a short vertical nose column
 *   - a mouth row (upper lip) and a mirror row (lower lip) — lower lip
 *     slides down with speech amplitude, producing a crisp mouth-open.
 */
function generatePortrait(): Dot[] {
  const dots: Dot[] = [];
  const rand = seeded(42);

  // --- Head outline (ellipse, 64 dots) ---------------------------------
  const outlineN = 64;
  const rx = 0.88;
  const ry = 1.0;
  for (let i = 0; i < outlineN; i++) {
    const a = (i / outlineN) * 2 * Math.PI - Math.PI / 2;
    dots.push({
      x: Math.cos(a) * rx,
      y: Math.sin(a) * ry,
      zone: 'outline',
      phase: rand() * Math.PI * 2,
    });
  }

  // --- Face fill: hexagonal grid filtered to ellipse interior ------------
  const step = 0.115;
  let row = 0;
  for (let y = -0.85; y <= 0.95; y += step * 0.9) {
    const offset = row++ % 2 === 0 ? 0 : step / 2;
    for (let x = -0.8 + offset; x <= 0.8; x += step) {
      const nx = x / rx;
      const ny = y / ry;
      const r = nx * nx + ny * ny;
      // Inside the ellipse, but leave breathing room from the outline
      // and carve out the interior regions the features will fill in.
      if (r > 0.96 || r < 0.08) continue;
      // Carve out eye regions so feature dots don't overlap the grid.
      const inLeftEye = x < -0.15 && x > -0.45 && y < -0.10 && y > -0.38;
      const inRightEye = x > 0.15 && x < 0.45 && y < -0.10 && y > -0.38;
      // Carve out mouth region.
      const inMouth = Math.abs(x) < 0.32 && y > 0.33 && y < 0.55;
      if (inLeftEye || inRightEye || inMouth) continue;
      dots.push({ x, y, zone: 'face', phase: rand() * Math.PI * 2 });
    }
  }

  // --- Eyes: two small clusters + explicit pupil dot --------------------
  for (const ex of [-0.3, 0.3]) {
    const eyeY = -0.22;
    const eyeW = 0.14;
    const eyeH = 0.07;
    // Eye shape ring — 10 dots around an ellipse
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 2 * Math.PI;
      dots.push({
        x: ex + Math.cos(a) * eyeW,
        y: eyeY + Math.sin(a) * eyeH,
        zone: 'eye',
        phase: rand() * Math.PI * 2,
      });
    }
    // Pupil — a single bright dot at the eye center (can blink off)
    dots.push({ x: ex, y: eyeY, zone: 'eye-pupil', phase: 0 });
  }

  // --- Nose: vertical column of 4 dots ---------------------------------
  for (let i = 0; i < 4; i++) {
    dots.push({
      x: 0,
      y: -0.02 + i * 0.08,
      zone: 'nose',
      phase: 0,
    });
  }

  // --- Mouth: upper row + lower row ------------------------------------
  // 9 dots in each row. When speaking, the lower row drops with amplitude,
  // producing a crisp open-mouth shape.
  const mouthDots = 9;
  for (let i = 0; i < mouthDots; i++) {
    const t = (i / (mouthDots - 1)) * 2 - 1; // -1..1
    const x = t * 0.28;
    // Slight arc so the mouth has a smile/neutral curve at rest.
    const y = 0.40 + Math.abs(t) * 0.02;
    dots.push({ x, y, zone: 'mouth', phase: rand() * Math.PI * 2 });
    // Mirror row — baseline just 0.03 below the upper row; speech
    // amplitude pushes it further in the render loop.
    dots.push({ x, y: y + 0.03, zone: 'mouth-lower', phase: rand() * Math.PI * 2 });
  }

  return dots;
}

/**
 * Ethereal voice-UI visualizer in retro-terminal green.
 * Uses Canvas 2D at 60fps; all dots are precomputed, the loop just draws them.
 */
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

  // Generate the portrait once per component instance.
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
      // Hard clear to pure black — no trail. Crisp motion requires no
      // residual pixels.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillRect(0, 0, width, height);

      const currentState = stateRef.current;
      const liveLevel = levelRef.current;

      // Smooth target-level for the outer ring pulse / mouth scale.
      // Crisp motion doesn't mean NO smoothing of the input signal — a
      // jittery mic would just look like static. We smooth the signal,
      // then QUANTIZE it into stepped positions where appropriate.
      const targetLevel =
        typeof liveLevel === 'number' && Number.isFinite(liveLevel)
          ? Math.max(0, Math.min(1, liveLevel))
          : 0;
      displayLevelRef.current += (targetLevel - displayLevelRef.current) * 0.25;
      const energy = displayLevelRef.current;

      // Quantize amplitude into discrete steps (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
      // so the mouth opens in stepped increments rather than smoothly.
      const mouthStep = Math.round(energy * 5) / 5;

      const cx = width / 2;
      const cy = height / 2;
      // Portrait scale: occupy ~80% of the min dimension.
      const scale = Math.min(width, height) * 0.40;

      // Breathing bias — the whole portrait sways up/down by a couple of
      // pixels, quantized to integer pixel positions so the motion reads
      // crisp (no sub-pixel easing).
      const breathSign = Math.sin(t / 2200);
      const breath = Math.round(breathSign * 2); // -2..+2 px

      // Blink schedule — a short window once every ~5s where eyes go dim.
      const blinkPeriod = 5200;
      const blinkPhase = (t % blinkPeriod) / blinkPeriod;
      const blinkActive = blinkPhase > 0.95;

      // Outline ring pulse — dots shift outward slightly with amplitude.
      // Quantized to ±0, ±2, ±4 px.
      const ringShift = Math.round(energy * 8 / 2) * 2; // stepped outward

      // Dot radius depends on canvas size. One pixel shy of the grid step so
      // dots don't blur into one another at common scales.
      const dotRadius = Math.max(1, Math.round(scale * 0.022));

      // Per-state brightness tint on the whole portrait. We don't fade
      // individual dots per frame — each dot lands in one of three buckets
      // (bright / mid / dim / off) picked deterministically so the motion
      // reads as crisp binary flicker rather than alpha drift.
      const accent = STATE_ACCENT[currentState] ?? 0.55;

      ctx.fillStyle = GREEN_BRIGHT; // overridden per dot below

      for (const dot of dots) {
        let px = cx + dot.x * scale;
        let py = cy + dot.y * scale + breath;

        // Per-zone crisp motion offsets
        if (dot.zone === 'outline') {
          // Push outline dots outward with amplitude. Stepped, no easing.
          const angle = Math.atan2(dot.y, dot.x);
          px += Math.cos(angle) * ringShift;
          py += Math.sin(angle) * ringShift;
        } else if (dot.zone === 'mouth-lower' && currentState === 'speaking') {
          // Lower lip drops with amplitude. Quantized step — the mouth
          // opens 0, 0.2x, 0.4x... of a full step.
          py += mouthStep * scale * 0.14;
        } else if (dot.zone === 'mouth-lower') {
          // Slight amplitude response even when not speaking, so the mouth
          // twitches with breath / stray audio. Smaller than the speaking
          // range.
          py += mouthStep * scale * 0.03;
        } else if (dot.zone === 'mouth' && currentState === 'speaking') {
          // Upper lip rises slightly too, just enough to feel like a
          // coordinated mouth movement.
          py -= mouthStep * scale * 0.04;
        } else if (dot.zone === 'face' && currentState === 'thinking') {
          // "Thinking" scanner — a diagonal stripe sweeps across the face,
          // dimming dots it crosses. Crisp on/off, no easing.
          const scan = ((t / 900) % 1) * 2 - 1; // -1..1 sweeps top-down
          const onLine = Math.abs(dot.y - scan) < 0.08;
          if (onLine) {
            // Skip drawing — produces a stripe of missing dots, reading
            // as a raster scanline.
            continue;
          }
        }

        // Brightness selection per dot. Deterministic per-frame: hash of
        // position + time-step picks which of three brightness levels the
        // dot currently uses. Gives a crisp twinkle instead of alpha fade.
        const twinkle = Math.sin(dot.phase + t / 360);
        let color: string;
        if (dot.zone === 'eye-pupil') {
          // Pupil blinks OFF during blink window. Otherwise bright.
          if (blinkActive) continue;
          color = GREEN_BRIGHT;
        } else if (dot.zone === 'eye') {
          // Eye ring: dim during blink.
          color = blinkActive ? GREEN_DIM : GREEN_MID;
        } else if (dot.zone === 'outline') {
          color = GREEN_BRIGHT;
        } else if (dot.zone === 'nose' || dot.zone === 'mouth' || dot.zone === 'mouth-lower') {
          color = GREEN_MID;
        } else {
          // Face dots twinkle stepwise.
          color = twinkle > 0.5 ? GREEN_MID : twinkle > -0.2 ? GREEN_DIM : GREEN_DIM;
        }

        // Apply the state accent by dimming when quiet.
        if (accent < 0.95 && (dot.zone === 'face' || dot.zone === 'mouth-lower')) {
          // Dim a stable fraction of face dots so the whole portrait feels
          // quieter when idle. Determined by dot.phase hash — same dots
          // each frame, not random flicker.
          if (dot.phase > accent * Math.PI * 2) {
            color = GREEN_DIM;
          }
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
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
