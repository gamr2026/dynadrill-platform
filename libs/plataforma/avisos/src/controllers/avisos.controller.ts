import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AnyAuthenticated, AuthUser, CurrentUser } from '@dyn/common';
import { AvisosService } from '../services/avisos.service';

/** La campanita de la aplicación: los avisos de quien consulta (nunca los de otra persona). */
@Controller('avisos')
export class AvisosController {
  constructor(private readonly avisos: AvisosService) {}

  @AnyAuthenticated()
  @Get()
  mios(@CurrentUser() actor: AuthUser) {
    return this.avisos.misAvisos(actor.id);
  }

  @AnyAuthenticated()
  @Post('leer-todos')
  @HttpCode(200)
  async leerTodos(@CurrentUser() actor: AuthUser) {
    return { leidos: await this.avisos.leerTodos(actor.id) };
  }

  @AnyAuthenticated()
  @Post(':id/leer')
  @HttpCode(200)
  async leer(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.avisos.leer(actor.id, id);
    return { ok: true };
  }
}
