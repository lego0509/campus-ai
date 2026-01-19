import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '授業レビュー投稿 | University review app',
  description: '授業レビューを投稿するフォーム',
};

export default function CourseReviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
