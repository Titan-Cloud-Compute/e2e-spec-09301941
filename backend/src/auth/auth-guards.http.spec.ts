/**
 * HTTP contract spec for POST /api/auth/invite — pins the guard chain so
 * only ADMIN sessions can mint registration tokens.
 *
 * Boots a minimal TestingModule with real JwtAuthGuard + RolesGuard registered
 * as APP_GUARDs (mirrors AuthModule wiring) but a mocked AuthService so no
 * database is needed.
 *
 * Contract:
 *   POST /api/auth/invite, no cookie           → 401
 *   POST /api/auth/invite, USER cookie         → 403
 *   POST /api/auth/invite, MANAGER cookie      → 403
 *   POST /api/auth/invite, ADMIN cookie        → 201 { token: string }
 *   POST /api/auth/invite, tampered cookie     → 401
 *   POST /api/auth/login,  valid body, no auth → 200 (still public)
 */

// Set JWT_SECRET before any module is imported so JwtModule.registerAsync
// picks it up from process.env.
process.env.JWT_SECRET = 'test-secret-for-guards-spec';

import * as cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SESSION_COOKIE_NAME } from './session-cookie';
import type { SessionPayload } from './session.types';

const JWT_SECRET = 'test-secret-for-guards-spec';

async function mintCookie(
  jwtService: JwtService,
  role: SessionPayload['role'],
): Promise<string> {
  const payload: SessionPayload = {
    userId: `user-${role}`,
    role,
    firmId: 'firm-1',
  };
  return jwtService.signAsync(payload);
}

describe('AuthController — invite guard chain (HTTP)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  const mockAuthService = {
    createInvite: jest.fn().mockResolvedValue({ token: 'a'.repeat(48) }),
    login: jest.fn().mockResolvedValue({
      user: { id: 'u1', email: 'a@b.c', role: 'USER' },
      token: 'some-jwt-token',
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/auth/invite — no cookie → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/invite')
      .expect(401);
  });

  it('POST /api/auth/invite — USER cookie → 403', async () => {
    const token = await mintCookie(jwtService, 'USER');
    await request(app.getHttpServer())
      .post('/api/auth/invite')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`)
      .expect(403);
  });

  it('POST /api/auth/invite — MANAGER cookie → 403', async () => {
    const token = await mintCookie(jwtService, 'MANAGER');
    await request(app.getHttpServer())
      .post('/api/auth/invite')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`)
      .expect(403);
  });

  it('POST /api/auth/invite — ADMIN cookie → 201 with token', async () => {
    const token = await mintCookie(jwtService, 'ADMIN');
    const res = await request(app.getHttpServer())
      .post('/api/auth/invite')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`)
      .expect(201);
    expect(res.body.token).toBeDefined();
  });

  it('POST /api/auth/invite — tampered cookie → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/invite')
      .set('Cookie', `${SESSION_COOKIE_NAME}=this.is.not.a.valid.jwt`)
      .expect(401);
  });

  it('POST /api/auth/login — no auth, valid body → 200 (still public)', async () => {
    // Mock login resolves successfully; this proves the public route is unaffected.
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'password123' })
      .expect(200);
  });
});
