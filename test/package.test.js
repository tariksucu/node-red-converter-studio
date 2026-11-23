'use strict';
/**
 * The package as Node-RED and its Flow Library read it: package.json, each node's .js and .html
 * pair, the editor scripts, the help, the icon and the example flows.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const nodes = Object.entries(pkg['node-red'].nodes);

/** The core nodes the examples may use (no other packages to install). */
const CORE = new Set([
  'comment',
  'inject',
  'file in',
  'file',
  'debug',
  'catch',
  'change',
  'switch',
  'http in',
  'http response',
]);

const examplesDir = path.join(ROOT, 'examples');
const examples = fs
  .readdirSync(examplesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({
    name,
    flow: JSON.parse(fs.readFileSync(path.join(examplesDir, name), 'utf8')),
  }));

describe('package', () => {
  it('has what the Flow Library and its scorecard check', () => {
    assert.match(pkg.name, /^@converterstudio\/node-red-/);
    assert.ok(pkg.keywords.includes('node-red'));
    assert.equal(pkg.license, 'MIT');
    assert.match(pkg.repository.url, /github\.com\/tariksucu\/node-red-converter-studio\.git$/);
    assert.ok(pkg.bugs.url);
    assert.equal(pkg['node-red'].version, '>=4.0.0');
    assert.equal(pkg.engines.node, '>=22');
    assert.equal(pkg.publishConfig.access, 'public');
    assert.deepEqual(pkg.dependencies ?? {}, {}, 'no runtime dependencies');
    assert.ok(fs.existsSync(path.join(ROOT, 'README.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')));
    assert.ok(pkg.files.includes('nodes') && pkg.files.includes('examples'));
  });

  for (const [type, file] of nodes) {
    it(`${type}: a .js and .html pair that registers the type the way the library reads it`, () => {
      const js = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(js.includes(`RED.nodes.registerType('${type}'`), 'the runtime registers it');
      const html = fs.readFileSync(path.join(ROOT, file.replace(/\.js$/, '.html')), 'utf8');

      // The library and node-red-dev take the scripts with type="text/javascript" and need the
      // type, category, color, icon, inputs and outputs as plain values.
      const scripts = [
        ...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g),
      ].map((m) => m[1]);
      assert.equal(scripts.length, 1);
      assert.doesNotThrow(() => new vm.Script(scripts[0]), 'the editor script parses');
      assert.ok(scripts[0].includes(`RED.nodes.registerType('${type}', {`));
      if (type !== 'converter-studio-config') {
        assert.match(scripts[0], /category: 'Converter Studio',/);
        assert.match(scripts[0], /color: '#[0-9A-F]{6}',/);
        assert.match(scripts[0], /inputs: 1,\n\s+outputs: 1,/);
        const icon = /icon: '([^']+)'/.exec(scripts[0])?.[1];
        assert.ok(
          icon && fs.existsSync(path.join(ROOT, 'nodes/icons', icon)),
          `the icon ${icon} is there`,
        );
      } else {
        assert.match(scripts[0], /category: 'config',/);
        assert.match(scripts[0], /credentials: \{\s+apiKey: \{ type: 'password' \},\s+\},/);
      }

      assert.ok(
        html.includes(`<script type="text/html" data-template-name="${type}">`),
        'an edit dialog',
      );
      const help = new RegExp(
        `<script type="text/markdown" data-help-name="${type}">\\n([\\s\\S]*?)</script>`,
      ).exec(html);
      assert.ok(help, 'help text');
      for (const line of help[1].split('\n')) {
        assert.ok(!/^\s+\S/.test(line), `markdown help without leading spaces: "${line}"`);
      }
      assert.ok(help[1].includes('https://converter.studio'), 'the help links to Converter Studio');
    });
  }

  it('has example flows that use every node and only core nodes besides', () => {
    const ours = new Set(nodes.map(([type]) => type));
    const used = new Set();
    for (const { name, flow } of examples) {
      const ids = new Set(flow.map((node) => node.id));
      assert.equal(ids.size, flow.length, `${name}: unique IDs`);
      for (const node of flow) {
        assert.ok(
          ours.has(node.type) || CORE.has(node.type),
          `${name}: ${node.type} is ours or core`,
        );
        used.add(node.type);
        for (const wire of (node.wires ?? []).flat())
          assert.ok(ids.has(wire), `${name}: wire to ${wire}`);
        if (node.server) assert.ok(ids.has(node.server), `${name}: the config node is in the flow`);
        assert.equal(node.credentials, undefined, `${name}: no credentials`);
      }
      assert.ok(
        flow.some((node) => node.type === 'comment'),
        `${name}: a comment says what it does`,
      );
    }
    for (const type of ours) assert.ok(used.has(type), `an example uses ${type}`);
  });

  it('ships only the nodes, the examples and the documents', () => {
    const icon = fs.readFileSync(path.join(ROOT, 'nodes/icons/converter-studio.svg'), 'utf8');
    assert.match(icon, /viewBox="0 0 40 60"/, 'a 2:3 icon');
    assert.ok(!/fill="#(?!fff)/i.test(icon), 'white on transparent');
  });
});
