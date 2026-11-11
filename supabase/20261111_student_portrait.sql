-- Store only a small, cropped student roster thumbnail. API access remains behind app authentication.
alter table public.students add column if not exists portrait_data text;
