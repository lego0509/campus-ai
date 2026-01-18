'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import SectionCard from '@/components/SectionCard';

type RollupPayload = {
  subject: { id: string; name: string };
  university: { id: string; name: string };
  rollup: Record<string, any> | null;
};

const metricLabels: Record<string, string> = {
  review_count: 'レビュー数',
  avg_credit_ease: '単位取得の容易さ',
  avg_class_difficulty: '授業の難易度',
  avg_assignment_load: '課題の量',
  avg_attendance_strictness: '出席の厳しさ',
  avg_satisfaction: '満足度',
  avg_recommendation: 'おすすめ度',
};

function formatMetric(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  return String(value);
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export default function SubjectDetailPage() {
  const params = useParams<{ subjectId: string }>();
  const searchParams = useSearchParams();
  const subjectId = params.subjectId ?? '';
  const universityId = searchParams.get('universityId') ?? '';
  const universityName = searchParams.get('universityName') ?? '';

  const [rollup, setRollup] = useState<RollupPayload | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!subjectId) return;
    const loadDetail = async () => {
      setIsLoadingDetail(true);
      setErrorMessage('');
      try {
        const data = await fetchJson<RollupPayload>(`/api/public/subjects/${subjectId}/rollup`);
        setRollup(data);
      } catch (error) {
        console.error(error);
        setErrorMessage('科目詳細の読み込みに失敗しました。');
        setRollup(null);
      } finally {
        setIsLoadingDetail(false);
      }
    };

    loadDetail();
  }, [subjectId]);

  const backHref = useMemo(() => {
    const params = new URLSearchParams();
    if (universityId) params.set('universityId', universityId);
    if (universityName) params.set('universityName', universityName);
    const suffix = params.toString();
    return suffix ? `/?${suffix}` : '/';
  }, [universityId, universityName]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 text-sm font-semibold text-brand-600"
        >
          ← 一覧に戻る
        </Link>
        <p className="badge-soft w-fit">科目詳細</p>
        <h1 className="text-2xl font-bold text-gray-900">レビュー概要</h1>
        <p className="text-sm text-gray-500">
          授業の集計結果と、レビューの要約を確認できます。
        </p>
      </header>

      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {errorMessage}
        </div>
      )}

      <SectionCard title="科目情報">
        {!isLoadingDetail && rollup && (
          <div>
            <p className="text-xs text-gray-400">{rollup.university.name}</p>
            <h2 className="text-lg font-semibold text-gray-900">{rollup.subject.name}</h2>
          </div>
        )}
        {isLoadingDetail && <p className="text-sm text-gray-500">読み込み中…</p>}
        {!isLoadingDetail && !rollup && (
          <p className="text-sm text-gray-500">科目情報を取得できませんでした。</p>
        )}
      </SectionCard>

      <SectionCard title="指標の概要">
        {!isLoadingDetail && rollup?.rollup ? (
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(metricLabels).map(([key, label]) => (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3"
              >
                <span className="text-sm text-gray-600">{label}</span>
                <span className="text-sm font-semibold text-gray-900">
                  {formatMetric(rollup.rollup?.[key])}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-gray-500">
            まだ集計がありません。
          </div>
        )}
      </SectionCard>

      <SectionCard title="要約">
        {!isLoadingDetail && rollup?.rollup ? (
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-sm font-semibold text-gray-700">要約</p>
            <p className="mt-2 text-sm text-gray-700">
              {rollup.rollup?.summary_1000?.trim() || '要約がありません。'}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-gray-500">
            要約がありません。
          </div>
        )}
      </SectionCard>
    </main>
  );
}
