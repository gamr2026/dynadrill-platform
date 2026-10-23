import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { ZonasService } from '../services/zonas.service';
import { BodegasService } from '../services/bodegas.service';
import { CondicionesPagoService } from '../services/condiciones-pago.service';
import { UnidadesMedidaService } from '../services/unidades-medida.service';
import { AnyAuthenticated, AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  CreateCatalogoAs2Dto,
  CreateCatalogoSimpleDto,
  CreateUnidadMedidaDto,
  UpdateUnidadMedidaDto,
  UpdateCatalogoAs2Dto,
  UpdateCatalogoSimpleDto,
  CreateBloqueDto,
  CreateCampoDto,
  CreateClienteDto,
  CreatePersonaDto,
  CreatePozoDto,
  CreateTaladroDto,
  PersonasQueryDto,
  PozosQueryDto,
  UpdateBloqueDto,
  UpdateCampoDto,
  UpdateClienteDto,
  UpdatePersonaDto,
  UpdatePozoDto,
  UpdateTaladroDto,
} from '../dto/catalogos.dto';
import { BloquesService } from '../services/bloques.service';
import { CamposService } from '../services/campos.service';
import { ClientesService } from '../services/clientes.service';
import { PersonasService } from '../services/personas.service';
import { PozosService } from '../services/pozos.service';
import { TaladrosService } from '../services/taladros.service';

/*
 * Mismas rutas y formas que el catálogo de la demo (`/api/catalogos/*`). La LECTURA es abierta a cualquier
 * usuario autenticado: todos los formularios necesitan estos datos para poblar sus selects. Cada ESCRITURA
 * exige su permiso. `DELETE` inactiva (las filas no se eliminan: otros módulos las referencian).
 * Bloques, campos, pozos y taladros comparten los permisos `catalogos.ubicacion.*`.
 */

@Controller('catalogos/bloques')
export class BloquesController {
  constructor(private readonly service: BloquesService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateBloqueDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBloqueDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/campos')
export class CamposController {
  constructor(private readonly service: CamposService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateCampoDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/taladros')
export class TaladrosController {
  constructor(private readonly service: TaladrosService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateTaladroDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaladroDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/pozos')
export class PozosController {
  constructor(private readonly service: PozosService) {}

  /** Filtros opcionales `campoId` y `bloqueId` (UUID) para las cascadas de los formularios. */
  @AnyAuthenticated()
  @Get()
  findAll(@Query() query: PozosQueryDto) {
    return this.service.findAll(query);
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreatePozoDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePozoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/clientes')
export class ClientesController {
  constructor(private readonly service: ClientesService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.CLIENTES_CREAR)
  @Post()
  create(@Body() dto: CreateClienteDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.CLIENTES_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClienteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.CLIENTES_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/personas')
export class PersonasController {
  constructor(private readonly service: PersonasService) {}

  /** Filtro opcional `tipo` (validado) para poblar cada select del Pedido. */
  @AnyAuthenticated()
  @Get()
  findAll(@Query() query: PersonasQueryDto) {
    return this.service.findAll(query);
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.PERSONAS_CREAR)
  @Post()
  create(@Body() dto: CreatePersonaDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.PERSONAS_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePersonaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.PERSONAS_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/zonas')
export class ZonasController {
  constructor(private readonly service: ZonasService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateCatalogoSimpleDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogoSimpleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/bodegas')
export class BodegasController {
  constructor(private readonly service: BodegasService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateCatalogoAs2Dto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogoAs2Dto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

@Controller('catalogos/condiciones-pago')
export class CondicionesPagoController {
  constructor(private readonly service: CondicionesPagoService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UBICACION_CREAR)
  @Post()
  create(@Body() dto: CreateCatalogoAs2Dto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UBICACION_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogoAs2Dto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UBICACION_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}

/** Unidades de medida compartidas (IN9). La lectura es de cualquier cuenta; escribir exige su permiso. */
@Controller('catalogos/unidades-medida')
export class UnidadesMedidaController {
  constructor(private readonly service: UnidadesMedidaService) {}

  @AnyAuthenticated()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @AnyAuthenticated()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @RequirePermission(Permission.UNIDADES_MEDIDA_CREAR)
  @Post()
  create(@Body() dto: CreateUnidadMedidaDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor);
  }

  @RequirePermission(Permission.UNIDADES_MEDIDA_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnidadMedidaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(id, dto, actor);
  }

  @RequirePermission(Permission.UNIDADES_MEDIDA_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.service.inactivar(id, actor);
    return { ok: true };
  }
}
