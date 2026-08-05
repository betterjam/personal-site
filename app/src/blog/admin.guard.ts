import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

export type AdminDecision = 'ok' | 'disabled' | 'unauthorized';

/**
 * Pure admin-access decision, kept separate from the guard for unit testing:
 * - no configured token  -> 'disabled'      (guard maps to 503)
 * - missing/wrong token  -> 'unauthorized'  (guard maps to 401)
 * - matching token       -> 'ok'
 */
export function evaluateAdminAccess(
  configuredToken: string | undefined,
  providedToken: string | undefined,
): AdminDecision {
  if (configuredToken === undefined || configuredToken === '') {
    return 'disabled';
  }
  if (typeof providedToken !== 'string' || providedToken === '') {
    return 'unauthorized';
  }
  const expected = Buffer.from(configuredToken);
  const actual = Buffer.from(providedToken);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return 'unauthorized';
  }
  return 'ok';
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = request.headers['x-admin-token'];
    const provided = Array.isArray(header) ? header[0] : header;

    switch (evaluateAdminAccess(process.env.ADMIN_TOKEN, provided)) {
      case 'disabled':
        throw new HttpException(
          { error: 'admin disabled' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      case 'unauthorized':
        throw new HttpException(
          { error: 'invalid admin token' },
          HttpStatus.UNAUTHORIZED,
        );
      case 'ok':
        return true;
    }
  }
}
