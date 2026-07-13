import { useEffect, useState } from "react";
import { ReframeScreen, type UploadScreenProps } from "./ReframeScreen";
import { usePublishExtras } from "./usePublishExtras";
import type { UploadPost } from "./uploadTypes";

/**
 * private エディションの実体。共通の `ReframeScreen` に投稿系スロット
 * (`usePublishExtras` の戻り値)を差し込む薄いラッパ(§entry.ts)。
 *
 * `posts` はミラー(`ReframeScreen` が `onPostsChange` で通知する読み取り専用コピー)
 * であり、ここから `ReframeScreen` の内部状態を書き換えることはない
 * (§ReframeScreen.tsx の `onPostsChange` コメント参照)。
 */
export function UploadScreen(props: UploadScreenProps) {
	const [posts, setPosts] = useState<UploadPost[]>([]);
	const publishSlots = usePublishExtras({
		clips: props.clips,
		source: props.source,
		posts,
		resetToken: props.resetToken,
	});

	useEffect(() => {
		props.onBusyChange?.(publishSlots.busy);
	}, [publishSlots.busy, props.onBusyChange]);

	return <ReframeScreen {...props} publishSlots={publishSlots} onPostsChange={setPosts} />;
}
