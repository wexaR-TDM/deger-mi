// "Değer mi?" uygulama kabuğu: hash yönlendirme + ekranlar.
// Kural: kullanıcı verisi DOM'a yalnızca metin olarak girer (el() / append / textContent).
import { sb, api, errorText, PAGE_SIZE } from './api.js';

const app = document.getElementById('app');
const toastBox = document.getElementById('toast');
const RETURN_KEY = 'degermi.donus';
const REFRESH_MS = 30000;

let session = null;

// ---------------------------------------------------------------------
// Küçük yardımcılar
// ---------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child); // string -> metin düğümü (HTML olarak yorumlanmaz)
  }
  return node;
}

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* gizli mod vb.: sorun değil */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let toastTimer;
function toast(message) {
  toastBox.textContent = message;
  toastBox.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove('show'), 4500);
}

const priceFmt = (digits) => new Intl.NumberFormat('tr-TR', {
  style: 'currency', currency: 'TRY', minimumFractionDigits: digits, maximumFractionDigits: digits,
});
const wholeFmt = priceFmt(0);
const centFmt = priceFmt(2);
const formatPrice = (n) => (Number.isInteger(Number(n)) ? wholeFmt : centFmt).format(Number(n));

const rtf = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
function timeAgo(iso) {
  const sec = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = sec;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// "1.500", "1500,50", "₺ 2.000" gibi yazımları sayıya çevirir.
function parsePrice(text) {
  let s = String(text).replace(/[₺\s]|TL/gi, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Number(s);
}

function shareUrl(id) {
  return `${location.origin}${location.pathname}#/t/${id}`;
}

// Al/Alma yüzde çubuğu
function resultBar(yes, no) {
  const total = Number(yes) + Number(no);
  const yesPct = total ? Math.round((yes * 100) / total) : 0;
  const noPct = total ? 100 - yesPct : 0;
  const wrap = el('div', { class: 'result' });
  if (!total) {
    wrap.append(el('p', { class: 'muted' }, 'Henüz oy yok. İlk oyu sen ver!'));
    return wrap;
  }
  const yesPart = el('span', { class: 'bar-yes' });
  const noPart = el('span', { class: 'bar-no' });
  yesPart.style.width = `${yesPct}%`;
  noPart.style.width = `${noPct}%`;
  wrap.append(
    el('div', {
      class: 'bar', role: 'img',
      'aria-label': `Yüzde ${yesPct} Al, yüzde ${noPct} Alma, toplam ${total} oy`,
    }, yesPart, noPart),
    el('div', { class: 'bar-labels', 'aria-hidden': 'true' },
      el('span', { class: 'yes-text' }, `Al %${yesPct}`),
      el('span', { class: 'muted' }, `${total} oy`),
      el('span', { class: 'no-text' }, `Alma %${noPct}`)),
  );
  return wrap;
}

function errorBox(err, retry) {
  return el('div', { class: 'notice', role: 'alert' },
    el('p', {}, errorText(err)),
    retry && el('button', { class: 'btn', type: 'button', onclick: retry }, 'Tekrar dene'));
}

function requireLogin(returnTo) {
  if (session) return true;
  store(RETURN_KEY, returnTo);
  toast('Önce giriş yapalım; sonra kaldığın yerden devam edersin.');
  location.replace('#/giris');
  return false;
}

// ---------------------------------------------------------------------
// Ekran: Akış
// ---------------------------------------------------------------------
function feedCard(row) {
  return el('li', {},
    el('a', { class: 'card', href: `#/t/${row.id}` },
      el('h2', { class: 'card-title' }, row.title),
      el('p', { class: 'price' }, formatPrice(row.price)),
      el('p', { class: 'reason clamp' }, row.reason),
      resultBar(row.yes_count, row.no_count),
      el('p', { class: 'meta' },
        `${row.comment_count} yorum · ${timeAgo(row.created_at)}`)));
}

async function viewFeed(root) {
  root.append(
    el('h1', {}, 'Almadan önce bir sor'),
    el('p', { class: 'lead' }, 'İnsanlar ne almak istiyor, sen ne dersin? Bas oyu, kurtar bir cüzdanı.'));
  const list = el('ul', { class: 'cards' });
  const more = el('button', { class: 'btn btn-ghost wide', type: 'button' }, 'Daha fazla göster');
  root.append(list);

  let cursor = null;
  async function loadPage() {
    more.disabled = true;
    more.textContent = 'Yükleniyor…';
    try {
      const rows = await api.feed(cursor);
      if (!cursor && rows.length === 0) {
        root.append(el('div', { class: 'empty' },
          el('p', {}, 'Burası çok sessiz… Henüz kimse bir şey almaya niyetlenmemiş.'),
          el('a', { class: 'btn btn-primary', href: '#/yeni' }, 'İlk soran sen ol')));
      }
      rows.forEach((row) => list.append(feedCard(row)));
      cursor = rows.at(-1) ?? cursor;
      if (rows.length === PAGE_SIZE) {
        more.disabled = false;
        more.textContent = 'Daha fazla göster';
        root.append(more);
      } else {
        more.remove();
      }
    } catch (err) {
      more.remove();
      root.append(errorBox(err, () => render()));
    }
  }
  more.addEventListener('click', loadPage);
  await loadPage();
}

// ---------------------------------------------------------------------
// Ekran: Yeni talep
// ---------------------------------------------------------------------
function field(id, labelText, input, hint) {
  const hintEl = hint ? el('p', { class: 'hint', id: `${id}-hint` }, hint) : null;
  const errEl = el('p', { class: 'field-error', id: `${id}-err`, 'aria-live': 'polite' });
  input.id = id;
  input.setAttribute('aria-describedby', [hintEl && `${id}-hint`, `${id}-err`].filter(Boolean).join(' '));
  return {
    wrap: el('div', { class: 'field' }, el('label', { for: id }, labelText), input, hintEl, errEl),
    setError(msg) {
      errEl.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

function counter(input, max) {
  const out = el('span', { class: 'counter', 'aria-hidden': 'true' }, `0 / ${max}`);
  input.addEventListener('input', () => { out.textContent = `${input.value.length} / ${max}`; });
  return out;
}

async function viewNew(root) {
  if (!requireLogin('#/yeni')) return;

  const title = el('input', { type: 'text', maxlength: '80', required: true, autocomplete: 'off', placeholder: 'ör. Kablosuz kulaklık' });
  const price = el('input', { type: 'text', inputmode: 'decimal', required: true, autocomplete: 'off', placeholder: 'ör. 2.499' });
  const reason = el('textarea', { maxlength: '500', rows: '4', required: true, placeholder: 'ör. Eskisinin bir tarafı gitti, ama bu biraz pahalı mı?' });

  const fTitle = field('f-title', 'Ne almak istiyorsun?', title);
  const fPrice = field('f-price', 'Fiyatı (₺)', price, 'Yaklaşık fiyat yeter.');
  const fReason = field('f-reason', 'Neden istiyorsun?', reason);
  fReason.wrap.append(counter(reason, 500));

  const radio = (value, label, hint, checked) =>
    el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'visibility', value, checked }),
      el('span', {}, el('strong', {}, label), el('span', { class: 'hint' }, hint)));

  const submit = el('button', { class: 'btn btn-primary wide', type: 'submit' }, 'Oylamaya aç');
  const form = el('form', { class: 'stack', novalidate: true },
    fTitle.wrap, fPrice.wrap, fReason.wrap,
    el('fieldset', { class: 'field' },
      el('legend', {}, 'Kimler görsün?'),
      radio('public', 'Herkese açık', 'Akışta görünür, herkes oy verebilir.', true),
      radio('link', 'Sadece linkle', 'Akışta görünmez; yalnızca linki olanlar görür.', false)),
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = title.value.trim();
    const r = reason.value.trim();
    const p = parsePrice(price.value);
    const visibility = form.elements.visibility.value;

    fTitle.setError(t.length < 3 ? 'En az 3 karakter yaz; "şey" yetmiyor.' : '');
    fPrice.setError(!(p >= 1 && p <= 10000000) ? 'Geçerli bir fiyat yaz (1 ₺ – 10.000.000 ₺).' : '');
    fReason.setError(r.length < 5 ? 'Biraz daha anlat, en az 5 karakter.' : '');
    const firstBad = form.querySelector('[aria-invalid="true"]');
    if (firstBad) { firstBad.focus(); return; }

    submit.disabled = true;
    submit.textContent = 'Açılıyor…';
    try {
      const id = await api.createRequest({ title: t, price: p, reason: r, visibility });
      toast('Talebin hazır! Şimdi paylaş, oylar yağsın.');
      location.hash = `#/t/${id}`;
    } catch (err) {
      toast(errorText(err));
      submit.disabled = false;
      submit.textContent = 'Oylamaya aç';
    }
  });

  root.append(el('h1', {}, 'Yeni talep'),
    el('p', { class: 'lead' }, 'Aklındakini yaz, karar halkın.'), form);
}

// ---------------------------------------------------------------------
// Ekran: Talep sayfası
// ---------------------------------------------------------------------
const YES_MSGS = ['Al gitsin, hayat kısa!', 'Cüzdan hafifçe titredi ama oyun kaydedildi.', 'Oyun kaydedildi. Sepete ekle sesi duyuldu sanki.'];
const NO_MSGS = ['Cüzdan sana minnettar.', 'Tasarruf kahramanı! Oyun kaydedildi.', 'Oyun kaydedildi. Bir kredi kartı derin bir nefes aldı.'];

async function viewRequest(root, { id }) {
  let data;
  try {
    data = await api.getRequest(id);
  } catch (err) {
    root.append(errorBox(err, () => render()));
    return;
  }
  if (!data) {
    root.append(el('div', { class: 'empty' },
      el('h1', {}, 'Bu talep ortada yok'),
      el('p', {}, 'Ya silinmiş, ya gizlenmiş, ya da sahibi çoktan alıp kullanmaya başlamış.'),
      el('a', { class: 'btn btn-primary', href: '#/' }, 'Akışa dön')));
    return;
  }

  // --- Üst bilgi
  root.append(el('article', { class: 'request' },
    data.visibility === 'link' && el('p', { class: 'badge' }, 'Sadece linkle'),
    el('h1', {}, data.title),
    el('p', { class: 'price big' }, formatPrice(data.price)),
    el('p', { class: 'reason' }, data.reason),
    el('p', { class: 'meta' }, timeAgo(data.created_at), data.is_owner ? ' · Bu senin talebin' : '')));

  // --- Oy
  const yesBtn = el('button', { class: 'vote vote-yes', type: 'button' }, 'Al');
  const noBtn = el('button', { class: 'vote vote-no', type: 'button' }, 'Alma');
  const resultSlot = el('div', {});
  root.append(el('section', { class: 'panel', 'aria-labelledby': 'vote-h' },
    el('h2', { id: 'vote-h' }, 'Sen olsan alır mıydın?'),
    el('div', { class: 'vote-row' }, yesBtn, noBtn),
    resultSlot));

  // --- Paylaş
  const url = shareUrl(id);
  const waText = `"${data.title}" (${formatPrice(data.price)}) almaya değer mi? Oyunu ver: ${url}`;
  const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Linki kopyala');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link kopyalandı. Şimdi yapıştır, gönder!');
    } catch {
      window.prompt('Linki buradan kopyalayabilirsin:', url);
    }
  });
  root.append(el('section', { class: 'panel', 'aria-labelledby': 'share-h' },
    el('h2', { id: 'share-h' }, 'Arkadaşlarına sor'),
    el('div', { class: 'share-row' },
      el('a', {
        class: 'btn btn-wa', target: '_blank', rel: 'noopener noreferrer',
        href: `https://wa.me/?text=${encodeURIComponent(waText)}`,
      }, 'WhatsApp\'ta paylaş'),
      copyBtn)));

  // --- Yorumlar
  const commentsH = el('h2', { id: 'comments-h' }, 'Yorumlar');
  const commentList = el('ul', { class: 'comments' });
  const commentInput = el('textarea', { id: 'c-body', maxlength: '280', rows: '2', required: true, placeholder: 'Kısa ve net: neden al, neden alma?' });
  const commentBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Gönder');
  const commentForm = el('form', { class: 'comment-form' },
    el('label', { for: 'c-body' }, 'Yorum yaz'),
    commentInput,
    el('div', { class: 'form-foot' }, counter(commentInput, 280), commentBtn));
  root.append(el('section', { class: 'panel', 'aria-labelledby': 'comments-h' },
    commentsH, commentForm, commentList));

  // --- Talebi bildir
  const reportReq = el('button', { class: 'link-btn', type: 'button' }, 'Bu talebi bildir');
  root.append(el('p', { class: 'center' }, reportReq));

  // --- Durumu ekrana yansıt (ilk çizim + yenilemeler)
  function paint() {
    yesBtn.setAttribute('aria-pressed', String(data.my_vote === true));
    noBtn.setAttribute('aria-pressed', String(data.my_vote === false));
    resultSlot.replaceChildren(resultBar(data.yes_count, data.no_count));
    commentsH.textContent = `Yorumlar (${data.comments.length})`;
    commentList.replaceChildren(...(data.comments.length
      ? data.comments.map((c) => el('li', { class: 'comment' },
        el('p', {}, c.body),
        el('div', { class: 'comment-meta' },
          el('span', { class: 'muted' }, c.mine ? `Sen · ${timeAgo(c.created_at)}` : timeAgo(c.created_at)),
          !c.mine && el('button', {
            class: 'link-btn', type: 'button', 'aria-label': 'Bu yorumu bildir',
            onclick: () => report('comment', c.id),
          }, 'Bildir'))))
      : [el('li', { class: 'muted' }, 'Henüz yorum yok. İlk sözü sen söyle.')]));
  }

  async function refresh() {
    try {
      const next = await api.getRequest(id);
      if (!root.isConnected) return;
      if (!next) { render(); return; }
      data = next;
      paint();
    } catch { /* sessiz: bir sonraki yenilemede tekrar denenir */ }
  }

  async function vote(choice) {
    const before = data.my_vote;
    yesBtn.disabled = noBtn.disabled = true;
    try {
      await api.vote(id, choice);
      if (before === choice) toast('Zaten bu fikirdeydin. Kararlılık güzel şey.');
      else if (before != null) toast('Fikir değiştirmek de bir erdemdir. Oyun güncellendi.');
      else toast(pick(choice ? YES_MSGS : NO_MSGS));
      await refresh();
    } catch (err) {
      toast(errorText(err));
    } finally {
      yesBtn.disabled = noBtn.disabled = false;
    }
  }

  async function report(kind, targetId) {
    const what = kind === 'request' ? 'Bu talebi' : 'Bu yorumu';
    if (!window.confirm(`${what} uygunsuz diye bildirmek istiyor musun?`)) return;
    try {
      const status = await api.report(kind, targetId);
      toast(status === 'zaten'
        ? 'Bunu zaten bildirmiştin; notumuzu aldık.'
        : 'Teşekkürler! Yeterince bildirim gelirse içerik gizlenir.');
      await refresh();
    } catch (err) {
      toast(errorText(err));
    }
  }

  yesBtn.addEventListener('click', () => vote(true));
  noBtn.addEventListener('click', () => vote(false));
  reportReq.addEventListener('click', () => report('request', id));

  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = commentInput.value.trim();
    if (!body) { toast('Boş yorum gönderemezsin; sessizlik de bir cevap ama.'); commentInput.focus(); return; }
    commentBtn.disabled = true;
    try {
      await api.comment(id, body);
      commentInput.value = '';
      commentInput.dispatchEvent(new Event('input'));
      toast('Yorumun eklendi.');
      await refresh();
    } catch (err) {
      toast(errorText(err));
    } finally {
      commentBtn.disabled = false;
    }
  });

  paint();

  // Canlı güncelleme yok; sayfa açıkken seyrek aralıkla yenile.
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
}

// ---------------------------------------------------------------------
// Ekran: Giriş
// ---------------------------------------------------------------------
async function viewLogin(root) {
  root.append(el('h1', {}, 'Giriş'));

  if (session) {
    root.append(
      el('p', { class: 'lead' }, 'Giriş yaptın: ', el('strong', {}, session.user.email ?? '')),
      el('div', { class: 'stack' },
        el('a', { class: 'btn btn-primary wide', href: '#/benim' }, 'Taleplerime git'),
        el('button', {
          class: 'btn btn-ghost wide', type: 'button',
          onclick: async () => {
            await sb.auth.signOut();
            toast('Çıkış yaptın. Yine bekleriz!');
            location.hash = '#/';
          },
        }, 'Çıkış yap')));
    return;
  }

  const email = el('input', { type: 'email', required: true, autocomplete: 'email', inputmode: 'email', placeholder: 'ornek@eposta.com' });
  const fEmail = field('f-email', 'E-posta adresin', email, 'Şifre yok. Mailine bir giriş bağlantısı göndereceğiz.');
  const submit = el('button', { class: 'btn btn-primary wide', type: 'submit' }, 'Giriş bağlantısı gönder');
  const form = el('form', { class: 'stack', novalidate: true }, fEmail.wrap, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      fEmail.setError('Bu e-posta adresine benzemiyor. Bir daha bakar mısın?');
      email.focus();
      return;
    }
    fEmail.setError('');
    submit.disabled = true;
    submit.textContent = 'Gönderiliyor…';
    const { error } = await sb.auth.signInWithOtp({
      email: value,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) {
      toast(errorText(error));
      submit.disabled = false;
      submit.textContent = 'Giriş bağlantısı gönder';
      return;
    }
    form.replaceWith(el('div', { class: 'notice', role: 'status' },
      el('p', {}, el('strong', {}, 'Mailini kontrol et!')),
      el('p', {}, `${value} adresine bir giriş bağlantısı gönderdik. Bağlantıya tıkla, gerisini biz hallederiz.`),
      el('p', { class: 'muted' }, 'Gelmedi mi? Spam klasörüne de bir göz at. Bir dakika sonra tekrar isteyebilirsin.')));
  });

  root.append(form);
}

// ---------------------------------------------------------------------
// Ekran: Taleplerim
// ---------------------------------------------------------------------
async function viewMine(root) {
  if (!requireLogin('#/benim')) return;
  root.append(el('h1', {}, 'Taleplerim'));

  let rows;
  try {
    rows = await api.myRequests();
  } catch (err) {
    root.append(errorBox(err, () => render()));
    return;
  }
  if (!rows.length) {
    root.append(el('div', { class: 'empty' },
      el('p', {}, 'Henüz hiç talep açmadın. Cüzdanın rahat, ama merak etmiyor musun?'),
      el('a', { class: 'btn btn-primary', href: '#/yeni' }, 'İlk talebini aç')));
    return;
  }

  const list = el('ul', { class: 'cards' });
  for (const row of rows) {
    const del = el('button', { class: 'btn btn-danger', type: 'button', 'aria-label': `"${row.title}" talebini sil` }, 'Sil');
    const item = el('li', { class: 'card mine' },
      el('div', { class: 'badges' },
        row.visibility === 'link' && el('span', { class: 'badge' }, 'Sadece linkle'),
        row.hidden && el('span', { class: 'badge badge-warn' }, 'Bildirimlerle gizlendi')),
      el('h2', { class: 'card-title' }, row.hidden ? row.title : el('a', { href: `#/t/${row.id}` }, row.title)),
      el('p', { class: 'price' }, formatPrice(row.price)),
      resultBar(row.yes_count, row.no_count),
      el('p', { class: 'meta' }, `${row.comment_count} yorum · ${timeAgo(row.created_at)}`),
      del);
    del.addEventListener('click', async () => {
      if (!window.confirm(`"${row.title}" talebini silmek istediğine emin misin? Oylar ve yorumlar da silinir, geri alınamaz.`)) return;
      del.disabled = true;
      try {
        await api.deleteRequest(row.id);
        item.remove();
        toast('Talep silindi. Hiç yaşanmamış gibi.');
        if (!list.children.length) render();
      } catch (err) {
        del.disabled = false;
        toast(errorText(err));
      }
    });
    list.append(item);
  }
  root.append(list);
}

// ---------------------------------------------------------------------
// Yönlendirme
// ---------------------------------------------------------------------
async function viewNotFound(root) {
  root.append(el('div', { class: 'empty' },
    el('h1', {}, 'Kaybolduk galiba'),
    el('p', {}, 'Böyle bir sayfa yok. Ama akışta seni bekleyen kararlar var.'),
    el('a', { class: 'btn btn-primary', href: '#/' }, 'Akışa dön')));
}

const ROUTES = { '/': viewFeed, '/yeni': viewNew, '/giris': viewLogin, '/benim': viewMine };

function parseRoute() {
  const path = location.hash.replace(/^#/, '') || '/';
  const m = path.match(/^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (m) return { path: '/t', view: viewRequest, params: { id: m[1].toLowerCase() } };
  return { path, view: ROUTES[path] ?? viewNotFound, params: {} };
}

function updateNav(path) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const auth = document.getElementById('auth-link');
  auth.textContent = session ? 'Hesabım' : 'Giriş';
}

async function render() {
  const { path, view, params } = parseRoute();
  updateNav(path);
  // Her ekran kendi kökünü alır; eski ekranın geç gelen cevapları kopuk köke yazılır, görünmez.
  const root = el('div', { class: 'view' });
  app.replaceChildren(root);
  window.scrollTo(0, 0);
  try {
    await view(root, params);
  } catch (err) {
    root.append(errorBox(err, () => render()));
  }
  if (root.isConnected) {
    const h1 = root.querySelector('h1');
    if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
  }
}

function goAfterLogin() {
  const target = load(RETURN_KEY);
  store(RETURN_KEY, null);
  location.replace(target || '#/');
}

// ---------------------------------------------------------------------
// Tema (açık / koyu); seçim yoksa sistem ayarı geçerli
// ---------------------------------------------------------------------
function setupTheme() {
  const btn = document.getElementById('theme-btn');
  const current = () => document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const label = () => {
    const dark = current() === 'dark';
    btn.setAttribute('aria-label', dark ? 'Açık temaya geç' : 'Koyu temaya geç');
    btn.textContent = dark ? '☀' : '☾';
  };
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store('degermi.tema', next);
    label();
  });
  label();
}

// ---------------------------------------------------------------------
// Başlangıç
// ---------------------------------------------------------------------
async function start() {
  setupTheme();

  // supabase-js e-postadaki bağlantıyla gelen #access_token=... kısmını kendisi okur
  // ve adres çubuğundan siler; yönlendirmeye başlamadan önce bunu bekliyoruz.
  const { data } = await sb.auth.getSession();
  session = data.session;

  if (/error_description=/.test(location.hash)) {
    const params = new URLSearchParams(location.hash.slice(1));
    const expired = params.get('error_code') === 'otp_expired';
    toast(expired
      ? 'Giriş bağlantısının süresi dolmuş ya da zaten kullanılmış. Yenisini isteyelim.'
      : 'Giriş tamamlanamadı. Bir daha deneyelim.');
    location.replace('#/giris');
  } else if (/access_token=/.test(location.hash)) {
    location.replace('#/');
  } else if (session && load(RETURN_KEY) && ['', '#', '#/', '#/giris'].includes(location.hash)) {
    goAfterLogin();
  }

  sb.auth.onAuthStateChange((event, newSession) => {
    // Not: bu geri çağrının içinde başka Supabase çağrısı yapma (kilitlenme riski).
    // SIGNED_IN sekmeye geri dönünce de gelir; yalnızca gerçekten yeni girişte yönlendir.
    const justLoggedIn = !session && newSession;
    session = newSession;
    updateNav(parseRoute().path);
    if (event === 'SIGNED_IN' && justLoggedIn && parseRoute().path === '/giris') {
      toast('Hoş geldin! Giriş yaptın.');
      setTimeout(goAfterLogin, 0);
    }
  });

  // "İçeriğe geç" bağlantısı hash'i #app yapıp yönlendiriciyi 404'e düşürmesin; yalnızca odağı taşı.
  document.querySelector('.skip')?.addEventListener('click', (e) => {
    e.preventDefault();
    app.focus();
  });

  window.addEventListener('hashchange', render);
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA olmasa da çalışır */ });
  }
}

start();
