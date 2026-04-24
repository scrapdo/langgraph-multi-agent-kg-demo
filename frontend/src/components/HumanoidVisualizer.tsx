import { useEffect, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  /** High-level visual state — idle/listening/thinking/speaking. */
  state: VisualizerState;
  /**
   * Optional live audio level (0-1). When provided, drives the blob's
   * pulse scale and surface wobble directly. When omitted, a gentle
   * per-state oscillation runs so the blob never reads as static.
   */
  level?: number;
  className?: string;
}

// Per-state palette. Warm-neutral idle → emerald listening → violet thinking
// → cyan speaking. Teal/violet-blue keeps the blob in the same "voice UI"
// colour family as reference visualizers (Perplexity, OpenAI voice) without
// being a carbon copy.
const PALETTE: Record<VisualizerState, { core: [number, number, number]; glow: [number, number, number] }> = {
  idle: { core: [140, 170, 200], glow: [60, 80, 140] },
  listening: { core: [80, 220, 190], glow: [40, 140, 160] },
  thinking: { core: [170, 140, 255], glow: [90, 70, 200] },
  speaking: { core: [90, 200, 255], glow: [40, 120, 220] },
};

// 20 control points around the blob's perimeter. Higher → smoother curve
// but more fill cost per frame; 20 reads as organic at all screen sizes.
const BLOB_POINTS = 20;

// Two independent phase offsets per point so the surface never periodically
// snaps back to the same shape — the blob looks alive because no two
// frequencies perfectly align.
const PHASES_A = Array.from({ length: BLOB_POINTS }, (_, i) => (i * 0.91) % (Math.PI * 2));
const PHASES_B = Array.from({ length: BLOB_POINTS }, (_, i) => (i * 1.37 + 1.1) % (Math.PI * 2));
const FREQS_A = Array.from({ length: BLOB_POINTS }, (_, i) => 0.00075 + (i % 4) * 0.00025);
const FREQS_B = Array.from({ length: BLOB_POINTS }, (_, i) => 0.00180 + ((i + 2) % 5) * 0.00020);

function midpoint(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Ethereal voice-UI visualizer. Renders three layers onto a 2D canvas:
 *
 *   1. Outer ambient glow — three radial gradients expanding with amplitude.
 *      Grounds the blob on a dark background so it doesn't look like a disc
 *      floating in a void. Carried over from the earlier visualizer.
 *   2. A central morphing blob, drawn as a closed quadratic-curve path
 *      through 20 control points. Each point's radius is modulated by two
 *      independent sinusoids plus the smoothed audio level, so the surface
 *      wobbles organically and bulges harder when you talk. Perplexity-style
 *      fluid motion — no two frames identical.
 *   3. A rim highlight traces the blob's outline so the shape reads as a
 *      bright liquid core with surface tension, not a flat disc.
 *
 * All rendering is inside a single requestAnimationFrame loop; no React
 * re-renders fire during animation. State / level are read via refs.
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
      // Soft trail clear — a low-alpha black wash. The blob never fully
      // erases, so motion reads as a liquid afterimage.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(7, 10, 15, 0.20)';
      ctx.fillRect(0, 0, width, height);

      const currentState = stateRef.current;
      const liveLevel = levelRef.current;
      const palette = PALETTE[currentState] ?? PALETTE.idle;

      // Target level: prefer the live mic/remote signal; otherwise synthesize
      // a state-appropriate oscillation so the blob is never fully still.
      const targetLevel =
        typeof liveLevel === 'number' && Number.isFinite(liveLevel)
          ? Math.max(0, Math.min(1, liveLevel))
          : currentState === 'speaking'
            ? 0.48 + 0.2 * Math.sin(t / 170)
            : currentState === 'thinking'
              ? 0.32 + 0.12 * Math.sin(t / 380)
              : currentState === 'listening'
                ? 0.18 + 0.08 * Math.sin(t / 560)
                : 0.08 + 0.04 * Math.sin(t / 650);
      // Exponential smoothing — a twitchy mic RMS would strobe the blob
      // otherwise. 0.18 lets it react inside ~100ms without single-frame jitter.
      displayLevelRef.current += (targetLevel - displayLevelRef.current) * 0.18;
      const energy = displayLevelRef.current;

      const cx = width / 2;
      const cy = height / 2;
      const baseR = Math.min(width, height) * 0.26;

      // --- 1. Outer ambient glow rings --------------------------------------
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const r = baseR * (1.6 + i * 0.75 + energy * (0.55 + i * 0.25));
        const gradient = ctx.createRadialGradient(cx, cy, baseR * 0.85, cx, cy, r);
        const alpha = (0.17 - i * 0.05) * (0.5 + energy * 0.85);
        gradient.addColorStop(
          0,
          `rgba(${palette.glow[0]}, ${palette.glow[1]}, ${palette.glow[2]}, ${alpha.toFixed(3)})`,
        );
        gradient.addColorStop(1, 'rgba(7, 10, 15, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // --- 2. Morphing blob --------------------------------------------------
      // Each control point's distance-from-center is:
      //   base_radius × axis_scale × pulse_scale(energy) × (1 + wobble(t, energy))
      //
      // Slight vertical elongation (y > x) so the blob reads as a head, not a
      // ball. Pairs with the faint eyes+mouth pass below to evoke a face
      // without turning into a cartoon.
      //
      // wobble is the sum of two independent sinusoids per point. Amplitude
      // (energy) scales BOTH the pulse and the wobble, so quiet states breathe
      // softly while speaking states bulge and ripple.
      const axisX = 0.92;
      const axisY = 1.08;
      const wobbleScale = 0.12 + energy * 0.42;
      const pulseScale = 1 + energy * 0.55;
      const points: Array<readonly [number, number]> = [];
      for (let i = 0; i < BLOB_POINTS; i++) {
        const angle = (i / BLOB_POINTS) * Math.PI * 2;
        const a = Math.sin(t * FREQS_A[i] + PHASES_A[i]) * 0.55;
        const b = Math.sin(t * FREQS_B[i] + PHASES_B[i]) * 0.35;
        const wobble = (a + b) * wobbleScale;
        const r = baseR * pulseScale * (1 + wobble);
        points.push([Math.cos(angle) * r * axisX, Math.sin(angle) * r * axisY] as const);
      }

      // Fill: radial gradient bright-core → muted-edge. Gives the blob depth
      // without a specular highlight (which would look metallic, not liquid).
      const coreAlpha = (0.7 + energy * 0.25).toFixed(3);
      const midAlpha = (0.38 + energy * 0.22).toFixed(3);
      const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 1.35);
      innerGrad.addColorStop(
        0,
        `rgba(${palette.core[0]}, ${palette.core[1]}, ${palette.core[2]}, ${coreAlpha})`,
      );
      innerGrad.addColorStop(
        0.55,
        `rgba(${palette.core[0]}, ${palette.core[1]}, ${palette.core[2]}, ${midAlpha})`,
      );
      innerGrad.addColorStop(
        1,
        `rgba(${palette.glow[0]}, ${palette.glow[1]}, ${palette.glow[2]}, 0)`,
      );
      ctx.fillStyle = innerGrad;
      ctx.globalCompositeOperation = 'lighter';

      // Smooth closed curve through the control points. Quadratic-bezier
      // through midpoints guarantees C1 continuity — no kinks, even when
      // wobble is large.
      ctx.beginPath();
      const firstMid = midpoint(points[BLOB_POINTS - 1], points[0]);
      ctx.moveTo(cx + firstMid[0], cy + firstMid[1]);
      for (let i = 0; i < BLOB_POINTS; i++) {
        const current = points[i];
        const next = points[(i + 1) % BLOB_POINTS];
        const mid = midpoint(current, next);
        ctx.quadraticCurveTo(cx + current[0], cy + current[1], cx + mid[0], cy + mid[1]);
      }
      ctx.closePath();
      ctx.fill();

      // Rim highlight — same path, stroked immediately so we don't lose it
      // when the face-voids pass below switches paths. Thin off-white; reads
      // as surface tension when the blob is speaking.
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(235, 245, 255, ${(0.1 + energy * 0.22).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, baseR * 0.006);
      ctx.stroke();

      // --- 3. Vague face — eyes + mouth -------------------------------------
      // Goal: the eye should READ as a head without the brain consciously
      // parsing "face." Everything here stays under ~15% opacity so it blends
      // into the blob; nudge opacity up when speaking so the mouth is visible.
      //
      // Eyes: two dim voids at upper-third. Drawn via "destination-out" with a
      // low-alpha soft brush — carves faint negative space into the blob fill.
      ctx.globalCompositeOperation = 'destination-out';
      const eyeY = cy - baseR * 0.28;
      const eyeDx = baseR * 0.30;
      const eyeR = baseR * 0.09;
      // Subtle breathing/blink: every ~5 seconds the eye dims briefly (eye
      // alpha scaled by a sine modulated to spend most of its time near 1 and
      // briefly dip to ~0.3 — a blink read).
      const blinkPhase = (t % 5200) / 5200;
      const blinkFactor = blinkPhase > 0.93 ? 0.3 + 0.7 * Math.abs(Math.cos((blinkPhase - 0.93) / 0.07 * Math.PI)) : 1;
      for (const ex of [cx - eyeDx, cx + eyeDx]) {
        const eyeGrad = ctx.createRadialGradient(ex, eyeY, 0, ex, eyeY, eyeR);
        const eyeAlpha = 0.55 * blinkFactor;
        eyeGrad.addColorStop(0, `rgba(0, 0, 0, ${eyeAlpha.toFixed(3)})`);
        eyeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = eyeGrad;
        ctx.beginPath();
        ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Mouth: horizontal ellipse that OPENS with speaking amplitude. The
      // visualizer is agnostic about WHO is speaking — whatever controller
      // owns the hook (delegator in the voice shell, specialist mid-handoff,
      // anything future) sets state="speaking" + passes amplitude via level,
      // and the mouth responds. So this animates on coordinator speech too.
      const mouthY = cy + baseR * 0.38;
      const mouthWidth = baseR * (0.32 + energy * 0.08);
      const isSpeaking = currentState === 'speaking';
      // When speaking, mouth height scales strongly with amplitude (syllables
      // visibly open the mouth). When not speaking, stays a thin line with
      // only subtle breathing.
      const mouthHeight = baseR * (isSpeaking ? 0.04 + energy * 0.18 : 0.012 + energy * 0.03);
      const mouthGrad = ctx.createRadialGradient(cx, mouthY, 0, cx, mouthY, mouthWidth);
      mouthGrad.addColorStop(0, `rgba(0, 0, 0, ${(0.45 + energy * 0.25).toFixed(3)})`);
      mouthGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = mouthGrad;
      ctx.save();
      ctx.translate(cx, mouthY);
      ctx.scale(1, Math.max(0.05, mouthHeight / mouthWidth));
      ctx.beginPath();
      ctx.arc(0, 0, mouthWidth, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // --- 4. Rim highlight --------------------------------------------------
      // Thin off-white stroke following the blob outline. At quiet levels it's
      // almost invisible; speaking amplitudes catch it as surface tension.
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(235, 245, 255, ${(0.1 + energy * 0.22).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.8, baseR * 0.006);
      ctx.stroke();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      className={cn('relative w-full h-full overflow-hidden', className)}
      data-visualizer-state={state}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden />
    </div>
  );
}
