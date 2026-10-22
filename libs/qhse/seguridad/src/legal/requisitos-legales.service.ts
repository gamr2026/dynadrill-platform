import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador } from '../comun/fechas';
import { texto } from '../epi/epi-tipos';
import { EstadoRequisitoLegal, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosLegalesConsultaService } from './requisitos-legales-consulta.service';

/** Código del módulo del servicio de archivos con el que se sube el documento de una revisión legal. */
export const MODULO_ARCHIVO_REQUISITO_LEGAL = 'qhse_requisito_legal';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface RegistrarRequisitoLegalEntrada {
  tipoId: string;
  revision: string;
  /** AAAA-MM-DD */
  fechaAprobacion: string;
  /** AAAA-MM-DD; opcional (no hay un plazo confirmado: QHSE lo indica si la matriz lo tiene). */
  vigenteHasta?: string | null;
  /** Documento subido antes con el módulo `qhse_requisito_legal`. */
  archivoId: string;
}

/**
 * Matrices de requisitos legales (Gestión Ambiental y SST). Registrar una revisión nueva deja la anterior del mismo tipo como reemplazada (queda como
 * historia, no se pisa). Eventos `qhse.requisito_legal.registrado` con el tipo, la revisión y la vigencia, para avisos y reportería.
 */
@Injectable()
export class RequisitosLegalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: RequisitosLegalesConsultaService,
  ) {}

  async registrar(e: RegistrarRequisitoLegalEntrada, actor: AuthUser) {
    const revision = texto(e.revision);
    if (!revision)
      throw new BadRequestException('Indique la revisión del documento (por ejemplo, Rev. 03)');
    if (e.fechaAprobacion > hoyEcuador())
      throw new BadRequestException('La fecha de aprobación no puede ser futura');
    if (e.vigenteHasta && e.vigenteHasta < e.fechaAprobacion)
      throw new BadRequestException(
        'La vigencia no puede terminar antes de la fecha de aprobación',
      );
    const id = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        const tipo = await tx.requisitoLegalTipo.findUnique({ where: { id: e.tipoId } });
        if (!tipo || !tipo.activo)
          throw new BadRequestException('El tipo de requisito legal no existe');
        const archivo = await tx.archivoRef.findUnique({
          where: { id: e.archivoId },
          select: { eliminadoAt: true, modulo: { select: { codigo: true } } },
        });
        if (!archivo || archivo.eliminadoAt)
          throw new BadRequestException('El documento no existe');
        if (archivo.modulo.codigo !== MODULO_ARCHIVO_REQUISITO_LEGAL)
          throw new BadRequestException(
            'El documento no se subió como requisito legal: súbalo de nuevo desde esta pantalla',
          );
        if (await tx.requisitoLegal.count({ where: { tipoId: e.tipoId, revision } }))
          throw new ConflictException(
            `Ya existe la revisión «${revision}» de este tipo de requisito legal`,
          );
        if (await tx.requisitoLegal.count({ where: { archivoId: e.archivoId } }))
          throw new ConflictException('Ese documento ya está registrado en otra revisión');
        // la revisión vigente del tipo pasa a reemplazada antes de insertar la nueva (una sola vigente por tipo)
        const anterior = await tx.requisitoLegal.findFirst({
          where: { tipoId: e.tipoId, estado: EstadoRequisitoLegal.vigente },
          select: { id: true },
        });
        if (anterior) {
          const cambio = await tx.requisitoLegal.updateMany({
            where: { id: anterior.id, estado: EstadoRequisitoLegal.vigente },
            data: {
              estado: EstadoRequisitoLegal.reemplazado,
              reemplazadoAt: new Date(),
              reemplazadoPor: actor.id,
              updatedBy: actor.id,
            },
          });
          if (cambio.count !== 1)
            throw new ConflictException('La revisión cambió; recargue e intente de nuevo');
        }
        await tx.requisitoLegal.create({
          data: {
            id,
            tipoId: e.tipoId,
            revision,
            fechaAprobacion: aFecha(e.fechaAprobacion),
            vigenteHasta: e.vigenteHasta ? aFecha(e.vigenteHasta) : null,
            archivoId: e.archivoId,
            createdBy: actor.id,
          },
        });
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'qhse.requisito_legal.registrado',
            subject: { type: 'requisito_legal', id },
            data: {
              requisitoLegalId: id,
              tipo: tipo.codigo,
              revision,
              fechaAprobacion: e.fechaAprobacion,
              vigenteHasta: e.vigenteHasta ?? null,
              reemplazaId: anterior?.id ?? null,
            },
            actor: enActor(actor),
            traceparent: currentTraceparent(),
          }),
        );
      });
    } catch (err) {
      // dos registros a la vez del mismo tipo: la base (índice único) deja pasar a uno solo
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException(
          'Otra persona registró una revisión a la vez; recargue e intente de nuevo',
        );
      throw err;
    }
    return this.consulta.uno(id);
  }
}
