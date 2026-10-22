// Copia la encuesta y la consola (relevamiento/*.html) y los íconos de la raíz a publico/ para servirlos desde el Worker
// en https://relevamiento.mbc-latam.com. Se ejecuta solo antes de cada deploy:  npm run deploy
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('publico', { recursive: true, force: true });
mkdirSync('publico', { recursive: true });
for (const f of ['index.html', 'admin.html', 'flujo-admin.js', 'flujo-gerente.js']) cpSync(`../${f}`, `publico/${f}`);
for (const f of ['favicon.png', 'apple-touch-icon.png', 'icon-512.png', 'og-image.png']) cpSync(`../../${f}`, `publico/${f}`);
console.log('publico/ listo');
