import type { FitMode, Preset, PresetName } from "@reframe/core";
import { PRESETS } from "@reframe/core";
import { cn } from "../../components/ui/cn";

interface PresetPanelProps {
  /** 現在選択中のプリセット。 */
  value: Preset;
  onChange: (preset: Preset) => void;
}

const ORDER: PresetName[] = ["9:16", "1:1", "4:5"];

const FIT_LABEL: Record<FitMode, string> = {
  "blur-pad": "Blur pad",
  crop: "Crop",
};

/**
 * 出力プリセット選択 + fit トグル。
 * PRESETS の既定を基点に、name 変更時は既定 fit へ、fit トグル時は寸法据え置きで
 * fit のみ差し替える。値の保持は親。
 */
export function PresetPanel({ value, onChange }: PresetPanelProps) {
  return (
    <div className="flex flex-col gap-4 p-3">
      {/* アスペクト選択 */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Aspect
        </p>
        <div className="grid grid-cols-3 gap-2">
          {ORDER.map((name) => {
            const preset = PRESETS[name];
            const active = value.name === name;
            return (
              <button
                key={name}
                onClick={() => onChange({ ...preset, fit: value.fit })}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-md border p-2.5 transition-colors",
                  active
                    ? "border-accent bg-accent/10"
                    : "border-line bg-elevated hover:border-neutral-600",
                )}
              >
                <AspectThumb name={name} active={active} />
                <span
                  className={cn(
                    "font-mono text-xs",
                    active ? "text-accent" : "text-neutral-300",
                  )}
                >
                  {name}
                </span>
                <span className="text-[10px] text-neutral-500">
                  {preset.width}×{preset.height}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* fit トグル */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Fit
        </p>
        <div className="flex rounded-md border border-line p-0.5">
          {(Object.keys(FIT_LABEL) as FitMode[]).map((fit) => {
            const active = value.fit === fit;
            return (
              <button
                key={fit}
                onClick={() => onChange({ ...value, fit })}
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-accent text-white"
                    : "text-neutral-400 hover:text-neutral-200",
                )}
              >
                {FIT_LABEL[fit]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          {value.fit === "blur-pad"
            ? "被写体を切らず、余白をぼかした自身で埋める。"
            : "ターゲットを覆うようにスケールし中央クロップ。端は切れる。"}
        </p>
      </div>
    </div>
  );
}

/** アスペクト比を表す小さな枠プレビュー。 */
function AspectThumb({ name, active }: { name: PresetName; active: boolean }) {
  const { width, height } = PRESETS[name];
  // 高さ 28px を基準に幅を出す。
  const h = 28;
  const w = (width / height) * h;
  return (
    <div
      className={cn(
        "rounded-sm border",
        active ? "border-accent bg-accent/20" : "border-neutral-600 bg-panel",
      )}
      style={{ width: w, height: h }}
    />
  );
}
