import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AppConfigModule } from '@dyn/config';
import { CommonModule } from '@dyn/common';
import { gatewayEnvSchema } from './env';
import { GatewayProxyMiddleware } from './gateway-proxy.middleware';

@Module({
  imports: [
    AppConfigModule.forRoot(gatewayEnvSchema, ['apps/gateway/.env', '.env']),
    CommonModule.forRoot({ serviceName: 'gateway' }),
  ],
  providers: [GatewayProxyMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(GatewayProxyMiddleware)
      .exclude(
        { path: 'health/live', method: RequestMethod.ALL },
        { path: 'health/ready', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
