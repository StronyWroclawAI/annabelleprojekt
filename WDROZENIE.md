# AnnaBelle — wdrożenie strony (GitHub + Cloudflare Pages)

## Co jest w paczce

```
public/                ← pliki strony (to jest „Build output directory”)
  index.html           ← strona + panel administratora (jeden plik)
  404.html, robots.txt, sitemap.xml, site.webmanifest, _headers, _routes.json
  favicon.svg, favicon-32.png, apple-touch-icon.png
  fonts/               ← czcionki Fraunces i DM Sans (wgrane lokalnie, bez Google Fonts)
  img/                 ← logo (ciemne i jasne), og-image.jpg, ikona 512 px
functions/[[path]].js  ← serwer: API panelu, formularz, wersje językowe, sitemap
narzedzia/generuj-hash.mjs ← generator hasha pierwszego hasła
```

## Krok po kroku

1. **GitHub** — utwórz prywatne repozytorium (np. `annabelle-strona`) i wgraj do niego całą zawartość tej paczki
   (foldery `public`, `functions`, `narzedzia` i ten plik).
2. **Cloudflare Pages** — Workers & Pages → Create → Pages → Connect to Git → wybierz repozytorium.
   - Framework preset: `None`
   - Build command: *(puste)*
   - Build output directory: `public`
3. **KV (pamięć treści)** — Storage & Databases → KV → Create namespace, nazwa np. `annabelle-tresci`.
   Następnie w projekcie Pages: Settings → Bindings → Add → KV namespace →
   Variable name: **`TRESCI`** (dokładnie tak), namespace: `annabelle-tresci`.
4. **Hasło do panelu** — na komputerze z Node.js uruchom:
   ```
   node narzedzia/generuj-hash.mjs "TwojeHaslo-min10znakow"
   ```
   Skrypt wypisze dwie wartości. W projekcie Pages: Settings → Variables and Secrets → Add (typ **Secret**):
   - `ADMIN_PASSWORD_HASH` = wypisany hash (zaczyna się od `pbkdf2$100000$…`)
   - `SESSION_SECRET` = wypisany losowy ciąg
5. **Wdróż ponownie** (Deployments → Retry deployment), żeby powiązanie KV i zmienne zaczęły działać.
6. Wejdź na adres `…pages.dev`, kliknij kłódkę w lewym dolnym rogu i zaloguj się.
   Hasło można potem zmienić w panelu: Ustawienia → Zmiana hasła (nowe hasło zapisuje się w KV i zastępuje to ze zmiennej).

## Po zakupie domeny

- W plikach `public/index.html`, `public/robots.txt` i `public/sitemap.xml` zamień tekst
  `https://[DOMENA]` na właściwy adres, np. `https://annabellebags.co.uk` (funkcja „znajdź i zamień”, bez końcowego ukośnika).
  W `index.html` występuje on w `<head>` oraz raz w kodzie jako `SITE_URL`.
- Cloudflare Pages → Custom domains → dodaj domenę.
- `sitemap.xml` i `robots.txt` po wdrożeniu generują się automatycznie z właściwą domeną i włączonymi językami.

## Formularz kontaktowy

- Wiadomości zapisują się w KV i są widoczne w panelu: **Przegląd → Wiadomości** (automatycznie kasowane po 12 miesiącach).
- **Powiadomienie e-mail (opcjonalnie):** załóż konto w Resend (resend.com), zweryfikuj domenę i dodaj zmienne:
  `RESEND_API_KEY`, `MAIL_FROM` (np. `AnnaBelle <kontakt@twojadomena>`), `MAIL_TO` (`annabellebags2026@gmail.com`).
  Bez tych zmiennych formularz działa, ale wiadomości trzeba sprawdzać w panelu.
- **Cloudflare Turnstile (opcjonalnie, zalecane):** Turnstile → Add widget → dodaj zmienne `TURNSTILE_SITEKEY` i `TURNSTILE_SECRET`.
  Bez nich działa pole-pułapka (honeypot) i limit 5 wiadomości na godzinę z jednego adresu.

## Wersje językowe

Strona jest po angielsku. Polski jest przygotowany, ale wyłączony: panel → Ustawienia → Wersje językowe.
Po włączeniu pojawia się adres `/pl/`, przełącznik języka w nagłówku, znaczniki hreflang i wpis w sitemap.
Teksty interfejsu (menu, przyciski, formularz) mają gotowe polskie tłumaczenie; treści wpisuje się w panelu w polach „PL”.
Uwaga: polskie treści są podmieniane w przeglądarce — dla pełnego SEO wersji `/pl/` warto później dodać renderowanie po stronie serwera.

## Google Search Console

1. search.google.com/search-console → Dodaj usługę → „Prefiks adresu URL” → wpisz adres strony.
2. Wybierz weryfikację „Tag HTML”, skopiuj kod i wklej go w `index.html` w miejscu oznaczonym
   komentarzem `GOOGLE SEARCH CONSOLE` (usuń znaczniki komentarza), wgraj zmianę na GitHub.
3. Po weryfikacji: Mapy witryn → wpisz `sitemap.xml` → Prześlij.
4. Sprawdzenie adresu URL → wklej adres strony głównej → „Poproś o zindeksowanie”.

## Tryb demonstracyjny

Plik `public/index.html` otwarty prosto z dysku (albo na hostingu bez funkcji) działa w trybie demonstracyjnym:
panel otwiera hasło `demo`, a zmiany zapisują się tylko w tej przeglądarce.

## Zmienne — podsumowanie

| Nazwa | Wymagana | Do czego |
|---|---|---|
| `TRESCI` (powiązanie KV) | tak | treści strony, zdjęcia, kopie, wiadomości |
| `ADMIN_PASSWORD_HASH` | tak | hash pierwszego hasła |
| `SESSION_SECRET` | tak | podpis sesji logowania |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO` | nie | e-mail o nowej wiadomości |
| `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` | nie | ochrona formularza przed botami |
