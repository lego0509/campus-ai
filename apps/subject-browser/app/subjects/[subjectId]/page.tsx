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
  review_count: '?????',
  avg_credit_ease: '????????',
  avg_class_difficulty: '??????',
  avg_assignment_load: '????',
  avg_attendance_strictness: '??????',
  avg_satisfaction: '???',
  avg_recommendation: '?????',
};

const summaryHeadings = [
  '???',
  '???',
  '??',
  '???',
  '???',
  '??',
  '???',
  '??',
  '??',
  '??',
  '??????',
];

function formatMetric(value: unknown) {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return String(value);
}

function splitSummarySections(raw: string) {
  const text = raw.replaceAll('
', '
').trim();
  if (!text) return [];

  const bracketHeadingRegex = new RegExp('[?\[]\s*([^\]?]+)\s*[?\]]', 'g');
  const bracketMatches = Array.from(text.matchAll(bracketHeadingRegex));
  if (bracketMatches.length > 0) {
    const sections = bracketMatches.map((match, index) => {
      const title = match[1].trim();
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index + 1 < bracketMatches.length ? (bracketMatches[index + 1].index ?? text.length) : text.length;
      const body = text.slice(start, end).trim();
      return { title, body };
    });
    return sections.filter((section) => section.body.length > 0);
  }

  const keywordHeadingRegex = new RegExp(`(?:^|\n)\s*(${summaryHeadings.join('|')})\s*[:?]`, 'g');
  const keywordMatches = Array.from(text.matchAll(keywordHeadingRegex));
  if (keywordMatches.length > 0) {
    const sections = keywordMatches.map((match, index) => {
      const title = match[1].trim();
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index + 1 < keywordMatches.length ? (keywordMatches[index + 1].index ?? text.length) : text.length;
      const body = text.slice(start, end).trim();
      return { title, body };
    });
    return sections.filter((section) => section.body.length > 0);
  }

  return [{ title: '', body: text }];
}

function splitSummaryItems(body: string) {
  return body
    .split(/?|
/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.endsWith('?') ? item : `${item}?`));
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
        setErrorMessage('?????????????????');
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

  const summarySections = useMemo(() => {
    const summary = rollup?.rollup?.summary_1000?.trim() ?? '';
    return splitSummarySections(summary).map((section) => ({
      title: section.title,
      items: splitSummaryItems(section.body),
    }));
  }, [rollup]);

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-10">
      <div className="campus-hero" aria-hidden="true">
        <div className="campus-hero__orb" />
        <div className="campus-hero__orb campus-hero__orb--right" />
      </div>

      <header className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 text-sm font-semibold text-brand-600"
        >
          ? ?????
        </Link>
        <p className="badge-soft w-fit">????</p>
        <h1 className="font-display text-3xl text-gray-900">??????</h1>
        <p className="text-sm text-gray-600">
          ????????????????????????
        </p>
      </header>

      {errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {errorMessage}
        </div>
      )}

      <SectionCard title="????">
        {!isLoadingDetail && rollup && (
          <div>
            <p className="text-xs text-gray-400">{rollup.university.name}</p>
            <h2 className="text-lg font-semibold text-gray-900">{rollup.subject.name}</h2>
          </div>
        )}
        {isLoadingDetail && <p className="text-sm text-gray-500">??????</p>}
        {!isLoadingDetail && !rollup && (
          <p className="text-sm text-gray-500">????????????????</p>
        )}
      </SectionCard>

      <SectionCard title="?????">
        {!isLoadingDetail && rollup?.rollup ? (
          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(metricLabels).map(([key, label]) => (
              <div key={key} className="metric-card">
                <span className="text-sm text-gray-600">{label}</span>
                <span className="text-sm font-semibold text-gray-900">
                  {formatMetric(rollup.rollup?.[key])}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-gray-500">
            ???????????
          </div>
        )}
      </SectionCard>

      <SectionCard title="??">
        {!isLoadingDetail && rollup?.rollup ? (
          summarySections.length > 0 ? (
            <div className="space-y-4">
              {summarySections.map((section, sectionIndex) => (
                <div key={`${section.title}-${sectionIndex}`} className="space-y-2">
                  {section.title && (
                    <p className="text-sm font-semibold text-gray-700">{section.title}</p>
                  )}
                  <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                    {section.items.map((item, itemIndex) => (
                      <li key={`${section.title}-${itemIndex}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-gray-500">
              ?????????
            </div>
          )
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-gray-500">
            ?????????
          </div>
        )}
      </SectionCard>
    </main>
  );
}
