import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Transport contract. Deliberately separate from the domain User. */
export class LoginDto {
  @IsEmail({}, { message: 'A valid email is required.' })
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(200)
  password!: string;
}
