import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import spinnerVerbs from "./spinner-verbs.txt?raw";
import "./generation-indicator.css";

const phrases = spinnerVerbs
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
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
  message,
}: {
  hasResponse: boolean;
  active: boolean;
  activityKey: string;
  message?: string;
}) {
  const [selection, setSelection] = useState(() => ({
    activityKey,
    index: Math.floor(Math.random() * phrases.length),
  }));

  useEffect(() => {
    setSelection((previous) =>
      previous.activityKey === activityKey
        ? previous
        : {
            activityKey,
            index:
              (previous.index +
                1 +
                Math.floor(Math.random() * (phrases.length - 1))) %
              phrases.length,
          },
    );
  }, [activityKey]);

  const phrase = phrases[selection.index];
  const characters = Array.from(phrase);

  return (
    <div
      className={`waiting-response generation-indicator${hasResponse ? " response-generating" : ""}`}
    >
      <LissajousDrift active={active} />
      <span className="generation-copy" aria-hidden="true">
        <span
          key={selection.activityKey}
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
        {message ?? "正在生成回答…"}
      </span>
    </div>
  );
}
