import { IsOptional, IsString, MaxLength } from 'class-validator';

export class VerificarFirmaDto {
  /** Nombre que se espera ver junto a la firma (opcional). */
  @IsOptional() @IsString() @MaxLength(200) nombreEsperado?: string;
  @IsOptional() @IsString() @MaxLength(200) cargoEsperado?: string;
}
