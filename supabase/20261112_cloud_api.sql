alter table public.students add column if not exists face_registered boolean not null default false;
alter table public.users add column if not exists email text unique;
create index if not exists attendance_date_student_idx on public.attendance_records(attendance_date,student_id);

create or replace function public.confirm_face_attendance(p_token_hash text,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.face_review_tokens%rowtype; v_consent text; v_student_active boolean; v_late_after time; v_today date; v_now timestamptz; v_status text; v_id bigint;
begin
  select * into v from public.face_review_tokens where token_hash=p_token_hash and consumed_at is null and expires_at>now() for update;
  if not found or v.user_id<>p_actor then raise exception using errcode='P0001',message='review_expired'; end if;
  select s.active into v_student_active from public.students s where s.id=v.student_id;
  select c.status into v_consent from public.face_consents c where c.student_id=v.student_id order by c.recorded_at desc,c.id desc limit 1;
  if not coalesce(v_student_active,false) or v_consent is distinct from 'granted' then raise exception using errcode='P0001',message='consent_revoked'; end if;
  select late_after into v_late_after from public.attendance_settings where id=true;
  v_now:=now(); v_today:=(v_now at time zone 'Asia/Bangkok')::date;
  v_status:=case when (v_now at time zone 'Asia/Bangkok')::time>v_late_after then 'late' else 'present' end;
  insert into public.attendance_records(student_id,attendance_date,status,checked_at,source,confidence,reviewed_by)
  values(v.student_id,v_today,v_status,v_now,'face-reviewed',v.confidence,p_actor)
  on conflict(student_id,attendance_date) do nothing returning id into v_id;
  if v_id is null then raise exception using errcode='23505',message='attendance_exists'; end if;
  update public.face_review_tokens set consumed_at=v_now where token_hash=p_token_hash;
  insert into public.audit_logs(actor_id,action,entity,entity_id,details) values(p_actor,'attendance.face-confirm','attendance',v_id::text,'{}'::jsonb);
  return jsonb_build_object('id',v_id,'status',v_status,'studentId',v.student_id,'confidence',v.confidence,'checkedAt',v_now);
end; $$;
revoke all on function public.confirm_face_attendance(text,uuid) from public,anon,authenticated;
grant execute on function public.confirm_face_attendance(text,uuid) to service_role;
