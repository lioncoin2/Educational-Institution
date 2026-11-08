import { loadConfig } from '../../src/platform/config/app-config';
import { environmentOf, readYaml, servicesOf, texts } from '../support/deployment-files';

/**
 * The FCM push overlays (ADR 0058), read from the committed files — a static
 * contract, never a running container:
 *
 *   - each overrides exactly one service, the API of its stack;
 *   - it names FCM and the in-container path of the credentials, and that path
 *     is exactly where the host's file is mounted — read-only;
 *   - the host path comes from the environment file and is required, so a
 *     missing setting stops compose instead of mounting nothing;
 *   - no key material, ever: the overlay holds paths only;
 *   - what it sets is a configuration the API accepts.
 */
const OVERLAYS = [
  ['infra/compose.push.yaml', 'api'],
  ['infra/compose.trial.push.yaml', 'trial-api'],
] as const;

describe.each(OVERLAYS)('the push overlay %s', (file, service) => {
  const services = servicesOf(readYaml(file), file);
  const api = services[service] ?? {};
  const environment = environmentOf(api, `services.${service}`);

  it(`overrides ${service} alone, with environment and one volume`, () => {
    expect(Object.keys(services)).toEqual([service]);
    expect(Object.keys(api).sort()).toEqual(['environment', 'volumes']);
  });

  it('mounts the host file read-only exactly where FCM_CREDENTIALS_FILE points', () => {
    expect(environment).toEqual({
      PUSH_PROVIDER: 'fcm',
      FCM_CREDENTIALS_FILE: '/run/secrets/fcm-service-account.json',
    });
    const [volume = '', ...others] = texts(api.volumes, `services.${service}.volumes`);
    expect(others).toEqual([]);
    // host:target:mode — the host side is a `${VAR:?message}` reference.
    const hostEnd = volume.indexOf('}:') + 1;
    const host = volume.slice(0, hostEnd);
    const [target, mode, ...more] = volume.slice(hostEnd + 1).split(':');
    expect(more).toEqual([]);
    expect(host).toMatch(/^\$\{FCM_SERVICE_ACCOUNT_FILE:\?[^}]+\}$/);
    expect(target).toBe(environment.FCM_CREDENTIALS_FILE);
    expect(mode).toBe('ro');
  });

  it('holds paths only — no key material', () => {
    const raw = JSON.stringify(readYaml(file));
    expect(raw).not.toMatch(/PRIVATE KEY|private_key|ya29\.|BEGIN/);
  });

  it('sets a push configuration the API accepts', () => {
    expect(
      loadConfig({
        PUSH_PROVIDER: environment.PUSH_PROVIDER ?? '',
        FCM_CREDENTIALS_FILE: environment.FCM_CREDENTIALS_FILE ?? '',
      }).push,
    ).toEqual({ provider: 'fcm', fcmCredentialsFile: '/run/secrets/fcm-service-account.json' });
  });
});
