import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config, type Role } from './config.js';
import { first } from './db.js';
import { unauthorized, forbidden } from './util.js';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name: string;
  refId: string | null;
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  // Treat incomplete/corrupt records as invalid credentials rather than
  // allowing scrypt or timingSafeEqual to throw and turn login into a 500.
  try {
    if (!password || !hash || !salt || !/^[0-9a-f]+$/i.test(hash) || hash.length % 2 !== 0) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function sign(payloadB64: string): string {
  return createHmac('sha256', config.authSecret).update(payloadB64).digest('base64url');
}

export function issueToken(user: AuthUser): string {
  const payload = {
    sub: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyToken(token: string): { sub: string; role: Role } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return { sub: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

async function loadUser(userId: string): Promise<AuthUser | null> {
  const row = await first<{ id: string; email: string; role: Role; name: string; ref_id: string | null }>('users', { id: `eq.${userId}` });
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role, name: row.name, refId: row.ref_id };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(required: boolean): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      if (required) return next(unauthorized());
      return next();
    }
    const decoded = verifyToken(match[1].trim());
    if (!decoded) return next(unauthorized('Invalid or expired token'));
    loadUser(decoded.sub).then((user) => {
      if (!user) return next(unauthorized('Account no longer exists'));
      req.user = user;
      next();
    }).catch(next);
  };
}

export function requireRole(...roles: Role[]): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}
