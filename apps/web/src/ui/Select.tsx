"use client";

// Compact click-to-open select matching the dark card vocabulary used
// across the app (border-2 border-paper/30, uppercase tracking-wider,
// `nb-card-dark` for the floating panel). Closes on outside click,
// Escape, or picking an option. Keyboard: ↑/↓ to move, Enter to pick.
//
// Deliberately small — no search, no groups, no multi-select. If a
// caller needs those, wire cmdk (`CommandBar` shows the pattern).

import { useEffect, useMemo, useRef, useState } from "react";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  hint?: string; // right-aligned muted text (e.g. aura balance)
}

export function Select<V extends string = string>({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled = false,
  ariaLabel,
}: {
  value: V | null | undefined;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = options[highlightIdx];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
        }
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, options, highlightIdx, onChange]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="flex w-full items-center justify-between gap-3 border-2 border-paper/30 bg-black px-3 py-2 text-sm font-bold uppercase tracking-wider text-paper hover:bg-white/5 disabled:opacity-40"
      >
        <span className="truncate">
          {selected ? selected.label : (
            <span className="text-paper/40">{placeholder}</span>
          )}
        </span>
        <span aria-hidden className="text-paper/50">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="nb-card-dark absolute left-0 right-0 top-full z-50 mt-1 flex max-h-64 flex-col overflow-y-auto p-1"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlight = i === highlightIdx;
            return (
              <li key={opt.value} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper ${
                    isHighlight ? "bg-white/10" : ""
                  } ${isSelected ? "border-l-2 border-paper/60 pl-2" : ""} hover:bg-white/10`}
                >
                  <span className="truncate">{opt.label}</span>
                  {opt.hint ? (
                    <span className="font-mono normal-case tracking-normal text-paper/50">
                      {opt.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
