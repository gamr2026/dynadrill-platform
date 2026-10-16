import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class As2PedidosQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Pedidos por página (cada uno cuesta una consulta de líneas a AS2; por eso el tope es bajo). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;

  /** Estado exacto en AS2 (ELABORADO, PROCESADO, CERRADO, ANULADO...). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z_]{1,30}$/)
  estado?: string;

  @IsOptional()
  @IsIn(['con', 'sin'])
  lineas?: 'con' | 'sin';

  /** Texto contenido en la descripción del pedido. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}
