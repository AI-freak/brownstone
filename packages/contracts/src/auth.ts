/** User account in the auth store. */
export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  role: UserRole;
}

export type UserRole = 'admin' | 'member';

/** Sanitized user object safe to return over HTTP. */
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
}

/** Server-side auth session backing a cookie. */
export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Result of decoding an incoming request's auth state. */
export interface AuthContext {
  user: UserProfile;
  sessionId: string;
}

/** Any resource that has an owner has this shape. */
export interface OwnedResource {
  ownerUserId: string;
}
