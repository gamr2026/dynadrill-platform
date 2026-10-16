import { buildPage, MAX_PAGE_SIZE, PaginationQueryDto, toSkipTake } from './pagination';

describe('pagination', () => {
  it('calcula skip/take y respeta el tope de tamaño', () => {
    const q = Object.assign(new PaginationQueryDto(), { page: 3, pageSize: 10 });
    expect(toSkipTake(q)).toEqual({ skip: 20, take: 10 });
    const big = Object.assign(new PaginationQueryDto(), { page: 1, pageSize: 99999 });
    expect(toSkipTake(big).take).toBe(MAX_PAGE_SIZE);
  });

  it('arma la página con totales', () => {
    const q = Object.assign(new PaginationQueryDto(), { page: 2, pageSize: 10 });
    const page = buildPage(['a'], 21, q);
    expect(page).toMatchObject({ total: 21, page: 2, pageSize: 10, totalPages: 3 });
  });
});
