'use strict';
/**
 * Runs the nodes in Node-RED's own runtime (node-red-node-test-helper) against the fake API.
 */
const helper = require('node-red-node-test-helper');
const { GOOD_KEY } = require('./fake-api');

helper.init(require.resolve('node-red'));

const NODES = [
  require('../nodes/converter-studio-config.js'),
  require('../nodes/converter-studio-convert.js'),
  require('../nodes/converter-studio-conversion.js'),
  require('../nodes/converter-studio-account.js'),
  require('../nodes/converter-studio-formats.js'),
];

const startServer = () => new Promise((resolve) => helper.startServer(resolve));
const stopServer = () => new Promise((resolve) => helper.stopServer(resolve));

/**
 * Loads a flow: the config node `cfg` (the fake API, with `key`), the node under test `n1`
 * wired to the helper node `out`, and a catch node wired to the helper node `caught`.
 */
async function loadNode(api, type, props = {}, { key = GOOD_KEY, extra = [] } = {}) {
  const flow = [
    { id: 'cfg', type: 'converter-studio-config', name: 'test account', baseUrl: api.baseUrl },
    { id: 'n1', type, name: 'under test', server: 'cfg', wires: [['out']], ...props },
    { id: 'out', type: 'helper' },
    { id: 'catcher', type: 'catch', scope: null, uncaught: false, wires: [['caught']] },
    { id: 'caught', type: 'helper' },
    ...extra,
  ];
  await new Promise((resolve, reject) =>
    helper.load(NODES, flow, { cfg: key === null ? {} : { apiKey: key } }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  return {
    node: helper.getNode('n1'),
    out: helper.getNode('out'),
    caught: helper.getNode('caught'),
  };
}

/** The next message a helper node receives (rejects after `ms`). */
function nextMessage(node, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no message for ${node.id} within ${ms} ms`)),
      ms,
    );
    node.once('input', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

/** Sends `msg` into the node and waits for what comes out of `out` or the catch node. */
async function run(nodes, msg, ms = 5000) {
  const result = Promise.race([
    nextMessage(nodes.out, ms).then((message) => ({ message })),
    nextMessage(nodes.caught, ms).then((caught) => ({ caught })),
  ]);
  nodes.node.receive(msg);
  return await result;
}

/** Every text the nodes logged, warned or reported, joined (to look for a leaked key). */
function everythingLogged(node) {
  return ['log', 'warn', 'error', 'debug', 'trace']
    .flatMap((method) => node[method].getCalls?.() ?? [])
    .map((call) =>
      call.args
        .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg)))
        .join(' '),
    )
    .join('\n');
}

/** The status the node shows last. */
function lastStatus(node) {
  const calls = node.status.getCalls().filter((call) => call.thisValue === node);
  return calls.length ? calls[calls.length - 1].args[0] : undefined;
}

module.exports = {
  NODES,
  everythingLogged,
  helper,
  lastStatus,
  loadNode,
  nextMessage,
  run,
  startServer,
  stopServer,
};
