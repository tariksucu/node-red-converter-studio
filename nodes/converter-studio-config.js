'use strict';
const { Client, DEFAULT_BASE_URL, normalizeBaseUrl } = require('./lib/client');

/** How long the editor's list of formats is kept before it is asked for again. */
const FORMATS_TTL_MS = 10 * 60 * 1000;

module.exports = function (RED) {
  /** The account: its API key (a credential, never in the flow file) and the API's address. */
  function ConverterStudioConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  }

  RED.nodes.registerType('converter-studio-config', ConverterStudioConfigNode, {
    credentials: {
      apiKey: { type: 'password' },
    },
  });

  // The formats for the editor's "Convert to" suggestions. Asking for them needs no API key and
  // sends no file; the answer is kept for ten minutes per address.
  const cache = new Map();
  RED.httpAdmin.get(
    '/converter-studio/formats',
    RED.auth.needsPermission('converter-studio-config.read'),
    async (req, res) => {
      const server =
        typeof req.query.server === 'string' && req.query.server
          ? RED.nodes.getNode(req.query.server)
          : null;
      const base =
        (server && normalizeBaseUrl(server.baseUrl)) || normalizeBaseUrl(DEFAULT_BASE_URL);
      try {
        let entry = cache.get(base);
        if (!entry || entry.until < Date.now()) {
          const formats = await new Client({ baseUrl: base }).formats();
          entry = {
            until: Date.now() + FORMATS_TTL_MS,
            formats: formats.map(({ id, name, category, to }) => ({ id, name, category, to })),
          };
          cache.set(base, entry);
        }
        res.json({ formats: entry.formats });
      } catch {
        res.status(502).json({ formats: [] });
      }
    },
  );
};
