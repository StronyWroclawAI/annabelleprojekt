// Generuje hash hasła do panelu (PBKDF2-SHA256, 100 000 iteracji, losowa sól).
// Użycie:  node narzedzia/generuj-hash.mjs "TwojeHaslo123!"
// Wynik wklej w Cloudflare Pages jako zmienną (Secret) ADMIN_PASSWORD_HASH.
import { webcrypto as crypto } from 'node:crypto';
const haslo = process.argv[2];
if (!haslo || haslo.length < 10) { console.error('Podaj hasło (min. 10 znaków):  node narzedzia/generuj-hash.mjs "TwojeHaslo123!"'); process.exit(1); }
const sol = crypto.getRandomValues(new Uint8Array(16));
const klucz = await crypto.subtle.importKey('raw', new TextEncoder().encode(haslo), 'PBKDF2', false, ['deriveBits']);
const bity = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sol, iterations: 100000 }, klucz, 256);
const b64 = (u) => Buffer.from(u).toString('base64');
console.log('\nADMIN_PASSWORD_HASH =\n' + `pbkdf2$100000$${b64(sol)}$${b64(new Uint8Array(bity))}`);
console.log('\nSESSION_SECRET (losowy, możesz użyć tego) =\n' + b64(crypto.getRandomValues(new Uint8Array(36))) + '\n');
