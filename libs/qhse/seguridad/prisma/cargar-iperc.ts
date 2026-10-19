/**
 * Carga la matriz IPERC real (DYN-SGI-RE-087, julio de 2026) como punto de partida: una actividad maestra por fila del formato, con su
 * matriz en versión 1. Cada matriz sube por el ciclo normal (borrador → evaluación → revisión) para que la base valide la valoración
 * completa; **no se aprueba**: el Gerente HSE debe adjuntar el procedimiento y el ATS base y aprobarla (la aprobación da los 12 meses de
 * vigencia). Idempotente: una actividad que ya existe (mismo proceso, zona y nombre) no se toca.
 *   npm run db:cargar:iperc
 * Variables: DATABASE_URL (usuario app_qhse). Los datos salen de `prisma/data/iperc-087.json` (ver `extraer-iperc.cjs`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadDotenv } from '@dyn/config';
import { toPgConnectionString } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { EstadoIperc, PrismaClient } from '../src/generated/client';
import { IpercCatalogosService } from '../src/iperc/iperc-catalogos.service';
import { insertarContenido } from '../src/iperc/iperc-contenido';
import type { TareaDto } from '../src/iperc/iperc.dto';
import type { PrismaService } from '../src/prisma/prisma.service';

loadDotenv('apps/qhse/.env', '.env');

interface PeligroJson {
  descripcion: string;
  clasificacion: string;
  fuenteRiesgo: string | null;
  generadoEn: string | null;
  efectosPosibles: string | null;
  controlExistenteFuente: string | null;
  controlExistenteMedio: string | null;
  controlExistenteIndividuo: string | null;
  numeroExpuestos: number | null;
  peorConsecuencia: string | null;
  requisitoLegal: boolean;
  seguimiento: string | null;
  seguimientoResidual: string | null;
  inicial: { nd: number; ne: number; nc: number } | null;
  residual: { nd: number; ne: number; nc: number } | null;
  controles: Array<{
    momento: 'propuesto' | 'residual';
    tipo: 'eliminacion' | 'sustitucion' | 'ingenieria' | 'administrativo' | 'epp';
    descripcion: string;
  }>;
}
interface ActividadJson {
  proceso: string;
  zona: string;
  actividad: string;
  tareas: Array<{
    descripcion: string;
    rutinaria: boolean;
    areaPuesto: string | null;
    cargos: string[];
    peligros: PeligroJson[];
  }>;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: toPgConnectionString(process.env['DATABASE_URL'] as string) },
      { schema: 'qhse' },
    ),
  });
  const catalogos = new IpercCatalogosService(prisma as unknown as PrismaService);
  try {
    const datos = JSON.parse(
      readFileSync(join(__dirname, 'data', 'iperc-087.json'), 'utf-8'),
    ) as ActividadJson[];
    const actor = await prisma.idUsuario.findFirst({
      where: { activo: true, rol: { codigo: 'superadmin' } },
      select: { id: true },
    });
    if (!actor)
      throw new Error(
        'No hay una cuenta de superadmin activa para registrar la carga: corra antes npm run db:seed:identidad',
      );
    let nuevas = 0;
    let existentes = 0;
    const incompletas: string[] = [];

    for (const a of datos) {
      await prisma.$transaction(
        async (tx) => {
          const procesoId = await catalogos.asegurar(tx, 'proceso', a.proceso, actor.id);
          const zonaId = await catalogos.asegurar(tx, 'zona', a.zona, actor.id);
          if (
            await tx.ipercActividad.findFirst({
              where: { procesoId, zonaId, nombre: { equals: a.actividad, mode: 'insensitive' } },
            })
          ) {
            existentes++;
            return;
          }
          const tareas: TareaDto[] = [];
          for (const t of a.tareas) {
            const cargoIds: string[] = [];
            for (const c of t.cargos)
              cargoIds.push(await catalogos.asegurar(tx, 'cargo', c, actor.id));
            const peligros = [];
            for (const p of t.peligros) {
              peligros.push({
                descripcion: p.descripcion,
                clasificacionId: await catalogos.asegurar(
                  tx,
                  'clasificacion',
                  p.clasificacion,
                  actor.id,
                ),
                generadoEnId: p.generadoEn
                  ? await catalogos.asegurar(tx, 'generado_en', p.generadoEn, actor.id)
                  : undefined,
                fuenteRiesgo: p.fuenteRiesgo ?? undefined,
                efectosPosibles: p.efectosPosibles ?? undefined,
                controlExistenteFuente: p.controlExistenteFuente ?? undefined,
                controlExistenteMedio: p.controlExistenteMedio ?? undefined,
                controlExistenteIndividuo: p.controlExistenteIndividuo ?? undefined,
                numeroExpuestos: p.numeroExpuestos ?? undefined,
                peorConsecuencia: p.peorConsecuencia ?? undefined,
                requisitoLegal: p.requisitoLegal,
                seguimiento: p.seguimiento ?? undefined,
                seguimientoResidual: p.seguimientoResidual ?? undefined,
                inicial: p.inicial ?? undefined,
                residual: p.residual ?? undefined,
                controles: p.controles,
              });
            }
            tareas.push({
              descripcion: t.descripcion,
              rutinaria: t.rutinaria,
              areaPuesto: t.areaPuesto ?? undefined,
              cargoIds,
              peligros,
            });
          }
          const actividadId = uuidv7();
          const matrizId = uuidv7();
          await tx.ipercActividad.create({
            data: { id: actividadId, procesoId, zonaId, nombre: a.actividad, createdBy: actor.id },
          });
          await tx.ipercMatriz.create({
            data: { id: matrizId, actividadId, version: 1, createdBy: actor.id },
          });
          await insertarContenido(tx, matrizId, tareas);
          const historia = (
            anterior: EstadoIperc | null,
            nuevo: EstadoIperc,
            motivo: string | null = null,
          ) =>
            tx.ipercHistorial.create({
              data: {
                id: uuidv7(),
                matrizId,
                estadoAnterior: anterior,
                estadoNuevo: nuevo,
                actorId: actor.id,
                motivo,
              },
            });
          await historia(
            null,
            EstadoIperc.borrador,
            'Carga del formato DYN-SGI-RE-087 (julio de 2026)',
          );
          await tx.ipercMatriz.update({
            where: { id: matrizId },
            data: { estado: EstadoIperc.en_evaluacion, updatedBy: actor.id },
          });
          await historia(EstadoIperc.borrador, EstadoIperc.en_evaluacion);
          // la base exige la valoración completa para pasar a revisión; si el formato real la trae incompleta, se queda en evaluación
          try {
            await tx.$executeRaw`SAVEPOINT a_revision`;
            await tx.ipercMatriz.update({
              where: { id: matrizId },
              data: { estado: EstadoIperc.en_revision, updatedBy: actor.id },
            });
            await historia(EstadoIperc.en_evaluacion, EstadoIperc.en_revision);
          } catch {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT a_revision`;
            incompletas.push(`${a.proceso} · ${a.actividad}`);
          }
          nuevas++;
        },
        { timeout: 60_000 },
      );
    }
    console.log(`IPERC: ${nuevas} actividades nuevas, ${existentes} ya existían.`);
    if (incompletas.length)
      console.log(
        `Quedaron en evaluación (el formato trae peligros sin valoración completa): ${incompletas.join('; ')}`,
      );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
