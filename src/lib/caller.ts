// Who is asking. Every data access is org-scoped, and every write lands in the
// audit row under this user. Routes build it from the token; services require
// it, so no query can accidentally run unscoped.
export type Caller = {
  organizationId: number;
  // null for a background job: a render or a sweep has no acting user, and the
  // audit row records it as a system write.
  userId: string | null;
};
