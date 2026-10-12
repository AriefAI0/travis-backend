// The change bus: one in-process fan-out, partitioned by organization.
//
// Who may see an event is NOT decided here. The bus delivers to a subscriber
// only when the organization matches, and the route applies the rights check on
// top, because rights belong to the request that opened the stream.
//
// ponytail: one process, which is one app container. A second container would
// need Postgres LISTEN/NOTIFY behind the same subscribe/publish pair.

export type ChangeEvent = {
  // Monotonic within a process. A client uses it to spot a gap after a drop.
  id: number;
  organizationId: number;
  // The audit vocabulary: create, modify, remove, archive, restore,
  // permission_change, password_reset, user_disable.
  action: string;
  // The audit row's word for the thing, e.g. "project" or "result".
  resourceType: string;
  resourceId: string | null;
  // The account the change concerns, when it concerns one. A permission change
  // carries it, which is how a user learns their own rights moved.
  userId: string | null;
  at: string;
};

export type ChangeInput = Omit<ChangeEvent, "id" | "at">;

type Subscriber = {
  organizationId: number;
  listener: (event: ChangeEvent) => void;
};

const subscribers = new Set<Subscriber>();

let nextId = 1;

// flow: subscriber > org match > listener
// Returns its own unsubscribe, so a closed stream cannot leak a listener.
export const subscribe = (
  organizationId: number,
  listener: (event: ChangeEvent) => void,
): (() => void) => {
  const entry: Subscriber = { organizationId, listener };
  subscribers.add(entry);

  return () => {
    subscribers.delete(entry);
  };
};

export const publish = (input: ChangeInput): void => {
  const event: ChangeEvent = { ...input, id: nextId, at: new Date().toISOString() };
  nextId += 1;

  for (const entry of subscribers) {
    if (entry.organizationId === event.organizationId) {
      entry.listener(event);
    }
  }
};

// How many streams are open. A test asserts a closed one unsubscribed.
export const subscriberCount = (): number => subscribers.size;
