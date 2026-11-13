-- Remember which saved foods came from a barcode, so re-scanning finds them instantly.
alter table public.foods add column if not exists barcode text;
create index if not exists foods_barcode on public.foods (user_id, barcode) where barcode is not null;
