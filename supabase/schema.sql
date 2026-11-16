-- =====================================================================
-- "Değer mi?" veritabanı şeması
-- Supabase SQL Editor'da tek seferde çalıştırılır. Tekrar çalıştırmak
-- güvenlidir (idempotent): tablolar/indeksler "if not exists", fonksiyonlar
-- "create or replace", yasaklı kelimeler "on conflict do nothing".
--
-- Güvenlik modeli:
--   * Tüm tablolarda RLS açık ve hiç policy yok; anon/authenticated
--     rollerinin tablolara doğrudan yetkisi geri alınır.
--   * İstemci yalnızca aşağıdaki SECURITY DEFINER RPC'leri çağırır:
--       get_feed, get_request, cast_vote, add_comment, report_content
--         -> anon + authenticated
--       create_request, my_requests, delete_request
--         -> yalnızca authenticated (içeride auth.uid() ayrıca kontrol edilir)
--   * Yardımcılar (normalize_text, contains_banned, has_spam) istemciye kapalı.
--   * Hiçbir RPC çıktısında e-posta veya owner_id/user_id yoktur.
--
-- Hata mesajları kısa kodlardır (ör. 'kufur', 'hiz_siniri'); istemci
-- bunları Türkçe esprili metinlere çevirir (js/api.js).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tablolar
-- ---------------------------------------------------------------------
create table if not exists public.requests (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null check (char_length(title) between 3 and 80),
  price       numeric(12,2) not null check (price >= 1 and price <= 10000000),
  reason      text not null check (char_length(reason) between 5 and 500),
  visibility  text not null default 'public' check (visibility in ('public', 'link')),
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.votes (
  request_id  uuid not null references public.requests(id) on delete cascade,
  device_id   uuid not null,
  choice      boolean not null,           -- true = "Al", false = "Alma"
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (request_id, device_id)     -- cihaz başına talep başına tek oy
);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  device_id   uuid not null,
  body        text not null check (char_length(body) between 1 and 280),
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.reports (
  id           bigint generated always as identity primary key,
  target_type  text not null check (target_type in ('request', 'comment')),
  target_id    uuid not null,
  device_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (target_type, target_id, device_id)  -- aynı cihaz aynı içeriği bir kez bildirir
);

-- Yasaklı kelimeler: word normalize_text() ile normalize edilmiş haldedir.
-- is_prefix = true  -> kelime bu kökle BAŞLIYORSA yakalanır (Türkçe ekler için)
-- is_prefix = false -> yalnızca kelimenin TAMAMI eşleşirse yakalanır
--                     (ör. "got" önek olsaydı "götürmek" de yakalanırdı)
create table if not exists public.banned_words (
  word       text primary key,
  is_prefix  boolean not null default true
);

create index if not exists requests_feed_idx
  on public.requests (created_at desc, id desc)
  where visibility = 'public' and not hidden;
create index if not exists requests_owner_idx    on public.requests (owner_id, created_at desc);
create index if not exists comments_request_idx  on public.comments (request_id, created_at);
create index if not exists comments_device_idx   on public.comments (device_id, created_at);
create index if not exists reports_device_idx    on public.reports (device_id, created_at);

alter table public.requests     enable row level security;
alter table public.votes        enable row level security;
alter table public.comments     enable row level security;
alter table public.reports      enable row level security;
alter table public.banned_words enable row level security;

-- Supabase varsayılan yetkileri anon/authenticated'a tablo erişimi verir; geri al.
revoke all on table public.requests, public.votes, public.comments,
                    public.reports, public.banned_words
  from public, anon, authenticated;
revoke all on sequence public.reports_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Yardımcı fonksiyonlar (istemciye kapalı)
-- ---------------------------------------------------------------------

-- Türkçe karakterleri sadeleştirir, küçültür, bazı "leet" rakamlarını harfe
-- çevirir, harf/boşluk dışını siler, tekrar eden harfleri teke indirir.
-- "OOROSPU", "o.r.o.s.p.u", "0r0spu" -> "orospu"
create or replace function public.normalize_text(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(
            lower(translate(coalesce(t, ''),
              'İIıÇçĞğÖöŞşÜüÂâÎîÛû',
              'iiiccggoossuuaaiiuu')),
            '013457@$',
            'oieastas'),
          '[^a-z[:space:]]', '', 'g'),
        '([a-z])\1+', '\1', 'g'),
      '[[:space:]]+', ' ', 'g'));
$$;

create or replace function public.contains_banned(t text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(string_to_array(public.normalize_text(t), ' ')) as tok
    join public.banned_words b
      on tok = b.word
      or (b.is_prefix and left(tok, char_length(b.word)) = b.word)
  );
$$;

-- Basit spam kuralı: bağlantı içeren metinler reddedilir.
create or replace function public.has_spam(t text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(t, '') ~* '(https?://|www\.|\m[a-z0-9-]+\.(com|net|org|xyz|ru|info|biz|top|click)\M)';
$$;

revoke all on function public.normalize_text(text)  from public, anon, authenticated;
revoke all on function public.contains_banned(text) from public, anon, authenticated;
revoke all on function public.has_spam(text)        from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Yasaklı kelime listesi (normalize edilerek eklenir)
-- shortcut: düz kelime listesi; harf aralarına boşluk koyan ("s i k") ya da
-- yeni türetilen yazımları kaçırır. Gerekirse liste büyütülür veya
-- moderasyon servisine geçilir.
-- ---------------------------------------------------------------------
insert into public.banned_words (word, is_prefix)
select public.normalize_text(w), p
from (values
  -- önekle yakalananlar (Türkçe eklerle birlikte)
  ('amına', true), ('amcık', true), ('orospu', true), ('siktir', true),
  ('sikerim', true), ('sikeyim', true), ('sikiyim', true), ('sikicem', true),
  ('sikik', true), ('sikimin', true), ('hassiktir', true), ('yarrak', true),
  ('dalyarak', true), ('yavşak', true), ('pezevenk', true), ('kahpe', true),
  ('kaltak', true), ('gavat', true), ('ibne', true), ('kancık', true),
  ('fahişe', true), ('sürtük', true), ('şerefsiz', true), ('götveren', true),
  ('götlek', true), ('kodumun', true), ('ananısikim', true), ('dangalak', true),
  ('godoş', true), ('puşt', true), ('amk', true),
  -- yalnızca tam kelime. Normalizasyon ı->i yaptığı için "sık", "sıktım",
  -- "sıkın", "götür" gibi masum kelimeler çakışmasın diye "sik", "siktim"
  -- vb. bilerek listede yok ya da yalnızca tam eşleşmeyle var.
  ('sikim', false), ('göt', false),
  ('götü', false), ('götün', false), ('götünü', false), ('götüne', false),
  ('piç', false), ('piçi', false), ('piçin', false), ('aq', false),
  ('amq', false), ('oç', false), ('mk', false), ('mq', false), ('sg', false)
) as v(w, p)
on conflict (word) do nothing;

-- ---------------------------------------------------------------------
-- İstemci RPC'leri
-- ---------------------------------------------------------------------

-- Akış: yalnızca herkese açık + gizlenmemiş talepler, en yeni üstte.
-- Sayfalama anahtar tabanlı: sonraki sayfa için son satırın created_at ve id'si.
create or replace function public.get_feed(
  p_limit      integer     default 20,
  p_before_at  timestamptz default null,
  p_before_id  uuid        default null
)
returns table (
  id            uuid,
  title         text,
  price         numeric,
  reason        text,
  created_at    timestamptz,
  yes_count     bigint,
  no_count      bigint,
  comment_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.title, r.price, r.reason, r.created_at,
         (select count(*) from public.votes v where v.request_id = r.id and v.choice),
         (select count(*) from public.votes v where v.request_id = r.id and not v.choice),
         (select count(*) from public.comments c where c.request_id = r.id and not c.hidden)
  from public.requests r
  where r.visibility = 'public'
    and not r.hidden
    and (p_before_at is null
         or (r.created_at, r.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by r.created_at desc, r.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- Tek talep: uuid bilen herkes görür ("sadece linkle" olanlar dahil).
-- Gizlenmiş/silinmiş talepte null döner.
create or replace function public.get_request(p_id uuid, p_device uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',         r.id,
    'title',      r.title,
    'price',      r.price,
    'reason',     r.reason,
    'visibility', r.visibility,
    'created_at', r.created_at,
    'yes_count',  (select count(*) from public.votes v where v.request_id = r.id and v.choice),
    'no_count',   (select count(*) from public.votes v where v.request_id = r.id and not v.choice),
    'my_vote',    (select v.choice from public.votes v
                    where v.request_id = r.id and v.device_id = p_device),
    'is_owner',   coalesce(r.owner_id = auth.uid(), false),
    'comments',   coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'id', c.id, 'body', c.body, 'created_at', c.created_at,
                             'mine', c.device_id = p_device)
                           order by c.created_at desc)
                    from public.comments c
                    where c.request_id = r.id and not c.hidden), '[]'::jsonb)
  )
  from public.requests r
  where r.id = p_id and not r.hidden;
$$;

-- Oy ver / değiştir (cihaz başına talep başına tek oy).
-- shortcut: cihaz kimliği istemcinin localStorage'ındaki UUID'dir; kararlı biri
-- depolamayı silerek tekrar oy verebilir. Gerekirse giriş zorunlu oy veya
-- captcha/IP tabanlı sınır eklenir.
create or replace function public.cast_vote(p_request uuid, p_device uuid, p_choice boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_device is null or p_choice is null then
    raise exception 'gecersiz_istek';
  end if;
  if not exists (select 1 from public.requests r where r.id = p_request and not r.hidden) then
    raise exception 'bulunamadi';
  end if;

  insert into public.votes (request_id, device_id, choice)
  values (p_request, p_device, p_choice)
  on conflict (request_id, device_id)
  do update set choice = excluded.choice, updated_at = now();
end;
$$;

-- Yorum ekle: uzunluk, küfür, spam ve hız sınırı (cihaz başına dakikada 3).
create or replace function public.add_comment(p_request uuid, p_device uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id   uuid;
begin
  if p_device is null then
    raise exception 'gecersiz_istek';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 280 then
    raise exception 'gecersiz_yorum';
  end if;
  if not exists (select 1 from public.requests r where r.id = p_request and not r.hidden) then
    raise exception 'bulunamadi';
  end if;
  if public.contains_banned(v_body) then
    raise exception 'kufur';
  end if;
  if public.has_spam(v_body) then
    raise exception 'spam';
  end if;
  if (select count(*) from public.comments c
       where c.device_id = p_device and c.created_at > now() - interval '1 minute') >= 3 then
    raise exception 'hiz_siniri';
  end if;

  insert into public.comments (request_id, device_id, body)
  values (p_request, p_device, v_body)
  returning id into v_id;
  return v_id;
end;
$$;

-- Bildir: aynı cihaz aynı içeriği bir kez; 3 farklı cihazda içerik gizlenir.
-- Dönüş: 'ok' (kaydedildi) veya 'zaten' (bu cihaz daha önce bildirmiş).
create or replace function public.report_content(p_kind text, p_target uuid, p_device uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_device is null or p_target is null then
    raise exception 'gecersiz_istek';
  end if;
  if p_kind = 'request' then
    if not exists (select 1 from public.requests r where r.id = p_target) then
      raise exception 'bulunamadi';
    end if;
  elsif p_kind = 'comment' then
    if not exists (select 1 from public.comments c where c.id = p_target) then
      raise exception 'bulunamadi';
    end if;
  else
    raise exception 'gecersiz_istek';
  end if;

  if exists (select 1 from public.reports x
              where x.target_type = p_kind and x.target_id = p_target and x.device_id = p_device) then
    return 'zaten';
  end if;
  if (select count(*) from public.reports x
       where x.device_id = p_device and x.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'hiz_siniri';
  end if;

  insert into public.reports (target_type, target_id, device_id)
  values (p_kind, p_target, p_device)
  on conflict (target_type, target_id, device_id) do nothing;

  select count(distinct x.device_id) into v_count
  from public.reports x
  where x.target_type = p_kind and x.target_id = p_target;

  if v_count >= 3 then
    if p_kind = 'request' then
      update public.requests set hidden = true where id = p_target;
    else
      update public.comments set hidden = true where id = p_target;
    end if;
  end if;
  return 'ok';
end;
$$;

-- Talep oluştur: giriş zorunlu, kullanıcı başına 24 saatte en fazla 5 talep.
create or replace function public.create_request(
  p_title      text,
  p_price      numeric,
  p_reason     text,
  p_visibility text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_title  text := btrim(coalesce(p_title, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'giris_gerekli';
  end if;
  if char_length(v_title) < 3 or char_length(v_title) > 80 then
    raise exception 'gecersiz_baslik';
  end if;
  if p_price is null or p_price < 1 or p_price > 10000000 then
    raise exception 'gecersiz_fiyat';
  end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'gecersiz_neden';
  end if;
  if p_visibility is null or p_visibility not in ('public', 'link') then
    raise exception 'gecersiz_istek';
  end if;
  if public.contains_banned(v_title) or public.contains_banned(v_reason) then
    raise exception 'kufur';
  end if;
  if public.has_spam(v_title) or public.has_spam(v_reason) then
    raise exception 'spam';
  end if;
  if (select count(*) from public.requests r
       where r.owner_id = v_uid and r.created_at > now() - interval '1 day') >= 5 then
    raise exception 'hiz_siniri';
  end if;

  insert into public.requests (owner_id, title, price, reason, visibility)
  values (v_uid, v_title, round(p_price, 2), v_reason, p_visibility)
  returning id into v_id;
  return v_id;
end;
$$;

-- Taleplerim: giriş yapanın kendi talepleri (gizlenenler dahil, işaretli).
create or replace function public.my_requests()
returns table (
  id            uuid,
  title         text,
  price         numeric,
  visibility    text,
  hidden        boolean,
  created_at    timestamptz,
  yes_count     bigint,
  no_count      bigint,
  comment_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.title, r.price, r.visibility, r.hidden, r.created_at,
         (select count(*) from public.votes v where v.request_id = r.id and v.choice),
         (select count(*) from public.votes v where v.request_id = r.id and not v.choice),
         (select count(*) from public.comments c where c.request_id = r.id and not c.hidden)
  from public.requests r
  where auth.uid() is not null and r.owner_id = auth.uid()
  order by r.created_at desc
  limit 200;
$$;

-- Talebi sil: yalnızca sahibi. Oylar ve yorumlar cascade ile silinir.
create or replace function public.delete_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'giris_gerekli';
  end if;
  delete from public.requests r where r.id = p_id and r.owner_id = v_uid;
  if not found then
    raise exception 'yetkisiz';
  end if;
  -- yetim kalan bildirimleri temizle
  delete from public.reports x
  where x.target_type = 'request' and x.target_id = p_id;
  delete from public.reports x
  where x.target_type = 'comment'
    and not exists (select 1 from public.comments c where c.id = x.target_id);
end;
$$;

-- ---------------------------------------------------------------------
-- Yetkiler: önce herkesten geri al, sonra yalnızca gerekene ver.
-- ---------------------------------------------------------------------
revoke all on function public.get_feed(integer, timestamptz, uuid)         from public, anon, authenticated;
revoke all on function public.get_request(uuid, uuid)                      from public, anon, authenticated;
revoke all on function public.cast_vote(uuid, uuid, boolean)               from public, anon, authenticated;
revoke all on function public.add_comment(uuid, uuid, text)                from public, anon, authenticated;
revoke all on function public.report_content(text, uuid, uuid)             from public, anon, authenticated;
revoke all on function public.create_request(text, numeric, text, text)    from public, anon, authenticated;
revoke all on function public.my_requests()                                from public, anon, authenticated;
revoke all on function public.delete_request(uuid)                         from public, anon, authenticated;

grant execute on function public.get_feed(integer, timestamptz, uuid)      to anon, authenticated;
grant execute on function public.get_request(uuid, uuid)                   to anon, authenticated;
grant execute on function public.cast_vote(uuid, uuid, boolean)            to anon, authenticated;
grant execute on function public.add_comment(uuid, uuid, text)             to anon, authenticated;
grant execute on function public.report_content(text, uuid, uuid)          to anon, authenticated;
grant execute on function public.create_request(text, numeric, text, text) to authenticated;
grant execute on function public.my_requests()                             to authenticated;
grant execute on function public.delete_request(uuid)                      to authenticated;
