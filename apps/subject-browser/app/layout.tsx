import './globals.css';

export const metadata = {
  title: '授業レビュー一覧',
  description: '大学別の科目とレビュー集計を確認するページ',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className="bg-slate-50 text-gray-900">
        {children}
      </body>
    </html>
  );
}
