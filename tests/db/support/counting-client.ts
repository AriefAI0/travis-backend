import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import type { Db } from "../../../src/db/client";
import * as schema from "../../../src/db/schema";
import { testDatabaseUrl } from "../../helpers/db";

export type QueryCounter = {
  count: number;
  reset: () => void;
};

export type CountingDatabase = {
  database: Db;
  counter: QueryCounter;
  close: () => Promise<void>;
};

/**
 * Wrap a pg.Client so every SQL statement issued through it is counted.
 *
 * pg port of the libsql counting client: drizzle-orm/node-postgres resolves every
 * ORM query to a single `client.query(config)` call. Statements inside a
 * transaction route through the tx's own client and are NOT counted here; that
 * is fine for read-path N+1 tests, since none of the measured services use a
 * transaction. One `query` call = one statement — batched fetches stay O(1)
 * round-trips vs N+1's O(rows).
 */
export const createCountingDatabase = async (): Promise<CountingDatabase> => {
  const counter: QueryCounter = {
    count: 0,
    reset: () => {
      counter.count = 0;
    },
  };

  const inner = new pg.Client({ connectionString: testDatabaseUrl });
  await inner.connect();

  const proxied = new Proxy(inner as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (property === "query") {
        return async (...args: unknown[]) => {
          counter.count += 1;
          return Reflect.apply(value, target, args);
        };
      }

      return value.bind(target);
    },
  });

  return {
    database: drizzle(proxied as unknown as pg.Client, { schema }),
    counter,
    close: () => inner.end(),
  };
};
