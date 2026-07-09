import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class VerifyMfaDto {
  @IsString()
  @IsNotEmpty()
  mfa_token!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refresh_token!: string;
}

export class TotpCodeDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
