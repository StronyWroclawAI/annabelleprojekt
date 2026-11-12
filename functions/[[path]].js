/* ==========================================================================
   AnnaBelle — serwer strony (Cloudflare Pages Functions)
   Jeden plik obsługuje: API panelu (/api/*), wersje językowe (/pl/ itd.),
   sitemap.xml i robots.txt. Dane w Cloudflare KV — powiązanie o nazwie TRESCI.

   Zmienne środowiskowe (Cloudflare Pages → Settings → Variables and Secrets):
     ADMIN_PASSWORD_HASH  – (opcjonalnie) hash pierwszego hasła; bez niego obowiązuje hasło tymczasowe „demo”
     SESSION_SECRET       – (opcjonalnie) długi losowy ciąg znaków; bez niego klucz tworzy się sam w KV
   Opcjonalne:
     RESEND_API_KEY, MAIL_FROM, MAIL_TO – powiadomienie e-mail o wiadomości
     TURNSTILE_SITEKEY, TURNSTILE_SECRET – Cloudflare Turnstile w formularzu
   ========================================================================== */

const KV_LIMIT_MS = 5500;          // limit czasu każdego odczytu/zapisu KV
const SESJA_GODZIN = 8;
const CIASTKO = 'ab_sesja';
const NAGLOWEK_CSRF = 'annabelle-panel';
const JEZYKI_DODATKOWE = ['pl', 'de', 'fr', 'es', 'it', 'uk'];
const MAX_TRESCI = 900 * 1024;     // maks. rozmiar danych strony (JSON)
const MAX_ZDJECIE = 2 * 1024 * 1024;
const ITERACJE = 100000;           // PBKDF2 (limit Cloudflare Workers)

/* ---------- narzędzia ---------- */
const enc = new TextEncoder();

function json(dane, status = 200, naglowki = {}) {
  return new Response(JSON.stringify(dane), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...naglowki },
  });
}
const blad = (status, komunikat) => json({ ok: false, blad: komunikat }, status);

class PrzekroczonoCzas extends Error {}

/* Każde żądanie czeka wyłącznie na własne zapytania i tylko przez określony czas.
   (Żadnych obietnic współdzielonych między żądaniami w zmiennych modułu.) */
function zLimitem(obietnica, ms = KV_LIMIT_MS) {
  let t;
  const limit = new Promise((_, odrzuc) => { t = setTimeout(() => odrzuc(new PrzekroczonoCzas('limit czasu')), ms); });
  return Promise.race([obietnica, limit]).finally(() => clearTimeout(t));
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const zB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const losowe = (n = 12) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

function rowne(a, b) {            // porównanie w stałym czasie
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

async function pbkdf2(haslo, sol, iteracje) {
  const klucz = await crypto.subtle.importKey('raw', enc.encode(haslo), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sol, iterations: iteracje }, klucz, 256));
}
async function utworzHash(haslo) {
  const sol = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERACJE}$${b64(sol)}$${b64(await pbkdf2(haslo, sol, ITERACJE))}`;
}
async function sprawdzHash(haslo, zapisany) {
  try {
    const [alg, it, sol, hash] = String(zapisany).trim().split('$');
    if (alg !== 'pbkdf2') return false;
    const iteracje = Math.min(parseInt(it, 10) || 0, ITERACJE);
    if (iteracje < 1000) return false;
    return rowne(await pbkdf2(haslo, zB64(sol), iteracje), zB64(hash));
  } catch { return false; }
}
async function hmac(sekret, tekst) {
  const klucz = await crypto.subtle.importKey('raw', enc.encode(sekret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', klucz, enc.encode(tekst)));
}
async function skrotIp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '0';
  const d = await crypto.subtle.digest('SHA-256', enc.encode(ip + '|' + (await sekretSesji(env))));
  return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- KV z limitem czasu ---------- */
const kvGet = (env, klucz, typ = 'text') => zLimitem(env.TRESCI.get(klucz, typ));
const kvPut = (env, klucz, wartosc, opcje) => zLimitem(env.TRESCI.put(klucz, wartosc, opcje));
const kvDel = (env, klucz) => zLimitem(env.TRESCI.delete(klucz));

async function czytajTresci(env) {
  const tekst = await kvGet(env, 'tresci');
  if (!tekst) return null;
  try { return JSON.parse(tekst); } catch { return null; }
}

/* ---------- sesja ---------- */
function ciastko(request, nazwa) {
  const c = request.headers.get('cookie') || '';
  for (const czesc of c.split(';')) {
    const i = czesc.indexOf('=');
    if (i > 0 && czesc.slice(0, i).trim() === nazwa) return czesc.slice(i + 1).trim();
  }
  return '';
}
function naglowekCiastka(wartosc, sekundy) {
  return `${CIASTKO}=${wartosc}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sekundy}`;
}
async function zalogowany(request, env) {
  const zeton = ciastko(request, CIASTKO);
  if (!zeton) return false;
  const [wygasa, epoka, podpis] = zeton.split('.');
  if (!wygasa || !podpis || Number(wygasa) < Date.now()) return false;
  const oczekiwany = await hmac(await sekretSesji(env), `${wygasa}.${epoka}`);
  if (!rowne(enc.encode(podpis), enc.encode(oczekiwany))) return false;
  const aktualna = (await kvGet(env, 'auth:epoka')) || '0';   // zmiana hasła unieważnia stare sesje
  return aktualna === epoka;
}
async function nowaSesja(env) {
  const wygasa = Date.now() + SESJA_GODZIN * 3600 * 1000;
  const epoka = (await kvGet(env, 'auth:epoka')) || '0';
  const podpis = await hmac(await sekretSesji(env), `${wygasa}.${epoka}`);
  return naglowekCiastka(`${wygasa}.${epoka}.${podpis}`, SESJA_GODZIN * 3600);
}
/* Klucz podpisu sesji: zmienna SESSION_SECRET, a gdy jej nie ma — losowy klucz zapisany w KV
   (nikt poza serwerem go nie odczyta, więc strona działa bez ręcznej konfiguracji). */
async function sekretSesji(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let k = await kvGet(env, 'auth:sekret');
  if (!k) { k = losowe(32); await kvPut(env, 'auth:sekret', k); }
  return k;
}

/* Hasło: 1) własne, ustawione w panelu (KV), 2) zmienna ADMIN_PASSWORD_HASH,
   3) tymczasowe hasło „demo” — panel przypomina, by je zmienić. */
const HASH_TYMCZASOWEGO = 'pbkdf2$100000$5bmIhkrY9IomSpTjipHCVA==$9vSYt4uo3fFBZaIcfpUE6Gi7CDEO7Da+4TSmNinoucM=';
async function hashHasla(env) {
  return (await kvGet(env, 'auth:hash')) || env.ADMIN_PASSWORD_HASH || HASH_TYMCZASOWEGO;
}
async function haslo_tymczasowe(env) {
  return !(await kvGet(env, 'auth:hash')) && !env.ADMIN_PASSWORD_HASH;
}

/* Ochrona przed CSRF: własny nagłówek + zgodny Origin */
function csrfOk(request) {
  if (request.headers.get('x-requested-with') !== NAGLOWEK_CSRF) return false;
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return false;
  return true;
}

/* Licznik prób (logowanie, formularz) — prosta blokada w KV */
async function limitProb(env, klucz, maks, sekundy) {
  const n = parseInt((await kvGet(env, klucz)) || '0', 10);
  return { n, zablokowany: n >= maks, dodaj: () => kvPut(env, klucz, String(n + 1), { expirationTtl: Math.max(60, sekundy) }) };
}

async function czytajJson(request, maks = MAX_TRESCI) {
  const tekst = await request.text();
  if (tekst.length > maks) throw new Error('za-duze');
  return JSON.parse(tekst);
}

/* ==========================================================================
   API
   ========================================================================== */
async function api(context, sciezka) {
  const { request, env } = context;
  const metoda = request.method;

  if (!env.TRESCI) return blad(503, 'Brak powiązania KV o nazwie TRESCI — sprawdź ustawienia Cloudflare Pages.');

  /* --- publiczne --- */
  if (sciezka === 'tresci' && metoda === 'GET') {
    const dane = await czytajTresci(env);
    return json({ ok: true, dane, turnstile: env.TURNSTILE_SITEKEY || '' });
  }

  const zdj = sciezka.match(/^zdjecia\/([a-f0-9]{8,40})$/);
  if (zdj && metoda === 'GET') {
    const { value, metadata } = await zLimitem(env.TRESCI.getWithMetadata('img:' + zdj[1], 'arrayBuffer'));
    if (!value) return new Response('Nie znaleziono', { status: 404 });
    return new Response(value, {
      headers: { 'content-type': (metadata && metadata.typ) || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  if (sciezka === 'kontakt' && metoda === 'POST') return kontakt(context);

  if (sciezka === 'sesja' && metoda === 'GET') {
    const zal = await zalogowany(request, env);
    return json({ ok: true, zalogowany: zal, tymczasowe: zal ? await haslo_tymczasowe(env) : false });
  }

  /* --- logowanie --- */
  if (sciezka === 'login' && metoda === 'POST') {
    if (!csrfOk(request)) return blad(403, 'Odrzucono żądanie.');
    const zapisany = await hashHasla(env);
    const proby = await limitProb(env, 'rl:login:' + (await skrotIp(request, env)), 5, 900);
    if (proby.zablokowany) return blad(429, 'Zbyt wiele nieudanych prób. Spróbuj ponownie za 15 minut.');
    let haslo = '';
    try { haslo = String((await czytajJson(request, 2000)).haslo || ''); } catch { return blad(400, 'Nieprawidłowe dane.'); }
    if (!(await sprawdzHash(haslo, zapisany))) {
      await proby.dodaj();
      return blad(401, 'Nieprawidłowe hasło.');
    }
    return json({ ok: true, tymczasowe: await haslo_tymczasowe(env) }, 200, { 'set-cookie': await nowaSesja(env) });
  }

  if (sciezka === 'logout' && metoda === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': naglowekCiastka('', 0) });
  }

  /* --- wszystko poniżej wymaga zalogowania i nagłówka CSRF --- */
  if (!(await zalogowany(request, env))) return blad(401, 'Sesja wygasła — zaloguj się ponownie.');
  if (metoda !== 'GET' && !csrfOk(request)) return blad(403, 'Odrzucono żądanie.');

  if (sciezka === 'haslo' && metoda === 'POST') {
    let d;
    try { d = await czytajJson(request, 4000); } catch { return blad(400, 'Nieprawidłowe dane.'); }
    const nowe = String(d.nowe || '');
    if (nowe.length < 10) return blad(400, 'Nowe hasło musi mieć co najmniej 10 znaków.');
    if (!(await sprawdzHash(String(d.obecne || ''), await hashHasla(env)))) return blad(401, 'Obecne hasło jest nieprawidłowe.');
    await kvPut(env, 'auth:hash', await utworzHash(nowe));
    await kvPut(env, 'auth:epoka', String(Date.now()));         // stare sesje przestają działać
    return json({ ok: true }, 200, { 'set-cookie': await nowaSesja(env) });
  }

  if (sciezka === 'tresci' && metoda === 'PUT') {
    let dane;
    try { dane = await czytajJson(request); } catch (e) {
      return blad(e.message === 'za-duze' ? 413 : 400, e.message === 'za-duze' ? 'Dane są zbyt duże.' : 'Nieprawidłowe dane.');
    }
    if (!dane || typeof dane !== 'object' || dane._app !== 'annabelle') return blad(400, 'To nie są dane tej strony.');
    dane._zapisano = new Date().toISOString();
    const tekst = JSON.stringify(dane);
    await kvPut(env, 'tresci', tekst);
    // automatyczna kopia: 10 ostatnich zapisów
    try {
      const indeks = JSON.parse((await kvGet(env, 'kopie:indeks')) || '[]');
      const id = Date.now() + '-' + losowe(3);
      await kvPut(env, 'kopia:' + id, tekst);
      indeks.unshift({ id, czas: dane._zapisano });
      const stare = indeks.splice(10);
      await kvPut(env, 'kopie:indeks', JSON.stringify(indeks));
      for (const s of stare) context.waitUntil(zLimitem(env.TRESCI.delete('kopia:' + s.id)).catch(() => {}));
    } catch { /* kopia nie może zablokować zapisu */ }
    return json({ ok: true, zapisano: dane._zapisano });
  }

  if (sciezka === 'kopie' && metoda === 'GET') {
    return json({ ok: true, kopie: JSON.parse((await kvGet(env, 'kopie:indeks')) || '[]') });
  }
  if (sciezka === 'kopie/przywroc' && metoda === 'POST') {
    let d;
    try { d = await czytajJson(request, 500); } catch { return blad(400, 'Nieprawidłowe dane.'); }
    if (!/^[0-9]+-[a-f0-9]+$/.test(String(d.id || ''))) return blad(400, 'Nieprawidłowa kopia.');
    const tekst = await kvGet(env, 'kopia:' + d.id);
    if (!tekst) return blad(404, 'Nie znaleziono tej kopii.');
    await kvPut(env, 'tresci', tekst);
    return json({ ok: true, dane: JSON.parse(tekst) });
  }

  if (sciezka === 'zdjecia' && metoda === 'POST') {
    const typ = (request.headers.get('content-type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(typ)) return blad(415, 'Dozwolone są tylko zdjęcia JPG, PNG lub WebP.');
    const bufor = await request.arrayBuffer();
    if (!bufor.byteLength || bufor.byteLength > MAX_ZDJECIE) return blad(413, 'Zdjęcie jest zbyt duże (maks. 2 MB po zmniejszeniu).');
    const id = losowe(12);
    await kvPut(env, 'img:' + id, bufor, { metadata: { typ } });
    return json({ ok: true, url: '/api/zdjecia/' + id });
  }
  if (zdj && metoda === 'DELETE') {
    await kvDel(env, 'img:' + zdj[1]);
    return json({ ok: true });
  }

  if (sciezka === 'wiadomosci' && metoda === 'GET') {
    const lista = await zLimitem(env.TRESCI.list({ prefix: 'msg:', limit: 100 }));
    const klucze = lista.keys.map((k) => k.name).sort().reverse().slice(0, 60);
    const wiadomosci = [];
    for (const k of klucze) {
      const t = await kvGet(env, k);
      if (t) { try { wiadomosci.push({ id: k.slice(4), ...JSON.parse(t) }); } catch { /* pomiń */ } }
    }
    return json({ ok: true, wiadomosci });
  }
  const wiad = sciezka.match(/^wiadomosci\/([0-9]+-[a-f0-9]+)$/);
  if (wiad && metoda === 'DELETE') {
    await kvDel(env, 'msg:' + wiad[1]);
    return json({ ok: true });
  }

  return blad(404, 'Nie ma takiego adresu API.');
}

/* ---------- formularz kontaktowy ---------- */
async function kontakt(context) {
  const { request, env } = context;
  let d;
  try { d = await czytajJson(request, 12000); } catch { return blad(400, 'Invalid data.'); }

  // pole-pułapka: bot dostaje „sukces”, ale nic nie zapisujemy
  if (d.website) return json({ ok: true });

  const s = (v, n) => String(v || '').trim().slice(0, n);
  const w = {
    imie: s(d.name, 100), email: s(d.email, 160), telefon: s(d.phone, 40),
    temat: s(d.topic, 120), termin: s(d.date, 20), wiadomosc: s(d.message, 3000), jezyk: s(d.lang, 5),
  };
  // walidacja po stronie serwera
  if (w.imie.length < 2) return blad(400, 'name');
  if (!w.email && !w.telefon) return blad(400, 'contact');
  if (w.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(w.email)) return blad(400, 'email');
  if (w.wiadomosc.length < 5) return blad(400, 'message');

  const proby = await limitProb(env, 'rl:msg:' + (await skrotIp(request, env)), 5, 3600);
  if (proby.zablokowany) return blad(429, 'limit');

  if (env.TURNSTILE_SECRET) {
    const cialo = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(d.turnstile || '') });
    try {
      const r = await zLimitem(fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: cialo }), 6000);
      if (!(await r.json()).success) return blad(400, 'turnstile');
    } catch { return blad(503, 'turnstile'); }
  }

  w.czas = new Date().toISOString();
  // przechowywanie najdłużej 12 miesięcy — KV usuwa wpis automatycznie
  await kvPut(env, `msg:${Date.now()}-${losowe(4)}`, JSON.stringify(w), { expirationTtl: 365 * 24 * 3600 });
  await proby.dodaj();

  // powiadomienie e-mail w tle (nie blokuje odpowiedzi, ma własny limit czasu)
  if (env.RESEND_API_KEY && env.MAIL_TO && env.MAIL_FROM) {
    const tresc = [`Name: ${w.imie}`, `E-mail: ${w.email || '—'}`, `Phone: ${w.telefon || '—'}`, `Topic: ${w.temat || '—'}`,
      `Preferred date: ${w.termin || '—'}`, '', w.wiadomosc].join('\n');
    context.waitUntil(zLimitem(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [env.MAIL_TO], reply_to: w.email || undefined, subject: `AnnaBelle — new enquiry from ${w.imie}`, text: tresc }),
    }), 8000).catch(() => {}));
  }
  return json({ ok: true });
}

/* ==========================================================================
   Wersje językowe, sitemap, robots
   ========================================================================== */
function wlaczoneJezyki(dane) {
  const lista = (dane && dane.langs && Array.isArray(dane.langs.list)) ? dane.langs.list : [];
  return lista.filter((j) => j && j.on && JEZYKI_DODATKOWE.includes(j.code)).map((j) => j.code);
}

async function stronaJezykowa(context, kod) {
  const { request, env } = context;
  const url = new URL(request.url);
  let wlaczone = [];
  try { wlaczone = env.TRESCI ? wlaczoneJezyki(await czytajTresci(env)) : []; } catch { wlaczone = []; }
  if (!wlaczone.includes(kod)) return Response.redirect(url.origin + '/', 302);   // wersja wyłączona → strona główna
  if (!url.pathname.endsWith('/')) return Response.redirect(`${url.origin}/${kod}/`, 301);

  const strona = await env.ASSETS.fetch(new Request(url.origin + '/', { headers: request.headers }));
  const adres = `${url.origin}/${kod}/`;
  let hreflang = `<base href="/"><link rel="alternate" hreflang="en" href="${url.origin}/"><link rel="alternate" hreflang="x-default" href="${url.origin}/">`;
  for (const j of wlaczone) hreflang += `<link rel="alternate" hreflang="${j}" href="${url.origin}/${j}/">`;

  return new HTMLRewriter()
    .on('html', { element(e) { e.setAttribute('lang', kod); } })
    .on('head', { element(e) { e.prepend(hreflang, { html: true }); } })
    .on('link[rel="canonical"]', { element(e) { e.setAttribute('href', adres); } })
    .on('meta[property="og:url"]', { element(e) { e.setAttribute('content', adres); } })
    .transform(strona);
}

async function sitemap(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;
  let wlaczone = [], zapisano = '';
  try {
    const dane = env.TRESCI ? await czytajTresci(env) : null;
    wlaczone = wlaczoneJezyki(dane);
    zapisano = (dane && dane._zapisano) ? dane._zapisano.slice(0, 10) : '';
  } catch { /* bez KV: tylko strona główna */ }
  const adresy = [['en', origin + '/'], ...wlaczone.map((j) => [j, `${origin}/${j}/`])];
  const alt = adresy.length > 1
    ? adresy.map(([j, a]) => `    <xhtml:link rel="alternate" hreflang="${j}" href="${a}"/>`).join('\n') +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${origin}/"/>\n` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    adresy.map(([, a]) => `  <url>\n    <loc>${a}</loc>\n${zapisano ? `    <lastmod>${zapisano}</lastmod>\n` : ''}${alt}  </url>`).join('\n') + '\n</urlset>\n';
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

function robots(request) {
  const origin = new URL(request.url).origin;
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

/* ==========================================================================
   Wejście
   ========================================================================== */
export async function onRequest(context) {
  const { request, env } = context;
  const sciezka = new URL(request.url).pathname;
  try {
    if (sciezka.startsWith('/api/')) return await api(context, sciezka.slice(5).replace(/\/+$/, ''));
    if (sciezka === '/sitemap.xml') return await sitemap(context);
    if (sciezka === '/robots.txt') return robots(request);
    const jezyk = sciezka.match(/^\/([a-z]{2})\/?$/);
    if (jezyk && JEZYKI_DODATKOWE.includes(jezyk[1])) return await stronaJezykowa(context, jezyk[1]);
    return await env.ASSETS.fetch(request);
  } catch (e) {
    if (sciezka.startsWith('/api/')) {
      if (e instanceof PrzekroczonoCzas) return blad(503, 'Serwer chwilowo nie odpowiada — spróbuj ponownie.');
      return blad(500, 'Błąd serwera — spróbuj ponownie.');
    }
    // strona i pliki zawsze mają się wyświetlić, nawet gdy KV nie odpowiada
    return env.ASSETS.fetch(request);
  }
}
