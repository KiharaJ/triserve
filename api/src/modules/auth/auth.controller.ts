import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import type { Request } from 'express';
import { ListQueryDto } from '../../common/dto/list-query.dto';
import { AuthService } from './auth.service';
import type {
  AuthTokensResponse,
  AuthUser,
  LoginResponse,
  PublicUser,
  SessionEntry,
} from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  LoginDto,
  RefreshDto,
  TotpCodeDto,
  VerifyMfaDto,
} from './dto/auth.dto';
import { AuthGuard } from './guards/auth.guard';

function requestMeta(req: Request): { ip?: string; userAgent?: string } {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponse> {
    return this.authService.login(dto.email, dto.password, requestMeta(req));
  }

  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
  ): Promise<AuthTokensResponse> {
    return this.authService.verifyMfa(
      dto.mfa_token,
      dto.code,
      requestMeta(req),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensResponse> {
    return this.authService.refresh(dto.refresh_token);
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.authService.logout(user.sessionId);
  }

  /**
   * GET /auth/sessions (Task 0.7) — the current user's device/login
   * history for the security screen. Own sessions only, newest use first;
   * `current` marks the session behind the presented access token.
   */
  @Get('sessions')
  @UseGuards(AuthGuard)
  sessions(
    @CurrentUser() user: AuthUser,
    @Query() query: ListQueryDto,
  ): Promise<PaginatedResponse<SessionEntry>> {
    return this.authService.listSessions(
      user.userId,
      user.sessionId,
      query.page ?? 1,
      query.page_size ?? 20,
    );
  }

  @Post('2fa/setup')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  setupTotp(
    @CurrentUser() user: AuthUser,
  ): Promise<{ otpauth_url: string; qr_data_uri: string }> {
    return this.authService.setupTotp(user.userId);
  }

  @Post('2fa/confirm')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  confirmTotp(
    @CurrentUser() user: AuthUser,
    @Body() dto: TotpCodeDto,
  ): Promise<{ totp_enabled: true }> {
    return this.authService.confirmTotp(user.userId, dto.code);
  }

  @Post('2fa/disable')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  disableTotp(
    @CurrentUser() user: AuthUser,
    @Body() dto: TotpCodeDto,
  ): Promise<{ totp_enabled: false }> {
    return this.authService.disableTotp(user.userId, dto.code);
  }
}

/** GET /api/v1/me — sits outside the /auth prefix per the API design (§7). */
@Controller()
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser): Promise<PublicUser> {
    return this.authService.me(user.userId);
  }
}
