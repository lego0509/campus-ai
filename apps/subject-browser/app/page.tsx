'use client';

import Link from 'next/link';
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

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function buildSubjectHref(
  subjectId: string,
  universityId: string,
  universityName: string
) {
  const params = new URLSearchParams();
  if (universityId) params.set('universityId', universityId);
  if (universityName) params.set('universityName', universityName);
  const suffix = params.toString();
  return suffix ? `/subjects/${subjectId}?${suffix}` : `/subjects/${subjectId}`;
}

export default function SubjectBrowserPage() {
  const [universities, setUniversities] = useState<University[]>([]);
  const [universityQuery, setUniversityQuery] = useState('');
  const [selectedUniversityId, setSelectedUniversityId] = useState('');
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SubjectSummary[]>([]);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(false);
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
    const params = new URLSearchParams(window.location.search);
    const universityId = params.get('universityId') ?? '';
    const universityName = params.get('universityName') ?? '';

    if (universityId) setSelectedUniversityId(universityId);
    if (universityName) setUniversityQuery(universityName);
  }, []);

  useEffect(() => {
    if (!selectedUniversityId) {
      setSubjects([]);
      setSearchResults([]);
      setSearchQuery('');
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

  const selectedUniversityName =
    universities.find((university) => university.id === selectedUniversityId)?.name ?? '';

  const listItems = useMemo(() => {
    if (searchQuery.trim().length > 0) {
      return searchResults;
    }
    return subjects;
  }, [searchQuery, searchResults, subjects]);

  const subjectSuggestions = useMemo(() => {
    if (searchQuery.trim().length === 0) return [];
    return searchResults.slice(0, 6);
  }, [searchQuery, searchResults]);

  const universitySuggestions = useMemo(() => {
    if (universityQuery.trim().length === 0) return [];
    const query = universityQuery.trim().toLowerCase();
    return universities
      .filter((university) => university.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [universities, universityQuery]);

  const handleSelectUniversity = (university: University) => {
    setSelectedUniversityId(university.id);
    setUniversityQuery(university.name);
    setSearchQuery('');
    setSearchResults([]);
    setErrorMessage('');
  };

  const handleClearUniversity = () => {
    setSelectedUniversityId('');
    setUniversityQuery('');
    setSubjects([]);
    setSearchQuery('');
    setSearchResults([]);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="space-y-2">
        <p className="badge-soft w-fit">授業レビュー一覧</p>
        <h1 className="text-2xl font-bold text-gray-900">大学・科目の一覧</h1>
        <p className="text-sm text-gray-500">
          大学名を入力して選択すると、科目一覧とレビュー集計が確認できます。
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
          <div className="relative">
            <input
              id="university"
              className="control"
              value={universityQuery}
              onChange={(event) => {
                setUniversityQuery(event.target.value);
                setSelectedUniversityId('');
              }}
              placeholder="大学名を入力してください"
            />
            {universitySuggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
                <ul className="max-h-56 overflow-y-auto text-sm">
                  {universitySuggestions.map((university) => (
                    <li key={university.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-slate-50"
                        onClick={() => handleSelectUniversity(university)}
                      >
                        <span>{university.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
            <span>
              {selectedUniversityId
                ? `選択中: ${selectedUniversityName}`
                : '候補から大学を選択してください'}
            </span>
            {selectedUniversityId && (
              <button
                type="button"
                className="text-xs font-semibold text-brand-600"
                onClick={handleClearUniversity}
              >
                クリア
              </button>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="科目を探す"
        subtitle={selectedUniversityName ? `${selectedUniversityName} の科目` : undefined}
      >
        <div className="field-wrapper">
          <label className="label" htmlFor="subject-search">
            科目検索
          </label>
          <div className="relative">
            <input
              id="subject-search"
              className="control"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="科目名で検索"
              disabled={!selectedUniversityId}
            />
            {subjectSuggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
                <ul className="max-h-56 overflow-y-auto text-sm">
                  {subjectSuggestions.map((subject) => (
                    <li key={subject.id}>
                      <Link
                        href={buildSubjectHref(
                          subject.id,
                          selectedUniversityId,
                          selectedUniversityName
                        )}
                        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-slate-50"
                      >
                        <span>{subject.name}</span>
                        <span className="text-xs text-gray-400">
                          {subject.review_count}件
                        </span>
                      </Link>
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
                クリア
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
                  <Link
                    href={buildSubjectHref(
                      subject.id,
                      selectedUniversityId,
                      selectedUniversityName
                    )}
                    className="rounded-full border border-brand-200 px-3 py-1 text-xs font-semibold text-brand-700"
                  >
                    科目詳細
                  </Link>
                </div>
              </div>
            ))}
            {!isLoadingSubjects && selectedUniversityId && listItems.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-gray-500">
                条件に合う科目が見つかりませんでした。
              </div>
            )}
            {!selectedUniversityId && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-gray-500">
                まずは大学を選択してください。
              </div>
            )}
          </div>
        </div>
      </SectionCard>
    </main>
  );
}
