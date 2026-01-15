export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';

type ModerationPayload = {
  comment: string;
};

type ModerationResult = {
  ai_flagged: boolean;
  severity: number | null;
  reason: string;
  raw_json: Record<string, unknown>;
};

function requireEnv(name: string, value?: string | null) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);
const MODERATION_MODEL = process.env.OPENAI_MODERATION_MODEL || 'gpt-5-mini';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function normalizeSeverity(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return Math.min(4, Math.max(1, rounded));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ModerationPayload;
    const comment = body.comment?.trim();

    if (!comment) {
      return NextResponse.json({ ok: false, error: 'comment is required' }, { status: 400 });
    }

    const prompt = `
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
  "reason": "短い理由"
}
`.trim();

    const resp = await openai.responses.create({
      model: MODERATION_MODEL,
      input: [
        { role: 'developer', content: prompt },
        { role: 'user', content: comment },
      ],
    });

    const text = (resp.output_text || '').trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const result: ModerationResult = {
      ai_flagged: Boolean(parsed?.ai_flagged),
      severity: normalizeSeverity(parsed?.severity),
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '判定理由を取得できませんでした',
      raw_json: {
        model: MODERATION_MODEL,
        output_text: text,
      },
    };

    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
