'use strict';
/**
 * The Converter Studio REST API (https://converter.studio/developers) for the nodes of this
 * package. No dependencies: Node's own fetch. The API key goes only to the API's own address;
 * upload and download links carry their own tokens and get no key.
 */
const fsp = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { version } = require('../../package.json');

const DEFAULT_BASE_URL = 'https://converter.studio/api';
/** Names this package, with its version, on every request (Converter Studio's statistics). */
const CLIENT_HEADER = 'X-Converter-Studio-Client';
const CLIENT_NAME = `node-red/${version}`;

/** How many times a request is sent again after a rate limit, a busy server or a lost connection. */
const MAX_RETRIES = 3;
/** The longest pause before a request is sent again. */
const MAX_RETRY_WAIT_MS = 60_000;
/** One request carries at most this much when the API does not say (its CDN stops at 100 MB). */
const DEFAULT_PART_BYTES = 95 * 1024 * 1024;
/** The longest file name the API takes. */
const MAX_NAME_LENGTH = 255;
/** The longest a single status request waits on the server (the API allows 60 seconds). */
const LONG_POLL_SECONDS = 50;

/** Statuses a conversion stays in until someone acts (or never leaves). */
const SETTLED = new Set(['done', 'failed', 'expired', 'canceled', 'quoted']);
/** Statuses that end a conversion without a result. */
const ENDED_WITHOUT_RESULT = new Set(['failed', 'expired', 'canceled']);
/** Conversion IDs are also upload IDs: 8 to 64 letters, digits, `-` and `_`. */
const CONVERSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * What to do next in Node-RED, for the API's error codes: added to the API's own message, only
 * where that message does not say it already.
 */
const HINTS = {
  invalidApiKey:
    'Check the API key in the Converter Studio config node: keys start with cvs_live_ and are made on https://converter.studio/account#api-keys.',
  notEnoughCredits: 'Plans and credit packs: https://converter.studio/pricing.',
  dailyLimit: 'Plans with more credits: https://converter.studio/pricing.',
  monthlyLimit: 'Credit packs and larger plans: https://converter.studio/pricing.',
  fileTooLarge: 'Plans with larger limits: https://converter.studio/pricing.',
  durationTooLong: 'Plans with longer limits: https://converter.studio/pricing.',
  unsupportedConversion: 'The formats node lists what each format converts to.',
  tooManyRequests:
    'Converter Studio takes up to 60 requests a minute for each API key; a delay node set to rate limit spaces the messages out.',
  notFound: 'Conversions are kept for 6 hours, and only the account that started one can see it.',
  fileExpired: 'Results are kept for 6 hours.',
  remoteFailed: 'Or read the file in Node-RED and send it as a Buffer.',
  invalidRequest:
    "Check the conversion options: one may have a name or value that Converter Studio doesn't know.",
  passwordNeeded: 'In Node-RED, that is "password" in the conversion options.',
  wrongPassword: 'In Node-RED, that is "password" in the conversion options.',
  noPages: 'In Node-RED, the pages are "pageRange" in the conversion options.',
  noText: 'In Node-RED, that is "ocr": true in the conversion options.',
  sizeTooSmall: 'In Node-RED, the size is "maxSize" in the conversion options.',
  invalidCallbackUrl:
    "Converter Studio doesn't call local or private addresses: the Node-RED that receives it must be reachable from the internet.",
};

/** Messages for the codes the website's own routes send without one (the download link). */
const FALLBACK_MESSAGES = {
  fileExpired: 'The converted file has already been deleted.',
  notFound: "That conversion wasn't found.",
  tooManyRequests: 'Too many requests at once.',
  serverBusy: 'The servers are busy right now. Try again in a few minutes.',
  invalidRequest: "The request wasn't accepted.",
  fileTooLarge: 'The file is larger than the limit of the plan.',
};

/**
 * An error of this package. `code` is the API's error code (`notEnoughCredits`,
 * `unsupportedConversion`…) or one of this package's own (`timeout`, `quoted`, `noInput`…);
 * Node-RED copies it to `msg.error.code` for a catch node. `conversion` is the conversion it
 * belongs to, when there is one.
 */
class ConverterStudioError extends Error {
  constructor(message, { code, status, params, conversion, hint } = {}) {
    super(hint ? `${message} ${hint}` : message);
    this.name = 'Converter Studio';
    if (code) this.code = code;
    if (status) this.status = status;
    if (params) this.params = params;
    if (conversion) this.conversion = conversion;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The API's base address: no trailing slash and no `/v1`; `undefined` if it is no web address. */
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_BASE_URL;
  const base = raw.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return /^https?:\/\/[^/\s?#]+/i.test(base) ? base : undefined;
}

/** The API's error code, message and parameters from an error body. */
function errorOf(body) {
  if (!isObject(body)) return {};
  const error = body.error;
  if (typeof error === 'string') return { code: error };
  if (!isObject(error)) return {};
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    params: isObject(error.params) ? error.params : undefined,
  };
}

/** An error for an answer of the API that is not a success, with the API's own message. */
function apiError(status, body) {
  const { code, message, params } = errorOf(body);
  const text =
    message ??
    (code ? FALLBACK_MESSAGES[code] : undefined) ??
    `The API answered with HTTP status ${status}.`;
  return new ConverterStudioError(sentence(text), {
    code: code ?? `http${status}`,
    status,
    params,
    hint: code ? HINTS[code] : undefined,
  });
}

/** How long to pause before sending a request again: `Retry-After`, the limit's reset, or a back-off. */
function retryDelay(headers, attempt) {
  const backoff = Math.min(MAX_RETRY_WAIT_MS, 2000 * 2 ** attempt);
  if (!headers) return backoff;
  const retryAfter = headers.get('retry-after');
  const reset = headers.get('x-ratelimit-reset');
  let ms;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  } else if (reset !== null && Number.isFinite(Number(reset))) {
    ms = Number(reset) * 1000;
  }
  if (ms === undefined || !Number.isFinite(ms)) return backoff;
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(1000, ms));
}

/** A file name the API takes: at most 255 characters, keeping its extension. */
function uploadName(name) {
  const trimmed = String(name ?? '').trim() || 'file';
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const extension = dot > 0 && trimmed.length - dot <= 16 ? trimmed.slice(dot) : '';
  return trimmed.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

/** The file name a `Content-Disposition` header gives, if any. */
function dispositionName(value) {
  if (!value) return undefined;
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall back to the plain name.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(value);
  return plain ? plain[1].trim() : undefined;
}

/** Options whose values the API takes as numbers written as text (`"height": "720"`). */
const TEXT_NUMBER_OPTIONS = new Set([
  'height',
  'frameRate',
  'bitrate',
  'sampleRate',
  'bitDepth',
  'width',
  'longSide',
  'scale',
  'rotate',
  'iconSize',
  'svgScale',
  'gifWidth',
  'fps',
  'dpi',
  'handoutSlides',
  'jsonIndent',
]);

/** The conversion options as the API takes them: `{"height": 720}` works as well as `"720"`. */
function apiOptions(options) {
  const out = { ...options };
  for (const [name, value] of Object.entries(out)) {
    if (TEXT_NUMBER_OPTIONS.has(name) && typeof value === 'number') out[name] = String(value);
  }
  return out;
}

/** A conversion ID from a string, or from an object that has one (`msg.conversion`). */
function conversionIdOf(value) {
  const raw = isObject(value) ? value.id : value;
  const id = typeof raw === 'string' ? raw.trim() : '';
  return CONVERSION_ID.test(id) ? id : undefined;
}

/** Statuses after which a request is sent again: the rate limit and a busy server always. */
const RETRY_ALWAYS = new Set([429, 503]);
/** Statuses after which only a request that changes nothing twice is sent again. */
const RETRY_IDEMPOTENT = new Set([500, 502, 504]);

/** How long one request of an upload may take: two minutes, plus two seconds a megabyte. */
const transferTimeout = (bytes) => 120_000 + Math.ceil((bytes || 0) / 1_000_000) * 2000;

async function readBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads `length` bytes at `offset` of an open file (fewer at its end). */
async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * One account's way into the API. `signal` stops every request and wait of this client (the node
 * closing); a request that was stopped throws an error with the code `stopped`.
 */
class Client {
  constructor({ apiKey, baseUrl, signal } = {}) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) {
      throw new ConverterStudioError("The base URL in the config node isn't a web address.", {
        code: 'invalidBaseUrl',
        hint: `Use ${DEFAULT_BASE_URL}, or leave it empty.`,
      });
    }
    this.baseUrl = base;
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.signal = signal;
  }

  stopped(conversion) {
    return new ConverterStudioError(
      conversion
        ? `The node was stopped while it waited. The conversion goes on at Converter Studio (ID ${conversion.id}): get it later with a conversion node.`
        : 'The node was stopped before the conversion started.',
      { code: 'stopped', conversion },
    );
  }

  /**
   * One HTTP request with retries: rate limits (429) and a busy server (503) are waited out; a
   * lost connection and 500, 502, 504 only for a request that changes nothing twice.
   */
  async send(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000, idempotent = false }) {
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw this.stopped();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: { [CLIENT_HEADER]: CLIENT_NAME, ...headers },
          body,
          signal,
          redirect: 'follow',
        });
      } catch (error) {
        if (this.signal?.aborted) throw this.stopped();
        if (idempotent && attempt < MAX_RETRIES) {
          await this.pause(retryDelay(undefined, attempt));
          continue;
        }
        const reason = timeout.aborted
          ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
          : (error.cause?.code ?? error.message);
        throw new ConverterStudioError(`Couldn't reach ${new URL(url).host} (${reason}).`, {
          code: timeout.aborted ? 'requestTimeout' : 'network',
          hint: 'Check the network of this Node-RED and the base URL in the config node.',
        });
      }
      const status = response.status;
      if (status >= 200 && status < 300) return response;
      const again = RETRY_ALWAYS.has(status) || (idempotent && RETRY_IDEMPOTENT.has(status));
      if (again && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await this.pause(retryDelay(response.headers, attempt));
        continue;
      }
      throw apiError(status, await readBody(response));
    }
  }

  async pause(ms) {
    try {
      await sleep(ms, undefined, this.signal ? { signal: this.signal } : undefined);
    } catch {
      throw this.stopped();
    }
  }

  /** A JSON call of the REST API (`/v1…`) with the account's API key. */
  async api(method, path, { body, query, headers, timeoutMs, idempotent, auth = true } = {}) {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(name, String(value));
      }
    }
    const all = { Accept: 'application/json', ...headers };
    if (auth) {
      if (!this.apiKey) {
        throw new ConverterStudioError('The config node has no API key.', {
          code: 'invalidApiKey',
          hint: HINTS.invalidApiKey,
        });
      }
      all.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) all['Content-Type'] = 'application/json';
    const response = await this.send(url, {
      method,
      headers: all,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      idempotent,
    });
    return await readBody(response);
  }

  /** The plan, the credits left and the limits of the account (`GET /v1/account`). */
  async account() {
    return await this.api('GET', '/account', { idempotent: true });
  }

  /** The formats and what each converts to, or only `from` (`GET /v1/formats`; needs no key). */
  async formats(from) {
    const answer = await this.api('GET', '/formats', {
      query: { from },
      idempotent: true,
      auth: false,
    });
    return Array.isArray(answer?.formats) ? answer.formats : [];
  }

  async conversion(id, waitSeconds = 0) {
    return await this.api('GET', `/conversions/${encodeURIComponent(id)}`, {
      query: waitSeconds > 0 ? { wait: waitSeconds } : undefined,
      timeoutMs: (waitSeconds + 30) * 1000,
      idempotent: true,
    });
  }

  async confirm(id) {
    return await this.api('POST', `/conversions/${encodeURIComponent(id)}/confirm`, {
      idempotent: true,
    });
  }

  /**
   * Starts a conversion. With the Idempotency-Key, sending it again after a lost answer gets
   * the same conversion, charged once.
   */
  async createConversion(body, idempotencyKey) {
    return await this.api('POST', '/conversions', {
      body,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      idempotent: Boolean(idempotencyKey),
    });
  }

  /** Sends one request of an upload to its upload URL (which carries its own token). */
  async putPart(uploadUrl, bytes, offset) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (offset !== null) headers['Upload-Offset'] = String(offset);
    try {
      const response = await this.send(uploadUrl, {
        method: 'PUT',
        headers,
        body: bytes,
        timeoutMs: transferTimeout(bytes.length),
        // The API overwrites what arrived of a part that is sent again.
        idempotent: true,
      });
      return await readBody(response);
    } catch (error) {
      const received = Number(error.params?.received);
      if (
        error.status === 409 &&
        offset !== null &&
        Number.isSafeInteger(received) &&
        received >= 0
      ) {
        return { status: 'gap', received };
      }
      throw error;
    }
  }

  /**
   * Uploads a file from memory (`buffer`) or from disk (`path`): an upload slot first (the API
   * checks the plan's size limit before anything is sent), then the bytes in one request, or in
   * parts with `Upload-Offset` for a file larger than one request takes.
   */
  async uploadFile({ fileName, buffer, path }) {
    let handle;
    let size;
    if (buffer) {
      size = buffer.length;
    } else {
      try {
        handle = await fsp.open(path, 'r');
        size = (await handle.stat()).size;
      } catch (error) {
        await handle?.close();
        throw new ConverterStudioError(
          `Couldn't read the file ${path} (${error.code ?? error.message}).`,
          {
            code: 'fileNotReadable',
          },
        );
      }
    }
    try {
      if (!size) {
        throw new ConverterStudioError('The input file is empty.', { code: 'emptyFile' });
      }
      const slot = await this.api('POST', '/uploads', {
        body: { fileName: uploadName(fileName), size },
      });
      const partBytes = slot.partBytes > 0 ? slot.partBytes : DEFAULT_PART_BYTES;
      const read = (offset, length) =>
        buffer ? buffer.subarray(offset, offset + length) : readAt(handle, offset, length);
      const incomplete = () =>
        new ConverterStudioError('The upload of the file did not finish.', {
          code: 'uploadIncomplete',
          hint: 'Converter Studio received a different number of bytes than the file has. Try again.',
        });

      let receipt;
      if (size <= partBytes) {
        receipt = await this.putPart(slot.uploadUrl, await read(0, size), null);
      } else {
        let offset = 0;
        let resumes = 0;
        while (offset < size) {
          const part = await read(offset, Math.min(partBytes, size - offset));
          if (part.length === 0) throw incomplete();
          receipt = await this.putPart(slot.uploadUrl, part, offset);
          if (receipt?.status === 'ready') break;
          if (receipt?.status === 'gap') {
            // The API has less than was sent: go on from there, a few times at most.
            if (++resumes > MAX_RETRIES || receipt.received >= offset + part.length) {
              throw incomplete();
            }
          } else if (receipt?.received !== offset + part.length) {
            throw incomplete();
          }
          offset = receipt.received;
        }
      }
      if (receipt?.status !== 'ready' || !isObject(receipt.file)) throw incomplete();
      return {
        id: slot.id,
        name: receipt.file.name,
        size: receipt.file.size,
        format: receipt.file.format ?? null,
      };
    } finally {
      await handle?.close();
    }
  }

  /**
   * Waits until a conversion is done, failed, expired, canceled or quoted. Each status request
   * waits on the server until something changes (up to 50 seconds), so a finished conversion is
   * seen at once; `intervalMs` only spaces out the requests.
   */
  async waitFor(start, { timeoutMs = 600_000, intervalMs = 2000, onUpdate } = {}) {
    const deadline = Date.now() + timeoutMs;
    let view = start;
    while (!SETTLED.has(view.status)) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new ConverterStudioError(
          `The conversion wasn't finished after ${Math.round(timeoutMs / 1000)} seconds. It goes on at Converter Studio (status ${view.status}, ID ${view.id}): get it later with a conversion node, or raise the node's timeout.`,
          { code: 'timeout', conversion: view },
        );
      }
      const asked = Date.now();
      try {
        view = await this.conversion(
          view.id,
          Math.max(1, Math.min(LONG_POLL_SECONDS, Math.floor(left / 1000))),
        );
      } catch (error) {
        if (error.code === 'stopped') throw this.stopped(view);
        if (!error.conversion) error.conversion = view;
        throw error;
      }
      if (SETTLED.has(view.status)) break;
      onUpdate?.(view);
      const pause = Math.min(intervalMs - (Date.now() - asked), deadline - Date.now());
      if (pause > 0) {
        try {
          await this.pause(pause);
        } catch {
          throw this.stopped(view);
        }
      }
    }
    return view;
  }

  /** Downloads a finished conversion's result into memory. The link needs no API key. */
  async download(view) {
    if (view.status !== 'done' || !view.downloadUrl) {
      throw new ConverterStudioError(
        `The conversion has no result to download yet (status ${view.status}).`,
        { code: 'notDone', conversion: view },
      );
    }
    let response;
    try {
      response = await this.send(view.downloadUrl, {
        timeoutMs: transferTimeout(view.outputSize),
        idempotent: true,
      });
    } catch (error) {
      if (error.code === 'stopped') throw this.stopped(view);
      if (!error.conversion) error.conversion = view;
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0].trim() || undefined;
    const fileName =
      view.outputName ??
      dispositionName(response.headers.get('content-disposition') ?? undefined) ??
      `converted.${view.to ?? 'bin'}`;
    return { buffer, contentType, fileName };
  }
}

/** An error for a conversion that ended without a result, with the API's reason. */
function conversionFailed(view) {
  const fallback = {
    failed: 'The conversion did not succeed.',
    expired: 'The result of the conversion was deleted after its time ran out.',
    canceled: 'The conversion was canceled.',
  };
  const message =
    view.error?.message ?? fallback[view.status] ?? view.next ?? 'The conversion ended.';
  const code = view.error?.code ?? view.status;
  return new ConverterStudioError(sentence(message), {
    code,
    conversion: view,
    hint: view.error
      ? HINTS[view.error.code]
      : view.status === 'failed'
        ? 'No credits were charged for it.'
        : undefined,
  });
}

/** An error for a conversion that costs more than it may cost on its own. */
function conversionQuoted(view) {
  const price = view.credits === 1 ? '1 credit' : `${view.credits ?? 'more'} credits`;
  return new ConverterStudioError(
    `The conversion costs ${price}, more than the node's max credits (${view.maxCredits ?? 0}).`,
    {
      code: 'quoted',
      conversion: view,
      hint: `Raise max credits, or set "Above max" to "Send the quote" and start it with a conversion node set to Confirm (ID ${view.id}).`,
    },
  );
}

/** The fields most flows need, for `msg.conversion`. */
function summary(view) {
  return {
    id: view.id,
    status: view.status,
    from: view.from ?? null,
    to: view.to ?? null,
    inputName: view.inputName ?? null,
    credits: view.credits ?? null,
    maxCredits: view.maxCredits ?? null,
    progress: view.progress ?? null,
    outputName: view.outputName ?? null,
    outputSize: view.outputSize ?? null,
    downloadUrl: view.downloadUrl ?? null,
    expiresAt: view.expiresAt ?? null,
    error: view.error ?? null,
    next: view.next ?? null,
  };
}

module.exports = {
  TEXT_NUMBER_OPTIONS,
  CLIENT_HEADER,
  CLIENT_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_PART_BYTES,
  ENDED_WITHOUT_RESULT,
  SETTLED,
  Client,
  ConverterStudioError,
  apiError,
  apiOptions,
  conversionFailed,
  conversionIdOf,
  conversionQuoted,
  dispositionName,
  errorOf,
  normalizeBaseUrl,
  retryDelay,
  summary,
  uploadName,
};
