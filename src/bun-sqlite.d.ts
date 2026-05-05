declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: {readonly?: boolean; readwrite?: boolean; create?: boolean})
    query<T = Record<string, unknown>>(sql: string): {
      all(...params: unknown[]): T[]
      get(...params: unknown[]): T | null
    }
    close(): void
  }
}
