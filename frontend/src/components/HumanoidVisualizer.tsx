import { useEffect, useRef } from 'react';
import { cn } from '../ui/cn';

export type VisualizerState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Palette code: "warm" = pink→red (feminine voices), "cool" = blue→green
 *  (masculine voices). The orb's ring color, halo, and LED grid all swap
 *  to the matching palette so the visualizer signals who's speaking. */
export type VisualizerPalette = 'warm' | 'cool';

interface Props {
  state: VisualizerState;
  /** 0-1 live audio level. Modulates ring brightness/pulse. */
  level?: number;
  /** Active speaker's palette. Smoothly crossfaded when it changes. */
  palette?: VisualizerPalette;
  className?: string;
}

// Palette colors as RGB triples (linear-ish, no gamma). Tuned so each is
// recognizable at a glance: warm reads as feminine identity, cool reads
// as masculine identity, and both stay vivid against the dark backdrop.
const WARM = {
  corePrimary:   [1.00, 0.30, 0.55] as const,    // hot pink
  coreSecondary: [1.00, 0.20, 0.40] as const,    // crimson
  haloPrimary:   [1.00, 0.36, 0.42] as const,    // rose
  haloSecondary: [0.92, 0.20, 0.30] as const,    // deep red
  haloTertiary:  [0.55, 0.10, 0.30] as const,    // wine purple — inner ghost
  ledA:          [1.00, 0.68, 0.70] as const,
  ledB:          [1.00, 0.40, 0.45] as const,
  ledC:          [1.00, 0.85, 0.78] as const,
  trailGlow:     [1.00, 0.55, 0.40] as const,
  reactiveHalo:  [0.95, 0.30, 0.55] as const,
  fineDash:      [1.00, 0.45, 0.50] as const,
};
const COOL = {
  corePrimary:   [0.20, 0.55, 1.00] as const,    // electric blue
  coreSecondary: [0.10, 0.85, 0.70] as const,    // teal-cyan
  haloPrimary:   [0.30, 0.70, 0.90] as const,
  haloSecondary: [0.18, 0.60, 0.80] as const,
  haloTertiary:  [0.10, 0.30, 0.55] as const,
  ledA:          [0.65, 0.85, 1.00] as const,
  ledB:          [0.30, 0.85, 0.80] as const,
  ledC:          [0.85, 0.95, 0.95] as const,
  trailGlow:     [0.40, 0.80, 1.00] as const,
  reactiveHalo:  [0.40, 0.80, 0.95] as const,
  fineDash:      [0.55, 0.85, 1.00] as const,
};

function paletteColors(palette: VisualizerPalette) {
  return palette === 'warm' ? WARM : COOL;
}

function lerpRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ============================================================================
// Visualizer = "holographic energy ring"
//
// Ported from "holographic energy ring" by fagimli, published 2026-04-25
// at https://www.shadertoy.com/view/sfSSRd. The shader builds a glowing
// pink core ring with chromatic dispersion, a wider blue halo, an
// animated LED grid in polar coords, and a soft outer glow.
//
// Re-used here under Shadertoy's default license terms (CC BY-NC-SA 3.0
// equivalent — non-commercial attribution share-alike). See LICENSE-NOTES.md
// in this project for license tracking of imported assets.
//
// Modulation added on top of the original shader:
//   - u_intensity: ramps the entire color buffer from ~0.10 (idle ember)
//     up to 1.00 when active. Speaking and listening both bring it up so
//     the operator can see the ring respond to their voice too.
//   - u_energy: live audio level, drives a subtle radial pulse + extra
//     LED brightness when sound is happening.
// ============================================================================

const VERT_SRC = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_intensity;
uniform float u_energy;

// Palette uniforms — swap to match the active speaker's palette
// (warm = feminine, cool = masculine). Smoothly interpolated on
// the JS side when the active agent changes.
uniform vec3  u_corePrimary;
uniform vec3  u_coreSecondary;
uniform vec3  u_haloPrimary;
uniform vec3  u_haloSecondary;
uniform vec3  u_haloTertiary;
uniform vec3  u_ledA;
uniform vec3  u_ledB;
uniform vec3  u_ledC;
uniform vec3  u_trailGlow;
uniform vec3  u_reactiveHalo;
uniform vec3  u_fineDash;

float hash12(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float ringMask(float rr, float rad, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth, halfWidth + aa, abs(rr - rad));
}

float radialBand(float rr, float r0, float r1, float aa) {
  return smoothstep(r0 - aa, r0 + aa, rr) * (1.0 - smoothstep(r1 - aa, r1 + aa, rr));
}

float ledMask(float rr, float aa, float t, float aaR) {
  float twistA = aa + sin(rr * 10.0 - t) * 0.1;

  vec2 st = vec2(rr, twistA);

  float acell = floor(st.y * 32.0) / 32.0;
  float af = fract(st.y * 32.0);

  float aaA = max(fwidth(st.y * 32.0), 0.002);

  float angularBlock = smoothstep(0.80, 0.80 + aaA * 1.5, af) *
                       (1.0 - smoothstep(0.965 - aaA * 1.5, 0.965, af));

  float trail = pow(fract(aa * 5.0 + t), 3.0);

  float stretch = 0.018 + trail * 0.075;
  float band = radialBand(rr, 0.33, 0.37 + stretch, aaR * 1.5);

  float rf = fract((rr - 0.33) * 185.0 - trail * 2.2);
  float radialDots = smoothstep(0.10, 0.18, rf) *
                     (1.0 - smoothstep(0.58, 0.78, rf));

  float flicker = 0.55 + 0.45 * sin(acell * 71.0 + sin(acell * 19.0) * 4.0 + t * 5.0);
  float clusters = smoothstep(0.18, 0.82, 0.5 + 0.5 * sin(acell * 13.0 - t * 1.6));
  float sweep = smoothstep(0.15, 0.95, fract(aa * 0.23 - t * 0.10 + sin(aa * 3.0) * 0.05));

  return angularBlock * radialDots * band * mix(0.35, 1.25, flicker) * mix(0.55, 1.0, clusters) * (0.45 + 0.75 * sweep);
}

void main() {
  // Convert v_uv (clip-space [-1,1]) into Shadertoy's centered uv where
  // y ranges [-0.5, 0.5] and x scales with aspect. This is the convention
  // the original shader was written against.
  float aspect = u_resolution.x / max(1.0, u_resolution.y);
  vec2 uv = v_uv * 0.5;
  uv.x *= aspect;

  float t = u_time;

  // SIZE ENVELOPE — the ring grows with state intensity. Dividing r by
  // this scale makes the ring's apparent radius grow proportionally.
  // 0.15 (idle, ~15% of full size) → 1.0 (speaking, full size). Audio
  // bursts briefly inflate the ring on loud syllables.
  float scale = 0.15 + 0.85 * u_intensity + 0.10 * u_energy;
  float r = length(uv) / scale;
  float a = atan(uv.y, uv.x);

  a += t * 0.8;
  // Original radial breathing + amplified audio-driven pulse so the ring
  // visibly throbs with each syllable, not subtly.
  r += sin(t * 2.0) * 0.02 + u_energy * 0.030;

  float aaR = max(fwidth(r), 0.0012);

  vec3 col = vec3(0.0);

  float rR = r;
  float rG = r * 1.02;
  float rB = r * 1.04;

  float ringR = ringMask(rR, 0.35, 0.010, aaR);
  float ringG = ringMask(rG, 0.35, 0.010, aaR);
  float ringB = ringMask(rB, 0.35, 0.010, aaR);

  vec3 coreP = u_corePrimary * 2.0;
  vec3 coreS = u_coreSecondary;

  col += coreP * vec3(ringR, ringG, ringB);
  col += coreS * 1.25 * ringMask(r, 0.348, 0.0045, aaR);

  float glowR = exp(-abs(rR - 0.38) * 15.0);
  float glowG = exp(-abs(rG - 0.38) * 15.0);
  float glowB = exp(-abs(rB - 0.38) * 15.0);

  col += u_haloPrimary * vec3(glowR, glowG, glowB) * 0.85;
  col += u_haloSecondary * exp(-abs(r - 0.405) * 32.0) * 1.15;

  float halo = exp(-abs(r - 0.39) * 8.5) * smoothstep(0.21, 0.46, r) * (1.0 - smoothstep(0.60, 0.85, r));
  col += u_haloTertiary * halo * 0.85;

  float ledR = ledMask(r * 0.995, a, t, aaR);
  float ledG = ledMask(r * 1.010, a, t, aaR);
  float ledB = ledMask(r * 1.030, a, t, aaR);

  vec3 ledCA = vec3(ledR, ledG, ledB);
  vec3 ledColor = u_ledA * ledR * 1.35 +
                  u_ledB * ledCA * 1.75 +
                  u_ledC * min(ledR, min(ledG, ledB)) * 1.15;

  // Audio-driven LED brightness boost — voice activity clearly intensifies
  // the dot matrix.
  col += ledColor * (1.0 + u_energy * 1.4);

  // Audio-reactive outer halo — a wider, softer glow that expands outward
  // when the voice is loud. Color matches the active palette so the
  // "breathing" reads as a feminine pink or masculine cyan accordingly.
  float reactiveGlow = exp(-abs(r - 0.42) * 6.5) * u_energy * 1.2;
  col += u_reactiveHalo * reactiveGlow;

  float trail = pow(fract(a * 5.0 + t), 3.0);
  float trailGlow = exp(-abs(r - (0.37 + trail * 0.045)) * 38.0);
  float polarBits = smoothstep(0.78, 0.98, fract((a + sin(r * 10.0 - t) * 0.1) * 32.0));
  col += u_trailGlow * trailGlow * polarBits * trail * 0.75;

  float innerGhost = exp(-abs(r - 0.30) * 22.0) * (0.5 + 0.5 * sin(a * 6.0 + t * 1.7));
  col += u_haloTertiary * 0.06 * innerGhost;

  float fineDash = ringMask(r, 0.333, 0.0022, aaR);
  float dashF = fract((a + sin(r * 10.0 - t) * 0.1) * 58.0);
  float dash = smoothstep(0.08, 0.14, dashF) * (1.0 - smoothstep(0.36, 0.46, dashF));
  col += u_fineDash * fineDash * dash * 1.45;

  float vignette = smoothstep(0.95, 0.15, length(uv));
  col *= vignette;

  float grain = hash12(v_uv * u_resolution.xy + fract(t) * 173.13) - 0.5;
  col += grain * 0.018 * smoothstep(0.05, 0.5, length(col));

  // Final intensity envelope — fades the whole ring down when the voice
  // agent is idle and back up when active. Smoothed in JS so transitions
  // feel graceful.
  outColor = vec4(col * u_intensity, 1.0);
}
`;

export function HumanoidVisualizer({ state, level, palette = 'cool', className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<VisualizerState>(state);
  const levelRef = useRef<number | undefined>(level);
  const paletteRef = useRef<VisualizerPalette>(palette);
  const intensityRef = useRef(0);
  const energyRef = useRef(0);
  // Crossfade factor for palette transitions: 0 = fully showing previous
  // palette, 1 = fully showing current palette. Eased over ~600ms.
  const paletteMixRef = useRef(1);
  const prevPaletteRef = useRef<VisualizerPalette>(palette);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);
  useEffect(() => {
    if (palette !== paletteRef.current) {
      // Snapshot the OLD palette as the "from" side of the crossfade,
      // then start interpolating toward the NEW palette over ~600ms.
      prevPaletteRef.current = paletteRef.current;
      paletteRef.current = palette;
      paletteMixRef.current = 0;
    }
  }, [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) return;

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        // eslint-disable-next-line no-console
        console.error('Visualizer shader compile error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vert = compile(gl.VERTEX_SHADER, VERT_SRC);
    const frag = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      // eslint-disable-next-line no-console
      console.error('Visualizer program link error:', gl.getProgramInfoLog(prog));
      return;
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_resolution');
    const uIntensity = gl.getUniformLocation(prog, 'u_intensity');
    const uEnergy = gl.getUniformLocation(prog, 'u_energy');
    const uCorePrimary    = gl.getUniformLocation(prog, 'u_corePrimary');
    const uCoreSecondary  = gl.getUniformLocation(prog, 'u_coreSecondary');
    const uHaloPrimary    = gl.getUniformLocation(prog, 'u_haloPrimary');
    const uHaloSecondary  = gl.getUniformLocation(prog, 'u_haloSecondary');
    const uHaloTertiary   = gl.getUniformLocation(prog, 'u_haloTertiary');
    const uLedA           = gl.getUniformLocation(prog, 'u_ledA');
    const uLedB           = gl.getUniformLocation(prog, 'u_ledB');
    const uLedC           = gl.getUniformLocation(prog, 'u_ledC');
    const uTrailGlow      = gl.getUniformLocation(prog, 'u_trailGlow');
    const uReactiveHalo   = gl.getUniformLocation(prog, 'u_reactiveHalo');
    const uFineDash       = gl.getUniformLocation(prog, 'u_fineDash');

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const draw = (t: number) => {
      const cur = stateRef.current;
      // Intensity envelope. Drives the ring's SIZE (via scale uniform)
      // AND brightness. Idle = small dim ember, speaking = full size +
      // full brightness. Smoothing rate (0.06) is gentle so the size
      // change reads as the ring "growing" rather than snapping.
      const targetIntensity =
        cur === 'speaking' ? 1.0
        : cur === 'listening' ? 0.92
        : cur === 'thinking' ? 0.65
        : 0.0;     // idle = collapsed/dormant
      intensityRef.current += (targetIntensity - intensityRef.current) * 0.06;

      // Audio energy: VoiceShell passes max(inputLevel, outputLevel) so
      // this fires whether the operator or the AI is speaking. Mic levels
      // typically read 0.05-0.2; amplifying by 4× pushes them into a
      // 0..1 range that produces clearly-visible ring expansion.
      const live = levelRef.current;
      const haveLive = typeof live === 'number' && Number.isFinite(live);
      const targetEnergy = haveLive
        ? Math.max(0, Math.min(1, live * 4.0))
        : 0.0;
      // Snappier smoothing on energy so per-syllable bursts read as
      // discrete pulses instead of getting averaged out.
      energyRef.current += (targetEnergy - energyRef.current) * 0.30;

      // Palette crossfade — when the active speaker changes, ease the
      // mix from 0 to 1 over ~600ms. Smooth, not snappy: speakers usually
      // don't bounce back-and-forth fast enough for snap-cuts to look good.
      if (paletteMixRef.current < 1) {
        paletteMixRef.current = Math.min(1, paletteMixRef.current + (1 / 36)); // ~600ms at 60fps
      }
      const fromColors = paletteColors(prevPaletteRef.current);
      const toColors = paletteColors(paletteRef.current);
      const mix = paletteMixRef.current;
      const blend = (
        key:
          | 'corePrimary' | 'coreSecondary'
          | 'haloPrimary' | 'haloSecondary' | 'haloTertiary'
          | 'ledA' | 'ledB' | 'ledC'
          | 'trailGlow' | 'reactiveHalo' | 'fineDash'
      ) => lerpRgb(fromColors[key], toColors[key], mix);

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(uTime, t / 1000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uIntensity, intensityRef.current);
      gl.uniform1f(uEnergy, energyRef.current);
      gl.uniform3fv(uCorePrimary,   blend('corePrimary'));
      gl.uniform3fv(uCoreSecondary, blend('coreSecondary'));
      gl.uniform3fv(uHaloPrimary,   blend('haloPrimary'));
      gl.uniform3fv(uHaloSecondary, blend('haloSecondary'));
      gl.uniform3fv(uHaloTertiary,  blend('haloTertiary'));
      gl.uniform3fv(uLedA,          blend('ledA'));
      gl.uniform3fv(uLedB,          blend('ledB'));
      gl.uniform3fv(uLedC,          blend('ledC'));
      gl.uniform3fv(uTrailGlow,     blend('trailGlow'));
      gl.uniform3fv(uReactiveHalo,  blend('reactiveHalo'));
      gl.uniform3fv(uFineDash,      blend('fineDash'));

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
    };
  }, []);

  return (
    <div
      className={cn('relative w-full h-full overflow-hidden bg-black', className)}
      data-visualizer-state={state}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden />
    </div>
  );
}
