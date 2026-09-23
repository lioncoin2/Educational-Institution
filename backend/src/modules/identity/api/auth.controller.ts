import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { unwrap } from '../../../platform/http/http-failure';
import { LoginUseCase } from '../application/login.use-case';
import { PublicRoute } from './decorators/require-permission';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly login: LoginUseCase) {}

  /** The one deliberately unauthenticated write endpoint. */
  @Post('login')
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  async authenticate(@Body() dto: LoginDto) {
    return unwrap(await this.login.execute({ email: dto.email, password: dto.password }));
  }
}
