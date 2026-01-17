'use client';

import { useEffect, useMemo, useState } from 'react';
import SectionCard from '@/components/SectionCard';

type University = {
  id: string;
  name: string;
};

type SubjectSummary = {
  id: string;
  name: string;
  review_count: number;
};

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

export default function SubjectBrowserPage() {
  const [universities, setUniversities] = useState<University[]>([]);
  const [selectedUniversityId, setSelectedUniversityId] = useState('');
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SubjectSummary[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [rollup, setRollup] = useState<RollupPayload | null>(null);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const loadUniversities = async () => {
      try {
        const data = await fetchJson<{ ok: boolean; universities: University[] }>(
          '/api/public/universities'
        );
        setUniversities(data.universities ?? []);
      } catch (error) {
        console.error(error);
        setErrorMessage('大学一覧の読み込みに失敗しました。');
      }
    };

    loadUniversities();
  }, []);

  useEffect(() => {
    if (!selectedUniversityId) {
      setSubjects([]);
      setSearchResults([]);
      setSelectedSubjectId('');
      setRollup(null);
      return;
    }

    const loadSubjects = async () => {
      setIsLoadingSubjects(true);
      try {
        const data = await fetchJson<{ ok: boolean; subjects: SubjectSummary[] }>(
          `/api/public/subjects?universityId=${selectedUniversityId}`
        );
        setSubjects(data.subjects ?? []);
        setSearchResults([]);
        setSearchQuery('');
      } catch (error) {
        console.error(error);
        setErrorMessage('科目一覧の読み込みに失敗しました。');
      } finally {
        setIsLoadingSubjects(false);
      }
    };

    loadSubjects();
  }, [selectedUniversityId]);

  useEffect(() => {
    if (!selectedUniversityId) return;
    if (searchQuery.trim().length === 0) {
      setSearchResults([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchJson<{ ok: boolean; subjects: SubjectSummary[] }>(
          `/api/public/subjects?universityId=${selectedUniversityId}&query=${encodeURIComponent(
            searchQuery.trim()
          )}`
        );
        setSearchResults(data.subjects ?? []);
      } catch (error) {
        console.error(error);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchQuery, selectedUniversityId]);

  const listItems = useMemo(() => {
    if (searchQuery.trim().length > 0) {
      return searchResults;
    }
    return subjects;
  }, [searchQuery, searchResults, subjects]);

  const suggestions = useMemo(() => {
    if (searchQuery.trim().length === 0) return [];
    return searchResults.slice(0, 6);
  }, [searchQuery, searchResults]);

  const loadDetail = async (subjectId: string) => {
    setSelectedSubjectId(subjectId);
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

  const selectedUniversity = universities.find((u) => u.id === selectedUniversityId)?.name ?? '';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="space-y-2">
        <p className="badge-soft w-fit">授業レビュー一覧</p>
        <h1 className="text-2xl font-bold text-gray-900">大学・科目の一覧</h1>
        <p className="text-sm text-gray-500">
          大学を選ぶと科目一覧が表示されます。科目を選択すると rollups の要約を確認できます。
        </p>
      </header>

      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {errorMessage}
        </div>
      )}

      <SectionCard title="大学を選択">
        <div className="field-wrapper">
          <label className="label" htmlFor="university">
            大学
          </label>
          <select
            id="university"
            className="control"
            value={selectedUniversityId}
            onChange={(event) => setSelectedUniversityId(event.target.value)}
          >
            <option value="">大学を選択してください</option>
            {universities.map((university) => (
              <option key={university.id} value={university.id}>
                {university.name}
              </option>
            ))}
          </select>
        </div>
      </SectionCard>

      <SectionCard title="科目を探す" subtitle={selectedUniversity ? `${selectedUniversity} の科目` : undefined}>
        <div className="field-wrapper">
          <label className="label" htmlFor="subject-search">
            科目名検索
          </label>
          <div className="relative">
            <input
              id="subject-search"
              className="control"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="科目名を入力"
              disabled={!selectedUniversityId}
            />
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
                <ul className="max-h-56 overflow-y-auto text-sm">
                  {suggestions.map((subject) => (
                    <li key={subject.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-slate-50"
                        onClick={() => {
                          setSearchQuery(subject.name);
                          loadDetail(subject.id);
                        }}
                      >
                        <span>{subject.name}</span>
                        <span className="text-xs text-gray-400">{subject.review_count}件</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>{isLoadingSubjects ? '読み込み中…' : `${listItems.length} 件`}</span>
            {searchQuery.trim().length > 0 && (
              <button
                type="button"
                className="text-xs font-semibold text-brand-600"
                onClick={() => setSearchQuery('')}
              >
                検索をクリア
              </button>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {listItems.map((subject) => (
              <div key={subject.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{subject.name}</p>
                    <p className="text-xs text-gray-500">レビュー {subject.review_count} 件</p>
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-brand-200 px-3 py-1 text-xs font-semibold text-brand-700"
                    onClick={() => loadDetail(subject.id)}
                  >
                    科目詳細
                  </button>
                </div>
              </div>
            ))}
            {!isLoadingSubjects && selectedUniversityId && listItems.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-gray-500">
                該当する科目がありません。
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="科目詳細">
        {!selectedSubjectId && (
          <p className="text-sm text-gray-500">科目を選択すると詳細が表示されます。</p>
        )}
        {isLoadingDetail && <p className="text-sm text-gray-500">詳細を読み込み中…</p>}
        {!isLoadingDetail && rollup && (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-400">{rollup.university.name}</p>
              <h3 className="text-lg font-semibold text-gray-900">{rollup.subject.name}</h3>
            </div>
            {rollup.rollup ? (
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
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-gray-700">要約</p>
              <p className="mt-2 text-sm text-gray-700">
                {rollup.rollup?.summary_1000?.trim() || '要約がありません。'}
              </p>
            </div>
          </div>
        )}
      </SectionCard>
    </main>
  );
}
