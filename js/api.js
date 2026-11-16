// Supabase istemcisi, cihaz kimliği ve RPC sarmalayıcıları.
// RPC adları ve parametre adları supabase/schema.sql ile birebir aynı olmalı.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// shortcut: cihaz kimliği localStorage'daki rastgele UUID; kararlı biri depolamayı
// silerek ya da gizli sekmeyle tekrar oy verebilir. Kötüye kullanım görülürse
// oy için giriş zorunluluğu veya sunucu tarafı IP/captcha sınırı eklenmeli.
const DEVICE_KEY = 'degermi.cihaz';
let memoryDeviceId = null;

function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID yalnızca güvenli bağlamda (https/localhost) var; yerel ağdan denemeler için yedek
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = newUuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    memoryDeviceId ??= newUuid();
    return memoryDeviceId;
  }
}

async function rpc(name, params) {
  const { data, error } = await sb.rpc(name, params);
  if (error) throw error;
  return data;
}

export const PAGE_SIZE = 20;

export const api = {
  feed: (cursor) =>
    rpc('get_feed', {
      p_limit: PAGE_SIZE,
      p_before_at: cursor?.created_at ?? null,
      p_before_id: cursor?.id ?? null,
    }),
  getRequest: (id) => rpc('get_request', { p_id: id, p_device: deviceId() }),
  vote: (id, choice) => rpc('cast_vote', { p_request: id, p_device: deviceId(), p_choice: choice }),
  comment: (id, body) => rpc('add_comment', { p_request: id, p_device: deviceId(), p_body: body }),
  report: (kind, targetId) =>
    rpc('report_content', { p_kind: kind, p_target: targetId, p_device: deviceId() }),
  createRequest: ({ title, price, reason, visibility }) =>
    rpc('create_request', {
      p_title: title,
      p_price: price,
      p_reason: reason,
      p_visibility: visibility,
    }),
  myRequests: () => rpc('my_requests'),
  deleteRequest: (id) => rpc('delete_request', { p_id: id }),
};

// Sunucudaki hata kodlarını (schema.sql'deki raise exception) Türkçe metne çevirir.
const MESSAGES = {
  kufur: 'Ayıp ayıp! O kelimeleri burada kullanmayalım, anneannen de okuyor olabilir.',
  spam: 'Link paylaşmak yok; burası reklam panosu değil, karar odası.',
  hiz_siniri: 'Biraz yavaş, Flash! Bir nefes al, birazdan tekrar dene.',
  giris_gerekli: 'Önce giriş yapman lazım.',
  gecersiz_baslik: 'Ne almak istediğini 3 ile 80 karakter arasında anlat.',
  gecersiz_fiyat: 'Fiyat 1 ₺ ile 10.000.000 ₺ arasında olmalı. Uzay gemisi şimdilik yok.',
  gecersiz_neden: 'Nedenini biraz anlat (5 ile 500 karakter arası).',
  gecersiz_yorum: 'Yorum 1 ile 280 karakter arasında olmalı.',
  bulunamadi: 'Bu talep ya silinmiş ya gizlenmiş. Belki de çoktan alındı!',
  yetkisiz: 'Bu senin talebin değil gibi görünüyor.',
  gecersiz_istek: 'Bir şeyler ters gitti. Sayfayı yenileyip tekrar dener misin?',
};

export function errorText(err) {
  const msg = err?.message ?? '';
  if (MESSAGES[msg]) return MESSAGES[msg];
  if (err?.status === 429 || /rate limit|security purposes/i.test(msg)) {
    return 'Çok sık denedin. Bir dakika kadar bekleyip tekrar dene.';
  }
  if (/fetch|network|load failed/i.test(msg)) {
    return 'İnternet bağlantısı naz yapıyor. Bağlantını kontrol edip tekrar dene.';
  }
  return 'Beklenmedik bir şey oldu. Sayfayı yenileyip tekrar dener misin?';
}
