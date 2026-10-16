// Debe ser el PRIMER import de main.ts: el tracing tiene que iniciar antes de cargar Nest/Express.
import { loadDotenv } from '@dyn/config';
import { initTracing } from '@dyn/common';

loadDotenv('apps/comercial/.env', '.env');
initTracing('comercial');
