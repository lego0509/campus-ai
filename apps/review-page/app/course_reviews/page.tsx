'use client';

import { useEffect, useMemo, useState } from 'react';
import liff from '@line/liff';

import SectionCard from '../../components/SectionCard';
import StarRating from '../../components/StarRating';
import TextCounterTextarea from '../../components/TextCounterTextarea';

const MIN_COMMENT_LENGTH = 30;
const REASON_MAX_CHARS = 60;

/**
 * JSの `.length` は絵文字など（サロゲートペア）でズレることがある。
 * DB側の `char_length()` と概ね揃えるため、コードポイント数で数える。
 * （これで「フロントOKなのにDBで30未満扱い」事故が減る）
 */
const charLen = (s: string) => Array.from(s).length;
const truncateReason = (s: string, max = REASON_MAX_CHARS) => {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
};

// 学年（DB保存値：1..6 / その他=99）
const gradeOptions = [
  { label: '1年生', value: 1 },
  { label: '2年生', value: 2 },
  { label: '3年生', value: 3 },
  { label: '4年生', value: 4 },
  { label: '5年生', value: 5 },
  { label: '6年生', value: 6 },
  { label: 'その他', value: 99 },
] as const;

// 学期（DB保存値）
const termOptions = [
  { label: '前期', value: 's1' },
  { label: '後期', value: 's2' },
  { label: 'Q1', value: 'q1' },
  { label: 'Q2', value: 'q2' },
  { label: 'Q3', value: 'q3' },
  { label: 'Q4', value: 'q4' },
  { label: '通年', value: 'full' },
  { label: '集中', value: 'intensive' },
  { label: 'その他', value: 'other' },
] as const;

const requirementTypeOptions = [
  { label: '必修', value: 'required' },
  { label: '選択', value: 'elective' },
  { label: '不明', value: 'unknown' },
] as const;

// 4段階：成績（DB保存値：1..4）
const performanceOptions = [
  { label: '未評価', value: 1 },
  { label: '単位なし', value: 2 },
  { label: '単位あり（普通）', value: 3 },
  { label: '単位あり（高評価）', value: 4 },
] as const;

// 4段階：課題の難易度（DB保存値：1..4）
const assignmentDifficultyOptions = [
  { label: '無し', value: 1 },
  { label: '易', value: 2 },
  { label: '中', value: 3 },
  { label: '難', value: 4 },
] as const;

// 5段階評価（DB列名に合わせる）
const assessmentOptions = [
  { key: 'credit_ease', label: '単位取得の容易さ' },
  { key: 'class_difficulty', label: '授業の難易度（内容）' },
  { key: 'assignment_load', label: '課題の量' },
  { key: 'attendance_strictness', label: '出席の厳しさ' },
  { key: 'satisfaction', label: '満足度' },
  { key: 'recommendation', label: 'おすすめ度' },
] as const;

type RatingKey = (typeof assessmentOptions)[number]['key'];

function buildAcademicYearOptions() {
  const now = new Date();
  const current = now.getFullYear();
  const start = 2020; // 必要なら変える
  const end = current + 1; // 来年度分まで
  const years: number[] = [];
  for (let y = end; y >= start; y--) years.push(y);
  return years;
}

const academicYearOptions = buildAcademicYearOptions();

export default function ReviewFormPage() {
  const requiredBadge = (show: boolean, className = '') =>
    show ? (
      <span
        className={`rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white ${className}`}
      >
        必須
      </span>
    ) : null;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showModerationModal, setShowModerationModal] = useState(false);

  // LIFFから取れるLINEの生userId（DBには保存しない）
  const [lineUserId, setLineUserId] = useState<string>('');
  const [liffError, setLiffError] = useState<string>('');

  /**
   * このシステムで使うユーザーID（users.id）
   * - 画面上の表示はこれに寄せる（デバッグや照合が楽）
   */
  const [systemUserId, setSystemUserId] = useState<string>('');

  // フォーム本体
  const [form, setForm] = useState({
    // ユーザー情報
    university: '',
    faculty: '',
    department: '',
    gradeAtTake: 0, // 1..6 / 99

    // 授業情報
    courseName: '',
    teacherNames: [''] as string[], // ★UIとして入力欄は残すが、必須にはしない

    // 受講情報
    academicYear: new Date().getFullYear(), // 必須（デフォルト今年）
    term: '', // 必須（s1/s2/q1..）
    creditsAtTake: '', // 必須（文字列で保持してバリデーション）
    requirementTypeAtTake: '', // 必須（required/elective/unknown）

    // 4段階
    performanceSelf: 0, // 1..4
    assignmentDifficulty4: 0, // 1..4

    // 5段階
    ratings: assessmentOptions.reduce(
      (acc, curr) => ({ ...acc, [curr.key]: 0 }),
      {} as Record<RatingKey, number>
    ),

    // コメント
    comment: '',
  });

  // ----------------------------
  // 1) LIFF init（本番） / ローカルはダミーID（開発）
  // ----------------------------
  useEffect(() => {
    let canceled = false;

    const init = async () => {
      try {
        // ローカル(PCブラウザ)ではLIFFが成立しないことが多いので、開発用IDを優先
        if (process.env.NODE_ENV === 'development') {
          const devId = process.env.NEXT_PUBLIC_DEV_LINE_USER_ID;
          if (devId && !canceled) {
            setLineUserId(devId);
            return;
          }
        }

        const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) throw new Error('NEXT_PUBLIC_LIFF_ID is not set');

        await liff.init({ liffId });

        if (!liff.isLoggedIn()) {
          // 未ログインならログインフローへ
          liff.login();
          return;
        }

        const profile = await liff.getProfile();
        if (!canceled) setLineUserId(profile.userId);
      } catch (e: any) {
        if (!canceled) setLiffError(e?.message ?? 'LIFF init failed');
      }
    };

    init();
    return () => {
      canceled = true;
    };
  }, []);

  // ----------------------------
  // 2) lineUserId → users.id を解決して表示用に保持する
  // ----------------------------
  useEffect(() => {
    let canceled = false;

    const resolveSystemUser = async () => {
      // lineUserIdが無いと解決できない
      if (!lineUserId) return;

      setSystemUserId('');

      try {
        const res = await fetch('/api/users/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ line_user_id: lineUserId }),
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          const msg =
            typeof json?.error === 'string'
              ? json.error
              : json?.error?.message
                ? json.error.message
                : `ユーザーID解決に失敗（HTTP ${res.status}）`;
          throw new Error(msg);
        }

        if (!canceled) setSystemUserId(String(json.user_id ?? ''));
      } catch {
        // 表示は出さない（背景で失敗しても入力は続けられるようにする）
      }
    };

    resolveSystemUser();

    return () => {
      canceled = true;
    };
  }, [lineUserId]);

  // ----------------------------
  // 3) systemUserId（users.id）が取れたら、所属を取ってフォームに事前入力する
  // ----------------------------
  useEffect(() => {
    let canceled = false;
  
    const prefillAffiliation = async () => {
      if (!systemUserId) return;
  
      try {
        const res = await fetch('/api/user-affiliations/latest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: systemUserId }),
        });
  
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            typeof json?.error === 'string'
              ? json.error
              : json?.error?.message
                ? json.error.message
                : `所属の取得に失敗（HTTP ${res.status}）`;
          throw new Error(msg);
        }
  
        const aff = json?.affiliation;
        if (!aff) return;
  
        // ユーザーが既に入力してたら上書きしない（体験を壊さない）
        if (canceled) return;
        setForm((prev) => {
          const universityEmpty = prev.university.trim().length === 0;
          const facultyEmpty = prev.faculty.trim().length === 0;
          const departmentEmpty = prev.department.trim().length === 0;
  
          return {
            ...prev,
            university: universityEmpty ? String(aff.university_name ?? '') : prev.university,
            faculty: facultyEmpty ? String(aff.faculty ?? '') : prev.faculty,
            department: departmentEmpty ? String(aff.department ?? '') : prev.department,
          };
        });
      } catch (e) {
        // ここはフォーム利用自体を止めるほどではないので、静かにログだけ
        console.warn('[prefill affiliation] failed:', e);
      }
    };
  
    prefillAffiliation();
  
    return () => {
      canceled = true;
    };
  }, [systemUserId]);

  // ----------------------------
  // フォーム操作系ヘルパ
  // ----------------------------
  const handleTextChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleNumberChange = (field: keyof typeof form, value: number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateRating = (key: RatingKey, value: number) => {
    setForm((prev) => ({ ...prev, ratings: { ...prev.ratings, [key]: value } }));
  };

  const updateTeacherName = (index: number, value: string) => {
    setForm((prev) => {
      const next = [...prev.teacherNames];
      next[index] = value;
      return { ...prev, teacherNames: next };
    });
  };

  const addTeacher = () => {
    setForm((prev) => {
      if (prev.teacherNames.length >= 5) return prev; // 上限
      return { ...prev, teacherNames: [...prev.teacherNames, ''] };
    });
  };

  const removeTeacher = (index: number) => {
    setForm((prev) => {
      // 1人目も削除できるようにして、空欄1つに戻す（入力欄が消えないUI）
      const next = prev.teacherNames.filter((_, i) => i !== index);
      return { ...prev, teacherNames: next.length ? next : [''] };
    });
  };

  /**
   * teacher_names は任意。
   * - 空欄・空白は除外して送る
   * - 最終的に空なら null を送る（DB側も許容）
   */
  const normalizedTeacherNames = useMemo(() => {
    return form.teacherNames.map((t) => t.trim()).filter((t) => t.length > 0);
  }, [form.teacherNames]);

  /**
   * 単位数：空ならnull、入力があるなら整数として扱う
   */
  const creditsValue = useMemo(() => {
    const raw = form.creditsAtTake.trim();
    if (raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) return NaN;
    return n;
  }, [form.creditsAtTake]);

  const isCreditsValid = Number.isFinite(creditsValue) && creditsValue !== null && creditsValue > 0;

  // ----------------------------
  // フォームの妥当性チェック（送信ボタンの活性/非活性）
  // ----------------------------
  const isFormValid = useMemo(() => {
    // 必須テキスト
    const requiredText = [form.university, form.faculty, form.courseName];
    if (!requiredText.every((v) => v.trim().length > 0)) return false;

    // 必須セレクト
    if (form.gradeAtTake === 0) return false;
    if (form.term.trim().length === 0) return false;
    if (form.requirementTypeAtTake.trim().length === 0) return false;

    // ★教員名は任意なので、ここで必須判定しない

    // 4段階：どちらも必須
    if (form.performanceSelf < 1 || form.performanceSelf > 4) return false;
    if (form.assignmentDifficulty4 < 1 || form.assignmentDifficulty4 > 4) return false;

    // 5段階：全部必須
    const hasAllRatings = Object.values(form.ratings).every((val) => val >= 1 && val <= 5);
    if (!hasAllRatings) return false;

    // コメント長：コードポイント数で判定（絵文字対策）
    if (charLen(form.comment.trim()) < MIN_COMMENT_LENGTH) return false;

    // 単位数：必須
    if (!Number.isFinite(creditsValue) || creditsValue === null || creditsValue <= 0) return false;

    // 年度：範囲チェック
    if (form.academicYear < 1990 || form.academicYear > 2100) return false;

    return true;
  }, [form, creditsValue]);

  // ----------------------------
  // 送信処理
  // ----------------------------
  const handleSubmit = async () => {
    if (!isFormValid || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError('');
    setShowSubmitModal(false);

    try {
      let moderationResult: {
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
      } | null = null;

      {
        try {
          setShowModerationModal(true);
          const moderationRes = await fetch('/api/review-moderation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: [
                { key: 'university', label: '大学名', value: form.university.trim() },
                { key: 'faculty', label: '学部名', value: form.faculty.trim() },
                { key: 'department', label: '学科名', value: form.department.trim() },
                { key: 'courseName', label: '科目名', value: form.courseName.trim() },
                {
                  key: 'teacherNames',
                  label: '教員名',
                  value: normalizedTeacherNames.join(' / '),
                },
                { key: 'comment', label: 'コメント', value: form.comment.trim() },
              ],
            }),
          });

          const moderationJson = await moderationRes.json().catch(() => ({}));

          if (!moderationRes.ok || !moderationJson?.ok) {
            throw new Error(
              typeof moderationJson?.error === 'string'
                ? moderationJson.error
                : 'コメントの判定に失敗しました。もう一度お試しください。'
            );
          }

          moderationResult = moderationJson.result ?? null;

          if (moderationResult?.ai_flagged) {
            const flaggedDetails =
              moderationResult.details?.filter((d) => d.ai_flagged) ?? [];
            const reasonLines =
              flaggedDetails.length > 0
                ? flaggedDetails.map((d) => `・${d.label}: ${truncateReason(d.reason)}`)
                : moderationResult.reason?.trim()
                  ? [`・${truncateReason(moderationResult.reason.trim())}`]
                  : [];
            const reasonText =
              reasonLines.length > 0 ? `${reasonLines.join('\n')}\n` : '';
            const confirmSend = window.confirm(
              `不適切なレビューの可能性があります。\n` +
                `AIの自動判定のため、誤検知の可能性もあります。\n` +
                reasonText +
                `このまま送信しますか？\n` +
                `（送信すると記録されます）`
            );

            if (!confirmSend) {
              const inlineReason =
                reasonLines.length > 0 ? reasonLines.join('\n') : moderationResult.reason || '';
              setSubmitError(
                inlineReason.length > 0
                  ? `不適切と判定された箇所があります。\n${inlineReason}`
                  : 'コメントを修正してください。'
              );
              return;
            }
          }
        } finally {
          setShowModerationModal(false);
        }
      }

      // LINE userId が取れてないと、サーバ側で users.id を作れない
      if (!lineUserId) {
        throw new Error('LINEユーザー情報を取得できていません（LIFF未初期化 or 開発用ID未設定）');
      }

      // APIが受け取るsnake_case payloadに合わせて組み立てる
      const payload = {
        university_name: form.university.trim(),
        faculty: form.faculty.trim(),
        department: form.department.trim() || null,
        grade_at_take: form.gradeAtTake,

        subject_name: form.courseName.trim(),

        // ★教員は任意：空ならnull（route.tsでもnull扱いするが、前で揃えておく）
        teacher_names: normalizedTeacherNames.length > 0 ? normalizedTeacherNames : null,

        academic_year: form.academicYear,
        term: form.term,
        credits_at_take: creditsValue,
        requirement_type_at_take: form.requirementTypeAtTake,

        performance_self: form.performanceSelf,
        assignment_difficulty_4: form.assignmentDifficulty4,

        ...form.ratings,

        body_main: form.comment.trim(),

        ...(moderationResult?.ai_flagged
          ? {
              ai_flagged: true,
              ai_severity: moderationResult.severity,
              ai_raw_json: moderationResult.raw_json,
            }
          : {}),
      };

      const res = await fetch('/api/course-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_user_id: lineUserId,
          ...payload,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        // route.ts は { error, details } を返すので、detailsがあれば表示に混ぜて原因追跡しやすくする
        const baseMsg =
          typeof json?.error === 'string'
            ? json.error
            : json?.error?.message
              ? json.error.message
              : `投稿に失敗しました（HTTP ${res.status}）`;

        const detailMsg =
          typeof json?.details?.message === 'string' ? ` / ${json.details.message}` : '';

        throw new Error(`${baseMsg}${detailMsg}`);
      }

      setForm((prev) => ({
        ...prev,
        courseName: '',
        teacherNames: [''],
        academicYear: new Date().getFullYear(),
        term: '',
        creditsAtTake: '',
        requirementTypeAtTake: '',
        performanceSelf: 0,
        assignmentDifficulty4: 0,
        ratings: assessmentOptions.reduce(
          (acc, curr) => ({ ...acc, [curr.key]: 0 }),
          {} as Record<RatingKey, number>
        ),
        comment: '',
      }));
      setShowSubmitModal(true);
    } catch (e: any) {
      setSubmitError(e?.message ?? '送信処理でエラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen justify-center px-3 py-4 sm:px-4">
      <div className="w-full max-w-xl space-y-4 rounded-2xl bg-white/80 p-4 shadow-soft backdrop-blur-sm">
        <header className="space-y-1">
          <p className="text-lg font-bold text-gray-900">授業レビュー投稿</p>
        </header>

        {liffError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            LIFF: {liffError}
          </div>
        ) : null}

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <SectionCard title="ユーザー情報" subtitle="大学・学部・学年（受講時点）を入力してください">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="university">
                  <span>大学名</span>
                  {requiredBadge(form.university.trim().length === 0)}
                </label>
                <input
                  id="university"
                  className="control"
                  placeholder="例：東京大学"
                  value={form.university}
                  onChange={(e) => handleTextChange('university', e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field-wrapper">
                  <label className="label flex items-center justify-between" htmlFor="faculty">
                    <span>学部名</span>
                    {requiredBadge(form.faculty.trim().length === 0)}
                  </label>
                  <input
                    id="faculty"
                    className="control"
                    placeholder="例：工学部"
                    value={form.faculty}
                    onChange={(e) => handleTextChange('faculty', e.target.value)}
                  />
                </div>

                <div className="field-wrapper">
                  <label className="label" htmlFor="department">
                    学科名
                  </label>
                  <input
                    id="department"
                    className="control"
                    placeholder="例：情報工学科（任意）"
                    value={form.department}
                    onChange={(e) => handleTextChange('department', e.target.value)}
                  />
                </div>
              </div>

              <div className="field-wrapper sm:max-w-xs">
                <label className="label flex items-center justify-between" htmlFor="gradeAtTake">
                  <span>学年</span>
                  {requiredBadge(form.gradeAtTake === 0)}
                </label>
                <select
                  id="gradeAtTake"
                  className="control"
                  value={form.gradeAtTake === 0 ? '' : String(form.gradeAtTake)}
                  onChange={(e) => handleNumberChange('gradeAtTake', Number(e.target.value))}
                >
                  <option value="">学年を選択</option>
                  {gradeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="授業情報" subtitle="科目名を入力してください（教員名は任意です）">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="courseName">
                  <span>科目名</span>
                  {requiredBadge(form.courseName.trim().length === 0)}
                </label>
                <input
                  id="courseName"
                  className="control"
                  placeholder="例：データベース概論"
                  value={form.courseName}
                  onChange={(e) => handleTextChange('courseName', e.target.value)}
                />
              </div>

              <div className="space-y-3">
                {form.teacherNames.map((name, idx) => (
                  <div key={idx} className="grid gap-2">
                    <div className="flex items-end justify-between gap-2">
                      <label className="label" htmlFor={`teacher-${idx}`}>
                        教員名（任意）
                      </label>
                      {form.teacherNames.length > 1 ? (
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-gray-800"
                          onClick={() => removeTeacher(idx)}
                        >
                          削除
                        </button>
                      ) : null}
                    </div>
                    <input
                      id={`teacher-${idx}`}
                      className="control"
                      placeholder={idx === 0 ? '例：山田太郎（空欄OK）' : '例：共同担当の先生（任意）'}
                      value={name}
                      onChange={(e) => updateTeacherName(idx, e.target.value)}
                    />
                  </div>
                ))}

                <div>
                  <button
                    type="button"
                    className="button-secondary w-full sm:w-auto"
                    onClick={addTeacher}
                    disabled={form.teacherNames.length >= 5}
                  >
                    ＋ 教員を追加（任意）
                  </button>
                  <p className="mt-1 text-xs text-gray-500">複数教員の場合のみ追加してください（最大5名）</p>
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="受講情報" subtitle="年度・学期・必修区分などを入力してください">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="academicYear">
                  <span>受講年度</span>
                  {requiredBadge(Number.isNaN(form.academicYear))}
                </label>
                <select
                  id="academicYear"
                  className="control"
                  value={String(form.academicYear)}
                  onChange={(e) => handleNumberChange('academicYear', Number(e.target.value))}
                >
                  {academicYearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}年度
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="term">
                  <span>学期</span>
                  {requiredBadge(form.term.trim().length === 0)}
                </label>
                <select
                  id="term"
                  className="control"
                  value={form.term}
                  onChange={(e) => handleTextChange('term', e.target.value)}
                >
                  <option value="">学期を選択</option>
                  {termOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="creditsAtTake">
                  <span>単位数</span>
                  {requiredBadge(!isCreditsValid)}
                </label>
                <input
                  id="creditsAtTake"
                  className="control"
                  inputMode="numeric"
                  placeholder="例：2（任意）"
                  value={form.creditsAtTake}
                  onChange={(e) => handleTextChange('creditsAtTake', e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-500">正の整数で入力してください</p>
              </div>

              <div className="field-wrapper">
                <label
                  className="label flex items-center justify-between"
                  htmlFor="requirementTypeAtTake"
                >
                  <span>必修/選択</span>
                  {requiredBadge(form.requirementTypeAtTake.trim().length === 0)}
                </label>
                <select
                  id="requirementTypeAtTake"
                  className="control"
                  value={form.requirementTypeAtTake}
                  onChange={(e) => handleTextChange('requirementTypeAtTake', e.target.value)}
                >
                  <option value="">選択してください</option>
                  {requirementTypeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="成績・課題難易度" subtitle="短い選択項目をまとめています（必須）">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 text-sm text-gray-700">
                <p className="label flex items-center justify-between">
                  <span>成績</span>
                  {requiredBadge(form.performanceSelf === 0)}
                </p>
                {performanceOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="performanceSelf"
                      value={opt.value}
                      checked={form.performanceSelf === opt.value}
                      onChange={(e) => handleNumberChange('performanceSelf', Number(e.target.value))}
                      className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-400"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>

              <div className="space-y-2 text-sm text-gray-700">
                <p className="label flex items-center justify-between">
                  <span>課題の難易度</span>
                  {requiredBadge(form.assignmentDifficulty4 === 0)}
                </p>
                {assignmentDifficultyOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="assignmentDifficulty4"
                      value={opt.value}
                      checked={form.assignmentDifficulty4 === opt.value}
                      onChange={(e) => handleNumberChange('assignmentDifficulty4', Number(e.target.value))}
                      className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="評価"
            subtitle="すべての項目を1~5で評価してください（教材や形式はコメント欄に書いてください）"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {assessmentOptions.map((item) => (
                  <StarRating
                    key={item.key}
                    label={item.label}
                    value={form.ratings[item.key]}
                    onChange={(val) => updateRating(item.key, val)}
                    required
                  />
              ))}
            </div>
          </SectionCard>

          <SectionCard title="コメント" subtitle="30文字以上でご記入ください（教材・形式・テスト方式などもここに）">
            {submitError ? (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {submitError}
              </div>
            ) : null}
            <TextCounterTextarea
              label={
                <span className="flex items-center">
                  コメント
                  {requiredBadge(charLen(form.comment.trim()) < MIN_COMMENT_LENGTH, 'ml-2')}
                </span>
              }
              value={form.comment}
              onChange={(val) => handleTextChange('comment', val)}
              minLength={MIN_COMMENT_LENGTH}
              placeholder="例：教材、授業形式、テスト形式、課題量、出席の厳しさなどをまとめて書いてください"
            />
          </SectionCard>

          <div className="sticky bottom-0 left-0 right-0 z-10 -mx-4 mt-2 bg-white/95 px-4 pb-3 pt-3 backdrop-blur">
            <button
              type="button"
              className="button-primary w-full"
              disabled={!isFormValid || isSubmitting}
              onClick={handleSubmit}
            >
              {isSubmitting ? '送信中...' : 'レビューを投稿する'}
            </button>
          </div>
        </div>
      </div>
      {showSubmitModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center shadow-xl">
            <p className="text-base font-semibold text-gray-900">投稿しました！</p>
            <p className="mt-2 text-sm text-gray-600">ご協力ありがとうございます。</p>
            <button
              type="button"
              className="mt-4 w-full rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white"
              onClick={() => setShowSubmitModal(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      ) : null}
      {showModerationModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
            <p className="text-base font-semibold text-gray-900">投稿内容を検査中…</p>
            <p className="mt-2 text-sm text-gray-600">少しだけお待ちください</p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
