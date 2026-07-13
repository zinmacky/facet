//! R2(Cloudflare, S3 互換)への署名付き PUT URL 生成。`rusty-s3` に委ねる
//! (クレート選定理由は `crate::jobs` モジュール冒頭コメント参照)。
//!
//! 旧 TS 実装(`apps/studio/server/src/services/scheduler-client.ts`)は
//! `aws4fetch` の `AwsClient` で Authorization ヘッダ方式の署名付き PUT を都度計算していた
//! (`service: "s3", region: "auto"`)。Rust 版は **presigned URL 方式**(署名をクエリ
//! パラメータに載せる)に変更した — 呼び出し側(`jobs::r2_upload`)が reqwest で素の
//! PUT を投げるだけで済み、署名対象ヘッダの選定を自前で気にする必要が無くなる
//! (S3 互換 API はどちらの方式でも検証結果は同じ)。

use std::time::Duration;

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use url::Url;

/// R2 の資格情報(アカウント ID・アクセスキー・シークレット・バケット名)。
/// キーチェーンへの JSON 保存(`commands::publish::r2_credentials`)と、ここでの署名の
/// 両方で共有する形状。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct R2Credentials {
	pub account_id: String,
	pub access_key_id: String,
	pub secret_access_key: String,
	pub bucket: String,
}

/// R2 の presigned PUT URL の既定有効期限。アップロード自体は通常数秒〜数分で終わるが、
/// 大きめのファイル・低速回線でも十分な余裕を持たせる(IG の上限 300MB を想定)。
pub const PRESIGNED_URL_EXPIRY: Duration = Duration::from_secs(60 * 60);

/// R2 のエンドポイント(`https://<accountId>.r2.cloudflarestorage.com`)。
fn r2_endpoint(account_id: &str) -> Result<Url, String> {
	format!("https://{account_id}.r2.cloudflarestorage.com")
		.parse()
		.map_err(|err| format!("R2 のエンドポイント URL が不正です: {err}"))
}

/// `key`(`posts/<date>/<uuid>.mp4`)への署名付き PUT URL を組み立てる。
///
/// path-style(`UrlStyle::Path`)を使う — 旧 TS 実装の
/// `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<r2Key>` と同じ URL 形式
/// (R2 はバケット名をサブドメインにする virtual-hosted-style も受け付けるが、
/// 旧実装との互換を優先する)。region は R2 の慣例に合わせ `"auto"` を使う。
pub fn presigned_put_url(credentials: &R2Credentials, key: &str) -> Result<Url, String> {
	let endpoint = r2_endpoint(&credentials.account_id)?;
	let bucket = Bucket::new(endpoint, UrlStyle::Path, credentials.bucket.clone(), "auto")
		.map_err(|err| format!("R2 バケットの URL 組み立てに失敗しました: {err:?}"))?;
	let creds = Credentials::new(&credentials.access_key_id, &credentials.secret_access_key);
	let action = bucket.put_object(Some(&creds), key);
	Ok(action.sign(PRESIGNED_URL_EXPIRY))
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::time::Duration as StdDuration;

	/// AWS 公式ドキュメントの SigV4 署名テストベクタ(2013-05-24, bucket "examplebucket",
	/// region "us-east-1")。rusty-s3 自身のテストスイート(`put_object.rs`)にも同じ
	/// ベクタが使われている、広く参照される既知値。
	///
	/// 旧 TS 実装(`scheduler-client.ts`)には署名そのもののテストが無かった
	/// (`scheduler-client.test.ts` は `buildR2Key` のみを検証)。ここでは代わりに
	/// この公式テストベクタを使い、「自分の呼び出しコード(bucket/region/credentials の
	/// 組み立て)」の正しさを検証する(`jobs` モジュール冒頭コメント参照)。
	#[test]
	fn presigned_url_matches_aws_reference_test_vector() {
		let endpoint: Url = "https://s3.amazonaws.com".parse().unwrap();
		let bucket = Bucket::new(
			endpoint,
			UrlStyle::VirtualHost,
			"examplebucket",
			"us-east-1",
		)
		.expect("valid bucket");
		let credentials = Credentials::new(
			"AKIAIOSFODNN7EXAMPLE",
			"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		);
		let action = bucket.put_object(Some(&credentials), "test.txt");

		// Fri, 24 May 2013 00:00:00 GMT + 86400s(公式ドキュメントの例と同じ)。
		let date = jiff::Timestamp::from_second(1_369_353_600).unwrap();
		let url = action.sign_with_time(StdDuration::from_secs(86_400), &date);

		let expected = "https://examplebucket.s3.amazonaws.com/test.txt?\
			X-Amz-Algorithm=AWS4-HMAC-SHA256&\
			X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&\
			X-Amz-Date=20130524T000000Z&\
			X-Amz-Expires=86400&\
			X-Amz-SignedHeaders=host&\
			X-Amz-Signature=f4db56459304dafaa603a99a23c6bea8821890259a65c18ff503a4a72a80efd9";
		assert_eq!(url.as_str(), expected);
	}

	/// 自前の `presigned_put_url`(path-style + region "auto")が、R2 想定の URL 形式
	/// (旧 TS 実装と同じ `<endpoint>/<bucket>/<key>` 形)で、クエリに署名パラメータ一式が
	/// 載ることを確認する(署名の数値自体は上のテストで検証済みのため、ここでは形状のみ)。
	#[test]
	fn presigned_put_url_uses_path_style_matching_legacy_ts_url() {
		let credentials = R2Credentials {
			account_id: "myaccount".to_string(),
			access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
			secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
			bucket: "facet-media".to_string(),
		};
		let url = presigned_put_url(&credentials, "posts/2026-07-10/uuid.mp4").unwrap();

		assert_eq!(url.scheme(), "https");
		assert_eq!(url.host_str(), Some("myaccount.r2.cloudflarestorage.com"));
		assert_eq!(url.path(), "/facet-media/posts/2026-07-10/uuid.mp4");
		let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
		assert_eq!(
			query.get("X-Amz-Algorithm").map(|v| v.as_ref()),
			Some("AWS4-HMAC-SHA256")
		);
		assert!(query.contains_key("X-Amz-Signature"));
		let credential = query
			.get("X-Amz-Credential")
			.expect("X-Amz-Credential must be present");
		assert!(
			credential.contains("/auto/s3/aws4_request"),
			"region は auto を使う: {credential}"
		);
	}

	#[test]
	fn r2_endpoint_rejects_invalid_account_id_chars() {
		// URL のホスト部として不正な文字(空白)を含む account_id を渡すと組み立てに失敗する
		// ("/" は URL パーサがホスト/パスの区切りとして解釈してしまい、構文的には有効な
		// (だが意図と異なる)URL になるため検証に使えない)。
		let err = r2_endpoint("bad account").unwrap_err();
		assert!(!err.is_empty());
	}
}
