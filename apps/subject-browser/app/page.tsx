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

function buildSubjectHref(subjectId: string, universityId: string, universityName: string) {
  const params = new URLSearchParams();
  if (universityId) params.set('universityId', universityId);
  if (universityName) params.set('universityName', universityName);
  const suffix = params.toString();
  return suffix ? `/subjects/${subjectId}?${suffix}` : `/subjects/${subjectId}`;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, '');
}

export default function SubjectBrowserPage() {
  const [universities, setUniversities] = useState<University[]>([]);
  const [universityQuery, setUniversityQuery] = useState('');
  const [selectedUniversityId, setSelectedUniversityId] = useState('');
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [subjectQuery, setSubjectQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SubjectSummary[]>([]);
  const [subjectCache, setSubjectCache] = useState<Record<string, SubjectSummary[]>>({});
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(false);
  const [isUniversityFocused, setIsUniversityFocused] = useState(false);
  const [isSubjectFocused, setIsSubjectFocused] = useState(false);
  const [universityCommitted, setUniversityCommitted] = useState(false);
  const [subjectCommitted, setSubjectCommitted] = useState(false);
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
        setErrorMessage('?????????????????');
      }
    };

    loadUniversities();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const universityId = params.get('universityId') ?? '';
    const universityName = params.get('universityName') ?? '';

    if (universityId) setSelectedUniversityId(universityId);
    if (universityName) {
      setUniversityQuery(universityName);
      setUniversityCommitted(true);
    }
  }, []);

  useEffect(() => {
    if (!selectedUniversityId) {
      setSubjects([]);
      setSearchResults([]);
      setSearchQuery('');
      return;
    }

    if (subjectCache[selectedUniversityId]) {
      setSubjects(subjectCache[selectedUniversityId]);
      return;
    }

    const loadSubjects = async () => {
      setIsLoadingSubjects(true);
      try {
        const data = await fetchJson<{ ok: boolean; subjects: SubjectSummary[] }>(
          `/api/public/subjects?universityId=${selectedUniversityId}`
        );
        const items = data.subjects ?? [];
        setSubjects(items);
        setSubjectCache((prev) => ({ ...prev, [selectedUniversityId]: items }));
        setSearchResults([]);
      } catch (error) {
        console.error(error);
        setErrorMessage('?????????????????');
      } finally {
        setIsLoadingSubjects(false);
      }
    };

    loadSubjects();
  }, [selectedUniversityId, subjectCache]);

  useEffect(() => {
    if (!selectedUniversityId) return;
    if (subjectQuery.trim().length === 0) {
      setSearchResults([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchJson<{ ok: boolean; subjects: SubjectSummary[] }>(
          `/api/public/subjects?universityId=${selectedUniversityId}&query=${encodeURIComponent(
            subjectQuery.trim()
          )}`
        );
        setSearchResults(data.subjects ?? []);
      } catch (error) {
        console.error(error);
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [subjectQuery, selectedUniversityId]);

  const selectedUniversityName =
    universities.find((university) => university.id === selectedUniversityId)?.name ?? '';

  const listItems = useMemo(() => {
    if (searchQuery.trim().length > 0) {
      return searchResults;
    }
    return subjects;
  }, [searchQuery, searchResults, subjects]);

  const subjectSuggestions = useMemo(() => {
    if (subjectQuery.trim().length === 0) return [];
    return searchResults.slice(0, 6);
  }, [subjectQuery, searchResults]);

  const universitySuggestions = useMemo(() => {
    if (universityQuery.trim().length === 0) return [];
    const query = normalizeText(universityQuery.trim());
    return universities
      .filter((university) => normalizeText(university.name).includes(query))
      .slice(0, 8);
  }, [universities, universityQuery]);

  const handleSelectUniversity = (university: University) => {
    setSelectedUniversityId(university.id);
    setUniversityQuery(university.name);
    setUniversityCommitted(true);
    setSearchQuery('');
    setSubjectQuery('');
    setSubjectCommitted(false);
    setSearchResults([]);
    setErrorMessage('');
  };

  const commitUniversity = () => {
    if (!universityQuery.trim()) return;
    if (universitySuggestions.length > 0) {
      handleSelectUniversity(universitySuggestions[0]);
      return;
    }
    setErrorMessage('??????????????????');
  };

  const handleClearUniversity = () => {
    setSelectedUniversityId('');
    setUniversityQuery('');
    setUniversityCommitted(false);
    setSubjects([]);
    setSearchQuery('');
    setSubjectQuery('');
    setSubjectCommitted(false);
    setSearchResults([]);
  };

  const commitSubjectSearch = () => {
    setSearchQuery(subjectQuery.trim());
    setSubjectCommitted(true);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="space-y-2">
        <p className="badge-soft w-fit">????????</p>
        <h1 className="text-2xl font-bold text-gray-900">????????</h1>
        <p className="text-sm text-gray-500">
          ?????????????????????????????????
        </p>
      </header>

      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {errorMessage}
        </div>
      )}

      <SectionCard title="?????">
        <div className="field-wrapper">
          <label className="label" htmlFor="university">
            ??
          </label>
          <div className="relative">
            <input
              id="university"
              className="control"
              value={universityQuery}
              onChange={(event) => {
                setUniversityQuery(event.target.value);
                setSelectedUniversityId('');
                setUniversityCommitted(false);
              }}
              onFocus={() => setIsUniversityFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setIsUniversityFocused(false), 120);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitUniversity();
                }
              }}
              placeholder="????????????"
            />
            {isUniversityFocused && !universityCommitted && universitySuggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
                <ul className="max-h-56 overflow-y-auto text-sm">
                  {universitySuggestions.map((university) => (
                    <li key={university.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-slate-50"
                        onMouseDown={() => handleSelectUniversity(university)}
                      >
                        <span>{university.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              {selectedUniversityId
                ? `???: ${selectedUniversityName}`
                : '???????????????'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-slate-200 px-3 py-1 text-xs font-semibold text-gray-600"
                onClick={commitUniversity}
              >
                ??
              </button>
              {selectedUniversityId && (
                <button
                  type="button"
                  className="text-xs font-semibold text-brand-600"
                  onClick={handleClearUniversity}
                >
                  ???
                </button>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="?????" subtitle={selectedUniversityName ? `${selectedUniversityName} ???` : undefined}>
        <div className="field-wrapper">
          <label className="label" htmlFor="subject-search">
            ????
          </label>
          <div className="relative">
            <input
              id="subject-search"
              className="control"
              value={subjectQuery}
              onChange={(event) => {
                setSubjectQuery(event.target.value);
                setSubjectCommitted(false);
              }}
              onFocus={() => setIsSubjectFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setIsSubjectFocused(false), 120);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSubjectSearch();
                }
              }}
              placeholder="??????"
              disabled={!selectedUniversityId}
            />
            {isSubjectFocused && !subjectCommitted && subjectSuggestions.length > 0 && (
              <div className="absolute z-10 mt-2 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
                <ul className="max-h-56 overflow-y-auto text-sm">
                  {subjectSuggestions.map((subject) => (
                    <li key={subject.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-slate-50"
                        onMouseDown={() => {
                          setSubjectQuery(subject.name);
                          setSearchQuery(subject.name);
                          setSubjectCommitted(true);
                        }}
                      >
                        <span>{subject.name}</span>
                        <span className="text-xs text-gray-400">{subject.review_count}?</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-sm text-gray-500">
          <span>{isLoadingSubjects ? '??????' : `${listItems.length} ?`}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-slate-200 px-3 py-1 text-xs font-semibold text-gray-600"
              onClick={commitSubjectSearch}
              disabled={!selectedUniversityId}
            >
              ??
            </button>
            {subjectQuery.trim().length > 0 && (
              <button
                type="button"
                className="text-xs font-semibold text-brand-600"
                onClick={() => {
                  setSubjectQuery('');
                  setSearchQuery('');
                  setSubjectCommitted(false);
                }}
              >
                ???
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {listItems.map((subject) => (
            <Link
              key={subject.id}
              href={buildSubjectHref(subject.id, selectedUniversityId, selectedUniversityName)}
              className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{subject.name}</p>
                  <p className="text-xs text-gray-500">???? {subject.review_count} ?</p>
                </div>
                <span className="rounded-full border border-brand-200 px-3 py-1 text-xs font-semibold text-brand-700">
                  ????
                </span>
              </div>
            </Link>
          ))}
          {!isLoadingSubjects && selectedUniversityId && listItems.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-gray-500">
              ???????????????????
            </div>
          )}
          {!selectedUniversityId && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-gray-500">
              ???????????????
            </div>
          )}
        </div>
      </SectionCard>
    </main>
  );
}
