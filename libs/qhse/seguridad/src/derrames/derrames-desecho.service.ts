import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { ClasificacionDesecho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { codigoDesecho } from '../desechos/desechos-consulta.service';
import { DesechosService, type LineaEntrada } from '../desechos/desechos.service';
import { DerramesConsultaService, codigoDerrame } from './derrames-consulta.service';
import { DerramesEventosService } from './derrames-eventos.service';

export interface GenerarDesechoEntrada {
  contenedorId: string;
  /** El equipo HSE elige la característica CRETIB del suelo contaminado: no se supone una. */
  caracteristicaIds: string[];
  items: LineaEntrada[];
  /** Texto adicional para el desecho (opcional); la descripción base sale del derrame. */
  nota?: string | null;
}

/**
 * Un derrame en suelo genera un desecho peligroso (HSE-AMBIENTAL-001/002). El derrame aporta la descripción y el sitio; el equipo HSE elige
 * la característica CRETIB, el contenedor y los galones (la demo no dice cuáles). El desecho y el evento del derrame se guardan en la misma
 * transacción; la base exige que la ubicación del derrame genere desecho y que sea uno solo por derrame.
 */
@Injectable()
export class DerramesDesechoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly desechos: DesechosService,
    private readonly eventos: DerramesEventosService,
    private readonly consulta: DerramesConsultaService,
  ) {}

  async generar(id: string, entrada: GenerarDesechoEntrada, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.derrame.findUnique({
        where: { id },
        include: { ubicacion: true, desecho: { select: { id: true } } },
      });
      if (!d) throw new NotFoundException('El derrame no existe');
      if (!d.ubicacion.generaDesecho)
        throw new ConflictException(
          `Un derrame en «${d.ubicacion.nombre}» no genera desecho: solo el que contamina suelo`,
        );
      if (d.desecho) throw new ConflictException('Este derrame ya generó su desecho');
      const base = `Suelo contaminado por el derrame ${codigoDerrame(d.numero)}: ${d.descripcion}`;
      const creado = await this.desechos.crearEn(
        tx,
        {
          clasificacion: ClasificacionDesecho.peligroso,
          contenedorId: entrada.contenedorId,
          caracteristicaIds: entrada.caracteristicaIds,
          descripcion: entrada.nota?.trim() ? `${base}. ${entrada.nota.trim()}` : base,
          ubicacion: d.ubicacionFisica,
          items: entrada.items,
        },
        actor,
        id,
      );
      await this.eventos.publicar(tx, 'qhse.derrame.desecho_generado', id, actor, {
        desechoId: creado.id,
        desechoCodigo: codigoDesecho(creado.numero),
      });
    });
    return this.consulta.detalle(id);
  }
}
