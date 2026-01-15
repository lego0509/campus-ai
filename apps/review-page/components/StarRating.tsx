'use client';

import { Star } from 'lucide-react';
import { useMemo } from 'react';
import clsx from 'clsx';

interface StarRatingProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  note?: string;
  required?: boolean;
}

const starValues = [1, 2, 3, 4, 5];

export function StarRating({ label, value, onChange, note, required }: StarRatingProps) {
  const displayNote = useMemo(() => (value ? `${value} / 5` : '未選択'), [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1 text-sm font-semibold text-gray-800">
          {label}
          {required && value === 0 ? (
            <span className="ml-1 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
              必須
            </span>
          ) : null}
        </label>
        <span className="text-xs font-semibold text-gray-500">{displayNote}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {starValues.map((star) => {
          const active = star <= value;
          return (
            <button
              key={star}
              type="button"
              aria-label={`${label} ${star}点`}
              className={clsx(
                'star-button',
                active ? 'bg-yellow-50 border-yellow-300 text-yellow-500' : 'bg-softGray text-gray-400'
              )}
              onClick={() => onChange(star)}
            >
              <Star
                className={clsx('h-5 w-5', active ? 'fill-current text-yellow-500' : 'text-gray-300')}
                strokeWidth={1.5}
              />
            </button>
          );
        })}
        {note && <span className="text-xs text-gray-500">{note}</span>}
      </div>
    </div>
  );
}

export default StarRating;
