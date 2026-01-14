import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const DUMMY_USER_ID = '00000000-0000-0000-0000-000000000001';

const universities = [
  'サンプル大学',
  '都市未来大学',
  '北海工科大学',
  '西都国際大学',
  '青葉学園大学',
];

const faculties = [
  { name: '工学部', departments: ['情報工学科', '電気電子工学科', '機械工学科'] },
  { name: '経済学部', departments: ['経済学科', '経営学科'] },
  { name: '文学部', departments: ['心理学科', '日本文学科'] },
  { name: '法学部', departments: ['法律学科'] },
  { name: '理学部', departments: ['数学科', '物理学科'] },
];

const subjectSeeds = [
  'データサイエンス入門',
  '統計学基礎',
  '線形代数',
  'ミクロ経済学',
  'マクロ経済学',
  '心理学概論',
  '法学入門',
  'プログラミング基礎',
  '経営戦略',
  '研究方法論',
];

const commentFragments = {
  openings: [
    '講義は丁寧で',
    '進行はテンポよく',
    '板書中心のスタイルで',
    'スライドが見やすく',
    '演習が多めで',
  ],
  workload: ['課題は少なめ', '課題はやや多い', '課題は平均的', '課題が重め'],
  attendance: ['出席は厳しめ', '出席確認はゆるめ', '出席は数回だけ', '出席チェックは毎回'],
  exams: ['試験対策はしやすい', '試験は応用寄り', '試験は暗記中心', '小テストが多い'],
  closing: [
    '全体として満足度が高かった。',
    'もう少し課題量が減ると助かる。',
    '友人にも勧めたいと感じた。',
    '真面目に取り組めば単位は取りやすい。',
  ],
};

function buildComment(seed) {
  const pick = (arr, offset) => arr[(seed + offset) % arr.length];
  return [
    pick(commentFragments.openings, 0),
    pick(commentFragments.workload, 1),
    pick(commentFragments.attendance, 2),
    pick(commentFragments.exams, 3),
    pick(commentFragments.closing, 4),
    `（レビューID: ${randomUUID().slice(0, 8)}）`,
  ].join('。');
}

async function getOrCreateUniversityId(name) {
  const { data: found, error: findErr } = await supabase
    .from('universities')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insertErr } = await supabase
    .from('universities')
    .insert({ name })
    .select('id')
    .single();

  if (insertErr) throw insertErr;
  return inserted.id;
}

async function getOrCreateSubjectId(universityId, name) {
  const { data: found, error: findErr } = await supabase
    .from('subjects')
    .select('id')
    .eq('university_id', universityId)
    .eq('name', name)
    .maybeSingle();

  if (findErr) throw findErr;
  if (found?.id) return found.id;

  const { data: inserted, error: insertErr } = await supabase
    .from('subjects')
    .insert({ university_id: universityId, name })
    .select('id')
    .single();

  if (insertErr) throw insertErr;
  return inserted.id;
}

async function insertReview({
  subjectId,
  faculty,
  department,
  bodyMain,
  ratings,
  teacherNames,
  academicYear,
  term,
  credits,
  requirementType,
  gradeAtTake,
}) {
  const { data: review, error: reviewErr } = await supabase
    .from('course_reviews')
    .insert({
      id: randomUUID(),
      user_id: DUMMY_USER_ID,
      subject_id: subjectId,
      faculty,
      department,
      grade_at_take: gradeAtTake,
      teacher_names: teacherNames,
      academic_year: academicYear,
      term,
      credits_at_take: credits,
      requirement_type_at_take: requirementType,
      performance_self: ratings.performance_self,
      assignment_difficulty_4: ratings.assignment_difficulty_4,
      credit_ease: ratings.credit_ease,
      class_difficulty: ratings.class_difficulty,
      assignment_load: ratings.assignment_load,
      attendance_strictness: ratings.attendance_strictness,
      satisfaction: ratings.satisfaction,
      recommendation: ratings.recommendation,
      body_main: bodyMain,
    })
    .select('id')
    .single();

  if (reviewErr) throw reviewErr;

  return review.id;
}

async function main() {
  const universityIds = {};
  for (const name of universities) {
    universityIds[name] = await getOrCreateUniversityId(name);
  }

  const subjectIds = {};
  for (const universityName of universities) {
    const universityId = universityIds[universityName];
    const faculty = faculties[universities.indexOf(universityName) % faculties.length];
    for (let i = 0; i < subjectSeeds.length; i += 1) {
      const subjectName = `${subjectSeeds[i]}（${universityName}）`;
      subjectIds[subjectName] = {
        id: await getOrCreateSubjectId(universityId, subjectName),
        faculty: faculty.name,
        department: faculty.departments[i % faculty.departments.length] ?? null,
      };
    }
  }

  const terms = ['s1', 's2', 'q1', 'q2', 'q3', 'q4', 'full', 'intensive', 'other'];
  const requirementTypes = ['required', 'elective', 'unknown'];
  const teacherPool = ['山田 太郎', '佐藤 花子', '鈴木 一郎', '田中 真由', '高橋 健'];

  let totalReviews = 0;

  for (const [subjectName, meta] of Object.entries(subjectIds)) {
    for (let i = 0; i < 20; i += 1) {
      const seed = totalReviews + i;
      const ratings = {
        performance_self: (seed % 4) + 1,
        assignment_difficulty_4: ((seed + 1) % 4) + 1,
        credit_ease: ((seed + 2) % 5) + 1,
        class_difficulty: ((seed + 3) % 5) + 1,
        assignment_load: ((seed + 4) % 5) + 1,
        attendance_strictness: ((seed + 1) % 5) + 1,
        satisfaction: ((seed + 2) % 5) + 1,
        recommendation: ((seed + 3) % 5) + 1,
      };

      const teacherNames =
        seed % 3 === 0
          ? null
          : [teacherPool[seed % teacherPool.length], teacherPool[(seed + 1) % teacherPool.length]];

      await insertReview({
        subjectId: meta.id,
        faculty: meta.faculty,
        department: meta.department,
        bodyMain: buildComment(seed),
        ratings,
        teacherNames,
        academicYear: 2024 + (seed % 2),
        term: terms[seed % terms.length],
        credits: (seed % 4) + 1,
        requirementType: requirementTypes[seed % requirementTypes.length],
        gradeAtTake: (seed % 6) + 1,
      });

      totalReviews += 1;
    }
  }

  console.log('✅ ダミーデータ投入が完了しました。');
  console.log(`- 大学数: ${universities.length}`);
  console.log(`- 科目数: ${Object.keys(subjectIds).length}`);
  console.log(`- レビュー数: ${totalReviews}`);
}

main().catch((error) => {
  console.error('❌ ダミーデータ投入に失敗しました。', error);
  process.exit(1);
});
