export { ReframeScreen as UploadScreen } from "./ReframeScreen";

/**
 * public(配布版)エディションで使う実体。`ReframeScreen`(両エディション共通:
 * ターゲット別アスペクト/フィットの選択・レンダリング・フォルダへの保存)を
 * `publishSlots` を渡さずにそのまま再輸出する — `publishSlots` は省略可能な prop
 * なので、投稿(スケジュール・キャプション・IG/YT 連携)UI は一切描画されない
 * (§ReframeScreen.tsx の `PublishSlots` インターフェース)。
 *
 * これにより、投稿系コード一式(`usePublishExtras.tsx` とそこから import される
 * `igPublish.ts` / `ScheduleSettingsModal.tsx` / `PostScheduleSection.tsx` /
 * `OutputPublishSection.tsx` / `PublishGateContext` / `schedulerUrlStore.ts` /
 * `publishSupport.ts`)は import グラフに一切現れず、public バンドルへ物理的に
 * 含まれない(vite.config.ts の `virtual:upload-entry` alias、§src/lib/edition.ts)。
 *
 * v2.4 のエディション分離では本ファイルが画面全体を no-op スタブへ差し替えていた
 * ため、リフレーム機能(製品の核)自体が配布版から消えてしまっていた
 * (切り分けミス)。現構造では「画面は両エディションに存在し、投稿系の部分だけを
 * virtual entry で差し替える」よう粒度を変更している
 * (§docs/desktop-migration-plan.md の wizard 再構成メモ)。
 */
