export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getEnv } from '@/lib/env';

type ModerationPayload = {
  comment?: string;
  fields?: { key: string; label: string; value: string }[];
};

type ModerationResult = {
  ai_flagged: boolean;
  severity: number | null;
  reason: string;
  raw_json: Record<string, unknown>;
  details?: {
    field: string;
    label: string;
    ai_flagged: boolean;
    severity: number | null;
    reason: string;
  }[];
};

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', getEnv('OPENAI_API_KEY'));
const MODERATION_MODEL = getEnv('OPENAI_MODERATION_MODEL') || 'gpt-4o-mini';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function normalizeSeverity(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return Math.min(4, Math.max(1, rounded));
}

const MAX_FIELD_CHARS = 80;
const MAX_TOTAL_CHARS = 800;

const truncateText = (s: string, maxChars: number) => {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…';
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ModerationPayload;
    const comment = body.comment?.trim();
    const fields = Array.isArray(body.fields) ? body.fields : [];

    const normalizedFields = fields
      .map((f) => ({
        key: String(f.key ?? '').trim(),
        label: String(f.label ?? '').trim(),
        value: String(f.value ?? '').trim(),
      }))
      .filter((f) => f.key.length > 0 && f.label.length > 0 && f.value.length > 0);

    if (!comment && normalizedFields.length === 0) {
      return NextResponse.json({ ok: false, error: 'comment is required' }, { status: 400 });
    }

    const promptSingle = `
あなたは授業レビューのコメントを審査する係です。
以下のコメントが「明らかに不適切」「低品質」かどうかを判定してください。

判定基準：
- 誹謗中傷・人格攻撃・差別的表現などが含まれる
- 意味のない連続文字（例: あああああ）や荒らし的内容
- コメントとして成立していない、極端に低品質

次のJSONのみ返してください：
{
  "ai_flagged": true/false,
  "severity": 1-4,
  "reason": "短い理由（20文字程度）"
}
`.trim();

    const promptFields = `
あなたは授業レビューの入力内容を審査する係です。
以下のフィールドごとに「明らかに不適切」「低品質」かどうかを判定してください。

判定基準：
- 誹謗中傷・人格攻撃・差別的表現などが含まれる
- 意味のない連続文字（例: あああああ）や荒らし的内容
- 入力として成立していない、極端に低品質

次のJSONのみ返してください：
{
  "ai_flagged": true/false,
  "severity": 1-4,
  "reason": "短い総評理由（任意・20文字程度）",
  "details": [
    { "field": "key", "label": "表示名", "ai_flagged": true/false, "severity": 1-4, "reason": "短い理由（20文字程度）" }
  ]
}
`.trim();

    const runModeration = async (text: string, useFieldsPrompt: boolean) => {
      const resp = await openai.responses.create({
        model: MODERATION_MODEL,
        input: [
          { role: 'developer', content: useFieldsPrompt ? promptFields : promptSingle },
          { role: 'user', content: text },
        ],
      });

      const outputText = (resp.output_text || '').trim();
      let parsed: any = null;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        parsed = null;
      }

      return {
        ai_flagged: Boolean(parsed?.ai_flagged),
        severity: normalizeSeverity(parsed?.severity),
        reason: typeof parsed?.reason === 'string' ? parsed.reason : '判定理由を取得できませんでした',
        raw_json: {
          model: MODERATION_MODEL,
          output_text: outputText,
        },
        parsed,
      };
    };

    if (normalizedFields.length > 0) {
      const compactFields = normalizedFields.map((f) => ({
        ...f,
        value: truncateText(f.value, MAX_FIELD_CHARS),
      }));
      const inputText = compactFields
        .map((f) => `[FIELD:${f.key}][LABEL:${f.label}]\n${f.value}`)
        .join('\n\n')
        .slice(0, MAX_TOTAL_CHARS);
      const multi = await runModeration(inputText, true);
      const parsed = (multi as any).parsed;
      const details =
        Array.isArray(parsed?.details)
          ? parsed.details
              .map((d: any) => ({
                field: String(d?.field ?? '').trim(),
                label: String(d?.label ?? '').trim(),
                ai_flagged: Boolean(d?.ai_flagged),
                severity: normalizeSeverity(d?.severity),
                reason:
                  typeof d?.reason === 'string' ? d.reason : '判定理由を取得できませんでした',
              }))
              .filter((d: any) => d.field.length > 0 && d.label.length > 0)
          : [];

      const flagged = details.filter((d: any) => d.ai_flagged);
      const topSeverity =
        flagged.length > 0
          ? Math.max(...flagged.map((d: any) => d.severity ?? 0))
          : null;

      const result: ModerationResult = {
        ai_flagged: Boolean(parsed?.ai_flagged) || flagged.length > 0,
        severity: normalizeSeverity(parsed?.severity) ?? topSeverity,
        reason:
          typeof parsed?.reason === 'string'
            ? parsed.reason
            : flagged.length > 0
              ? flagged.map((d: any) => `${d.label}: ${d.reason}`).join(' / ')
              : '問題は見つかりませんでした',
        raw_json: {
          model: MODERATION_MODEL,
          mode: 'single-call',
          output_text: (multi as any).raw_json?.output_text ?? '',
        },
        details,
      };

      return NextResponse.json({ ok: true, result });
    }

    const safeComment = truncateText(comment!, MAX_TOTAL_CHARS);
    const single = await runModeration(safeComment, false);
    const result: ModerationResult = {
      ai_flagged: single.ai_flagged,
      severity: single.severity,
      reason: single.reason,
      raw_json: single.raw_json,
    };

    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
