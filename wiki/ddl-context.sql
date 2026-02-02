-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['system'::text, 'user'::text, 'assistant'::text, 'tool'::text])),
  content text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.companies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''::text),
  hq_prefecture text NOT NULL CHECK (hq_prefecture = ANY (ARRAY['北海道'::text, '青森県'::text, '岩手県'::text, '宮城県'::text, '秋田県'::text, '山形県'::text, '福島県'::text, '茨城県'::text, '栃木県'::text, '群馬県'::text, '埼玉県'::text, '千葉県'::text, '東京都'::text, '神奈川県'::text, '新潟県'::text, '富山県'::text, '石川県'::text, '福井県'::text, '山梨県'::text, '長野県'::text, '岐阜県'::text, '静岡県'::text, '愛知県'::text, '三重県'::text, '滋賀県'::text, '京都府'::text, '大阪府'::text, '兵庫県'::text, '奈良県'::text, '和歌山県'::text, '鳥取県'::text, '島根県'::text, '岡山県'::text, '広島県'::text, '山口県'::text, '徳島県'::text, '香川県'::text, '愛媛県'::text, '高知県'::text, '福岡県'::text, '佐賀県'::text, '長崎県'::text, '熊本県'::text, '大分県'::text, '宮崎県'::text, '鹿児島県'::text, '沖縄県'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companies_pkey PRIMARY KEY (id)
);
CREATE TABLE public.company_embedding_jobs (
  review_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'::text CHECK (status = ANY (ARRAY['queued'::text, 'processing'::text, 'done'::text, 'failed'::text])),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  locked_at timestamp with time zone,
  locked_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_embedding_jobs_pkey PRIMARY KEY (review_id),
  CONSTRAINT company_embedding_jobs_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.company_reviews(id)
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
  embedding USER-DEFINED,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  model text NOT NULL DEFAULT 'text-embedding-3-small'::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT company_review_embeddings_pkey PRIMARY KEY (review_id),
  CONSTRAINT company_review_embeddings_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.company_reviews(id)
);
CREATE TABLE public.company_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  department text,
  company_id uuid NOT NULL,
  grad_year integer NOT NULL CHECK (grad_year >= 1990 AND grad_year <= 2100),
  outcome text NOT NULL CHECK (outcome = ANY (ARRAY['offer'::text, 'rejected'::text, 'other'::text])),
  result_month date NOT NULL CHECK (result_month = date_trunc('month'::text, result_month::timestamp with time zone)::date),
  employee_count integer CHECK (employee_count IS NULL OR employee_count > 0),
  annual_salary_band text CHECK (annual_salary_band IS NULL OR (annual_salary_band = ANY (ARRAY['under_300'::text, '300_399'::text, '400_499'::text, '500_599'::text, '600_699'::text, '700_799'::text, '800_899'::text, '900_999'::text, '1000_plus'::text]))),
  selection_types ARRAY NOT NULL DEFAULT '{}'::text[] CHECK (selection_types <@ ARRAY['es'::text, 'test'::text, 'interview'::text, 'gd'::text, 'assignment'::text, 'other'::text]),
  body_main text NOT NULL CHECK (btrim(body_main) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT company_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT company_reviews_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id),
  CONSTRAINT company_reviews_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id)
);
CREATE TABLE public.company_rollup_embeddings (
  university_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  company_id uuid NOT NULL,
  embedding USER-DEFINED,
  model text NOT NULL DEFAULT 'text-embedding-3-small'::text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT company_rollup_embeddings_pkey PRIMARY KEY (university_id, faculty, company_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (university_id) REFERENCES public.company_rollups(university_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (faculty) REFERENCES public.company_rollups(university_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (company_id) REFERENCES public.company_rollups(university_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (university_id) REFERENCES public.company_rollups(faculty),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (faculty) REFERENCES public.company_rollups(faculty),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (company_id) REFERENCES public.company_rollups(faculty),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (university_id) REFERENCES public.company_rollups(company_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (faculty) REFERENCES public.company_rollups(company_id),
  CONSTRAINT company_rollup_embeddings_rollup_fkey FOREIGN KEY (company_id) REFERENCES public.company_rollups(company_id)
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
  embedding USER-DEFINED,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  model text NOT NULL DEFAULT 'text-embedding-3-small'::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  content_hash character,
  CONSTRAINT course_review_embeddings_pkey PRIMARY KEY (review_id),
  CONSTRAINT course_review_embeddings_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.course_reviews(id)
);
CREATE TABLE public.course_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  faculty text NOT NULL CHECK (btrim(faculty) <> ''::text),
  department text,
  grade_at_take integer NOT NULL CHECK (grade_at_take >= 1 AND grade_at_take <= 6 OR grade_at_take = 99),
  teacher_names ARRAY CHECK (teacher_names_optional_valid(teacher_names)),
  academic_year integer NOT NULL CHECK (academic_year >= 1990 AND academic_year <= 2100),
  term text NOT NULL CHECK (term = ANY (ARRAY['s1'::text, 's2'::text, 'q1'::text, 'q2'::text, 'q3'::text, 'q4'::text, 'full'::text, 'intensive'::text, 'other'::text])),
  credits_at_take integer CHECK (credits_at_take IS NULL OR credits_at_take > 0),
  requirement_type_at_take text NOT NULL CHECK (requirement_type_at_take = ANY (ARRAY['required'::text, 'elective'::text, 'unknown'::text])),
  performance_self integer NOT NULL CHECK (performance_self >= 1 AND performance_self <= 4),
  assignment_difficulty_4 integer NOT NULL CHECK (assignment_difficulty_4 >= 1 AND assignment_difficulty_4 <= 4),
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
CREATE TABLE public.embedding_jobs (
  review_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'::text CHECK (status = ANY (ARRAY['queued'::text, 'processing'::text, 'done'::text, 'failed'::text])),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  locked_at timestamp with time zone,
  locked_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT embedding_jobs_pkey PRIMARY KEY (review_id),
  CONSTRAINT embedding_jobs_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.course_reviews(id)
);
CREATE TABLE public.subject_rollup_embeddings (
  subject_id uuid NOT NULL,
  embedding USER-DEFINED,
  model text NOT NULL DEFAULT 'text-embedding-3-small'::text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subject_rollup_embeddings_pkey PRIMARY KEY (subject_id),
  CONSTRAINT subject_rollup_embeddings_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subject_rollups(subject_id)
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
CREATE TABLE public.subjects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subjects_pkey PRIMARY KEY (id),
  CONSTRAINT subjects_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id)
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
  CONSTRAINT user_affiliations_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id),
  CONSTRAINT user_affiliations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_memory (
  user_id uuid NOT NULL,
  summary_1000 text NOT NULL DEFAULT ''::text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_summarized_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_memory_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_memory_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  line_user_hash character NOT NULL UNIQUE CHECK (btrim(line_user_hash::text) <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
