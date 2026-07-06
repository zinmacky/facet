import type { Clip, VariantKind } from "../../types";
import { Button } from "../../components/ui/Button";
import { cn } from "../../components/ui/cn";

interface ClipListProps {
  clips: Clip[];
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (clip: Clip) => void;
}

/**
 * 切り抜き一覧。各行で名前の inline 編集・バリアント選択・削除・選択を行う。
 * バリアントは少なくとも 1 つ必須。両方を false にする操作は無効化する。
 */
export function ClipList({
  clips,
  selectedClipId,
  onSelect,
  onAdd,
  onRemove,
  onChange,
}: ClipListProps) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {clips.length === 0 && (
        <p className="px-1 py-2 text-xs text-neutral-600">
          切り抜きがありません。追加してください。
        </p>
      )}

      {clips.map((clip) => (
        <ClipRow
          key={clip.id}
          clip={clip}
          selected={clip.id === selectedClipId}
          onSelect={() => onSelect(clip.id)}
          onRemove={() => onRemove(clip.id)}
          onChange={onChange}
        />
      ))}

      <Button size="sm" variant="secondary" onClick={onAdd} className="mt-1 self-start">
        + 切り抜きを追加
      </Button>
    </div>
  );
}

function ClipRow({
  clip,
  selected,
  onSelect,
  onRemove,
  onChange,
}: {
  clip: Clip;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onChange: (clip: Clip) => void;
}) {
  // バリアント切り替え。両方 false になる操作は無効化する(直近操作を打ち消す)。
  const toggleVariant = (kind: VariantKind, checked: boolean) => {
    const next = { ...clip.variants, [kind]: checked };
    if (!next.short && !next.insta) return; // 少なくとも 1 つ必須。
    onChange({ ...clip, variants: next });
  };

  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer flex-col gap-2 rounded-md border p-2.5 transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : "border-line bg-elevated hover:border-neutral-600",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          value={clip.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ ...clip, name: e.target.value })}
          placeholder="切り抜き名"
          className="h-7 flex-1 rounded border border-line bg-panel px-2 font-mono text-xs text-neutral-200 outline-none focus:border-accent"
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="shrink-0 rounded px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-danger/15 hover:text-danger"
          title="削除"
        >
          削除
        </button>
      </div>

      <div className="flex items-center gap-4">
        <VariantCheckbox
          label="ショート 9:16"
          checked={clip.variants.short}
          onChange={(c) => toggleVariant("short", c)}
        />
        <VariantCheckbox
          label="insta 1:1"
          checked={clip.variants.insta}
          onChange={(c) => toggleVariant("insta", c)}
        />
      </div>
    </div>
  );
}

function VariantCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="flex items-center gap-1.5 text-[11px] text-neutral-300"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}
