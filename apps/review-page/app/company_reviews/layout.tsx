import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '会社レビュー投稿 | University review app',
  description: '会社レビューを投稿するフォーム',
};

export default function CompanyReviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
