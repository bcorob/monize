import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const settings = {
  POSTGRES_DB: 'monize_caddy_test',
  POSTGRES_USER: 'monize_test',
  POSTGRES_PASSWORD: 'test-only-not-a-real-password',
  JWT_SECRET: 'test-only-jwt-secret-not-for-deployment',
  ENCRYPTION_KEY: 'test-only-encryption-key-not-for-deployment',
  MSN_API_KEY: '',
  PUBLIC_APP_URL: 'http://localhost:3101',
  CORS_ORIGIN: 'http://localhost:3101',
  DISABLE_HTTPS_HEADERS: 'true',
  FRONTEND_PORT: '3101',
  BACKEND_PORT: '3100',
  CADDY_DOMAIN: 'money.example.com',
  CADDY_ROUTE53_HOSTED_ZONE_ID: 'ZEXAMPLE',
  CADDY_AWS_ACCESS_KEY_ID: 'test-only-access-key',
  CADDY_AWS_SECRET_ACCESS_KEY: 'test-only-secret-key',
  CADDY_AWS_SESSION_TOKEN: '',
  CADDY_AWS_REGION: 'us-east-1',
};
let directory;
let envFile;

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'monize-caddy-test-'));
  envFile = join(directory, 'test.env');
  writeFileSync(
    envFile,
    Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'),
  );
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function config(withCaddy, overrides = {}) {
  const files = ['-f', join(root, 'docker-compose.prod.yml')];
  if (withCaddy) files.push('-f', join(root, 'docker-compose.caddy.yml'));
  return JSON.parse(execFileSync('docker', [
    'compose', '--env-file', envFile, ...files, 'config', '--format', 'json',
  ], {
    cwd: root,
    env: { ...process.env, ...settings, ...overrides },
    encoding: 'utf8',
  }));
}

test('the production stack keeps its direct frontend port without Caddy', () => {
  const { services } = config(false);
  assert.equal(services.caddy, undefined);
  assert.equal(services.frontend.ports.length, 1);
  assert.equal(services.frontend.ports[0].published, '3101');
});

test('Caddy is the only published entry point and preserves certificate storage', () => {
  const { services } = config(true);
  assert.equal(services.frontend.ports?.length ?? 0, 0);
  assert.equal(services.backend.ports?.length ?? 0, 0);
  assert.deepEqual(
    services.caddy.ports.map(({ published, target, protocol }) => [published, target, protocol]),
    [['80', 80, 'tcp'], ['443', 443, 'tcp'], ['443', 443, 'udp']],
  );
  assert.equal(services.caddy.environment.FRONTEND_PORT, '3101');
  for (const target of ['/data', '/config']) {
    assert.ok(services.caddy.volumes.some((volume) =>
      volume.type === 'volume' && volume.target === target));
  }
  assert.ok(services.caddy.volumes.some((volume) =>
    volume.target === '/etc/caddy/Caddyfile' && volume.read_only));
  assert.equal(services.caddy.depends_on.frontend.condition, 'service_healthy');
});

test('the overlay enables the HTTPS origin and confines DNS credentials to Caddy', () => {
  const { services } = config(true);
  for (const name of ['frontend', 'backend']) {
    const env = services[name].environment;
    assert.equal(env.PUBLIC_APP_URL, 'https://money.example.com');
    assert.equal(env.DISABLE_HTTPS_HEADERS, 'false');
    assert.ok(!Object.keys(env).some((key) => /AWS.*KEY|AWS_SESSION_TOKEN/.test(key)));
  }
  assert.equal(services.backend.environment.CORS_ORIGIN, 'https://money.example.com');
  assert.equal(services.frontend.environment.TRUSTED_PROXY_HOPS, '1');
  assert.equal(services.frontend.environment.CLIENT_IP_HEADER, '');
  assert.equal(services.frontend.environment.INTERNAL_API_URL, 'http://backend:3100');
  assert.equal(services.caddy.environment.AWS_ACCESS_KEY_ID, settings.CADDY_AWS_ACCESS_KEY_ID);
  assert.equal(services.caddy.environment.AWS_SECRET_ACCESS_KEY, settings.CADDY_AWS_SECRET_ACCESS_KEY);
});

test('the overlay refuses missing hostname, public zone, or AWS credentials', () => {
  for (const key of [
    'CADDY_DOMAIN',
    'CADDY_ROUTE53_HOSTED_ZONE_ID',
    'CADDY_AWS_ACCESS_KEY_ID',
    'CADDY_AWS_SECRET_ACCESS_KEY',
  ]) {
    assert.throws(() => config(true, { [key]: '' }), /required variable/);
  }
});
