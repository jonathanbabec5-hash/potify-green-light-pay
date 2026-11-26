import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), 'data/greenlight-pay.sqlite');
rmSync(path, { force: true });
rmSync(`${path}-shm`, { force: true });
rmSync(`${path}-wal`, { force: true });
console.log('Sandbox database reset. Run npm start to reseed it.');
