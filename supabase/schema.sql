-- FACE ATTENDANCE initial schema: personal data protected by RLS; biometric templates never exposed to browser roles.
create schema if not exists private;
create table public.users(id uuid primary key references auth.users(id) on delete cascade, display_name text not null, role text not null check(role in ('admin','teacher')), active boolean not null default true, created_at timestamptz not null default now());
create table public.classrooms(id bigint generated always as identity primary key, grade text not null, room text not null, unique(grade,room));
create table public.students(id bigint generated always as identity primary key, student_code text not null unique, first_name text not null, last_name text not null, portrait_data text, classroom_id bigint references public.classrooms(id), active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.face_consents(id bigint generated always as identity primary key, student_id bigint not null references public.students(id) on delete cascade, status text not null check(status in ('granted','revoked')), version text not null, recorded_by uuid not null references public.users(id), recorded_at timestamptz not null default now());
create index face_consents_latest_idx on public.face_consents(student_id,recorded_at desc);
create table public.face_templates(student_id bigint primary key references public.students(id) on delete cascade, ciphertext bytea not null, iv bytea not null, auth_tag bytea not null, dimensions integer not null, model_version text not null, created_by uuid not null references public.users(id), created_at timestamptz not null default now());
create table public.attendance_settings(id boolean primary key default true check(id), starts_at time not null default '08:00', late_after time not null default '08:15', match_threshold real not null default 0.88 check(match_threshold between 0.5 and 0.999), updated_by uuid references public.users(id), updated_at timestamptz not null default now());
insert into public.attendance_settings(id) values(true) on conflict do nothing;
create table public.attendance_records(id bigint generated always as identity primary key, student_id bigint not null references public.students(id), attendance_date date not null, status text not null check(status in ('present','late','absent','excused')), checked_at timestamptz, source text not null check(source in ('manual','face-reviewed','edit')), confidence real check(confidence between 0 and 1), reviewed_by uuid references public.users(id), note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(student_id,attendance_date));
create index attendance_date_status_idx on public.attendance_records(attendance_date,status);
create table public.camera_devices(id bigint generated always as identity primary key, label text not null, kind text not null check(kind in ('webcam','cctv-gateway')), active boolean not null default true, config jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.audit_logs(id bigint generated always as identity primary key, actor_id uuid references public.users(id), action text not null, entity text not null, entity_id text, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.face_review_tokens(token_hash text primary key, student_id bigint not null references public.students(id) on delete cascade, user_id uuid not null references public.users(id) on delete cascade, confidence real not null check(confidence between 0 and 1), expires_at timestamptz not null, consumed_at timestamptz);
create or replace function private.current_role() returns text language sql stable security definer set search_path='' as $$ select role from public.users where id=auth.uid() and active $$;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke all on function private.current_role() from public, anon;
grant execute on function private.current_role() to authenticated;

alter table public.users enable row level security;
alter table public.classrooms enable row level security;
alter table public.students enable row level security;
alter table public.face_consents enable row level security;
alter table public.face_templates enable row level security;
alter table public.attendance_settings enable row level security;
alter table public.attendance_records enable row level security;
alter table public.camera_devices enable row level security;
alter table public.audit_logs enable row level security;
alter table public.face_review_tokens enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select,insert,update,delete on public.classrooms,public.students,public.face_consents,public.attendance_settings,public.attendance_records,public.camera_devices to authenticated;
grant select,update on public.users to authenticated;
grant select on public.audit_logs to authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to authenticated,service_role;

create policy users_read_self_or_admin on public.users for select to authenticated using(id=auth.uid() or private.current_role()='admin');
create policy users_admin_update on public.users for update to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy classroom_staff_read on public.classrooms for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy classroom_admin_write on public.classrooms for all to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy student_staff_read on public.students for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy student_admin_write on public.students for all to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy consent_staff_read on public.face_consents for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy consent_admin_insert on public.face_consents for insert to authenticated with check(private.current_role()='admin' and recorded_by=auth.uid());
create policy settings_staff_read on public.attendance_settings for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy settings_admin_write on public.attendance_settings for update to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy attendance_staff_read on public.attendance_records for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy attendance_staff_insert on public.attendance_records for insert to authenticated with check(private.current_role() in ('admin','teacher') and reviewed_by=auth.uid() and (status<>'absent' or private.current_role()='admin'));
create policy attendance_admin_update on public.attendance_records for update to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy camera_staff_read on public.camera_devices for select to authenticated using(private.current_role() in ('admin','teacher'));
create policy camera_admin_write on public.camera_devices for all to authenticated using(private.current_role()='admin') with check(private.current_role()='admin');
create policy audit_admin_read on public.audit_logs for select to authenticated using(private.current_role()='admin');
-- biometric templates and one-time review tokens have no browser grants or policies; Edge Functions only.
