import type { OwnedResource, UserProfile } from '@brownstone/contracts';
import { ForbiddenError, NotFoundError } from '@brownstone/errors';

/**
 * Resource ownership check.
 *
 * Admins bypass the owner check (so an admin can inspect any user's tasks
 * for support purposes); regular members can only see their own.
 *
 * The original code had no ownership concept at all — any authenticated
 * client could pass any sessionId. Point #5 of the review.
 */
export function assertOwner(resource: OwnedResource | undefined, user: UserProfile, kind = 'resource'): asserts resource {
  if (!resource) {
    throw new NotFoundError(`${kind} not found`);
  }
  if (user.role === 'admin') return;
  if (resource.ownerUserId !== user.id) {
    // Deliberately return 404 not 403 so we don't disclose existence of
    // resources owned by other users.
    throw new NotFoundError(`${kind} not found`);
  }
}

/** Filter a collection to entries the caller can see. */
export function filterOwned<T extends OwnedResource>(items: T[], user: UserProfile): T[] {
  if (user.role === 'admin') return items;
  return items.filter((item) => item.ownerUserId === user.id);
}

/** Refuse if the caller isn't an admin (used for user-management routes). */
export function assertAdmin(user: UserProfile): void {
  if (user.role !== 'admin') {
    throw new ForbiddenError('Admin role required for this action');
  }
}
