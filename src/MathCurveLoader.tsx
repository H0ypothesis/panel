import { memo, useEffect, useRef } from "react";
import {
  curveBreath,
  curveConfigs,
  curveParticle,
  mathCurvePath,
  type SubagentCurve,
} from "./math-curve-loaders";

const STILL_TIME = 1400;

export const MathCurveLoader = memo(function MathCurveLoader({
  curve,
  active,
}: {
  curve: SubagentCurve;
  active: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const config = curveConfigs[curve];

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const group = svg.querySelector("g")!;
    const path = svg.querySelector("path")!;
    const circles = svg.querySelectorAll("circle");
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    const startedAt = performance.now();
    let frame = 0;

    function draw(time: number) {
      group.setAttribute(
        "transform",
        `rotate(${-(time / config.rotation) * 360} 50 50)`,
      );
      path.setAttribute("d", mathCurvePath(curve, curveBreath(curve, time)));
      circles.forEach((circle, index) => {
        const particle = curveParticle(curve, index, time);
        circle.setAttribute("cx", particle.x.toFixed(2));
        circle.setAttribute("cy", particle.y.toFixed(2));
      });
    }

    function tick(now: number) {
      draw(now - startedAt + STILL_TIME);
      frame = requestAnimationFrame(tick);
    }

    function updateAnimation() {
      cancelAnimationFrame(frame);
      if (active && !document.hidden && !reducedMotion?.matches) {
        frame = requestAnimationFrame(tick);
      } else {
        draw(STILL_TIME);
      }
    }

    updateAnimation();
    reducedMotion?.addEventListener("change", updateAnimation);
    document.addEventListener("visibilitychange", updateAnimation);
    return () => {
      cancelAnimationFrame(frame);
      reducedMotion?.removeEventListener("change", updateAnimation);
      document.removeEventListener("visibilitychange", updateAnimation);
    };
  }, [active, curve, config]);

  return (
    <svg
      ref={svgRef}
      className="math-curve-loader"
      data-curve={curve}
      viewBox="4 4 92 92"
      fill="none"
      aria-hidden="true"
    >
      <g transform={`rotate(${-(STILL_TIME / config.rotation) * 360} 50 50)`}>
        <path
          d={mathCurvePath(curve, curveBreath(curve, STILL_TIME))}
          stroke="currentColor"
          strokeWidth={config.stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.1"
        />
        {Array.from({ length: config.particles }, (_, index) => {
          const particle = curveParticle(curve, index, STILL_TIME);
          return (
            <circle
              key={index}
              cx={particle.x}
              cy={particle.y}
              r={particle.radius}
              opacity={particle.opacity}
              fill="currentColor"
            />
          );
        })}
      </g>
    </svg>
  );
});
