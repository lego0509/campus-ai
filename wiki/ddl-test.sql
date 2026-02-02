-- =========================================
-- Extensions
-- =========================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =========================================
-- Functions
-- =========================================
CREATE OR REPLACE FUNCTION public.teacher_names_optional_valid(arr text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    arr IS NULL
    OR array_length(arr, 1) IS NULL
    OR (
      bool_and(btrim(x) <> '')
    )
  FROM unnest(arr) AS x
$$;

-- =========================================
-- Core tables
-- =========================================
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  line_user_hash character(64) NOT NULL UNIQUE CHECK (btrim(line_user_hash::text) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE TABLE public.universities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT universities_pkey PRIMARY KEY (id)
);

CREATE TABLE public.user_affiliations (
  user_id uuid NOT NULL,
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  department text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_affiliations_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_affiliations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT user_affiliations_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id)
);

CREATE TABLE public.subjects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subjects_pkey PRIMARY KEY (id),
  CONSTRAINT subjects_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id)
);

-- =========================================
-- Course reviews (base)
-- =========================================
CREATE TABLE public.course_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  department text,
  grade_at_take integer NOT NULL CHECK (grade_at_take >= 1 AND grade_at_take <= 6 OR grade_at_take = 99),
  teacher_names text[] CHECK (teacher_names_optional_valid(teacher_names)),
  academic_year integer NOT NULL CHECK (academic_year >= 1990 AND academic_year <= 2100),
  term text NOT NULL CHECK (term = ANY (ARRAY['s1','s2','q1','q2','q3','q4','full','intensive','other'])),
  credits_at_take integer CHECK (credits_at_take IS NULL OR credits_at_take > 0),
  requirement_type_at_take text NOT NULL CHECK (requirement_type_at_take = ANY (ARRAY['required','elective','unknown'])),
  performance_self integer NOT NULL CHECK (performance_self >= 1 AND performance_self <= 4),
  assignment_difficulty_4 integer NOT NULL CHECK (assignment_difficulty_4 >= 1 AND assignment_difficulty_4 <= 5),
  credit_ease integer NOT NULL,
  class_difficulty integer NOT NULL,
  assignment_load integer NOT NULL,
  attendance_strictness integer NOT NULL,
  satisfaction integer NOT NULL,
  recommendation integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  body_main text NOT NULL CHECK (btrim(body_main) <> ''::text),
  CONSTRAINT course_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT course_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT course_reviews_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id)
);

CREATE TABLE public.course_review_ai_flags (
  review_id uuid NOT NULL,
  ai_flagged boolean NOT NULL DEFAULT false,
  category text,
  severity numeric,
  raw_json jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT course_review_ai_flags_pkey PRIMARY KEY (review_id),
  CONSTRAINT course_review_ai_flags_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.course_reviews(id)
);

CREATE TABLE public.course_review_embeddings (
  review_id uuid NOT NULL,
  embedding vector,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  model text NOT NULL DEFAULT 'text-embedding-3-small',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  content_hash character(64),
  CONSTRAINT course_review_embeddings_pkey PRIMARY KEY (review_id),
  CONSTRAINT course_review_embeddings_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.course_reviews(id)
);

CREATE TABLE public.embedding_jobs (
  review_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status = ANY (ARRAY['queued','processing','done','failed'])),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  locked_at timestamp with time zone,
  locked_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT embedding_jobs_pkey PRIMARY KEY (review_id),
  CONSTRAINT embedding_jobs_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.course_reviews(id)
);

CREATE TABLE public.subject_rollups (
  subject_id uuid NOT NULL,
  summary_1000 text NOT NULL DEFAULT ''::text,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  avg_credit_ease numeric,
  avg_class_difficulty numeric,
  avg_assignment_load numeric,
  avg_attendance_strictness numeric,
  avg_satisfaction numeric,
  avg_recommendation numeric,
  last_processed_review_id uuid,
  is_dirty boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  count_performance_unknown integer NOT NULL DEFAULT 0 CHECK (count_performance_unknown >= 0),
  count_no_credit integer NOT NULL DEFAULT 0 CHECK (count_no_credit >= 0),
  count_credit_normal integer NOT NULL DEFAULT 0 CHECK (count_credit_normal >= 0),
  count_credit_high integer NOT NULL DEFAULT 0 CHECK (count_credit_high >= 0),
  CONSTRAINT subject_rollups_pkey PRIMARY KEY (subject_id),
  CONSTRAINT subject_rollups_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id)
);

CREATE TABLE public.subject_rollup_embeddings (
  subject_id uuid NOT NULL,
  embedding vector,
  model text NOT NULL DEFAULT 'text-embedding-3-small',
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subject_rollup_embeddings_pkey PRIMARY KEY (subject_id),
  CONSTRAINT subject_rollup_embeddings_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subject_rollups(subject_id)
);

-- =========================================
-- Company reviews (unchanged)
-- =========================================
CREATE TABLE public.companies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''::text),
  hq_prefecture text NOT NULL CHECK (hq_prefecture = ANY (ARRAY[
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
    '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
    '新潟県','富山県','石川県','福井県','山梨県','長野県',
    '岐阜県','静岡県','愛知県','三重県',
    '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県',
    '徳島県','香川県','愛媛県','高知県',
    '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companies_pkey PRIMARY KEY (id)
);

CREATE TABLE public.company_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  department text,
  company_id uuid NOT NULL,
  grad_year integer NOT NULL CHECK (grad_year >= 1990 AND grad_year <= 2100),
  outcome text NOT NULL CHECK (outcome = ANY (ARRAY['offer','rejected','other'])),
  result_month date NOT NULL CHECK (result_month = date_trunc('month', result_month::timestamp with time zone)::date),
  employee_count integer CHECK (employee_count IS NULL OR employee_count > 0),
  annual_salary_band text CHECK (annual_salary_band IS NULL OR annual_salary_band = ANY (ARRAY[
    'under_300','300_399','400_499','500_599','600_699','700_799','800_899','900_999','1000_plus'
  ])),
  selection_types text[] NOT NULL DEFAULT '{}' CHECK (selection_types <@ ARRAY['es','test','interview','gd','assignment','other']),
  body_main text NOT NULL CHECK (btrim(body_main) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT company_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT company_reviews_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id),
  CONSTRAINT company_reviews_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id)
);

CREATE TABLE public.company_review_ai_flags (
  review_id uuid NOT NULL,
  ai_flagged boolean NOT NULL DEFAULT false,
  category text,
  severity numeric,
  raw_json jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_review_ai_flags_pkey PRIMARY KEY (review_id),
  CONSTRAINT company_review_ai_flags_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.company_reviews(id)
);

CREATE TABLE public.company_review_embeddings (
  review_id uuid NOT NULL,
  embedding vector,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  model text NOT NULL DEFAULT 'text-embedding-3-small',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT company_review_embeddings_pkey PRIMARY KEY (review_id),
  CONSTRAINT company_review_embeddings_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.company_reviews(id)
);

CREATE TABLE public.company_embedding_jobs (
  review_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status = ANY (ARRAY['queued','processing','done','failed'])),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  locked_at timestamp with time zone,
  locked_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_embedding_jobs_pkey PRIMARY KEY (review_id),
  CONSTRAINT company_embedding_jobs_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.company_reviews(id)
);

CREATE TABLE public.company_rollups (
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  company_id uuid NOT NULL,
  summary_1000 text NOT NULL DEFAULT ''::text,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  count_offer integer NOT NULL DEFAULT 0 CHECK (count_offer >= 0),
  count_rejected integer NOT NULL DEFAULT 0 CHECK (count_rejected >= 0),
  count_other integer NOT NULL DEFAULT 0 CHECK (count_other >= 0),
  last_processed_review_id uuid,
  is_dirty boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_rollups_pkey PRIMARY KEY (university_id, faculty, company_id),
  CONSTRAINT company_rollups_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id),
  CONSTRAINT company_rollups_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id)
);

CREATE TABLE public.company_rollup_embeddings (
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  company_id uuid NOT NULL,
  embedding vector,
  model text NOT NULL DEFAULT 'text-embedding-3-small',
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_rollup_embeddings_pkey PRIMARY KEY (university_id, faculty, company_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey
    FOREIGN KEY (university_id, faculty, company_id)
    REFERENCES public.company_rollups(university_id, faculty, company_id)
);

-- =========================================
-- Chat + user memory
-- =========================================
CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['system','user','assistant','tool'])),
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE TABLE public.user_memory (
  user_id uuid NOT NULL,
  summary_1000 text NOT NULL DEFAULT ''::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_summarized_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_memory_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_memory_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);

-- =========================================
-- Tags (new)
-- =========================================
CREATE TABLE public.review_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''::text),
  usage_count integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT review_tags_pkey PRIMARY KEY (id),
  CONSTRAINT review_tags_name_len CHECK (char_length(name) <= 12)
);

CREATE TABLE public.course_review_tags (
  review_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT course_review_tags_pkey PRIMARY KEY (review_id, tag_id),
  CONSTRAINT course_review_tags_review_id_fkey
    FOREIGN KEY (review_id) REFERENCES public.course_reviews(id) ON DELETE CASCADE,
  CONSTRAINT course_review_tags_tag_id_fkey
    FOREIGN KEY (tag_id) REFERENCES public.review_tags(id) ON DELETE CASCADE
);

CREATE INDEX course_review_tags_tag_id_idx
  ON public.course_review_tags(tag_id);

CREATE INDEX review_tags_usage_count_idx
  ON public.review_tags(usage_count DESC, name);

-- =========================================
-- Course reviews: NULL許容化（運用方針に合わせる）
-- =========================================
ALTER TABLE public.course_reviews
  ALTER COLUMN academic_year DROP NOT NULL,
  ALTER COLUMN term DROP NOT NULL,
  ALTER COLUMN requirement_type_at_take DROP NOT NULL,
  ALTER COLUMN credit_ease DROP NOT NULL,
  ALTER COLUMN assignment_load DROP NOT NULL,
  ALTER COLUMN attendance_strictness DROP NOT NULL,
  ALTER COLUMN satisfaction DROP NOT NULL,
  ALTER COLUMN assignment_difficulty_4 DROP NOT NULL;

-- =========================================
-- subject_rollups: 平均値のNULL許容
-- =========================================
ALTER TABLE public.subject_rollups
  ALTER COLUMN avg_credit_ease DROP NOT NULL,
  ALTER COLUMN avg_assignment_load DROP NOT NULL,
  ALTER COLUMN avg_attendance_strictness DROP NOT NULL,
  ALTER COLUMN avg_satisfaction DROP NOT NULL;
