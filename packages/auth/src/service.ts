import type { AgentConfig, UserProfile } from '@brownstone/contracts';
import { UnauthenticatedError, ValidationError } from '@brownstone/errors';
import { countUsers, createUserRecord, findUserByEmail, findUserById, toProfile } from './user-store.js';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): string {
  const normalized = (email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new ValidationError('Email is not in a valid format');
  }
  if (normalized.length > 254) {
    throw new ValidationError('Email is too long');
  }
  return normalized;
}

function validateDisplayName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length > 80) {
    throw new ValidationError('Display name must be at most 80 characters');
  }
  return trimmed;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
}

export async function registerUser(config: AgentConfig, input: RegisterInput): Promise<UserProfile> {
  if (!config.allowRegistration) {
    // Allow the very first user (bootstrap admin) even with registration off.
    const existing = await countUsers(config);
    if (existing > 0) {
      throw new ValidationError('Registration is disabled on this server');
    }
  }
  const email = validateEmail(input.email);
  const displayName = validateDisplayName(input.displayName ?? '');
  validatePassword(input.password);

  const existing = await countUsers(config);
  const role = existing === 0 ? 'admin' : 'member';

  const passwordHash = await hashPassword(config, input.password);
  const account = await createUserRecord(config, { email, displayName, passwordHash, role });
  return toProfile(account);
}

export async function authenticate(config: AgentConfig, email: string, password: string): Promise<UserProfile> {
  // Always run the verify path even on unknown email to limit timing leaks.
  const normalized = validateEmail(email);
  const account = await findUserByEmail(config, normalized);
  // Reference hash uses the same scrypt format so verifyPassword does the
  // same amount of work as it would for a real account.
  const referenceHash = account?.passwordHash
    ?? 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64) + '$4096:8:1';
  const ok = await verifyPassword(password, referenceHash);
  if (!account || !ok) {
    throw new UnauthenticatedError('Email or password is incorrect');
  }
  return toProfile(account);
}

export async function loadUserProfile(config: AgentConfig, userId: string): Promise<UserProfile> {
  const account = await findUserById(config, userId);
  if (!account) {
    throw new UnauthenticatedError('User account no longer exists');
  }
  return toProfile(account);
}
