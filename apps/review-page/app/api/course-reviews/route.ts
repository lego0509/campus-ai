export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getEnv } from '@/lib/env';

/**
 * term / requirement は DB の CHECK 制約と合わせる。
 * → ここがズレると insert が 400 で落ちる。
 */
type TermCode = 's1' | 's2' | 'q1' | 'q2' | 'q3' | 'q4' | 'full' | 'intensive' | 'other';
type RequirementType = 'required' | 'elective' | 'unknown';
const TAG_MAX = 5;
const TAG_MAX_CHARS = 12;

type Payload = {
  // LIFFから来るLINEユーザーID（生IDをDB保存しない）
  line_user_id: string;

  // 大学名（universitiesへ getOrCreate）
  university_name: string;

  // 所属（user_affiliationsを最新にupsertするために必須）
  faculty: string;
  department?: string | null;
  grade_at_take: number; // 1..6 or 99

  // 授業名（subjectsへ getOrCreate）
  subject_name: string;

  /**
   * 教師名：必須（1名以上）
   * - DB側は teacher_names_optional_valid() で NULL / 空配列OK
   * - 入ってるなら要素の空白/NULLはNG
   */
  teacher_names?: string[] | null;

  // 受講時期（同一科目に複数レビューを許容するため識別軸）
  academic_year?: number | null;
  term?: TermCode | null;

  // その他メタ
  credits_at_take?: number | null;
  requirement_type_at_take?: RequirementType | null;

  // 自己評価系
  performance_self: number; // 1..4
  assignment_difficulty_4: number; // 1..5

  // 5段階評価（DB側チェックあり）
  credit_ease?: number | null; // 1..5
  class_difficulty: number; // 1..5
  assignment_load?: number | null; // 1..5
  attendance_strictness?: number | null; // 1..5
  satisfaction?: number | null; // 1..5
  recommendation: number; // 1..5

  /**
   * 本文：course_reviews.body_main に保存
   * - 30文字以上制約は DB 側で担保
   */
  body_main: string;

  // ハッシュタグ（#なしで保存）
  hashtags?: string[] | string;

  /**
   * コメントのAI判定結果（警告表示後に「送信する」を選んだ場合のみ）
   */
  ai_flagged?: boolean;
  ai_severity?: number | null;
  ai_raw_json?: Record<string, unknown> | null;
};

/**
 * LINE userId を HMAC-SHA256(pepper) でハッシュ化して hex(64) を作る
 * - “pepperが違う” と userが別人扱いで全崩壊するので、環境変数未設定は即例外
 */
function lineUserIdToHash(lineUserId: string) {
  const pepper = getEnv('LINE_HASH_PEPPER');
  if (!pepper) {
    throw new Error('LINE_HASH_PEPPER is not set');
  }
  return createHmac('sha256', pepper).update(lineUserId, 'utf8').digest('hex');
}

/**
 * Supabaseのエラーを JSON で返しやすい形にしてログ/レスポンスへ
 * - 卒研のデバッグで「どの制約で落ちたか」追いやすくなる
 */
function supabaseErrorToJson(err: any) {
  if (!err) return null;
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
  };
}

function normalizeTag(raw: string) {
  const withoutFullWidthHash = raw.replace(/＃/g, '#').trim();
  const withoutHash = withoutFullWidthHash.replace(/^#+/, '').trim();
  const collapsed = withoutHash.replace(/\s+/g, '');
  const lowered = collapsed.toLowerCase();
  if (lowered.length === 0) return null;
  if (Array.from(lowered).length > TAG_MAX_CHARS) return null;
  return lowered;
}

/**
 * universities から name で探して、無ければ insert する
 * - UNIQUE(name) を貼ってるので同時投稿で競合する可能性がある
 * - 競合(23505)なら再検索してIDを取る
 */
async function getOrCreateUniversityId(name: string) {
  const { data: found, error: findErr } = await supabaseAdmin
    .from('universities')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('universities')
    .insert({ name })
    .select('id')
    .single();

  // unique違反（同時投稿）対策：負けた側は再取得して整合
  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('universities')
      .select('id')
      .eq('name', name)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('university conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

/**
 * subjects を (university_id, name) で探して無ければ insert
 * - DBに UNIQUE(university_id, name) がある前提
 * - 同時投稿競合(23505)なら再検索
 */
async function getOrCreateSubjectId(universityId: string, subjectName: string) {
  const { data: found, error: findErr } = await supabaseAdmin
    .from('subjects')
    .select('id')
    .eq('university_id', universityId)
    .eq('name', subjectName)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('subjects')
    .insert({ university_id: universityId, name: subjectName })
    .select('id')
    .single();

  // UNIQUE(university_id, name) 競合対策
  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('university_id', universityId)
      .eq('name', subjectName)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('subject conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

/**
 * users を line_user_hash で探して無ければ insert
 * - 生のLINE userIdはDBに保存しない
 * - 競合時は再検索で整合を取る
 */
async function getOrCreateUserId(lineUserId: string) {
  const hash = lineUserIdToHash(lineUserId);

  const { data: found, error: findErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('line_user_hash', hash)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('users')
    .insert({ line_user_hash: hash })
    .select('id')
    .single();

  if (insErr && (insErr as any).code === '23505') {
    const { data: again, error: againErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('line_user_hash', hash)
      .single();

    if (againErr) throw againErr;
    if (!again) throw new Error('user conflict retry failed');
    return again.id;
  }

  if (insErr) throw insErr;
  return inserted.id;
}

export async function POST(req: Request) {
  /**
   * 途中で失敗したときに「レビュー本体だけ残る」事故を防ぐため、
   * insertしたreview_idを控えておく（cleanup用）
   */
  let insertedReviewId: string | null = null;

  try {
    // 受信JSONをPayloadとして扱う（この段階では信用しない）
    const body = (await req.json()) as Payload;

    // テキスト系は前処理でtrimしておく（DBのbtrimチェックに寄せる）
    const universityName = body.university_name?.trim();
    const faculty = body.faculty?.trim();
    const department = body.department?.trim() || null;
    const subjectName = body.subject_name?.trim();

    // 教師：空白は落とす。未入力は空配列になる。
    const teacherNames = (body.teacher_names ?? [])
      .map((s) => (s ?? '').trim())
      .filter(Boolean);

    // 本文（bodies側で30文字制約があるが、API側でも先に弾いてUXを良くする）
    const comment = body.body_main?.trim();

    // タグ（任意）
    const rawTags = Array.isArray(body.hashtags)
      ? body.hashtags
      : typeof body.hashtags === 'string'
        ? body.hashtags.replace(/＃/g, '#').replace(/#/g, ' ').split(/[\s,]+/)
        : [];
    const normalizedTags = rawTags
      .map((t) => normalizeTag(String(t)))
      .filter((t): t is string => Boolean(t))
      .filter((t, idx, arr) => arr.indexOf(t) === idx)
      .slice(0, TAG_MAX);

    // ----------------------------
    // 1) 最低限の入力チェック
    // ----------------------------
    // （数値範囲の細かい検証はDB制約に任せる。APIで二重に書くとメンテ死ぬ）
    if (!body.line_user_id) {
      return NextResponse.json({ error: 'line_user_id is required' }, { status: 400 });
    }
    if (!universityName || !faculty || !subjectName) {
      return NextResponse.json({ error: 'missing required text' }, { status: 400 });
    }
    if (teacherNames.length === 0) {
      return NextResponse.json({ error: 'teacher_names is required' }, { status: 400 });
    }
    if (!comment || comment.length < 30) {
      return NextResponse.json({ error: 'comment must be >= 30 chars' }, { status: 400 });
    }

    if (body.academic_year != null) {
      if (body.academic_year < 1990 || body.academic_year > 2100) {
        return NextResponse.json({ error: 'academic_year must be between 1990 and 2100' }, { status: 400 });
      }
    }

    if (body.term != null) {
      const allowedTerms: TermCode[] = ['s1', 's2', 'q1', 'q2', 'q3', 'q4', 'full', 'intensive', 'other'];
      if (!allowedTerms.includes(body.term)) {
        return NextResponse.json({ error: 'term is invalid' }, { status: 400 });
      }
    }

    if (body.credits_at_take != null) {
      if (!Number.isInteger(body.credits_at_take) || body.credits_at_take <= 0) {
        return NextResponse.json({ error: 'credits_at_take must be positive integer' }, { status: 400 });
      }
    }

    if (
      body.class_difficulty < 1 ||
      body.class_difficulty > 5 ||
      body.assignment_difficulty_4 < 1 ||
      body.assignment_difficulty_4 > 5 ||
      body.recommendation < 1 ||
      body.recommendation > 5
    ) {
      return NextResponse.json({ error: 'ratings must be between 1 and 5' }, { status: 400 });
    }

    // ----------------------------
    // 2) user と university の確定
    // ----------------------------
    // 並列実行できるので Promise.all
    const [userId, universityId] = await Promise.all([
      getOrCreateUserId(body.line_user_id),
      getOrCreateUniversityId(universityName),
    ]);

    // ----------------------------
    // 3) user_affiliations を最新状態として upsert
    // ----------------------------
    // 履歴を持たない運用（最新のみ保持）
    {
      const { error: affErr } = await supabaseAdmin
        .from('user_affiliations')
        .upsert(
          {
            user_id: userId,
            university_id: universityId,
            faculty,
            department,
          },
          { onConflict: 'user_id' }
        );

      if (affErr) {
        return NextResponse.json(
          { error: 'failed to upsert user_affiliations', details: supabaseErrorToJson(affErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 4) subject の確定（大学＋授業名で一意）
    // ----------------------------
    const subjectId = await getOrCreateSubjectId(universityId, subjectName);

    // ----------------------------
    // 5) course_reviews（本文含む）を insert
    // ----------------------------
    // 重要：
    // - course_reviews に university_id はもう無い（subject経由で取る）
    const { data: inserted, error: insReviewErr } = await supabaseAdmin
      .from('course_reviews')
      .insert({
        user_id: userId,
        subject_id: subjectId,

        faculty,
        department,
        grade_at_take: body.grade_at_take,

    // 教師は必須だが、念のため空ならNULLに統一
        teacher_names: teacherNames.length > 0 ? teacherNames : null,

        academic_year: body.academic_year ?? null,
        term: body.term ?? null,
        credits_at_take: body.credits_at_take ?? null,
        requirement_type_at_take: body.requirement_type_at_take ?? null,

        performance_self: body.performance_self,
        assignment_difficulty_4: body.assignment_difficulty_4,

        credit_ease: body.credit_ease ?? null,
        class_difficulty: body.class_difficulty,
        assignment_load: body.assignment_load ?? null,
        attendance_strictness: body.attendance_strictness ?? null,
        satisfaction: body.satisfaction ?? null,
        recommendation: body.recommendation,
        body_main: comment,
      })
      .select('id')
      .single();

    if (insReviewErr || !inserted?.id) {
      return NextResponse.json(
        { error: 'failed to insert course_reviews', details: supabaseErrorToJson(insReviewErr) },
        { status: 400 }
      );
    }

    insertedReviewId = inserted.id;

    // ----------------------------
    // 6) course_review_ai_flags（任意）
    // ----------------------------
    if (body.ai_flagged === true) {
      const { error: flagErr } = await supabaseAdmin
        .from('course_review_ai_flags')
        .insert({
          review_id: insertedReviewId,
          ai_flagged: true,
          severity: body.ai_severity ?? null,
          raw_json: body.ai_raw_json ?? null,
        });

      if (flagErr) {
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to insert course_review_ai_flags', details: supabaseErrorToJson(flagErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 6.5) hashtags（任意・失敗してもレビューは残す）
    // ----------------------------
    if (normalizedTags.length > 0) {
      try {
        const tagPayload = normalizedTags.map((name) => ({ name }));
        const { data: tagRows, error: tagErr } = await supabaseAdmin
          .from('review_tags')
          .upsert(tagPayload, { onConflict: 'name' })
          .select('id,name,usage_count');

        if (tagErr) throw tagErr;

        const links = (tagRows || []).map((t) => ({
          review_id: insertedReviewId,
          tag_id: t.id,
        }));

        if (links.length > 0) {
          const { error: linkErr } = await supabaseAdmin
            .from('course_review_tags')
            .upsert(links, { onConflict: 'review_id,tag_id' });
          if (linkErr) throw linkErr;
        }

        for (const t of tagRows || []) {
          const nextCount = Number.isFinite(t.usage_count) ? Number(t.usage_count) + 1 : 1;
          const { error: updErr } = await supabaseAdmin
            .from('review_tags')
            .update({ usage_count: nextCount, updated_at: new Date().toISOString() })
            .eq('id', t.id);
          if (updErr) throw updErr;
        }
      } catch (e) {
        console.error('[course-reviews] tag upsert failed:', e);
      }
    }

    // ----------------------------
    // 7) embedding_jobs を queued で積む
    // ----------------------------
    // バッチ処理は「jobsを見て処理する」想定にすると運用が楽。
    // - 未処理レビュー探索が確実
    // - リトライ/ロック/失敗管理がやりやすい
    {
      const { error: jobErr } = await supabaseAdmin
        .from('embedding_jobs')
        .upsert(
          {
            review_id: insertedReviewId,
            status: 'queued',
            attempt_count: 0,
            last_error: null,
            locked_at: null,
            locked_by: null,
          },
          { onConflict: 'review_id' }
        );

      if (jobErr) {
        // ここで落ちると「レビューはあるのにジョブが無い」状態になって後で面倒
        // 編集機能なし運用なら潔くロールバックでOK
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to upsert embedding_jobs', details: supabaseErrorToJson(jobErr) },
          { status: 500 }
        );
      }
    }

    // ----------------------------
    // 8) subject_rollups を dirty にする
    // ----------------------------
    // 投稿時点では集計・要約は更新しない（遅い/失敗がUX悪化）
    // バッチが is_dirty=true を拾って集計(avg/count/summary)を更新する
    {
      const { error: rollErr } = await supabaseAdmin
        .from('subject_rollups')
        .upsert(
          {
            subject_id: subjectId,
            is_dirty: true,
          },
          { onConflict: 'subject_id' }
        );

      if (rollErr) {
        // dirtyが立たないと rollups更新が走らないので、これもロールバックで揃える
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
        insertedReviewId = null;

        return NextResponse.json(
          { error: 'failed to upsert subject_rollups', details: supabaseErrorToJson(rollErr) },
          { status: 500 }
        );
      }
    }

    // 成功レスポンス
    return NextResponse.json({ ok: true, review_id: insertedReviewId });
  } catch (e: any) {
    // 予期しない例外（JSON parse失敗やsupabaseのthrowなど）
    console.error('[course-reviews] POST error:', e);

    // 例外でも片肺防止：reviewだけ作れてる可能性があるので削除を試みる
    if (insertedReviewId) {
      try {
        await supabaseAdmin.from('course_reviews').delete().eq('id', insertedReviewId);
      } catch {
        // ここでさらにエラー出ても、APIレスポンスの邪魔なので握りつぶす
      }
    }

    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
