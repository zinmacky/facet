import { z } from "zod";

/**
 * process.env を zod で検証して型付き config を得る。
 * ローカルツール前提のため、外部連携用のシークレット類は起動時必須にせず optional にする
 * (実際に使う経路で未設定を検出する)。PORT / WORK_DIR のみ既定値を持つ。
 */
const envSchema = z.object({
	PORT: z.coerce.number().int().positive().default(5178),
	WORK_DIR: z.string().default("./.work"),

	// YouTube OAuth
	YOUTUBE_CLIENT_ID: z.string().optional(),
	YOUTUBE_CLIENT_SECRET: z.string().optional(),
	YOUTUBE_REDIRECT_URI: z.string().optional(),
	YOUTUBE_REFRESH_TOKEN: z.string().optional(),

	// Cloudflare R2 (S3 互換)
	R2_ACCOUNT_ID: z.string().optional(),
	R2_ACCESS_KEY_ID: z.string().optional(),
	R2_SECRET_ACCESS_KEY: z.string().optional(),
	R2_BUCKET: z.string().default("facet-media"),
	R2_PUBLIC_BASE: z.string().optional(),

	// scheduler(クラウド側)
	SCHEDULER_URL: z.string().default("http://localhost:8787"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
	// 起動時に必須項目が壊れている場合のみここに来る(現状は coerce 失敗など)。
	throw new Error(`環境変数の検証に失敗しました:\n${parsed.error.toString()}`);
}

export const config = parsed.data;
export type Config = typeof config;
