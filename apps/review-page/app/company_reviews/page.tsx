'use client';

import { useEffect, useMemo, useState } from 'react';
import liff from '@line/liff';

import SectionCard from '../../components/SectionCard';
import TextCounterTextarea from '../../components/TextCounterTextarea';

const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
] as const;

const outcomeOptions = [
  { label: '内定', value: 'offer' },
  { label: '不採用', value: 'rejected' },
  { label: 'その他', value: 'other' },
] as const;

const selectionTypeOptions = [
  { label: 'ES', value: 'es' },
  { label: 'テスト', value: 'test' },
  { label: '面接', value: 'interview' },
  { label: 'GD', value: 'gd' },
  { label: '課題', value: 'assignment' },
  { label: 'その他', value: 'other' },
] as const;

const salaryBandOptions = [
  { label: '300万円未満', value: 'under_300' },
  { label: '300〜399万円', value: '300_399' },
  { label: '400〜499万円', value: '400_499' },
  { label: '500〜599万円', value: '500_599' },
  { label: '600〜699万円', value: '600_699' },
  { label: '700〜799万円', value: '700_799' },
  { label: '800〜899万円', value: '800_899' },
  { label: '900〜999万円', value: '900_999' },
  { label: '1000万円以上', value: '1000_plus' },
] as const;

function buildGradYearOptions() {
  const now = new Date();
  const current = now.getFullYear();
  const start = 1990;
  const end = current + 6;
  const years: number[] = [];
  for (let y = end; y >= start; y--) years.push(y);
  return years;
}

const gradYearOptions = buildGradYearOptions();

type SelectionType = (typeof selectionTypeOptions)[number]['value'];

type FieldErrors = Record<string, string>;

export default function CompanyReviewFormPage() {
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
  const [showErrors, setShowErrors] = useState(false);

  const [lineUserId, setLineUserId] = useState<string>('');
  const [liffError, setLiffError] = useState<string>('');
  const [systemUserId, setSystemUserId] = useState<string>('');

  const [form, setForm] = useState({
    university: '',
    faculty: '',
    department: '',
    gradYear: '',

    companyName: '',
    hqPrefecture: '',

    outcome: '',
    resultMonth: '',
    selectionTypes: [] as SelectionType[],

    employeeCount: '',
    annualSalaryBand: '',

    bodyMain: '',
  });

  useEffect(() => {
    let canceled = false;

    const init = async () => {
      try {
        if (process.env.NODE_ENV === 'development') {
          const devId = process.env.NEXT_PUBLIC_DEV_LINE_USER_ID;
          if (devId && !canceled) {
            setLineUserId(devId);
            return;
          }
        }

        const liffId =
          process.env.NEXT_PUBLIC_LIFF_ID_COMPANY || process.env.NEXT_PUBLIC_LIFF_ID;
        if (!liffId) {
          throw new Error('NEXT_PUBLIC_LIFF_ID_COMPANY is not set');
        }

        await liff.init({ liffId });

        if (!liff.isLoggedIn()) {
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

  useEffect(() => {
    let canceled = false;

    const resolveSystemUser = async () => {
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
        // background only
      }
    };

    resolveSystemUser();

    return () => {
      canceled = true;
    };
  }, [lineUserId]);

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
        console.warn('[prefill affiliation] failed:', e);
      }
    };

    prefillAffiliation();

    return () => {
      canceled = true;
    };
  }, [systemUserId]);

  const handleTextChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const toggleSelectionType = (value: SelectionType) => {
    setForm((prev) => {
      const exists = prev.selectionTypes.includes(value);
      return {
        ...prev,
        selectionTypes: exists
          ? prev.selectionTypes.filter((v) => v !== value)
          : [...prev.selectionTypes, value],
      };
    });
  };

  const gradYearValue = useMemo(() => {
    const raw = form.gradYear.trim();
    if (raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) return NaN;
    return n;
  }, [form.gradYear]);

  const employeeCountValue = useMemo(() => {
    const raw = form.employeeCount.trim();
    if (raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) return NaN;
    return n;
  }, [form.employeeCount]);

  const fieldErrors = useMemo<FieldErrors>(() => {
    const errors: FieldErrors = {};

    if (!form.university.trim()) errors.university = '大学名を入力してください';
    if (!form.faculty.trim()) errors.faculty = '学部名を入力してください';

    if (!form.gradYear.trim()) {
      errors.gradYear = '卒業年を入力してください';
    } else if (gradYearValue === null || Number.isNaN(gradYearValue)) {
      errors.gradYear = '卒業年は整数で入力してください';
    } else if (gradYearValue < 1990 || gradYearValue > 2100) {
      errors.gradYear = '卒業年は1990〜2100の範囲で入力してください';
    }

    if (!form.companyName.trim()) errors.companyName = '会社名を入力してください';
    if (!form.hqPrefecture.trim()) {
      errors.hqPrefecture = '本社所在地（都道府県）を選択してください';
    } else if (!PREFECTURES.includes(form.hqPrefecture as (typeof PREFECTURES)[number])) {
      errors.hqPrefecture = '都道府県が不正です';
    }

    if (!form.outcome.trim()) errors.outcome = '結果を選択してください';
    if (!form.resultMonth.trim()) {
      errors.resultMonth = '結果が分かった年月を入力してください';
    } else if (!/^\d{4}-\d{2}$/.test(form.resultMonth)) {
      errors.resultMonth = 'YYYY-MM形式で入力してください';
    }

    if (!form.bodyMain.trim()) errors.bodyMain = '本文を入力してください';

    if (employeeCountValue !== null) {
      if (!Number.isFinite(employeeCountValue) || employeeCountValue <= 0) {
        errors.employeeCount = '社員数は正の整数で入力してください';
      }
    }

    if (form.annualSalaryBand && !salaryBandOptions.some((o) => o.value === form.annualSalaryBand)) {
      errors.annualSalaryBand = '年収帯を選択してください';
    }

    return errors;
  }, [employeeCountValue, form, gradYearValue]);

  const isFormValid = useMemo(() => Object.keys(fieldErrors).length === 0, [fieldErrors]);

  const handleSubmit = async () => {
    if (isSubmitting) return;

    setShowErrors(true);
    setSubmitError('');

    if (!isFormValid) return;

    setIsSubmitting(true);

    try {
      let moderationResult: {
        ai_flagged: boolean;
        severity: number | null;
        reason: string;
        raw_json: Record<string, unknown>;
      } | null = null;

      {
        const moderationRes = await fetch('/api/review-moderation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: form.bodyMain.trim() }),
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
          const confirmSend = window.confirm(
            `不適切なコメントの可能性があります。\n` +
              `このまま送信しますか？\n` +
              `（送信すると記録されます）`
          );

          if (!confirmSend) {
            setSubmitError(moderationResult.reason || 'コメントを修正してください。');
            return;
          }
        }
      }

      if (!lineUserId) {
        throw new Error('LINEユーザー情報を取得できていません（LIFF未初期化 or 開発用ID未設定）');
      }

      const payload = {
        university_name: form.university.trim(),
        faculty: form.faculty.trim(),
        department: form.department.trim() || null,
        grad_year: gradYearValue,

        company_id: null,
        company_name: form.companyName.trim(),
        hq_prefecture: form.hqPrefecture.trim(),

        outcome: form.outcome,
        result_month: form.resultMonth,
        selection_types: form.selectionTypes,
        body_main: form.bodyMain.trim(),

        employee_count: employeeCountValue,
        annual_salary_band: form.annualSalaryBand || null,
        ...(moderationResult?.ai_flagged
          ? {
              ai_flagged: true,
              ai_severity: moderationResult.severity,
              ai_raw_json: moderationResult.raw_json,
            }
          : {}),
      };

      const res = await fetch('/api/company-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_user_id: lineUserId,
          ...payload,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
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
        gradYear: '',
        companyName: '',
        hqPrefecture: '',
        outcome: '',
        resultMonth: '',
        selectionTypes: [],
        employeeCount: '',
        annualSalaryBand: '',
        bodyMain: '',
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
          <p className="text-lg font-bold text-gray-900">会社レビュー投稿</p>
        </header>

        {liffError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            LIFF: {liffError}
          </div>
        ) : null}

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <SectionCard title="ユーザー情報" subtitle="大学・学部・卒業年を入力してください">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="university">
                  <span>大学名</span>
                  {requiredBadge(!form.university.trim())}
                </label>
                <input
                  id="university"
                  className="control"
                  placeholder="例：東京大学"
                  value={form.university}
                  onChange={(e) => handleTextChange('university', e.target.value)}
                />
                {showErrors && fieldErrors.university ? (
                  <p className="text-xs text-red-600">{fieldErrors.university}</p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field-wrapper">
                  <label className="label flex items-center justify-between" htmlFor="faculty">
                    <span>学部名</span>
                    {requiredBadge(!form.faculty.trim())}
                  </label>
                  <input
                    id="faculty"
                    className="control"
                    placeholder="例：工学部"
                    value={form.faculty}
                    onChange={(e) => handleTextChange('faculty', e.target.value)}
                  />
                  {showErrors && fieldErrors.faculty ? (
                    <p className="text-xs text-red-600">{fieldErrors.faculty}</p>
                  ) : null}
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
                <label className="label flex items-center justify-between" htmlFor="gradYear">
                  <span>卒業年</span>
                  {requiredBadge(!form.gradYear.trim() || !!fieldErrors.gradYear)}
                </label>
                <select
                  id="gradYear"
                  className="control"
                  value={form.gradYear}
                  onChange={(e) => handleTextChange('gradYear', e.target.value)}
                >
                  <option value="">選択してください</option>
                  {gradYearOptions.map((year) => (
                    <option key={year} value={String(year)}>
                      {year}
                    </option>
                  ))}
                </select>
                {showErrors && fieldErrors.gradYear ? (
                  <p className="text-xs text-red-600">{fieldErrors.gradYear}</p>
                ) : (
                  <p className="text-xs text-gray-500">1990〜2100の範囲で入力してください</p>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="会社情報" subtitle="正式な会社名を入力してください">
            <div className="grid gap-4">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="companyName">
                  <span>会社名</span>
                  {requiredBadge(!form.companyName.trim())}
                </label>
                <input
                  id="companyName"
                  className="control"
                  placeholder="例：サンプル株式会社"
                  value={form.companyName}
                  onChange={(e) => handleTextChange('companyName', e.target.value)}
                />
                {showErrors && fieldErrors.companyName ? (
                  <p className="text-xs text-red-600">{fieldErrors.companyName}</p>
                ) : (
                  <p className="text-xs text-gray-500">正式名称で入力してください</p>
                )}
              </div>

              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="hqPrefecture">
                  <span>本社所在地（都道府県）</span>
                  {requiredBadge(!form.hqPrefecture.trim())}
                </label>
                <select
                  id="hqPrefecture"
                  className="control"
                  value={form.hqPrefecture}
                  onChange={(e) => handleTextChange('hqPrefecture', e.target.value)}
                >
                  <option value="">都道府県を選択</option>
                  {PREFECTURES.map((pref) => (
                    <option key={pref} value={pref}>
                      {pref}
                    </option>
                  ))}
                </select>
                {showErrors && fieldErrors.hqPrefecture ? (
                  <p className="text-xs text-red-600">{fieldErrors.hqPrefecture}</p>
                ) : null}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="結果・選考" subtitle="結果が分かった時期と選考内容を入力してください">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="outcome">
                  <span>結果</span>
                  {requiredBadge(!form.outcome.trim())}
                </label>
                <select
                  id="outcome"
                  className="control"
                  value={form.outcome}
                  onChange={(e) => handleTextChange('outcome', e.target.value)}
                >
                  <option value="">選択してください</option>
                  {outcomeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {showErrors && fieldErrors.outcome ? (
                  <p className="text-xs text-red-600">{fieldErrors.outcome}</p>
                ) : null}
              </div>

              <div className="field-wrapper">
                <label className="label flex items-center justify-between" htmlFor="resultMonth">
                  <span>結果が分かった年月</span>
                  {requiredBadge(!form.resultMonth.trim())}
                </label>
                <input
                  id="resultMonth"
                  type="month"
                  className="control"
                  value={form.resultMonth}
                  onChange={(e) => handleTextChange('resultMonth', e.target.value)}
                />
                {showErrors && fieldErrors.resultMonth ? (
                  <p className="text-xs text-red-600">{fieldErrors.resultMonth}</p>
                ) : null}
              </div>
            </div>

            <div className="field-wrapper">
              <label className="label">選考種別（複数選択可）</label>
              <div className="checklist">
                {selectionTypeOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      value={opt.value}
                      checked={form.selectionTypes.includes(opt.value)}
                      onChange={() => toggleSelectionType(opt.value)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="詳細情報" subtitle="任意項目は空欄でOKです">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="field-wrapper">
                <label className="label" htmlFor="employeeCount">
                  社員数（任意）
                </label>
                <input
                  id="employeeCount"
                  className="control"
                  inputMode="numeric"
                  placeholder="例：300"
                  value={form.employeeCount}
                  onChange={(e) => handleTextChange('employeeCount', e.target.value)}
                />
                {showErrors && fieldErrors.employeeCount ? (
                  <p className="text-xs text-red-600">{fieldErrors.employeeCount}</p>
                ) : (
                  <p className="text-xs text-gray-500">整数で入力してください</p>
                )}
              </div>

              <div className="field-wrapper">
                <label className="label" htmlFor="annualSalaryBand">
                  年収帯（任意）
                </label>
                <select
                  id="annualSalaryBand"
                  className="control"
                  value={form.annualSalaryBand}
                  onChange={(e) => handleTextChange('annualSalaryBand', e.target.value)}
                >
                  <option value="">選択しない</option>
                  {salaryBandOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {showErrors && fieldErrors.annualSalaryBand ? (
                  <p className="text-xs text-red-600">{fieldErrors.annualSalaryBand}</p>
                ) : null}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="本文" subtitle="選考内容の詳細や印象を自由に書いてください">
            {submitError ? (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {submitError}
              </div>
            ) : null}
            <TextCounterTextarea
              label={
                <span className="flex items-center">
                  本文
                  {requiredBadge(!form.bodyMain.trim(), 'ml-2')}
                </span>
              }
              value={form.bodyMain}
              onChange={(val) => handleTextChange('bodyMain', val)}
              minLength={1}
              placeholder="例：ESは比較的短めで、面接は2回でした。GDは時間が短くて忙しかったです。"
            />
            {showErrors && fieldErrors.bodyMain ? (
              <p className="text-xs text-red-600">{fieldErrors.bodyMain}</p>
            ) : null}
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
    </main>
  );
}
