import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Query estándar de listados. Mantiene la forma `page`/`pageSize` del backend demo
 * (contrato del frontend), con un tope de tamaño de página (documento de arquitectura, cap. 10.4).
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = DEFAULT_PAGE_SIZE;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** `skip`/`take` listos para Prisma a partir de un `PaginationQueryDto`. */
export function toSkipTake(query: PaginationQueryDto): { skip: number; take: number } {
  const page = query.page ?? 1;
  const take = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { skip: (page - 1) * take, take };
}

export function buildPage<T>(items: T[], total: number, query: PaginationQueryDto): PageResult<T> {
  const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return {
    items,
    total,
    page: query.page ?? 1,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
