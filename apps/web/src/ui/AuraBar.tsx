// Compact aura indicator: ✦ glyph + thin horizontal fill bar.
//
// Used inline inside HudButton-style pills (Population pill at-rest, the
// PopulationPopover header) so the meter is glanceable without taking
// up enough room to spell out the numbers. The exact `current / max` is
// surfaced as a `title` for hover precision.

export interface AuraBarProps {
  current: number;
  max: number;
  /** Width of the bar in px. Default sized to fit inside the population
   *  pill without bumping the rest of the corner row. */
  width?: number;
}

const COLOR = "#ffd75c"; // CORE-yellow accent — reused from suggestions badge.

export function AuraBar({ current, max, width = 36 }: AuraBarProps) {
  const safeMax = Math.max(1, max);
  const safeCurrent = Math.max(0, Math.min(current, safeMax));
  // Floor at 2% when current > 0 so the bar always has a visible sliver
  // of fill (otherwise a single-digit aura reads as "empty").
  const ratio = safeCurrent / safeMax;
  const pct =
    safeCurrent === 0 ? 0 : Math.max(2, Math.round(ratio * 100));
  return (
    <span
      className="inline-flex items-center gap-1 leading-none"
      title={`Aura: ${current} / ${max} — regens 50/hour`}
      aria-label={`Aura ${current} of ${max}`}
    >
      <span aria-hidden style={{ color: COLOR, fontSize: 12 }}>
        ✦
      </span>
      <span
        aria-hidden
        className="inline-block border border-paper/30"
        style={{
          width,
          height: 6,
          background: "rgba(0, 0, 0, 0.35)",
        }}
      >
        <span
          className="block h-full"
          style={{ width: `${pct}%`, background: COLOR }}
        />
      </span>
    </span>
  );
}
