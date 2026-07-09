import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { toDataURL } from 'qrcode';
import { createHash, randomUUID } from 'node:crypto';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AccessTokenPayload,
  AuthTokensResponse,
  LoginResponse,
  MfaTokenPayload,
  PublicUser,
  RefreshTokenPayload,
  SessionEntry,
} from './auth.types';

/** TOTP issuer shown in authenticator apps. */
const TOTP_ISSUER = 'TriServe';
/** mfa_token lifetime — long enough to type a code, useless as an access token. */
const MFA_TOKEN_TTL = '5m';

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Login / MFA
  // -------------------------------------------------------------------------

  /**
   * POST /auth/login. Verifies argon2id password; if the user has TOTP
   * enabled, returns a short-lived mfa_token instead of real tokens —
   * the session is only created once the second factor is verified.
   */
  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.totpEnabled) {
      const payload: MfaTokenPayload = { sub: user.id, type: 'mfa' };
      const mfaToken = await this.jwt.signAsync(payload, {
        secret: this.accessSecret,
        expiresIn: MFA_TOKEN_TTL,
      });
      return { mfa_required: true, mfa_token: mfaToken };
    }

    return this.createSession(user, meta);
  }

  /** POST /auth/login/verify — second step of a 2FA login. */
  async verifyMfa(
    mfaToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<AuthTokensResponse> {
    let payload: MfaTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<MfaTokenPayload>(mfaToken, {
        secret: this.accessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }
    if (payload.type !== 'mfa') {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }
    if (!user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException(
        'Two-factor authentication is not enabled',
      );
    }
    if (!authenticator.verify({ token: code, secret: user.totpSecret })) {
      throw new UnauthorizedException('Invalid verification code');
    }

    return this.createSession(user, meta);
  }

  // -------------------------------------------------------------------------
  // Refresh rotation / logout
  // -------------------------------------------------------------------------

  /**
   * POST /auth/refresh. Verifies the refresh JWT, matches its SHA-256 hash
   * against the session's stored hash (so a rotated/revoked token is
   * rejected), then rotates: a NEW refresh token replaces the old hash.
   */
  async refresh(refreshToken: string): Promise<AuthTokensResponse> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
    });
    if (
      !session ||
      session.revokedAt ||
      session.refreshTokenHash !== this.hashToken(refreshToken)
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.signTokens(user, session.id);
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: this.hashToken(tokens.refresh_token),
        lastUsedAt: new Date(),
      },
    });

    return { ...tokens, user: this.toPublicUser(user) };
  }

  /** POST /auth/logout — revokes the current session's refresh token. */
  async logout(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (session && !session.revokedAt) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Current user
  // -------------------------------------------------------------------------

  /** GET /me. */
  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('User no longer active');
    }
    return this.toPublicUser(user);
  }

  // -------------------------------------------------------------------------
  // Sessions (device / login history)
  // -------------------------------------------------------------------------

  /**
   * GET /auth/sessions (Task 0.7) — the CURRENT user's session history for
   * the security screen, newest activity first. Sessions are scoped by
   * user_id (never company-wide): a user only ever sees their own devices.
   */
  async listSessions(
    userId: string,
    currentSessionId: string,
    page = 1,
    pageSize = 20,
  ): Promise<PaginatedResponse<SessionEntry>> {
    const where = { userId };
    const [total, rows] = await Promise.all([
      this.prisma.session.count({ where }),
      this.prisma.session.findMany({
        where,
        orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      data: rows.map((s) => ({
        id: s.id,
        user_agent: s.userAgent,
        ip: s.ip,
        created_at: s.createdAt.toISOString(),
        last_used_at: s.lastUsedAt.toISOString(),
        revoked_at: s.revokedAt?.toISOString() ?? null,
        current: s.id === currentSessionId,
      })),
      page,
      page_size: pageSize,
      total,
    };
  }

  // -------------------------------------------------------------------------
  // 2FA (TOTP) lifecycle
  // -------------------------------------------------------------------------

  /**
   * POST /auth/2fa/setup — stores a fresh secret (pending: totp_enabled
   * stays false until /auth/2fa/confirm) and returns the otpauth URL + a QR
   * data URI for authenticator apps.
   */
  async setupTotp(
    userId: string,
  ): Promise<{ otpauth_url: string; qr_data_uri: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('User no longer active');
    }
    if (user.totpEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: secret, totpEnabled: false },
    });

    const otpauthUrl = authenticator.keyuri(user.email, TOTP_ISSUER, secret);
    const qrDataUri = await toDataURL(otpauthUrl);
    return { otpauth_url: otpauthUrl, qr_data_uri: qrDataUri };
  }

  /** POST /auth/2fa/confirm — verifies a code against the pending secret. */
  async confirmTotp(
    userId: string,
    code: string,
  ): Promise<{ totp_enabled: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('User no longer active');
    }
    if (user.totpEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }
    if (!user.totpSecret) {
      throw new BadRequestException('Run /auth/2fa/setup first');
    }
    if (!authenticator.verify({ token: code, secret: user.totpSecret })) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true },
    });
    return { totp_enabled: true };
  }

  /** POST /auth/2fa/disable — verifies a current code, then disables. */
  async disableTotp(
    userId: string,
    code: string,
  ): Promise<{ totp_enabled: false }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.deletedAt) {
      throw new UnauthorizedException('User no longer active');
    }
    if (!user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }
    if (!authenticator.verify({ token: code, secret: user.totpSecret })) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null },
    });
    return { totp_enabled: false };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private get accessSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret');
  }

  private get refreshSecret(): string {
    return this.config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret');
  }

  /**
   * TTL strings from env ("15m", "7d"). @nestjs/jwt types `expiresIn` as
   * ms.StringValue, which ConfigService can't know statically — cast.
   */
  private ttl(key: string, def: string): JwtSignOptions['expiresIn'] {
    return this.config.get<string>(key, def) as JwtSignOptions['expiresIn'];
  }

  /** SHA-256 hex — deterministic, so the session row can be matched exactly. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Creates a session row (device/login history: ip + user-agent) and signs tokens. */
  private async createSession(
    user: User,
    meta: RequestMeta,
  ): Promise<AuthTokensResponse> {
    const sessionId = randomUUID();
    const tokens = await this.signTokens(user, sessionId);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: this.hashToken(tokens.refresh_token),
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
      },
    });

    return { ...tokens, user: this.toPublicUser(user) };
  }

  private async signTokens(
    user: User,
    sessionId: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      sid: sessionId,
      companyId: user.companyId,
      role: user.role,
      scope: user.scope,
      homeBranchId: user.homeBranchId,
      type: 'access',
    };
    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      sid: sessionId,
      jti: randomUUID(),
      type: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.ttl('JWT_ACCESS_TTL', '15m'),
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        expiresIn: this.ttl('JWT_REFRESH_TTL', '7d'),
      }),
    ]);

    return { access_token: accessToken, refresh_token: refreshToken };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      role: user.role,
      scope: user.scope,
      company_id: user.companyId,
      home_branch_id: user.homeBranchId,
      totp_enabled: user.totpEnabled,
    };
  }
}
