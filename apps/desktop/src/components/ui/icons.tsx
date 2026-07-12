import type { SVGProps } from "react";

/**
 * 共通アイコン群。すべて 12x12 の currentColor ストローク/塗り。
 * 削除・移動・追加などのメタファをアプリ全体で統一するために集約する。
 * aria-hidden は各 svg に直接付ける(Biome の noSvgWithoutTitle はスプレッド経由の
 * 属性を静的検出できないため)。
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** 追加(＋)。 */
export function PlusIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			{...rest}
		>
			<path d="M6 2.5v7M2.5 6h7" strokeLinecap="round" />
		</svg>
	);
}

/** 削除(ゴミ箱)。全ての「削除」操作で共通に使う。 */
export function TrashIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...rest}
		>
			<path d="M2.5 3.5h7M5 3.5V2.5h2v1M3.3 3.5l.4 6h4.6l.4-6M5 5.5v2.5M7 5.5v2.5" />
		</svg>
	);
}

/** 閉じる(✕)。モーダルのクローズなど「消す」ではない離脱に使う。 */
export function CloseIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			{...rest}
		>
			<path d="M3 3l6 6M9 3l-6 6" />
		</svg>
	);
}

/** 上へ。 */
export function ChevronUpIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...rest}
		>
			<path d="M3 7.5L6 4.5l3 3" />
		</svg>
	);
}

/** 下へ。 */
export function ChevronDownIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...rest}
		>
			<path d="M3 4.5L6 7.5l3-3" />
		</svg>
	);
}

/** 再生(▶)。 */
export function PlayIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="currentColor"
			{...rest}
		>
			<path d="M3 1.8v8.4a.5.5 0 0 0 .77.42l6.5-4.2a.5.5 0 0 0 0-.84l-6.5-4.2A.5.5 0 0 0 3 1.8Z" />
		</svg>
	);
}

/** 一時停止(⏸)。 */
export function PauseIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="currentColor"
			{...rest}
		>
			<rect x="2" y="1.5" width="3" height="9" rx="0.5" />
			<rect x="7" y="1.5" width="3" height="9" rx="0.5" />
		</svg>
	);
}

/** 音量(スピーカー)。ミュート・音量0のときは SpeakerMuteIcon を使う。 */
export function SpeakerIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			{...rest}
		>
			<path
				d="M1.5 4.5h2L6.5 2v8L3.5 7.5h-2z"
				fill="currentColor"
				stroke="none"
			/>
			<path
				d="M8.3 4.2a2.6 2.6 0 0 1 0 3.6M9.6 3a4.4 4.4 0 0 1 0 6"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** ミュート(スピーカー+✕)。 */
export function SpeakerMuteIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			{...rest}
		>
			<path
				d="M1.5 4.5h2L6.5 2v8L3.5 7.5h-2z"
				fill="currentColor"
				stroke="none"
			/>
			<path
				d="M8 4l3 3M11 4l-3 3"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** 歯車(設定)。ヘッダの設定ボタンで使う。 */
export function SettingsIcon({ size = 12, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 12 12"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			{...rest}
		>
			<circle cx="6" cy="6" r="1.6" />
			<path d="M6 1.2v1.3M6 9.5v1.3M10.8 6h-1.3M2.5 6H1.2M9.1 2.9l-.9.9M3.8 8.3l-.9.9M9.1 9.1l-.9-.9M3.8 3.7l-.9-.9" />
		</svg>
	);
}

/** 回転スピナー(ローディング)。 */
export function SpinnerIcon({ size = 16, ...rest }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			fill="none"
			{...rest}
		>
			<circle
				cx="12"
				cy="12"
				r="9"
				stroke="currentColor"
				strokeOpacity="0.25"
				strokeWidth="3"
			/>
			<path
				d="M21 12a9 9 0 0 0-9-9"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
			>
				<animateTransform
					attributeName="transform"
					type="rotate"
					from="0 12 12"
					to="360 12 12"
					dur="0.8s"
					repeatCount="indefinite"
				/>
			</path>
		</svg>
	);
}
