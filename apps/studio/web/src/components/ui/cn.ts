/** className を結合する軽量ヘルパ。falsy を除去するだけの clsx 相当。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
