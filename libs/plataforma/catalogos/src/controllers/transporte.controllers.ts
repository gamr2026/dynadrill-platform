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
import { AnyAuthenticated, AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  CreateChoferDto,
  CreateTipoVehiculoDto,
  CreateTransportistaDto,
  CreateVehiculoDto,
  TransporteQueryDto,
  UpdateChoferDto,
  UpdateTipoVehiculoDto,
  UpdateTransportistaDto,
  UpdateVehiculoDto,
} from '../dto/transporte.dto';
import { TransporteService } from '../services/transporte.service';

const P = Permission;

@Controller('catalogos/transportistas')
export class TransportistasController {
  constructor(private readonly s: TransporteService) {}

  @AnyAuthenticated() @Get() listar() {
    return this.s.transportistas();
  }
  @AnyAuthenticated() @Get(':id') uno(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.transportista(id);
  }
  @RequirePermission(P.TRANSPORTE_CREAR)
  @Post()
  crear(@Body() dto: CreateTransportistaDto, @CurrentUser() a: AuthUser) {
    return this.s.crearTransportista(dto, a);
  }
  @RequirePermission(P.TRANSPORTE_EDITAR)
  @Put(':id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransportistaDto,
    @CurrentUser() a: AuthUser,
  ) {
    return this.s.actualizarTransportista(id, dto, a);
  }
  @RequirePermission(P.TRANSPORTE_INACTIVAR)
  @Delete(':id')
  async inactivar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() a: AuthUser) {
    await this.s.inactivarTransportista(id, a);
    return { ok: true };
  }
}

@Controller('catalogos/tipos-vehiculo')
export class TiposVehiculoController {
  constructor(private readonly s: TransporteService) {}

  @AnyAuthenticated() @Get() listar() {
    return this.s.tiposVehiculo();
  }
  @RequirePermission(P.TRANSPORTE_CREAR)
  @Post()
  crear(@Body() dto: CreateTipoVehiculoDto, @CurrentUser() a: AuthUser) {
    return this.s.crearTipoVehiculo(dto, a);
  }
  @RequirePermission(P.TRANSPORTE_EDITAR)
  @Put(':id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTipoVehiculoDto,
    @CurrentUser() a: AuthUser,
  ) {
    return this.s.actualizarTipoVehiculo(id, dto, a);
  }
  @RequirePermission(P.TRANSPORTE_INACTIVAR)
  @Delete(':id')
  async inactivar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() a: AuthUser) {
    await this.s.inactivar('tipoVehiculo', id, a);
    return { ok: true };
  }
}

@Controller('catalogos/vehiculos')
export class VehiculosController {
  constructor(private readonly s: TransporteService) {}

  @AnyAuthenticated() @Get() listar(@Query() q: TransporteQueryDto) {
    return this.s.vehiculos(q.transportistaId);
  }
  @AnyAuthenticated() @Get(':id') uno(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.vehiculo(id);
  }
  @RequirePermission(P.TRANSPORTE_CREAR)
  @Post()
  crear(@Body() dto: CreateVehiculoDto, @CurrentUser() a: AuthUser) {
    return this.s.crearVehiculo(dto, a);
  }
  @RequirePermission(P.TRANSPORTE_EDITAR)
  @Put(':id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehiculoDto,
    @CurrentUser() a: AuthUser,
  ) {
    return this.s.actualizarVehiculo(id, dto, a);
  }
  @RequirePermission(P.TRANSPORTE_INACTIVAR)
  @Delete(':id')
  async inactivar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() a: AuthUser) {
    await this.s.inactivar('vehiculo', id, a);
    return { ok: true };
  }
}

@Controller('catalogos/choferes')
export class ChoferesController {
  constructor(private readonly s: TransporteService) {}

  @AnyAuthenticated() @Get() listar(@Query() q: TransporteQueryDto) {
    return this.s.choferes(q.transportistaId);
  }
  @AnyAuthenticated() @Get(':id') uno(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.chofer(id);
  }
  @RequirePermission(P.TRANSPORTE_CREAR)
  @Post()
  crear(@Body() dto: CreateChoferDto, @CurrentUser() a: AuthUser) {
    return this.s.crearChofer(dto, a);
  }
  @RequirePermission(P.TRANSPORTE_EDITAR)
  @Put(':id')
  actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChoferDto,
    @CurrentUser() a: AuthUser,
  ) {
    return this.s.actualizarChofer(id, dto, a);
  }
  @RequirePermission(P.TRANSPORTE_INACTIVAR)
  @Delete(':id')
  async inactivar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() a: AuthUser) {
    await this.s.inactivar('chofer', id, a);
    return { ok: true };
  }
}
