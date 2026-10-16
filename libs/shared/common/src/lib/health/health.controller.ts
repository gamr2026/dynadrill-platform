import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';

/** `/health/live` y `/health/ready` para Container Apps / docker. Fuera del prefijo `/api`. */
@Controller('health')
export class HealthController {
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  ready() {
    return { status: 'ok' };
  }
}
