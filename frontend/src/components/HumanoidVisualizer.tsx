import { useEffect, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  /** High-level visual state — idle/listening/thinking/speaking. */
  state: VisualizerState;
  /**
   * Optional live audio level (0-1). When provided, drives the aura intensity
   * and body glow directly. When omitted, a gentle breathing animation runs.
   */
  level?: number;
  className?: string;
}

const TONE = {
  idle: 'rgba(154, 167, 184, 0.5)',
  listening: 'rgba(52, 211, 153, 0.85)', // emerald
  thinking: 'rgba(155, 140, 255, 0.8)', // violet
  speaking: 'rgba(41, 216, 255, 0.95)', // cyan
} as const;

/**
 * A humanoid SVG silhouette (head + shoulders + torso) layered behind concentric
 * auras. Driven by a single <canvas> where we paint a radial "presence" field so
 * the audio reactivity can be smooth at 60fps without re-rendering React.
 *
 * The SVG figure itself is low-opacity and non-reactive — the canvas behind it
 * carries the energy. The overall impression is "a humanoid is faintly visible
 * inside a field of light that responds to the conversation."
 */
export function HumanoidVisualizer({ state, level, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const breathRef = useRef<number>(0);
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
      // Clear with a soft alpha for a subtle trail effect.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(7, 10, 15, 0.25)';
      ctx.fillRect(0, 0, width, height);

      const currentState = stateRef.current;
      const liveLevel = levelRef.current;

      // Baseline breathing — 4s cycle, amplitude 0.08.
      breathRef.current = 0.5 + 0.08 * Math.sin(t / 650);

      // Smooth the displayed level toward the target so frames never jitter.
      const targetLevel =
        typeof liveLevel === 'number' && Number.isFinite(liveLevel)
          ? Math.max(0, Math.min(1, liveLevel))
          : currentState === 'thinking'
            ? 0.4 + 0.2 * Math.sin(t / 220)
            : currentState === 'listening'
              ? 0.25 + 0.12 * Math.sin(t / 500)
              : currentState === 'speaking'
                ? 0.55
                : breathRef.current * 0.5;
      displayLevelRef.current += (targetLevel - displayLevelRef.current) * 0.22;
      const energy = displayLevelRef.current;

      const cx = width / 2;
      const cy = height / 2;
      const baseR = Math.min(width, height) * 0.22;

      // Core glow — cheap outward rings.
      const tone = TONE[currentState] ?? TONE.idle;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const r = baseR * (1 + i * 0.55 + energy * (0.4 + i * 0.18));
        const gradient = ctx.createRadialGradient(cx, cy, baseR * 0.4, cx, cy, r);
        const alpha = (0.28 - i * 0.06) * (0.6 + energy * 0.9);
        gradient.addColorStop(0, tone.replace(/,\s*[\d.]+\)$/, `, ${alpha.toFixed(3)})`));
        gradient.addColorStop(1, 'rgba(7, 10, 15, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Particle field — points orbiting the figure, density follows energy.
      const particleCount = 38;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < particleCount; i++) {
        const phase = t / (2600 + (i % 5) * 180);
        const ring = baseR * (1.1 + ((i * 0.13) % 1) * (1.8 + energy * 1.1));
        const angle = phase + i * 0.58 + (currentState === 'speaking' ? energy * 2 : 0);
        const x = cx + Math.cos(angle) * ring;
        const y = cy + Math.sin(angle) * ring * 0.82;
        const size = 0.6 + ((i % 4) * 0.2 + energy * 1.8);
        ctx.fillStyle = tone.replace(/,\s*[\d.]+\)$/, `, ${(0.18 + energy * 0.6).toFixed(3)})`);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }

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

      {/* Humanoid silhouette — stays barely visible regardless of state. */}
      <svg
        aria-hidden
        className="absolute inset-0 w-full h-full"
        viewBox="0 0 400 400"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="humanoid-skin" cx="50%" cy="45%" r="50%">
            <stop offset="0%" stopColor="rgba(216, 238, 252, 0.15)" />
            <stop offset="75%" stopColor="rgba(216, 238, 252, 0.05)" />
            <stop offset="100%" stopColor="rgba(216, 238, 252, 0)" />
          </radialGradient>
          <filter id="humanoid-blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.6" />
          </filter>
        </defs>

        <g
          filter="url(#humanoid-blur)"
          className="origin-center transition-transform duration-[900ms] ease-out"
          style={{
            transform:
              state === 'speaking'
                ? 'scale(1.02)'
                : state === 'thinking'
                  ? 'scale(1.008)'
                  : 'scale(1)',
            transformOrigin: '200px 200px',
          }}
        >
          {/* Head */}
          <ellipse cx="200" cy="148" rx="44" ry="52" fill="url(#humanoid-skin)" />
          {/* Neck */}
          <path d="M180 188 Q200 206 220 188 L232 214 Q200 226 168 214 Z" fill="url(#humanoid-skin)" />
          {/* Shoulders + chest */}
          <path
            d="M118 260 Q158 224 200 224 Q242 224 282 260 Q290 280 286 312 L286 360 Q260 388 200 392 Q140 388 114 360 L114 312 Q110 280 118 260 Z"
            fill="url(#humanoid-skin)"
          />
        </g>

        {/* Faint breathing ring hugging the head */}
        <circle
          cx="200"
          cy="148"
          r="68"
          fill="none"
          stroke="rgba(216, 238, 252, 0.06)"
          strokeWidth="1"
          className="origin-center"
          style={{
            transformOrigin: '200px 148px',
            transform: `scale(${1 + (state === 'speaking' ? 0.06 : state === 'listening' ? 0.03 : 0.01)})`,
            transition: 'transform 900ms ease-out',
          }}
        />
      </svg>
    </div>
  );
}
