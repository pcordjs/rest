import * as https from 'https';
import * as stream from 'stream';
import * as timers from 'timers/promises';
import { URLSearchParams } from 'url';
import { createGunzip, createInflate } from 'zlib';
import RESTError, { RESTErrorCode } from './RESTError';

// eslint-disable-next-line
const packageInfo = require('../package.json') as { version: string };

const BASE_USER_AGENT = `DiscordBot (https://github.com/pcordjs/rest, ${packageInfo.version})`;

export enum RequestDestination {
  API,
  CDN
}

export enum TokenType {
  BOT,
  BEARER
}

const httpsAgent = new https.Agent({ keepAlive: true });

export default class RESTClient {
  public constructor(private readonly options: RESTClientOptions) {}

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
      await this.block;
      while (bucket.queue.length) {
        const finalizeRequest = bucket.queue.shift()!;

        if (bucket.remaining === 0) {
          await timers.setTimeout(bucket.reset.getTime() - Date.now(), null, {
            ref: false
          });
        }

        await finalizeRequest();
      }
    } finally {
      bucket.flushing = false;
    }
  }

  private async flushGlobalBucket() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.block;
      while (this.queue.length) {
        const finalizeRequest = this.queue.shift()!;
        await finalizeRequest();
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
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip,deflate',
      ...options.headers
    };

    if (options.auth) headers.Authorization = this.auth;
    if (typeof options.body === 'object' && !(options.body instanceof Buffer))
      headers['Content-Type'] = 'application/json';

    let finalPath = path;
    if (options.queryString) finalPath += `?${options.queryString.toString()}`;

    const finalBody =
      typeof options.body === 'object' && !(options.body instanceof Buffer)
        ? Buffer.from(JSON.stringify(options.body))
        : options.body;

    const bucketId = RESTClient.getRateLimitBucket(finalPath);

    return new Promise<ResponseType>((resolve, reject) => {
      const finalize: RequestFinalizer = () =>
        new Promise<void>(
          (onResponse) =>
            void (
              this.finalizeRequest({
                headers,
                method,
                path: finalPath,
                host:
                  options.destination === RequestDestination.CDN
                    ? this.options.cdn ?? 'cdn.discordapp.com'
                    : this.options.api ?? 'discord.com',
                agent: this.options.agent ?? httpsAgent,
                body:
                  finalBody !== undefined ? Buffer.from(finalBody) : undefined,
                timeout: options.timeout ?? this.options.timeout ?? Infinity,
                bucketId,
                onResponse
              }) as Promise<ResponseType>
            ).then(resolve, reject)
        );

      const bucket = bucketId ? this.buckets.get(bucketId) : null;
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
  }) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
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
        method: init.method
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

        const rateLimitReset =
          'x-ratelimit-reset' in response.headers
            ? new Date(
                parseFloat(response.headers['x-ratelimit-reset'] as string) *
                  1000
              )
            : 'retry-after' in response.headers
            ? new Date(
                parseInt(response.headers['retry-after']!) * 1000 + Date.now()
              )
            : null;
        if ('x-ratelimit-bucket' in response.headers && init.bucketId) {
          let bucket = this.buckets.get(init.bucketId);
          const remaining = parseInt(
            response.headers['x-ratelimit-remaining'] as string,
            10
          );

          if (!bucket) {
            bucket = {
              remaining,
              reset: rateLimitReset!,
              queue: [],
              flushing: false
            };

            this.buckets.set(init.bucketId, bucket);
          } else {
            bucket.remaining = remaining;
            bucket.reset = rateLimitReset!;
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

        response.once('error', handleError);

        let stream: stream.Readable = response;
        if (response.headers['content-encoding']) {
          const encoding = response.headers['content-encoding'];

          // TODO: remove me
          console.log(response.headers);

          if (encoding.includes('gzip')) stream = response.pipe(createGunzip());
          else if (encoding.includes('deflate'))
            stream = response.pipe(createInflate());
        }

        stream.once('error', handleError);

        let data = '';
        stream
          .on('data', (chunk) => {
            data += chunk;
          })
          .once('end', () => {
            if (cancelled) return;
            if (timeout !== null) clearTimeout(timeout);

            if (
              response.headers['content-type']?.startsWith('application/json')
            )
              resolve(JSON.parse(data));
            else resolve(Buffer.from(data));
          });
      });

      request.end(init.body);
    });
  }

  private static getRateLimitBucket(this: void, path: string) {
    return (
      /^\/api\/v\d+\/(channels\/\d+|guilds\/\d+|webhooks\/\d+\/\d+)/.exec(
        path
      )?.[1] ?? null
    );
  }
}

type RequestFinalizer = () => Promise<void>;

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
  /** Where the request will be sent to - the API, or CDN */
  destination?: RequestDestination;
  /** Query string pieces to be appended to the path */
  queryString?: URLSearchParams;
}

export interface RESTClientOptions {
  /** The token used to authenticate with the Discord API */
  token?: string;
  /** Specifies whether this is a bot token or a bearer token. */
  tokenType?: TokenType;
  /** The endpoint of the Discord API */
  api?: string;
  /** The endpoint of the Discord CDN */
  cdn?: string;
  /** Information to be appended to the base [User Agent](https://discord.com/developers/docs/reference#user-agent) */
  userAgentSuffix?: string;
  /** Passed to `https.request` */
  agent?: https.Agent;
  /** The default value of {@link RequestOptions.timeout} */
  timeout?: number;
}
