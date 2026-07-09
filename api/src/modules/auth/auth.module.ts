import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';

/**
 * AuthModule — Task 0.2 (§11 / E18): login, JWT access+refresh with
 * rotation, argon2id passwords, TOTP 2FA, session (device/login) history.
 *
 * JwtModule is registered without a default secret: every sign/verify call
 * passes its secret explicitly (access vs refresh are SEPARATE env secrets).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, MeController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard, JwtModule],
})
export class AuthModule {}
