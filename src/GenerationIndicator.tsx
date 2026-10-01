import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { spinnerVerbGroups, type SpinnerVerbGroup } from "./spinner-verbs";
import { MathCurveLoader } from "./MathCurveLoader";
import type { SubagentCurve } from "./math-curve-loaders";

const announcements: Record<SpinnerVerbGroup, string> = {
  thinking: "正在生成回答…",
  "computer-use": "正在操作电脑…",
  delegation: "正在协调子代理任务…",
  subagent: "子代理正在处理任务…",
};

const TAU = Math.PI * 2;

// Lissajous Drift, with the reference's 3:4 curve, 6s loop and 5.4s breath:
// https://paidax01.github.io/math-curve-loaders/
function curvePoint(time: number) {
  const t = (time / 6000) * TAU;
  const breath = 0.76 + Math.sin((time / 5400) * TAU + 0.55) * 0.24;
  const amplitude = 24 + 6 * breath;
  return {
    x: 50 + Math.sin(3 * t + 1.57) * amplitude,
    y: 50 + Math.sin(4 * t) * amplitude * 0.92,
  };
}

const TRAIL_DURATION_MS = 1400;
const particles = Array.from({ length: 48 }, (_, index) => {
  const offset = index / 47;
  const fade = (1 - offset) ** 1.65;
  return {
    age: offset * TRAIL_DURATION_MS,
    radius: 0.35 + (1 - offset) * 2.5,
    opacity: fade,
  };
});

const LissajousDrift = memo(function LissajousDrift({
  active,
}: {
  active: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const circles = svg.querySelectorAll("circle");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = performance.now();
    let frame = 0;

    function draw(time: number) {
      circles.forEach((circle, index) => {
        const particle = particles[index];
        // Sample the actual past position, including its breathing amplitude.
        // Each visited point fades out completely after the trail's lifetime.
        const pastTime = time - particle.age;
        const point = curvePoint(Math.max(0, pastTime));
        circle.setAttribute("cx", point.x.toFixed(2));
        circle.setAttribute("cy", point.y.toFixed(2));
        circle.setAttribute(
          "opacity",
          String(pastTime < 0 ? 0 : particle.opacity),
        );
      });
    }

    function tick(now: number) {
      draw(now - startedAt);
      frame = requestAnimationFrame(tick);
    }

    function updateAnimation() {
      cancelAnimationFrame(frame);
      if (active && !document.hidden && !reducedMotion.matches) {
        frame = requestAnimationFrame(tick);
      } else {
        draw(TRAIL_DURATION_MS);
      }
    }

    draw(0);
    updateAnimation();
    reducedMotion.addEventListener("change", updateAnimation);
    document.addEventListener("visibilitychange", updateAnimation);
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion.removeEventListener("change", updateAnimation);
      document.removeEventListener("visibilitychange", updateAnimation);
    };
  }, [active]);

  return (
    <svg
      ref={svgRef}
      className="lissajous-drift"
      viewBox="12 12 76 76"
      fill="none"
      aria-hidden="true"
    >
      {particles.map((particle, index) => {
        const point = curvePoint(TRAIL_DURATION_MS - particle.age);
        return (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={particle.radius}
            opacity={particle.opacity}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
});

export function GenerationIndicator({
  hasResponse,
  active,
  activityKey,
  phraseGroup = "thinking",
  message,
  curve,
}: {
  hasResponse: boolean;
  active: boolean;
  activityKey: string;
  phraseGroup?: SpinnerVerbGroup;
  message?: string;
  curve?: SubagentCurve;
}) {
  const phrases = spinnerVerbGroups[phraseGroup];
  const [selection, setSelection] = useState(() => ({
    activityKey,
    phraseGroup,
    index: Math.floor(Math.random() * phrases.length),
  }));

  // Pick at the activity boundary, before rendering children. Switching to a
  // shorter pool must never read the old pool's index or flash its old word.
  let current = selection;
  if (
    selection.activityKey !== activityKey ||
    selection.phraseGroup !== phraseGroup
  ) {
    current = {
      activityKey,
      phraseGroup,
      index:
        selection.phraseGroup === phraseGroup
          ? (selection.index +
              1 +
              Math.floor(Math.random() * (phrases.length - 1))) %
            phrases.length
          : Math.floor(Math.random() * phrases.length),
    };
    setSelection(current);
  }

  const phrase = phrases[current.index];
  const characters = Array.from(phrase);

  return (
    <div
      className={`waiting-response generation-indicator${hasResponse ? " response-generating" : ""}`}
      data-phrase-group={phraseGroup}
    >
      {curve ? (
        <MathCurveLoader curve={curve} active={active} />
      ) : (
        <LissajousDrift active={active} />
      )}
      <span className="generation-copy" aria-hidden="true">
        <span
          key={JSON.stringify([current.activityKey, current.phraseGroup])}
          className="generation-phrase"
          style={
            {
              "--wave-duration": `${Math.max(2200, characters.length * 75 + 1000)}ms`,
            } as CSSProperties
          }
        >
          {characters.map((character, index) => (
            <span
              key={index}
              className="generation-character"
              style={{ animationDelay: `${index * 75}ms` }}
            >
              {character}
            </span>
          ))}
        </span>
        {message && <span className="generation-detail">{message}</span>}
      </span>
      <span
        className="generation-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message ?? announcements[phraseGroup]}
      </span>
    </div>
  );
}
