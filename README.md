# Campus AI

大学向けの **LINE チャットボット型レビュー/QAシステム** です。学生が LIFF フォームで授業レビューを投稿し、Supabase に保存したレビューを OpenAI で要約・Embedding 化して検索に活用します。フロントは Next.js + LIFF、バックエンドは Next.js API Routes を中心に構成されています。詳しい構成は `wiki/` を参照してください。

## リポジトリ構成

```
.
├── apps/
│   ├── review-page/   # Next.js + LIFF
│   └── line-ai-bot/   # LINE Webhook
├── wiki/              # ドキュメント
└── report.md          # 設計まとめ/DDLメモ
```

## ドキュメント

- 目次: [wiki/00-目次.md](./wiki/00-目次.md)
- アーキテクチャ: [wiki/03-アーキテクチャ.md](./wiki/03-アーキテクチャ.md)
- API: [wiki/07-APIドキュメント.md](./wiki/07-APIドキュメント.md)

## 開発メモ

- review 側のアプリ: `apps/review-page`
- line 側の Webhook: `apps/line-ai-bot`

詳細なセットアップや運用は `wiki/02-クイックスタート.md` を参照してください。
