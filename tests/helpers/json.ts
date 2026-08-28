// res.json() is Promise<unknown> under bun-types; tests want loose bodies.
export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
