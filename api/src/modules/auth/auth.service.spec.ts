import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Session, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { AuthTokensResponse, MfaRequiredResponse } from './auth.types';

const PASSWORD = 'Password123!';

const CONFIG: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};

/** In-memory stand-ins for the `users` and `sessions` tables. */
function makePrismaMock(
  users: Map<string, User>,
  sessions: Map<string, Session>,
) {
  return {
    user: {
      findUnique: jest.fn(
        ({ where }: { where: { id?: string; email?: string } }) =>
          Promise.resolve(
            where.id
              ? (users.get(where.id) ?? null)
              : ([...users.values()].find((u) => u.email === where.email) ??
                  null),
          ),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
          const next = { ...users.get(where.id)!, ...data };
          users.set(where.id, next);
          return Promise.resolve(next);
        },
      ),
    },
    session: {
      create: jest.fn(({ data }: { data: Session }) => {
        const defaults = {
          createdAt: new Date(),
          lastUsedAt: new Date(),
          revokedAt: null,
          userAgent: null,
          ip: null,
        };
        const row: Session = { ...defaults, ...data };
        sessions.set(row.id, row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(sessions.get(where.id) ?? null),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Session>;
        }) => {
          const next = { ...sessions.get(where.id)!, ...data };
          sessions.set(where.id, next);
          return Promise.resolve(next);
        },
      ),
    },
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    fullName: 'Test Admin',
    initials: 'TA',
    email: 'admin@test.local',
    phone: null,
    passwordHash: '',
    role: 'SUPER_ADMIN',
    homeBranchId: null,
    scope: 'group',
    totpSecret: null,
    totpEnabled: false,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    createdById: null,
    updatedById: null,
    ...overrides,
  };
}

describe('AuthService', () => {
  let passwordHash: string;
  let users: Map<string, User>;
  let sessions: Map<string, Session>;
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AuthService;
  let user: User;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  });

  beforeEach(() => {
    users = new Map();
    sessions = new Map();
    user = makeUser({ passwordHash });
    users.set(user.id, user);

    prisma = makePrismaMock(users, sessions);
    const config = {
      get: (key: string, def?: string) => CONFIG[key] ?? def,
    } as unknown as ConfigService;
    service = new AuthService(
      prisma as unknown as PrismaService,
      new JwtService({}),
      config,
    );
  });

  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  describe('login', () => {
    it('returns access + refresh tokens and the user on valid credentials', async () => {
      const result = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as AuthTokensResponse;

      expect(result.access_token).toEqual(expect.any(String));
      expect(result.refresh_token).toEqual(expect.any(String));
      expect(result.user).toMatchObject({
        id: user.id,
        email: user.email,
        role: 'SUPER_ADMIN',
        totp_enabled: false,
      });
      // password hash must never leak
      expect(result.user).not.toHaveProperty('password_hash');

      // a session row was recorded with ip + user-agent (device history, E18)
      expect(sessions.size).toBe(1);
      const session = [...sessions.values()][0];
      expect(session.userId).toBe(user.id);
      expect(session.ip).toBe('127.0.0.1');
      expect(session.userAgent).toBe('jest');
      // only a hash of the refresh token is stored
      expect(session.refreshTokenHash).not.toContain(result.refresh_token);
      expect(session.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects a wrong password with 401 and creates no session', async () => {
      await expect(
        service.login(user.email, 'wrong-password', meta),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login('nobody@test.local', PASSWORD, meta),
      ).rejects.toThrow(UnauthorizedException);
      expect(sessions.size).toBe(0);
    });
  });

  describe('2FA login flow', () => {
    it('returns mfa_required, then issues tokens after TOTP verification', async () => {
      const secret = authenticator.generateSecret();
      users.set(user.id, { ...user, totpSecret: secret, totpEnabled: true });

      const step1 = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as MfaRequiredResponse;
      expect(step1.mfa_required).toBe(true);
      expect(step1.mfa_token).toEqual(expect.any(String));
      // no session until the second factor succeeds
      expect(sessions.size).toBe(0);

      // wrong code is rejected
      await expect(
        service.verifyMfa(step1.mfa_token, '000000', meta),
      ).rejects.toThrow(UnauthorizedException);

      const code = authenticator.generate(secret);
      const step2 = await service.verifyMfa(step1.mfa_token, code, meta);
      expect(step2.access_token).toEqual(expect.any(String));
      expect(step2.refresh_token).toEqual(expect.any(String));
      expect(step2.user.id).toBe(user.id);
      expect(sessions.size).toBe(1);
    });

    it('rejects an mfa_token used as an access-token substitute for refresh', async () => {
      users.set(user.id, {
        ...user,
        totpSecret: authenticator.generateSecret(),
        totpEnabled: true,
      });
      const step1 = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as MfaRequiredResponse;
      await expect(service.refresh(step1.mfa_token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refresh rotation', () => {
    it('rotates the refresh token and rejects the previous one afterwards', async () => {
      const login = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as AuthTokensResponse;

      const rotated = await service.refresh(login.refresh_token);
      expect(rotated.access_token).toEqual(expect.any(String));
      expect(rotated.refresh_token).toEqual(expect.any(String));
      expect(rotated.refresh_token).not.toBe(login.refresh_token);

      // the pre-rotation token no longer matches the stored hash
      await expect(service.refresh(login.refresh_token)).rejects.toThrow(
        UnauthorizedException,
      );

      // the rotated token still works
      const again = await service.refresh(rotated.refresh_token);
      expect(again.refresh_token).not.toBe(rotated.refresh_token);
    });

    it('rejects garbage and access tokens presented as refresh tokens', async () => {
      const login = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as AuthTokensResponse;
      await expect(service.refresh('not-a-jwt')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refresh(login.access_token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('revokes the session so its refresh token is rejected', async () => {
      const login = (await service.login(
        user.email,
        PASSWORD,
        meta,
      )) as AuthTokensResponse;
      const sessionId = [...sessions.keys()][0];

      await service.logout(sessionId);
      expect(sessions.get(sessionId)!.revokedAt).toBeInstanceOf(Date);

      await expect(service.refresh(login.refresh_token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('TOTP lifecycle', () => {
    it('setup stores a pending secret, confirm enables, disable turns it off', async () => {
      const setup = await service.setupTotp(user.id);
      expect(setup.otpauth_url).toContain('otpauth://totp/');
      expect(setup.qr_data_uri).toMatch(/^data:image\/png;base64,/);
      expect(users.get(user.id)!.totpEnabled).toBe(false);

      const secret = users.get(user.id)!.totpSecret!;
      await expect(service.confirmTotp(user.id, '000000')).rejects.toThrow(
        UnauthorizedException,
      );
      await service.confirmTotp(user.id, authenticator.generate(secret));
      expect(users.get(user.id)!.totpEnabled).toBe(true);

      await service.disableTotp(user.id, authenticator.generate(secret));
      expect(users.get(user.id)!.totpEnabled).toBe(false);
      expect(users.get(user.id)!.totpSecret).toBeNull();
    });
  });

  describe('me', () => {
    it('returns the sanitized current user', async () => {
      const result = await service.me(user.id);
      expect(result).toMatchObject({ id: user.id, email: user.email });
      expect(result).not.toHaveProperty('password_hash');
    });

    it('rejects a deactivated user', async () => {
      users.set(user.id, { ...user, active: false });
      await expect(service.me(user.id)).rejects.toThrow(UnauthorizedException);
    });
  });
});
