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

/**
 * The default {@link RESTClient} user agent.
 *
 * @see {@link RESTClient.userAgent} for the actual user agent header sent with requests
 */
export const BASE_USER_AGENT = `DiscordBot (https://github.com/pcordjs/rest, ${packageInfo.version})`;

/**
 * The category of a Discord token, used to describe which is being used to
 * authenticate.
 *
 * @see {@link RESTClientOptions.tokenType} for setting the token type of
 * requests
 */
export enum TokenType {
  /**
   * A token for a Discord bot, generated on the Discord Developer Portal.
   *
   * @remarks
   * This token type can be used to authenticate as a bot user.
   */
  BOT,
  /**
   * An OAuth2 token, generated via Discord's OAuth2 flow.
   *
   * @remarks
   * This token type can be used to authenticate as a user who has connected
   * their account to your app.
   */
  BEARER
}

/**
 * The default agent is used so that as many connections are reused as possible,
 * reducing the time needed to reconnect.
 */
const httpsAgent = new https.Agent({ keepAlive: true });

type PreparedRequest = {
  headers: Record<string, string>;
  method: string;
  path: string;
  host: string;
  agent: https.Agent;
  body?: Buffer | stream.Readable;
  bucketId: string | null;
  stack: string;
  port?: number;
} & (
  | {
      stream: false;
      timeout: number;
    }
  | {
      stream: true;
    }
);

/**
 * Send REST requests to Discord.
 *
 * @remarks
 * Objects send HTTPS requests to a configurable host, port, and API
 * version. They can automatically prevent and handle rate limits, and store
 * your authentication token to send in requests.
 *
 * @see {@link RESTClientOptions} for configuration options
 */
export default class RESTClient {
  public constructor(private readonly options: RESTClientOptions) {
    /*
     * API versions that aren't positive integers are likely mistakes, so we
     * emit a warning.
     */
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

  // Node.js warnings aren't supposed to be emitted more than once
  private static hasEmittedInvalidAPIVersionWarning = false;

  /**
   * The user agent of the client.
   *
   * @remarks
   * The user agent header is sent in all requests, and is used to signal to
   * Discord that your requests come from a bot. It also specifies which library
   * you are using, and its version.
   *
   * While the first section of the header is constant, a suffix can optionally
   * be appended.
   *
   * @see {@link BASE_USER_AGENT} for the constant first section of the header
   * @see {@link RESTClientOptions.userAgentSuffix} for the suffix that can be
   * optionally appended
   * @see The [Discord Developer
   * Docs](https://discord.com/developers/docs/reference#user-agent) for more
   * information
   */
  public get userAgent(): string {
    const parts = [BASE_USER_AGENT];

    if (this.options.userAgentSuffix) parts.push(this.options.userAgentSuffix);

    return parts.join(', ');
  }

  /**
   * The client's Discord authentication.
   *
   * @remarks
   * Contains the value of the `Authentication` header, sent in requests that
   * have the `auth` option enabled. It consists of one of the token types `Bearer` or
   * `Bot`, then the token provided by the {@link RESTClient} object's
   * configuration.
   *
   * @see {@link RESTClientOptions.tokenType} to configure which token type is used
   * @see {@link RESTClientOptions.token} to configure the authentication token sent
   */
  public get auth(): string {
    if (!this.options.token) throw new RESTError(RESTErrorCode.TOKEN_REQUIRED);
    return `${this.options.tokenType === TokenType.BEARER ? 'Bearer' : 'Bot'} ${
      this.options.token
    }`;
  }

  /**
   * The global block field may contain a Promise that resolves when it is safe
   * to send requests again. It is used to block the client while it is
   * experiencing a rate limit.
   */
  private block: Promise<void> | null = null;

  /**
   * This field maps bucket IDs to their corresponding rate limit buckets. The
   * IDs are routes are trimmed to remove unnecessary data (e.g.
   * `/api/v10/channels/123/` becomes `channels/123`).
   *
   * @see {@link RateLimitBucket} for the structure stored in this Map
   * @see {@link RESTClient.getRateLimitBucket} for the API for getting a bucket ID
   */
  private readonly buckets = new Map<string, RateLimitBucket>();

  /*
   * global bucket fields apply for requests without specific buckets (such as
   * `/sticker-packs`)
   */

  /**
   * @see {@link RateLimitBucket.queue}
   */
  private readonly queue: RequestFinalizer[] = [];

  /**
   * @see {@link RateLimitBucket.flushing}
   */
  private flushing = false;

  /**
   * Flushes all requests in a specific rate limit bucket.
   *
   * @remarks
   * This method finalizes (i.e. sends) all requests in a rate limit bucket's
   * queue, pausing if a rate limit has occurred or is about to. This method
   * sets the bucket's `flushing` property to `true` while it is running,
   * effectively creating a mutex.
   *
   * @see {@link RESTClient.flushGlobalBucket}
   */
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

  /**
   * Performs the same actions as {@link RESTClient.flushBucket}, but on the
   * global, client-wide bucket.
   *
   * @remarks
   * This method does not pause when a rate limit is about to occur, because
   * responses outside of buckets do not have the `X-RateLimit-Remaining` header.
   */
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

  /**
   * Prepares a request to be sent by setting the User Agent, adding
   * authentication, calculating the rate limit bucket, etc.
   *
   * This method doesn't have any side effects so it should be called as soon as
   * possible to get useful information like the rate limit bucket id.
   *
   * @param options The options used to create the request.
   * @returns A PreparedRequest object that can be used with
   * {@link RESTClient.finalizeRequest}.
   */
  private prepareRequest(
    options: RequestOptions & {
      method: string;
      path: string;
      stack: string;
      streamResponse: boolean;
    }
  ): PreparedRequest {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip,deflate',
      ...options.headers
    };

    if (options.auth) headers.Authorization = this.auth;
    if (typeof options.body === 'object' && !(options.body instanceof Buffer))
      headers['Content-Type'] = 'application/json';

    let finalPath = `/api/v${this.options.apiVersion ?? '9'}${options.path}`;
    if (options.queryString) finalPath += `?${options.queryString.toString()}`;

    const finalBody =
      options.body instanceof stream.Readable || options.body === undefined
        ? options.body
        : Buffer.from(
            typeof options.body === 'object' &&
              !(options.body instanceof Buffer)
              ? JSON.stringify(options.body)
              : options.body
          );

    const bucketId = RESTClient.getRateLimitBucket(options.path);

    return {
      headers,
      method: options.method,
      path: finalPath,
      host: this.options.host ?? 'discord.com',
      agent: this.options.agent ?? httpsAgent,
      body: finalBody !== undefined ? finalBody : undefined,
      timeout: options.timeout ?? this.options.timeout ?? Infinity,
      bucketId,
      stack: options.stack,
      port: this.options.port,
      stream: options.streamResponse
    };
  }

  /**
   * Enqueues a request in a rate limit bucket's queue.
   * @param bucketId The ID of the bucket to push to.
   * @param finalize The callback for when the request has reached the front of the bucket's queue.
   */
  private pushRequest(bucketId: string | null, finalize: RequestFinalizer) {
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
      /*
       * we don't need to catch this because finalizer callbacks
       * are required to not throw
       */
      void this.flushBucket(bucket);
    } else {
      this.queue.push(finalize);
      void this.flushGlobalBucket();
    }
  }

  /**
   * Sends an HTTPS request to the Discord API.
   *
   * @example Sending a "Hello World!" message to a channel
   * ```ts
   * import RESTClient from '@pcordjs/rest';
   *
   * const channelId = '123456789012345678';
   * const client = new RESTClient({
   *   token: '123.456.789'
   * });
   *
   * await client.request('POST', `/channels/${channelId}/messages`, {
   *   auth: true,
   *   body: { content: 'Hello World!' }
   * });
   * ```
   *
   * @typeParam ResponseType - Used to change the return type to what the API
   * will actually respond with. Defaults to a Buffer, which is used when JSON
   * was not sent in the response.
   *
   * @param method - The HTTP method used in the request, passed directly to
   * `https.request`.
   * @param path - The route the request should be sent to, without the
   * `/api/vX` prefix
   * @param options - Options used to configure this request in particular.
   *
   * @returns The parsed JSON data if available, otherwise a Buffer containing
   * the response.
   *
   * @throws {@link RESTError} - This error is thrown when the
   * {@link RequestOptions.timeout} has elapsed or when
   * {@link RequestOptions.auth} was true but no token was provided.
   *
   * @throws {@link DiscordAPIError} - Thrown if the Discord API responds with a
   * non-200 status code. Keep in mind that rate limits (429) will not cause
   * this error to be thrown - instead, they will cause the request to be
   * retried.
   *
   * @see The [Discord Developer Docs](https://discord.com/developers/docs/) for
   * API documentation
   * @see {@link RequestOptions} for customization of this request
   */
  public request<ResponseType = Buffer>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ) {
    const stack = captureStack();
    const preparedRequest = this.prepareRequest({
      ...options,
      method,
      path,
      stack,
      streamResponse: false
    });

    return new Promise<ResponseType>((resolve, reject) => {
      const finalize: RequestFinalizer = () =>
        new Promise<void>(
          (onResponse) =>
            void (
              this.finalizeRequest(
                Object.assign(preparedRequest, {
                  onResponse
                })
              ) as Promise<ResponseType>
            ).then(resolve, reject)
        );

      this.pushRequest(preparedRequest.bucketId, finalize);
    });
  }

  /**
   * Sends a request without considering rate limit buckets. They are expected
   * to have been already handled by the calling function.
   *
   * @param init - Various initializers provided by {@link RESTClient.request}
   * @param init.onResponse - Called when a response header has been received
   * but before the body has been received. Useful for preventing rate limits.
   * @param init.stack - Holds the stack frames for any errors that are thrown.
   * Used because the stack frames would be useless without seeing where 3rd
   * party code is being run.
   */
  private finalizeRequest(init: PreparedRequest & { onResponse: () => void }) {
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const startTime = Date.now();
      const timeout =
        init.stream || init.timeout === Infinity
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
                    timeout: init.stream
                      ? null
                      : init.timeout - (Date.now() - startTime)
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

        if (init.stream && !cancelled) resolve(stream);
        else {
          stream.once('error', handleError);

          if (!cancelled) {
            let data = '';
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
        }
      });

      if (init.body instanceof stream.Readable) init.body.pipe(request);
      else request.end(init.body);
    });
  }

  /**
   * Creates a bucket ID based on the API route passed as an argument.
   *
   * @see {@link RESTClient.buckets}
   */
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

/**
 * Stores information about all requests going to a specific route bucket.
 *
 * @remarks
 * Rate limit buckets (i.e. categories) are sets of API routes that have their
 * own "local" rate limit parameters. This includes the number of requests that
 * can be sent without causing a rate limit, and the timestamp at which that
 * number will reset.
 */
interface RateLimitBucket {
  /**
   * The remaining number of requests tied to this bucket that can be sent
   * without causing a rate limit.
   */
  remaining: number;
  /**
   * The timestamp at which {@link RateLimitBucket.remaining} will reset to a
   * larger number. If this is in the past, it is safe to send requests _even
   * if_ the number remaining is zero.
   */
  reset: Date;
  /**
   * All requests that are waiting to be sent and are tied to this rate limit bucket.
   * Callbacks MUST NOT throw.
   */
  queue: RequestFinalizer[];
  /**
   * Acts as a mutex, and signals whether it is safe to begin handling requests
   * in the queue.
   */
  flushing: boolean;
}

export interface StreamRequestOptions {
  /**
   * The headers to send with the request.
   *
   * @remarks
   * The headers `User-Agent` and `Accept-Encoding` are automatically set on all
   * requests. Additionally, the `Content-Type` header is set to
   * `application/json` if JSON data (i.e. an object or array) was passed to
   * {@link RequestOptions.body}.
   *
   * @example Setting an audit log reason when renaming a channel
   * ```ts
   * import RESTClient from '@pcordjs/rest';
   *
   * const channelId = '123456789012345678';
   * const client = new RESTClient({
   *   token: '123.456.789'
   * });
   *
   * await client.request('PATCH', `/channels/${channelId}`, {
   *   auth: true,
   *   body: { name: 'new-name' },
   *   headers: {
   *     'X-Audit-Log-Reason': '@pcordjs/rest example'
   *   }
   * });
   * ```
   *
   * @see The [Discord Developer
   * Docs](https://discord.com/developers/docs/resources/audit-log#audit-logs)
   * for information on the `X-Audit-Log-Reason` header
   */
  headers?: Record<string, string>;
  /**
   * The body of the request.
   *
   * @remarks
   * Strings and buffers will be sent as-is. However, objects and arrays will be
   * serialized to JSON, and a `Content-Type: application/json` header will be
   * added.
   *
   * @see {@link RequestOptions.headers} for more headers that are automatically
   * added
   * @see {@link RESTClient.request} for an example using this field
   */
  body?:
    | string
    | Buffer
    | Record<string, unknown>
    | unknown[]
    | stream.Readable;
  /**
   * Controls if the request will be authenticated.
   *
   * @remarks
   * Enabling this adds the `Authentication` header to the request, which
   * contains your authentication token and is required for most Discord API
   * routes.
   *
   * @see {@link RESTClient.auth} for the value sent with the request
   */
  auth?: boolean;
  /**
   * The query string appended to the API route.
   */
  queryString?: URLSearchParams;
}

export interface RequestOptions extends StreamRequestOptions {
  /**
   * The amount of time to wait before giving up.
   *
   * @remarks
   * The timeout value, measured in milliseconds, specifies how long should be
   * waited before giving up on the request. If this amount of time passes
   * without a successful response, a {@link RESTError} will be
   * thrown.
   *
   * @defaultValue {@link RESTClientOptions.timeout}
   */
  timeout?: number;
}

export interface RESTClientOptions {
  /**
   * The token used to authenticate with the API.
   *
   * @remarks
   * This authentication token will be sent in requests that have the `auth`
   * option enabled, along with the token's type.
   *
   * @see {@link RequestOptions.auth} for controlling if it will be sent
   * @see {@link RESTClientOptions.tokenType} for specifying the token's type
   */
  token?: string;
  /**
   * The category of the authentication token.
   *
   * @defaultValue {@link TokenType.BOT}
   *
   * @example Using an OAuth2 bearer token
   * ```ts
   * import RESTClient, { TokenType } from '@pcordjs/rest';
   *
   * const client = new RESTClient({
   *   token: '...',
   *   tokenType: TokenType.BEARER
   * });
   * ```
   * @see {@link TokenType} for more information
   */
  tokenType?: TokenType;
  /**
   * The hostname that requests will be sent to.
   *
   * @defaultValue `'discord.com'`
   *
   * @example Sending requests to a custom host
   * ```ts
   * import RESTClient from '@pcordjs/rest';
   *
   * const client = new RESTClient({
   *   host: 'my-test-api.xyz',
   *   port: 3000
   * });
   * ```
   */
  host?: string;
  /**
   * The port number that requests will be sent to.
   *
   * @defaultValue `443`
   */
  port?: number;
  /**
   * The version number of the API which requests will be sent to.
   *
   * @remarks
   * The version number is added to all requests sent with
   * {@link RESTClient.request}. Changing this property will cause all requests
   * to be sent to a different version of the API.
   *
   * @defaultValue `9`
   *
   * @example Sending all requests to an older API version
   * ```ts
   * import RESTClient from '@pcordjs/rest';
   *
   * const client = new RESTClient({
   *   apiVersion: 8
   * });
   * ```
   *
   * @see https://discord.com/developers/docs/reference#api-versioning
   */
  apiVersion?: number;
  /**
   * Information to be appended to the user agent
   *
   * @example Adding custom info to the user agent
   * ```ts
   * import RESTClient from '@pcordjs/rest';
   *
   * const client = new RESTClient({
   *   userAgentSuffix: 'MyBot (https://mybot.example.com, 1.0.0)'
   * });
   * ```
   *
   * @see {@link RESTClient.userAgent} for more information
   */
  userAgentSuffix?: string;
  /**
   * The HTTPS Agent used in requests.
   *
   * @remarks
   * The default agent has `keepAlive` enabled to lower the time spent
   * connecting. You can specify your own if you would like to set other
   * configuration options.
   */
  agent?: https.Agent;
  /**
   * The amount of time to wait before giving up a request.
   *
   * @defaultValue `Infinity`
   *
   * @see {@link RequestOptions.timeout} for more information
   */
  timeout?: number;
}
