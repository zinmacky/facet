import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
}

/** ネイティブ range を薄くラップした range スライダ。値の解釈は呼び出し側。 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onValueChange,
  className,
  ...rest
}: SliderProps) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onValueChange(Number(e.target.value))}
      className={cn(
        "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line",
        "accent-accent",
        className,
      )}
      {...rest}
    />
  );
}
