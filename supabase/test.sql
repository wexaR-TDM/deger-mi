-- =====================================================================
-- "Değer mi?" küçük öz-kontrol
-- schema.sql uygulandıktan SONRA Supabase SQL Editor'da çalıştırın.
-- Her şey tek bir transaction içinde yapılır ve sonda ROLLBACK edilir;
-- yani test verisi (sahte kullanıcı, talep, oy, yorum, bildirim) kalmaz.
-- Bir kontrol başarısız olursa betik o noktada hata verip durur.
-- En sonda "TUM TESTLER GECTI" satırını görüyorsanız her şey yolunda.
-- =====================================================================

begin;

-- Sahte kullanıcı (yalnızca bu transaction içinde var olur)
insert into auth.users (id, email, aud, role)
values ('00000000-0000-4000-8000-0000000000a1', 'test-deger-mi@example.invalid',
        'authenticated', 'authenticated');

do $$
declare
  u1   constant uuid := '00000000-0000-4000-8000-0000000000a1';
  d1   constant uuid := '00000000-0000-4000-8000-0000000000d1';
  d2   constant uuid := '00000000-0000-4000-8000-0000000000d2';
  d3   constant uuid := '00000000-0000-4000-8000-0000000000d3';
  d4   constant uuid := '00000000-0000-4000-8000-0000000000d4';
  rid  uuid;
  cid  uuid;
  j    jsonb;
  st   text;
begin
  -- -------------------------------------------------------------------
  -- 1) Küfür filtresi: normalizasyon (Türkçe harf, büyük/küçük, tekrar,
  --    nokta/rakam hileleri) ve masum kelimelerin geçmesi
  -- -------------------------------------------------------------------
  assert public.contains_banned('Bu ne AMK'),               'kufur: AMK yakalanmali';
  assert public.contains_banned('a.m.k'),                   'kufur: a.m.k yakalanmali';
  assert public.contains_banned('OOORROSPUUU çocuğu'),      'kufur: tekrar harf yakalanmali';
  assert public.contains_banned('S İ K T İ R') = false,     'bilinen sinir: harf arasi bosluk (shortcut)';
  assert public.contains_banned('S1KT1R git'),              'kufur: leet rakam yakalanmali';
  assert public.contains_banned('Şerefsizler'),             'kufur: Turkce ek yakalanmali';
  assert not public.contains_banned('Sık sık sıkıldım, trafik çok sıkışık'), 'masum: sik/sikis';
  assert not public.contains_banned('Kargo bunu bana götürür mü?'),          'masum: goturmek';
  assert not public.contains_banned('Ananas alayım mı, amin'),               'masum: ananas/amin';
  assert public.has_spam('bedava kazan www.ornek.com'),     'spam: link yakalanmali';
  assert not public.has_spam('Fiyatı 1.500 TL, mantıklı mı?'), 'spam: masum metin';

  -- -------------------------------------------------------------------
  -- 2) Yetkisiz talep açma reddedilmeli
  -- -------------------------------------------------------------------
  -- 2a) anon rolünün create_request yetkisi yok
  set local role anon;
  begin
    perform public.create_request('Yeni telefon', 25000, 'Eskisi çok yavaş', 'public');
    raise exception 'BEKLENMEDIK_BASARI';
  exception when insufficient_privilege then
    null; -- beklenen
  end;
  reset role;

  -- 2b) authenticated ama kimliksiz (sub yok) -> giris_gerekli
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.create_request('Yeni telefon', 25000, 'Eskisi çok yavaş', 'public');
    raise exception 'BEKLENMEDIK_BASARI';
  exception when others then
    assert sqlerrm = 'giris_gerekli', 'kimliksiz talep: beklenen giris_gerekli, gelen ' || sqlerrm;
  end;
  reset role;

  -- -------------------------------------------------------------------
  -- 3) Giriş yapmış kullanıcı talep açar; küfürlü talep reddedilir
  -- -------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    perform public.create_request('Sikerim böyle telefonu', 25000, 'Eskisi çok yavaş', 'public');
    raise exception 'BEKLENMEDIK_BASARI';
  exception when others then
    assert sqlerrm = 'kufur', 'kufurlu talep: beklenen kufur, gelen ' || sqlerrm;
  end;

  begin
    perform public.create_request('Yeni telefon', 0, 'Eskisi çok yavaş', 'public');
    raise exception 'BEKLENMEDIK_BASARI';
  exception when others then
    assert sqlerrm = 'gecersiz_fiyat', 'fiyat: beklenen gecersiz_fiyat, gelen ' || sqlerrm;
  end;

  rid := public.create_request('Yeni telefon', 25000, 'Eskisi çok yavaş', 'public');
  assert rid is not null, 'talep olusmali';
  assert (select count(*) from public.my_requests()) = 1, 'taleplerim 1 kayit donmeli';
  reset role;

  -- -------------------------------------------------------------------
  -- 4) Tek oy kuralı: cihaz başına tek oy, değiştirilebilir
  -- -------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  perform public.cast_vote(rid, d1, true);
  perform public.cast_vote(rid, d1, true);
  perform public.cast_vote(rid, d1, false);   -- fikir değiştirdi
  perform public.cast_vote(rid, d2, true);
  j := public.get_request(rid, d1);
  assert (j->>'yes_count')::int = 1, 'oy: al sayisi 1 olmali, gelen ' || (j->>'yes_count');
  assert (j->>'no_count')::int  = 1, 'oy: alma sayisi 1 olmali, gelen ' || (j->>'no_count');
  assert (j->>'my_vote')::boolean = false, 'oy: d1 son oyu alma olmali';
  assert not (j ? 'owner_id') and not (j ? 'email'), 'sizinti: owner_id/email donmemeli';

  -- küfürlü yorum reddedilir
  begin
    perform public.add_comment(rid, d1, 'alma amk');
    raise exception 'BEKLENMEDIK_BASARI';
  exception when others then
    assert sqlerrm = 'kufur', 'kufurlu yorum: beklenen kufur, gelen ' || sqlerrm;
  end;

  -- -------------------------------------------------------------------
  -- 5) 3 farklı cihazdan bildirim -> gizleme
  -- -------------------------------------------------------------------
  cid := public.add_comment(rid, d1, 'Bence bekle, kampanya gelir');
  assert jsonb_array_length(public.get_request(rid, d1)->'comments') = 1, 'yorum gorunmeli';

  st := public.report_content('comment', cid, d2);  assert st = 'ok',    'bildir d2';
  st := public.report_content('comment', cid, d2);  assert st = 'zaten', 'ayni cihaz ikinci kez sayilmamali';
  st := public.report_content('comment', cid, d3);  assert st = 'ok',    'bildir d3';
  assert jsonb_array_length(public.get_request(rid, d1)->'comments') = 1, '2 bildirimde hala gorunmeli';
  st := public.report_content('comment', cid, d4);  assert st = 'ok',    'bildir d4';
  assert jsonb_array_length(public.get_request(rid, d1)->'comments') = 0, '3 bildirimde gizlenmeli';

  assert exists (select 1 from public.get_feed(50) f where f.id = rid), 'talep akista gorunmeli';
  perform public.report_content('request', rid, d2);
  perform public.report_content('request', rid, d3);
  perform public.report_content('request', rid, d4);
  assert public.get_request(rid, d1) is null, 'gizlenen talep acilmamali';
  assert not exists (select 1 from public.get_feed(50) f where f.id = rid), 'gizlenen talep akista olmamali';

  -- anon tablolara doğrudan erişemez
  begin
    perform 1 from public.requests limit 1;
    raise exception 'BEKLENMEDIK_BASARI';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- -------------------------------------------------------------------
  -- 6) Başkası silemez, sahibi silebilir
  -- -------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_request(rid);
    raise exception 'BEKLENMEDIK_BASARI';
  exception when others then
    assert sqlerrm = 'yetkisiz', 'baskasi silememeli, gelen ' || sqlerrm;
  end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.delete_request(rid);
  assert (select count(*) from public.my_requests()) = 0, 'sahibi silebilmeli';
  reset role;

  raise notice 'TUM TESTLER GECTI';
end;
$$;

rollback;

select 'TUM TESTLER GECTI (veriler geri alindi)' as sonuc;
