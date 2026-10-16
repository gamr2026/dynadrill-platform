import { Module } from '@nestjs/common';
import {
  BloquesController,
  BodegasController,
  CamposController,
  ClientesController,
  CondicionesPagoController,
  PersonasController,
  PozosController,
  TaladrosController,
  ZonasController,
} from './controllers/catalogos.controllers';
import { PrismaService } from './prisma/prisma.service';
import {
  ChoferesController,
  TiposVehiculoController,
  TransportistasController,
  VehiculosController,
} from './controllers/transporte.controllers';
import { TransporteService } from './services/transporte.service';
import { BloquesService } from './services/bloques.service';
import { BodegasService } from './services/bodegas.service';
import { CondicionesPagoService } from './services/condiciones-pago.service';
import { CamposService } from './services/campos.service';
import { CatalogoEventos } from './services/catalogo-eventos.service';
import { ClientesService } from './services/clientes.service';
import { PersonasService } from './services/personas.service';
import { PozosService } from './services/pozos.service';
import { TaladrosService } from './services/taladros.service';
import { ZonasService } from './services/zonas.service';

/**
 * Catálogos: datos maestros compartidos (clientes, personas de contacto y ubicaciones operativas). Dueño
 * exclusivo del schema `catalogos`. Requiere en la app: `AppConfigModule` (DATABASE_URL), `CommonModule`
 * y `MessagingModule`.
 */
@Module({
  controllers: [
    BloquesController,
    CamposController,
    TaladrosController,
    PozosController,
    ClientesController,
    PersonasController,
    ZonasController,
    BodegasController,
    CondicionesPagoController,
    TransportistasController,
    TiposVehiculoController,
    VehiculosController,
    ChoferesController,
  ],
  providers: [
    PrismaService,
    CatalogoEventos,
    BloquesService,
    CamposService,
    TaladrosService,
    ZonasService,
    BodegasService,
    TransporteService,
    CondicionesPagoService,
    PozosService,
    ClientesService,
    PersonasService,
  ],
})
export class CatalogosModule {}
