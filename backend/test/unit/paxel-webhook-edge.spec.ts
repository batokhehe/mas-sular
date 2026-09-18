import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { lookupProviderStatus } from '../../src/modules/shipment/shipment-status.mapper';

/**
 * Paxel webhook edge hardening: the nginx source-IP allowlist, on top of the unchanged
 * application HMAC check. Paxel confirmed its push sources in writing:
 *   non-production  34.85.159.153
 *   production      34.126.76.148
 * TEMPORARY: staging and production coexist on this VPS, so its config allows BOTH.
 * When staging is retired, `allow 34.85.159.153;` is removed and this spec updated.
 */

const ROOT = join(__dirname, '../../..');
const NGINX_DIR = join(ROOT, 'ops/nginx');
const STAGING_CONF = readFileSync(join(NGINX_DIR, 'mas-sular.conf'), 'utf8');
const RUNBOOK = readFileSync(join(__dirname, '../../src/modules/shipment/paxel-webhook.RUNBOOK.md'), 'utf8');
const SERVICE = readFileSync(join(__dirname, '../../src/modules/shipment/paxel-webhook.service.ts'), 'utf8');

const PAXEL_NON_PRODUCTION_IP = '34.85.159.153';
const PAXEL_PRODUCTION_IP = '34.126.76.148';
const PAXEL_PATH = '/api/v1/shipments/webhook/paxel';

const withoutComments = (conf: string) => conf.replace(/#.*$/gm, '');

/** Body of every `<header> { ... }` block (brace-balanced), for a header regex. */
function blocks(conf: string, header: RegExp): string[] {
  const src = withoutComments(conf);
  const out: string[] = [];
  const re = new RegExp(header.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') depth -= 1;
      if (depth === 0) {
        out.push(src.slice(open + 1, i));
        break;
      }
    }
  }
  return out;
}

const serverBlocks = (conf: string) => blocks(conf, /\bserver\s*\{/);
const serverNames = (server: string) => (/\bserver_name\s+([^;]+);/.exec(server)?.[1] ?? '').trim().split(/\s+/);
const paxelLocations = (block: string) => blocks(block, /location\s*=\s*\/api\/v1\/shipments\/webhook\/paxel\s*\{/);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** nginx ngx_http_access_module: allow/deny rules in order, first match wins; none = allowed. */
function nginxAllows(block: string, ip: string): boolean {
  const rules = [...withoutComments(block).matchAll(/\b(allow|deny)\s+([^;]+);/g)].map((m) => ({ action: m[1], target: m[2].trim() }));
  for (const { action, target } of rules) {
    let matches = false;
    if (target === 'all') matches = true;
    else if (target.includes('/')) {
      const [net, bits] = target.split('/');
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      matches = (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
    } else matches = target === ip;
    if (matches) return action === 'allow';
  }
  return true;
}

describe('this VPS nginx: Paxel webhook allowlist (TEMPORARY: staging + production coexist)', () => {
  const api = serverBlocks(STAGING_CONF).filter((s) => serverNames(s).includes('staging-api.baksomassular.com') && /listen\s+443/.test(s));

  it('has exactly one exact-match Paxel location, in the staging API TLS server block only', () => {
    expect(api).toHaveLength(1);
    expect(paxelLocations(api[0])).toHaveLength(1);
    const elsewhere = serverBlocks(STAGING_CONF).filter((s) => s !== api[0]).flatMap(paxelLocations);
    expect(elsewhere).toEqual([]);
  });

  it.each([
    [PAXEL_NON_PRODUCTION_IP, true],
    [PAXEL_PRODUCTION_IP, true],
    ['127.0.0.1', false],
    ['8.8.8.8', false],
  ])('%s -> %s (first match wins)', (ip, allowed) => {
    expect(nginxAllows(paxelLocations(api[0])[0], ip)).toBe(allowed);
  });

  it('any other address is denied (neighbours of the Paxel IPs, private, Docker, this VPS)', () => {
    const location = paxelLocations(api[0])[0];
    for (const ip of ['34.85.159.152', '34.85.159.154', '34.126.76.147', '34.126.76.149', '1.2.3.4', '10.0.0.1', '172.18.0.1', '192.168.1.10', '187.53.139.88', '255.255.255.255', '0.0.0.0']) {
      expect([ip, nginxAllows(location, ip)]).toEqual([ip, false]);
    }
  });

  it('the only rules are the two exact Paxel allows followed by deny all (no CIDR, no allow all)', () => {
    const location = paxelLocations(api[0])[0];
    expect([...location.matchAll(/\b(allow|deny)\s+([^;]+);/g)].map((m) => `${m[1]} ${m[2].trim()}`)).toEqual([
      `allow ${PAXEL_NON_PRODUCTION_IP}`,
      `allow ${PAXEL_PRODUCTION_IP}`,
      'deny all',
    ]);
  });

  it('the dual allowlist is marked TEMPORARY with its cleanup step, in the config and the runbook', () => {
    expect(STAGING_CONF).toMatch(/TEMPORARY: staging and production coexist on this VPS, so BOTH are allowed\./);
    expect(STAGING_CONF).toMatch(/remove `allow 34\.85\.159\.153;` and keep only\s+#\s+`allow 34\.126\.76\.148;`/);
    expect(RUNBOOK).toContain('**TEMPORARY — staging and production coexist on this VPS.**');
    expect(RUNBOOK).toContain('**Cleanup when staging is retired:** remove `allow 34.85.159.153;` from the location and\n> keep only `allow 34.126.76.148;`');
  });

  it('proxies to the backend exactly like the API catch-all location (headers and body untouched)', () => {
    const location = paxelLocations(api[0])[0];
    const catchAll = blocks(api[0], /location\s+\/\s*\{/)[0];
    const directives = (b: string) =>
      withoutComments(b)
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter((d) => d && !/^(allow|deny) /.test(d));
    expect(directives(location)).toEqual(directives(catchAll));
    expect(location).not.toMatch(/X-Paxel-Signature|proxy_set_body|proxy_pass_request_(headers|body)\s+off/i);
  });

  it('the JNE webhook edge closure is untouched', () => {
    expect(blocks(api[0], /location\s*=\s*\/api\/v1\/shipments\/webhook\/jne\s*\{/)[0].replace(/\s+/g, ' ').trim()).toBe('return 403;');
  });
});

describe('production nginx: Paxel webhook allowlist', () => {
  const confs = readdirSync(NGINX_DIR).filter((f) => f.endsWith('.conf'));
  const productionServers = confs
    .flatMap((f) => serverBlocks(readFileSync(join(NGINX_DIR, f), 'utf8')))
    .filter((s) => serverNames(s).some((n) => n !== '_' && n.includes('baksomassular.com') && !n.startsWith('staging-')));

  it('any production server block with the Paxel route allows 34.126.76.148; 34.85.159.153 only while the TEMPORARY coexistence exception is documented', () => {
    // No production server block exists in the repository yet; this guards the future one.
    // While staging and production share this VPS the dual allowlist is the documented
    // exception; once the TEMPORARY marker is removed, production must deny 34.85.159.153.
    const temporaryCoexistence = /TEMPORARY: staging and production coexist on this VPS/.test(STAGING_CONF);
    for (const server of productionServers) {
      for (const location of paxelLocations(server)) {
        expect(nginxAllows(location, PAXEL_PRODUCTION_IP)).toBe(true);
        if (!temporaryCoexistence) expect(nginxAllows(location, PAXEL_NON_PRODUCTION_IP)).toBe(false);
        expect(nginxAllows(location, '1.2.3.4')).toBe(false);
        expect(nginxAllows(location, '8.8.8.8')).toBe(false);
      }
    }
  });

  it('the documented production snippet allows ONLY 34.126.76.148', () => {
    const section = RUNBOOK.slice(RUNBOOK.indexOf('**Production (final state)**'), RUNBOOK.indexOf('## 5.'));
    const snippet = /```nginx\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
    const location = paxelLocations(snippet)[0];
    expect(location).toBeDefined();
    expect(nginxAllows(location, PAXEL_PRODUCTION_IP)).toBe(true);
    expect(nginxAllows(location, PAXEL_NON_PRODUCTION_IP)).toBe(false);
    expect(nginxAllows(location, '1.2.3.4')).toBe(false);
    expect(location).toContain('proxy_pass $ms_upstream;');
    expect(location).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  });
});

describe('the allowlist is defense in depth: application checks unchanged', () => {
  it('the signature is still verified before the payload is parsed or any shipment is processed', () => {
    const verify = SERVICE.indexOf('verifyPaxelWebhookSignature(headers.signature, signed.airwaybillCode, signed.latestStatus, this.config.secret)');
    const refuse401 = SERVICE.indexOf("return refuse(401, 'invalid X-Paxel-Signature');");
    const parse = SERVICE.indexOf('const parsed = parsePaxelWebhook(body);');
    const processCall = SERVICE.indexOf('await this.process(payload, receivedAt)');
    expect(verify).toBeGreaterThan(0);
    expect(refuse401).toBeGreaterThan(verify);
    expect(parse).toBeGreaterThan(refuse401);
    expect(processCall).toBeGreaterThan(parse);
    expect(SERVICE).toMatch(/if \(!headers\.signature\?\.trim\(\)\) \{[\s\S]*?return refuse\(401, 'X-Paxel-Signature header is required'\);/);
    // No IP-based shortcut in the application.
    expect(SERVICE).not.toMatch(/34\.85\.159\.153|34\.126\.76\.148|remoteAddress|x-forwarded-for/i);
  });

  it.each(['FAILED3PL', 'ONHOLD3PL'])('%s stays AS-IS: unmapped (record-only) and documented as unconfirmed', (code) => {
    expect(lookupProviderStatus('paxel', code)).toBeUndefined();
    expect(RUNBOOK).toContain('**AS-IS, meaning not confirmed by Paxel:** FAILED3PL and ONHOLD3PL.');
    expect(RUNBOOK).toMatch(/\*\*Open — AS-IS\*\* for FAILED3PL and ONHOLD3PL/);
  });

  it.each(['RTP', 'COL', 'PAPV', 'POLXL', 'ODLXL', 'COD', 'PDO', 'PRJL', 'HAPH', 'ODL'])('documented %s is mapped and listed in the runbook status table', (code) => {
    expect(lookupProviderStatus('paxel', code)).toBeDefined();
    expect(RUNBOOK).toMatch(new RegExp(`\\| ${code} — \\*[^*]+\\* \\|`));
  });

  it('the runbook records the confirmed facts', () => {
    for (const fact of [
      'HTTP **200**',
      'up to 3 times',
      'Non-production **34.85.159.153**; production **34.126.76.148**',
      'Always the order/invoice number Mas Sular sent',
      '`actual_weight` = grams, `actual_price` = Rupiah',
      'Both **WIB / Asia/Jakarta**',
      '| I | Are `photo` / `signature` / `pdo_photo` / `pdo_signature` URLs? | **Closed** | Always URLs |',
      'Per **Corporate Account**, not per shipment',
      "Paxel's **Sales Team**, who enter it in **Paxel CMS Production**",
    ]) {
      expect([fact, RUNBOOK.includes(fact)]).toEqual([fact, true]);
    }
  });
});
