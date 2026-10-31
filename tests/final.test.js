import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import {
  zones, buildAirUrl, parseOpenMeteo, isFreshAir, analyzeAirData, cdmxParts,
} from '../shared/air-core.js';
import { analyzeAirData as serverAnalysis } from '../api/assistant.js';
import { fixture } from './helpers.js';

test('The complete HTML has unique IDs and every static application control exists', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of app.matchAll(/\$\("([^"\n]+)"\)/g))
    assert.ok(ids.includes(id), 'Missing DOM control: ' + id);
  assert.equal(html.includes('enviarSuscripcion'), false);
  assert.equal(html.includes('onclick='), false);
  for (const [, attributes, content] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!attributes.includes('application/json') && !attributes.includes('src='))
      assert.doesNotThrow(() => new vm.Script(content));
  }
  for (const path of ['assets/app.js', 'shared/air-core.js'])
    execFileSync(process.execPath, ['--check', new URL('../' + path, import.meta.url).pathname]);
});

test('All four channels have contact and verification controls inside the alerts section', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('<section id="alertas"'), html.indexOf('<section id="reportes"'));
  for (const channel of ['telegram', 'sms', 'whatsapp', 'email']) {
    assert.ok(section.includes('id="contact-' + channel + '"'));
    assert.ok(section.includes('data-verify-send="' + channel + '"'));
    assert.ok(section.includes('data-verify-confirm="' + channel + '"'));
  }
  assert.equal((html.match(/id="alertsForm"/g) || []).length, 1);
});

test('The browser and server use the same pure analysis function', () => {
  assert.equal(serverAnalysis, analyzeAirData);
  const data = parseOpenMeteo(fixture(125));
  const general = analyzeAirData(data, 'iztapalapa', 'general');
  const athlete = analyzeAirData(data, 'iztapalapa', 'deportista');
  assert.equal(general.dominant, 'pm25');
  assert.equal(general.details.find(d => d.key === 'o3').value, 110);
  assert.notEqual(general.recommendations[0], athlete.recommendations[0]);
  assert.match(athlete.summary, /125/);
});

test('Current data and pollutant units are validated for all sixteen zones', () => {
  const data = parseOpenMeteo(fixture());
  assert.equal(data.stations.length, zones.length);
  assert.equal(isFreshAir(data), true);
  const invalid = fixture();
  invalid[4].current_units.pm2_5 = 'ppb';
  assert.throws(() => parseOpenMeteo(invalid), /Unidad inesperada/);
  const url = new URL(buildAirUrl());
  assert.equal(url.searchParams.get('latitude').split(',').length, 16);
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
});

test('Stale or missing air data cannot produce a reassuring assessment', () => {
  const now = Date.now(), data = parseOpenMeteo(fixture(125, now), now);
  data.observedAt = new Date(now - 3 * 3600000).toISOString();
  const analysis = analyzeAirData(data, 'iztapalapa', 'sensible', '', now);
  assert.equal(analysis.status, 'missing');
  assert.ok(analysis.details.every(d => d.value === null));
  assert.throws(() => parseOpenMeteo(fixture(125, now - 3 * 3600000), now), /actuales válidos/);
});

test('CDMX calendar uses the local date at the UTC day boundary', () => {
  const parts = cdmxParts(new Date('2026-10-31T04:00:00Z'));
  assert.equal(parts.day, 30);
  assert.equal(parts.hour, 22);
});
