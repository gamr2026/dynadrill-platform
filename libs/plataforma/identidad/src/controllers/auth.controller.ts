import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  AllowPendingPasswordChange,
  AnyAuthenticated,
  AuthUser,
  CurrentUser,
  Public,
} from '@dyn/common';
import { ChangePasswordDto, LoginDto, LogoutDto, RefreshDto, SwitchRoleDto } from '../dto/auth.dto';
import { AuthService } from '../services/auth.service';
import { clientContext } from './client-context';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, clientContext(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, clientContext(req));
  }

  /** La persona elige su clave (obligatorio en el primer ingreso de una cuenta con clave provisional). */
  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(user, dto, clientContext(req));
  }

  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.auth.logout(user, dto.refreshToken);
  }

  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  /** Solo desarrollo (`DEV_ROLE_SWITCH=true`); en producción responde 403. */
  @AnyAuthenticated()
  @Post('switch-role')
  @HttpCode(HttpStatus.OK)
  switchRole(@CurrentUser() user: AuthUser, @Body() dto: SwitchRoleDto) {
    return this.auth.switchRole(user, dto);
  }

  /** Clave pública en formato JWKS, para que otros servicios validen los tokens sin copiar el PEM. */
  @Public()
  @Get('jwks')
  jwks() {
    return this.auth.jwks();
  }
}
