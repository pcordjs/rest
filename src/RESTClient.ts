import * as https from 'node:https';
import * as stream from 'node:stream';
import * as timers from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { createGunzip, createInflate } from 'node:zlib';
import RESTError, { DiscordAPIError, RESTErrorCode } from './RESTError';
// FIXME(@doinkythederp): eslint rule false positive
// eslint-disable-next-line no-restricted-imports
import { captureStack } from './util';

// eslint-disable-next-line
const packageInfo = require('../package.json') as { version: string };

export const BASE_USER_AGENT = `DiscordBot (https://github.com/pcordjs/rest, ${packageInfo.version})`;

export enum TokenType {
  BOT,
  BEARER
}

const httpsAgent = new https.Agent({ keepAlive: true });

export default class RESTClient {
  public constructor(private readonly options: RESTClientOptions) {
    if (
      !RESTClient.hasEmittedInvalidAPIVersionWarning &&
      options.apiVersion !== undefined &&
      (!Number.isInteger(options.apiVersion) || options.apiVersion < 0)
    ) {
      RESTClient.hasEmittedInvalidAPIVersionWarning = true;
      process.emitWarning(
        new RESTError(RESTErrorCode.INVALID_API_VERSION).message,
        {
          code: RESTErrorCode[RESTErrorCode.INVALID_API_VERSION],
          ctor: RESTClient,
          detail: `Expected a positive integer, got ${options.apiVersion}.`,
          type: 'RESTWarning'
        }
      );
    }
  }

  private static hasEmittedInvalidAPIVersionWarning = false;

  public get userAgent(): string {
    const parts = [BASE_USER_AGENT];

    if (this.options.userAgentSuffix) parts.push(this.options.userAgentSuffix);

    return parts.join(', ');
  }

  public get auth(): string {
    if (!this.options.token) throw new RESTError(RESTErrorCode.TOKEN_REQUIRED);
    return `${this.options.tokenType === TokenType.BEARER ? 'Bearer' : 'Bot'} ${
      this.options.token
    }`;
  }

  private block: Promise<void> | null = null;

  private readonly buckets = new Map<string, RateLimitBucket>();

  // global bucket
  private readonly queue: RequestFinalizer[] = [];
  private flushing = false;

  private async flushBucket(bucket: RateLimitBucket) {
    if (bucket.flushing) return;
    bucket.flushing = true;
    try {
      let finalizeRequest: RequestFinalizer | null = null;
      while ((finalizeRequest = bucket.queue.shift() ?? null)) {
        /* eslint-disable no-await-in-loop */
        await this.block;

        if (bucket.remaining === 0)
          await timers.setTimeout(bucket.reset.getTime() - Date.now());

        await finalizeRequest();
        /* eslint-enable no-await-in-loop */
      }
    } finally {
      bucket.flushing = false;
    }
  }

  private async flushGlobalBucket() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      let finalizeRequest: RequestFinalizer | null = null;
      while ((finalizeRequest = this.queue.shift() ?? null)) {
        /* eslint-disable no-await-in-loop */
        await this.block;

        await finalizeRequest();
        /* eslint-enable no-await-in-loop */
      }
    } finally {
      this.flushing = false;
    }
  }

  public request<ResponseType = Buffer>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ) {
    const stack = captureStack();
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip,deflate',
      ...options.headers
    };

    if (options.auth) headers.Authorization = this.auth;
    if (typeof options.body === 'object' && !(options.body instanceof Buffer))
      headers['Content-Type'] = 'application/json';

    let finalPath = `/api/v${this.options.apiVersion ?? '9'}${path}`;
    if (options.queryString) finalPath += `?${options.queryString.toString()}`;

    const finalBody =
      typeof options.body === 'object' && !(options.body instanceof Buffer)
        ? Buffer.from(JSON.stringify(options.body))
        : options.body;

    const bucketId = RESTClient.getRateLimitBucket(path);

    return new Promise<ResponseType>((resolve, reject) => {
      const finalize: RequestFinalizer = () =>
        new Promise<void>(
          (onResponse) =>
            void (
              this.finalizeRequest({
                headers,
                method,
                path: finalPath,
                host: this.options.host ?? 'discord.com',
                agent: this.options.agent ?? httpsAgent,
                body:
                  finalBody !== undefined ? Buffer.from(finalBody) : undefined,
                timeout: options.timeout ?? this.options.timeout ?? Infinity,
                bucketId,
                onResponse,
                stack,
                port: this.options.port
              }) as Promise<ResponseType>
            ).then(resolve, reject)
        );

      let bucket = bucketId ? this.buckets.get(bucketId) : null;

      if (bucketId && !bucket) {
        bucket = {
          remaining: Infinity,
          reset: new Date(),
          queue: [],
          flushing: false
        };
        this.buckets.set(bucketId, bucket);
      }

      if (bucket) {
        bucket.queue.push(finalize);
        this.flushBucket(bucket).catch(reject);
      } else {
        this.queue.push(finalize);
        this.flushGlobalBucket().catch(reject);
      }
    });
  }

  /** Sends a request, ignoring any ratelimits. */
  private finalizeRequest(init: {
    headers: Record<string, string>;
    method: string;
    path: string;
    host: string;
    agent: https.Agent;
    body?: Buffer;
    timeout: number;
    bucketId: string | null;
    onResponse: () => void;
    stack: string;
    port?: number;
  }) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const startTime = Date.now();
      const timeout =
        init.timeout === Infinity
          ? null
          : setTimeout(() => {
              cancelled = true;
              reject(
                new RESTError(RESTErrorCode.TIMEOUT, init.path, init.timeout)
              );
            }, init.timeout).unref();

      const request = https.request({
        agent: init.agent,
        host: init.host,
        path: init.path,
        headers: init.headers,
        method: init.method,
        port: init.port
      });

      request.once('error', (err) => {
        request.destroy();
        reject(
          Object.assign(err, {
            request
          })
        );
      });

      request.once('response', (response) => {
        const handleError = (err: Error) => {
          request.emit(
            'error',
            Object.assign(err, {
              response
            })
          );
        };

        const rateLimitReset = response.headers['x-ratelimit-reset']
          ? new Date(
              parseFloat(response.headers['x-ratelimit-reset'] as string) * 1000
            )
          : response.headers['retry-after']
          ? new Date(
              parseInt(response.headers['retry-after'], 10) * 1000 + Date.now()
            )
          : null;

        if (
          response.headers['x-ratelimit-remaining'] &&
          init.bucketId &&
          rateLimitReset
        ) {
          let bucket = this.buckets.get(init.bucketId);
          const remaining = parseInt(
            response.headers['x-ratelimit-remaining'] as string,
            10
          );

          if (!bucket) {
            bucket = {
              remaining,
              reset: rateLimitReset,
              queue: [],
              flushing: false
            };

            this.buckets.set(init.bucketId, bucket);
          } else {
            bucket.remaining = remaining;
            bucket.reset = rateLimitReset;
          }
        }

        if (
          response.statusCode === 429 &&
          rateLimitReset &&
          'x-ratelimit-global' in response.headers
        ) {
          this.block = new Promise((resolve) => {
            setTimeout(() => {
              this.block = null;
              resolve();
            }, rateLimitReset.getTime() - Date.now()).unref();
          });
        }

        init.onResponse();

        const errored = response.statusCode
          ? response.statusCode >= 400
          : false;

        if (
          response.statusCode &&
          (response.statusCode === 429 || response.statusCode >= 500)
        ) {
          cancelled = true;
          const bucket = init.bucketId ? this.buckets.get(init.bucketId) : null;
          const queue = bucket ? bucket.queue : this.queue;
          queue.push(
            () =>
              new Promise<void>((onResponse) => {
                if (timeout !== null) clearTimeout(timeout);
                void this.finalizeRequest(
                  Object.assign(init, {
                    onResponse,
                    timeout: init.timeout - (Date.now() - startTime)
                  })
                ).then(resolve, reject);
              })
          );
        }

        response.once('error', handleError);

        let stream: stream.Readable = response;
        if (response.headers['content-encoding']) {
          const encoding = response.headers['content-encoding'];

          if (encoding.includes('gzip')) stream = response.pipe(createGunzip());
          else if (encoding.includes('deflate'))
            stream = response.pipe(createInflate());
        }

        stream.once('error', handleError);

        let data = '';
        if (!cancelled) {
          stream
            .on('data', (chunk) => {
              data += chunk;
            })
            .once('end', () => {
              if (cancelled) return;
              if (timeout !== null) clearTimeout(timeout);
              const parsedData = response.headers['content-type']?.startsWith(
                'application/json'
              )
                ? (JSON.parse(data) as unknown)
                : Buffer.from(data);

              if (errored) {
                if (parsedData instanceof Buffer)
                  reject(new DiscordAPIError(-1, parsedData.toString()));
                else {
                  reject(
                    new DiscordAPIError(
                      (parsedData as FailedRequest).code,
                      (parsedData as FailedRequest).message,
                      init.stack
                    )
                  );
                }
              } else resolve(parsedData);
            });
        }
      });

      request.end(init.body);
    });
  }

  private static getRateLimitBucket(this: void, path: string) {
    return (
      /^\/((?:channels|guilds|webhooks\/\d+)\/\d+)/.exec(path)?.[1] ?? null
    );
  }
}

type RequestFinalizer = () => Promise<void>;

interface FailedRequest {
  message: string;
  code: number;
}

interface RateLimitBucket {
  remaining: number;
  reset: Date;
  queue: RequestFinalizer[];
  flushing: boolean;
}

export interface RequestOptions {
  /** The headers to send with the request */
  headers?: Record<string, string>;
  /**
   * The body of the request.
   *
   * @remarks
   * Strings and buffers will be sent as-is.
   * However, objects and arrays will be serialized to JSON,
   * and a `Content-Type: application/json` header will be added.
   *
   * @example
   * ```ts
   * // POST some JSON data to an endpoint
   * await client.request('POST', '/api/v9/channels/123456789/messages', {
   *   body: { content: 'Hello world!' },
   *   auth: true
   * });
   * ```
   */
  body?: string | Buffer | Record<string, unknown> | unknown[];
  /** Whether or not to attach the `Authorization` header (requires token) */
  auth?: boolean;
  /** The amount of time, in milliseconds, after which to give up the request */
  timeout?: number;
  /** Query string pieces to be appended to the path */
  queryString?: URLSearchParams;
}

export interface RESTClientOptions {
  /** The token used to authenticate with the Discord API */
  token?: string;
  /** Specifies whether this is a bot token or a bearer token. */
  tokenType?: TokenType;
  /**
   * The hostname of the Discord API.
   *
   * @default
   * ```ts
   * 'discord.com'
   * ```
   */
  host?: string;
  /**
   * The port number of the Discord API.
   *
   * @default
   * ```ts
   * 443
   * ```
   */
  port?: number;
  /**
   * The version number of the API which requests will be sent to.
   *
   * @remarks
   * This is used so you don't have to specify an API
   * version in every request. Altering this is a quick
   * and easy way to start sending all requests to a new
   * version.
   *
   * @default 9
   *
   * @see https://discord.com/developers/docs/reference#api-versioning
   */
  apiVersion?: number;
  /** Information to be appended to the base [User Agent](https://discord.com/developers/docs/reference#user-agent) */
  userAgentSuffix?: string;
  /** Passed to `https.request` */
  agent?: https.Agent;
  /** The default value of {@link RequestOptions.timeout} */
  timeout?: number;
}
