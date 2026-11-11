-- Follow-up: indexes for foreign keys, explicit deny policies for private biometric tables.
create index students_classroom_idx on public.students(classroom_id);
create index consent_actor_idx on public.face_consents(recorded_by);
create index templates_actor_idx on public.face_templates(created_by);
create index attendance_reviewer_idx on public.attendance_records(reviewed_by);
create index settings_actor_idx on public.attendance_settings(updated_by);
create index audit_actor_idx on public.audit_logs(actor_id);
create index review_student_idx on public.face_review_tokens(student_id);
create index review_user_idx on public.face_review_tokens(user_id);
create policy biometric_templates_deny_browser on public.face_templates for all to anon, authenticated using (false) with check (false);
create policy review_tokens_deny_browser on public.face_review_tokens for all to anon, authenticated using (false) with check (false);
drop policy users_read_self_or_admin on public.users;
create policy users_read_self_or_admin on public.users for select to authenticated using ((select auth.uid())=id or private.current_role()='admin');
drop policy consent_admin_insert on public.face_consents;
create policy consent_admin_insert on public.face_consents for insert to authenticated with check (private.current_role()='admin' and recorded_by=(select auth.uid()));
drop policy attendance_staff_insert on public.attendance_records;
create policy attendance_staff_insert on public.attendance_records for insert to authenticated with check (private.current_role() in ('admin','teacher') and reviewed_by=(select auth.uid()) and (status<>'absent' or private.current_role()='admin'));
drop policy classroom_admin_write on public.classrooms;
create policy classroom_admin_insert on public.classrooms for insert to authenticated with check (private.current_role()='admin');
create policy classroom_admin_update on public.classrooms for update to authenticated using (private.current_role()='admin') with check (private.current_role()='admin');
create policy classroom_admin_delete on public.classrooms for delete to authenticated using (private.current_role()='admin');
drop policy student_admin_write on public.students;
create policy student_admin_insert on public.students for insert to authenticated with check (private.current_role()='admin');
create policy student_admin_update on public.students for update to authenticated using (private.current_role()='admin') with check (private.current_role()='admin');
create policy student_admin_delete on public.students for delete to authenticated using (private.current_role()='admin');
drop policy camera_admin_write on public.camera_devices;
create policy camera_admin_insert on public.camera_devices for insert to authenticated with check (private.current_role()='admin');
create policy camera_admin_update on public.camera_devices for update to authenticated using (private.current_role()='admin') with check (private.current_role()='admin');
create policy camera_admin_delete on public.camera_devices for delete to authenticated using (private.current_role()='admin');
drop policy student_admin_delete on public.students;
drop policy classroom_admin_delete on public.classrooms;
create or replace function private.log_change() returns trigger language plpgsql security definer set search_path='' as $$
declare row_id text;
begin
  row_id := coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id',to_jsonb(new)->>'student_id',to_jsonb(old)->>'student_id');
  insert into public.audit_logs(actor_id,action,entity,entity_id,details)
  values(auth.uid(),lower(tg_table_name||'.'||tg_op),tg_table_name,row_id,'{}'::jsonb);
  return coalesce(new,old);
end; $$;
revoke all on function private.log_change() from public,anon,authenticated;
create trigger audit_students after insert or update or delete on public.students for each row execute function private.log_change();
create trigger audit_consents after insert on public.face_consents for each row execute function private.log_change();
create trigger audit_attendance after insert or update or delete on public.attendance_records for each row execute function private.log_change();
create trigger audit_settings after update on public.attendance_settings for each row execute function private.log_change();
