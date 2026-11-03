// Copia a interface (../static) para www/, que o Capacitor embute no app iOS.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
rmSync(here + 'www', { recursive: true, force: true });
cpSync(here + '../static', here + 'www', { recursive: true });
console.log('Interface copiada para www/');
