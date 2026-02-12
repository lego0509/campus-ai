# 🔌 07. APIドキュメント

## 7.1 主要エンドポイント一覧（review-page）

| Method | Path | 目的 |
|---|---|---|
| POST | `/api/course-reviews` | 授業レビュー投稿 |
| POST | `/api/company-reviews` | 企業レビュー投稿 |
| POST | `/api/review-ask` | 授業DB検索チャット |
| POST | `/api/ask` | `/api/review-ask` 互換エイリアス |
| POST | `/api/company-ask` | 企業DB検索チャット |
| POST | `/api/review-moderation` | 投稿前モデレーション |
| GET | `/api/review-tags/popular` | 人気タグ取得 |
| GET | `/api/subjects/suggest` | 科目名サジェスト |
| GET | `/api/companies/suggest` | 会社名サジェスト |
| POST | `/api/users/resolve` | LINE user → users.id 解決 |
| POST | `/api/user-affiliations/latest` | 所属情報取得 |

(参照: `../apps/review-page/app/api/course-reviews/route.ts:229-542`、`../apps/review-page/app/api/review-ask/route.ts:1481-1535`)

## 7.2 Bot連携エンドポイント（line-ai-bot）

| Method | Path | 目的 |
|---|---|---|
| GET/POST | `/api/webhook` | LINE Webhook受信・返信 |

(参照: `../apps/line-ai-bot/vercel.json:1-4`、`../apps/line-ai-bot/api/webhook.js:401-559`)

## 7.3 公開ブラウザAPI（subject-browser）

| Method | Path | 目的 |
|---|---|---|
| GET | `/api/public/universities` | 大学一覧 |
| GET | `/api/public/subjects?universityId=...` | 科目一覧/検索 |
| GET | `/api/public/subjects/:subjectId/rollup` | 科目集計・要約 |

(参照: `../apps/subject-browser/app/api/public/universities/route.ts:16-35`、`../apps/subject-browser/app/api/public/subjects/route.ts:16-58`、`../apps/subject-browser/app/api/public/subjects/[subjectId]/rollup/route.ts:16-83`)

## 7.4 バッチAPI（review-page）

| Method | Path | 目的 |
|---|---|---|
| POST | `/api/batch/embeddings/run` | 授業レビュー埋め込み更新 |
| POST | `/api/batch/rollups/run` | 授業rollup更新 |
| POST | `/api/batch/company-embeddings/run` | 企業レビュー埋め込み更新 |
| POST | `/api/batch/company-rollups/run` | 企業rollup更新 |
| POST | `/api/batch/full-rebuild/run` | 全件再キュー＋連続実行 |

(参照: `../apps/review-page/app/api/batch/embeddings/run/route.ts:99-170`、`../apps/review-page/app/api/batch/full-rebuild/run/route.ts:12-42`)

## 7.5 リクエスト例（タグ検索）

```bash
curl -s -X POST "https://<domain>/api/review-ask" \
  -H "Content-Type: application/json" \
  -H "x-ask-debug: 1" \
  -d '{"line_user_id":"Uxxxxxxxx","message":"#高難易度"}'
```

## 7.6 エラー処理の基本

- バリデーションエラー: 400
- 認証/トークン不一致（バッチ）: 401
- サーバ側処理失敗: 500
- 多くのAPIで `details` に Supabase エラー情報を返却

(参照: `../apps/review-page/app/api/course-reviews/route.ts:392-396`、`../apps/review-page/app/api/batch/embeddings/run/route.ts:108-110`)

## 7.7 API関係図

```mermaid
flowchart LR
  LINE[LINE webhook] --> WB[/line-ai-bot/api/webhook]
  WB --> RA[/review-page/api/review-ask]
  WB --> CA[/review-page/api/company-ask]
  UI[LIFFフォーム] --> CR[/api/course-reviews]
  UI --> CMR[/api/company-reviews]
  UI --> MOD[/api/review-moderation]
  UI --> TAG[/api/review-tags/popular]
  UI --> SG[/api/subjects/suggest]
  BROWSER[subject-browser] --> PUB[/api/public/*]
```

## 7.8 コードスニペット（Webhook分岐）

```js
// apps/line-ai-bot/api/webhook.js:489-505
const normalizedMessage = userMessage.replace(/＃/g, "#");
if (normalizedMessage.includes("#")) {
  replyText = await callAskApi(reviewUrl, lineUserId, userMessage); // ハッシュタグは review-ask
} else if (shouldUseCompanyAsk(userMessage)) {
  replyText = await callAskApi(companyUrl, lineUserId, userMessage);
} else if (shouldUseReviewAsk(userMessage)) {
  replyText = await callAskApi(reviewUrl, lineUserId, userMessage);
}
```

## 7.9 関連ページ

- 構造の解説: [03. アーキテクチャ](./03-アーキテクチャ.md)
- 実行・運用: [09. デプロイメント](./09-デプロイメント.md)
