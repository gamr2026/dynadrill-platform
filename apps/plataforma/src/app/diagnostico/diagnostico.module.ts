import { Module } from '@nestjs/common';
import { DiagnosticoController } from './diagnostico.controller';
import { DiagnosticoService } from './diagnostico.service';

@Module({
  controllers: [DiagnosticoController],
  providers: [DiagnosticoService],
})
export class DiagnosticoModule {}
