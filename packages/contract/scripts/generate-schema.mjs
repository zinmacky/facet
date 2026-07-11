// zod スキーマ(真実の源)から JSON Schema を生成し、言語中立の中間表現として
// schema/job-manifest.json に書き出す(desktop-migration-plan.md §6.1 / Phase 0)。
//
// tsc によるビルド後の dist/ から実行する(新規の重いツールを避けるため、
// Node の型ストリップではなくコンパイル済み JS を素直に import する方式)。
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	jobCreateResponse,
	jobManifest,
	jobRecord,
	jobStatus,
	mediaType,
} from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../schema/job-manifest.json");

// zod-to-json-schema@3.25.2 は target が文字列 "jsonSchema7" のときのみ
// exclusiveMinimum を数値形式で出力する(parsers/number.js の実装依存)。
// それ以外(2019-09 含む)では draft-04 由来のブール形式
// (exclusiveMinimum: true + minimum) にフォールバックし、$schema で宣言する
// draft 2019-09 に非準拠になってしまう。2019-09 と draft-07 は数値
// exclusiveMinimum のセマンティクスが同一なため、出力形式の正しさを優先して
// jsonSchema7 を指定する($schema の URL は 2019-09 のまま変更しない)。
const TARGET = "jsonSchema7";
const DEFINITION_PATH = "$defs";

/**
 * オブジェクトキーを再帰的にソートする。
 * ライブラリの内部実装(Map の反復順など)に依存せず、出力を決定的にするため。
 * 配列の要素順は意味を持つため(enum/required 等)変更しない。
 */
function sortKeysDeep(value) {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value !== null && typeof value === "object") {
		const sorted = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeysDeep(value[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * 単一の zod スキーマを、指定した名前の $defs エントリへ変換する。
 *
 * jobRecord は jobManifest.extend(...) で作られており、共通フィールドの
 * zod スキーマインスタンスを jobManifest と共有している。そのため 5 スキーマを
 * 1 回の zodToJsonSchema 呼び出し(共有 definitions)にまとめると、ライブラリの
 * 「同一インスタンスの2回目の出現を $ref にする」実装により、jobManifest 側の
 * フィールドが `#/$defs/jobRecord/properties/...` を指す逆転した $ref になって
 * しまう(処理順に依存する意図しない構造)。
 * それを避けるため、各スキーマを独立した呼び出しで生成する。呼び出しごとに
 * 内部の "seen" 状態がリセットされるため、スキーマ同士が意図せず参照し合う
 * ことはない。列挙型(mediaType/jobStatus)だけは意図的に共有し、それぞれの
 * スキーマから `$defs/mediaType` / `$defs/jobStatus` への $ref にする。
 */
function toJsonSchemaDef(name, schema, sharedEnumDefinitions) {
	const result = zodToJsonSchema(schema, {
		name,
		target: TARGET,
		definitionPath: DEFINITION_PATH,
		definitions: sharedEnumDefinitions,
	});
	return result[DEFINITION_PATH][name];
}

const sharedEnums = { mediaType, jobStatus };

const defs = {
	// 列挙型は他スキーマから共有参照されるため先に単独生成する。
	mediaType: toJsonSchemaDef("mediaType", mediaType, {}),
	jobStatus: toJsonSchemaDef("jobStatus", jobStatus, {}),
	jobManifest: toJsonSchemaDef("jobManifest", jobManifest, sharedEnums),
	jobRecord: toJsonSchemaDef("jobRecord", jobRecord, sharedEnums),
	jobCreateResponse: toJsonSchemaDef(
		"jobCreateResponse",
		jobCreateResponse,
		sharedEnums,
	),
};

const schema = {
	$schema: "https://json-schema.org/draft/2019-09/schema#",
	$defs: defs,
};

const output = `${JSON.stringify(sortKeysDeep(schema), null, "\t")}\n`;
writeFileSync(outputPath, output);
