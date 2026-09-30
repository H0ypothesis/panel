// The first two rows of https://paidax01.github.io/math-curve-loaders/.
// Keep the reference's formulas, breathing, rotation and timing together.
export const subagentCurves = [
  "original-thinking",
  "thinking-five",
  "thinking-nine",
  "rose-orbit",
  "rose-curve",
  "rose-two",
  "rose-three",
  "rose-four",
] as const;

export type SubagentCurve = (typeof subagentCurves)[number];

interface CurveConfig {
  name: string;
  kind: "thinking" | "orbit" | "rose";
  petals: number;
  particles: number;
  trail: number;
  duration: number;
  rotation: number;
  pulse: number;
  stroke: number;
}

export const curveConfigs: Record<SubagentCurve, CurveConfig> = {
  "original-thinking": {
    name: "Original Thinking",
    kind: "thinking",
    petals: 7,
    particles: 64,
    trail: 0.38,
    duration: 4600,
    rotation: 28000,
    pulse: 4200,
    stroke: 5.5,
  },
  "thinking-five": {
    name: "Thinking Five",
    kind: "thinking",
    petals: 5,
    particles: 62,
    trail: 0.38,
    duration: 4600,
    rotation: 28000,
    pulse: 4200,
    stroke: 5.5,
  },
  "thinking-nine": {
    name: "Thinking Nine",
    kind: "thinking",
    petals: 9,
    particles: 68,
    trail: 0.39,
    duration: 4700,
    rotation: 30000,
    pulse: 4200,
    stroke: 5.5,
  },
  "rose-orbit": {
    name: "Rose Orbit",
    kind: "orbit",
    petals: 7,
    particles: 72,
    trail: 0.42,
    duration: 5200,
    rotation: 28000,
    pulse: 4600,
    stroke: 5.2,
  },
  "rose-curve": {
    name: "Rose Curve",
    kind: "rose",
    petals: 5,
    particles: 78,
    trail: 0.32,
    duration: 5400,
    rotation: 28000,
    pulse: 4600,
    stroke: 4.5,
  },
  "rose-two": {
    name: "Rose Two",
    kind: "rose",
    petals: 2,
    particles: 74,
    trail: 0.3,
    duration: 5200,
    rotation: 28000,
    pulse: 4300,
    stroke: 4.6,
  },
  "rose-three": {
    name: "Rose Three",
    kind: "rose",
    petals: 3,
    particles: 76,
    trail: 0.31,
    duration: 5300,
    rotation: 28000,
    pulse: 4400,
    stroke: 4.6,
  },
  "rose-four": {
    name: "Rose Four",
    kind: "rose",
    petals: 4,
    particles: 78,
    trail: 0.32,
    duration: 5400,
    rotation: 28000,
    pulse: 4500,
    stroke: 4.6,
  },
};

const TAU = Math.PI * 2;

export function curveBreath(curve: SubagentCurve, time: number) {
  return (
    0.76 + Math.sin((time / curveConfigs[curve].pulse) * TAU + 0.55) * 0.24
  );
}

export function mathCurvePoint(
  curve: SubagentCurve,
  progress: number,
  breath: number,
) {
  const config = curveConfigs[curve];
  const t = progress * TAU;
  if (config.kind === "thinking") {
    return {
      x:
        50 + (7 * Math.cos(t) - 3 * breath * Math.cos(config.petals * t)) * 3.9,
      y:
        50 + (7 * Math.sin(t) - 3 * breath * Math.sin(config.petals * t)) * 3.9,
    };
  }
  const radius =
    config.kind === "orbit"
      ? (7 - 2.7 * breath * Math.cos(config.petals * t)) * 3.9
      : (9.2 + breath * 0.6) *
        (0.72 + breath * 0.28) *
        Math.cos(config.petals * t) *
        3.25;
  return { x: 50 + Math.cos(t) * radius, y: 50 + Math.sin(t) * radius };
}

export function mathCurvePath(curve: SubagentCurve, breath: number) {
  return Array.from({ length: 193 }, (_, index) => {
    const point = mathCurvePoint(curve, index / 192, breath);
    return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(" ");
}

export function curveParticle(
  curve: SubagentCurve,
  index: number,
  time: number,
) {
  const config = curveConfigs[curve];
  const offset = index / (config.particles - 1);
  const fade = (1 - offset) ** 0.56;
  return {
    ...mathCurvePoint(
      curve,
      time / config.duration - offset * config.trail,
      curveBreath(curve, time),
    ),
    radius: 0.9 + fade * 2.7,
    opacity: 0.04 + fade * 0.96,
  };
}
