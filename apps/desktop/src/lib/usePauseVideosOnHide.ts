import type { RefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * `active` が true→false になった瞬間、返した ref 配下にある全 `<video>` を
 * pause() する。ExportScreen/UploadScreen は常時マウントされているため、
 * 非アクティブ(=表示上は隠れている)画面の動画が音を鳴らし続けるのを防ぐために使う。
 */
export function usePauseVideosOnHide(
	active: boolean,
): RefObject<HTMLElement | null> {
	const rootRef = useRef<HTMLElement>(null);
	const wasActiveRef = useRef(active);

	useEffect(() => {
		if (wasActiveRef.current && !active) {
			const root = rootRef.current;
			if (root) {
				for (const video of root.querySelectorAll("video")) {
					video.pause();
				}
			}
		}
		wasActiveRef.current = active;
	}, [active]);

	return rootRef;
}
